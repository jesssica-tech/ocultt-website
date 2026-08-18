const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Razorpay = require('razorpay');
const { supabase } = require('../db');
const { sendCustomerBookingConfirmation } = require('../utils/notify');

const router = express.Router();

// ── Server-side price enforcement ── NEVER trust a client-supplied amount.
// Mirrors PRICE_MAP in js/script.js (Tarot Reading durations only — the
// only service type that currently goes through Razorpay checkout).
const TAROT_PRICE_PAISE = {
  '15 Min': 99900,
  '30 Min': 155500,
  '45 Min': 188800,
  '60 Min': 255500
};

const razorpayConfigured = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const razorpay = razorpayConfigured
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;
if (!razorpayConfigured) {
  console.warn('[payments] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — checkout will return 503 until configured.');
}

const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// In-memory guard against a double order for the same bookingId within one
// process lifetime — a real duplicate-payment guard also happens at verify
// time via Supabase (payment_id uniqueness), this just avoids spamming
// Razorpay with repeat clicks.
const _recentOrders = new Map();

// ── POST /api/payments/create-order ──
router.post('/payments/create-order', orderLimiter, async (req, res) => {
  if (!razorpayConfigured) return res.status(503).json({ error: 'Payments are not configured yet.' });

  const { bookingId, duration, type, name, email, phone } = req.body || {};
  if (!bookingId || typeof bookingId !== 'string') return res.status(400).json({ error: 'Missing bookingId.' });
  if (type !== 'booking') return res.status(400).json({ error: 'Unsupported payment type.' });

  const amount = TAROT_PRICE_PAISE[duration];
  if (!amount) return res.status(400).json({ error: 'Unknown or unsupported duration — cannot price this booking.' });

  if (_recentOrders.has(bookingId)) {
    return res.json(_recentOrders.get(bookingId));
  }

  try {
    const order = await razorpay.orders.create({
      amount, currency: 'INR', receipt: bookingId,
      notes: { bookingId, duration }
    });
    const payload = { orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID };
    _recentOrders.set(bookingId, payload);
    setTimeout(() => _recentOrders.delete(bookingId), 30 * 60 * 1000); // forget after 30 min

    // Best-effort: create a placeholder booking row under this same bookingId
    // right away, so the razorpay webhook (payment.failed / payment.captured)
    // has a row to find and update even if the customer never completes
    // checkout and the frontend never calls /payments/verify or POST
    // /bookings. showConfirmation() later upserts this same row (same id)
    // with the full booking details once payment actually succeeds — never
    // blocks order creation from returning to the client.
    if (supabase && name && email) {
      supabase.from('bookings').upsert({
        id: bookingId, service: 'Tarot Reading', duration,
        name, email, phone: phone || null,
        payment_status: 'Unpaid', status: 'Booking Received'
      }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.warn('[payments create-order] Could not create placeholder booking row:', error.message);
      });
    }

    res.json(payload);
  } catch (err) {
    console.error('[payments create-order]', err.message);
    res.status(502).json({ error: 'Could not create payment order. Please try again.' });
  }
});

// ── POST /api/payments/verify ── HMAC-SHA256 signature check — the only
// trustworthy way to know a payment really happened and wasn't spoofed.
router.post('/payments/verify', async (req, res) => {
  if (!razorpayConfigured) return res.status(503).json({ success: false, error: 'Payments are not configured yet.' });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingId, bookingType } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bookingId) {
    return res.status(400).json({ success: false, error: 'Missing verification fields.' });
  }

  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('[payments verify] Signature mismatch for bookingId=%s', bookingId);
    return res.status(400).json({ success: false, error: 'Payment signature verification failed.' });
  }

  // Backend is the sole authority for payment status: this update — gated
  // entirely on the HMAC signature check above, never on anything the
  // client claims — is what actually marks the booking Paid. Also the
  // trigger point for the customer's "booking confirmed" email; nothing
  // else in this codebase sends that email for a Tarot booking.
  if (supabase) {
    const { data: updated, error } = await supabase.from('bookings').update({
      payment_status: 'Paid', payment_id: razorpay_payment_id, updated_at: new Date().toISOString()
    }).eq('id', bookingId).select().maybeSingle();
    if (error) {
      console.warn('[payments verify] Could not sync payment status to bookings row:', error.message);
    } else if (updated) {
      sendCustomerBookingConfirmation(updated).catch(() => {});
    }
  }

  res.json({ success: true });
});

module.exports = router;
