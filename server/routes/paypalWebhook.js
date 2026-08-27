// ── PayPal webhook ────────────────────────────────────────────────────
// WHY THIS ROUTE EXISTS: routes/paypal.js's /paypal/capture-order is only
// ever called by the FRONTEND, right after the customer approves payment
// on PayPal's screen. If the tab closes, the connection drops, or the
// browser crashes in that gap, PayPal has already captured the money but
// our server never hears about it — the booking is left at
// payment_status:'Unpaid' forever, with no record of what happened.
// This is the exact same gap routes/razorpayWebhook.js closes for
// Razorpay, just for the international/PayPal flow.
//
// This webhook is PayPal calling US directly, server-to-server, regardless
// of what the customer's browser does — so a payment that actually
// completed always ends up recorded, even if the frontend never checked in.
//
// REQUIRES (manual, one-time, in PayPal's dashboard — see chat for the
// exact steps): a webhook configured at developer.paypal.com → your app →
// Add Webhook, pointing at POST https://<your-render-url>/api/paypal/webhook,
// subscribed to at minimum: PAYMENT.CAPTURE.COMPLETED. PayPal gives you a
// Webhook ID at creation time — set PAYPAL_WEBHOOK_ID in Render's
// environment. Until that's set, this route safely no-ops (fails closed).

const express = require('express');
const { supabase } = require('../db');
const { sendCustomerBookingConfirmation, sendSpellBookingConfirmation, sendEnergyHealingConfirmation, sendNumerologyConfirmation } = require('../utils/notify');

const router = express.Router();

const PAYPAL_API_BASE = 'https://api-m.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';

// Separate token cache from routes/paypal.js on purpose — this file is
// intentionally self-contained so it can't ever break the already-working
// create-order/capture-order routes.
let _cachedToken = null, _cachedTokenExpiresAt = 0;
async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiresAt) return _cachedToken;
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'PayPal auth failed');
  _cachedToken = data.access_token;
  _cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return _cachedToken;
}

// PayPal doesn't use a simple HMAC-over-raw-body like Razorpay — instead
// you hand the transmission headers + the event body BACK to PayPal's own
// verify-webhook-signature endpoint and it tells you if it's genuine. This
// is PayPal's officially recommended verification method.
async function verifyWebhookSignature(req) {
  const token = await getAccessToken();
  const body = {
    transmission_id: req.headers['paypal-transmission-id'],
    transmission_time: req.headers['paypal-transmission-time'],
    cert_url: req.headers['paypal-cert-url'],
    auth_algo: req.headers['paypal-auth-algo'],
    transmission_sig: req.headers['paypal-transmission-sig'],
    webhook_id: PAYPAL_WEBHOOK_ID,
    webhook_event: req.body
  };
  const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  return res.ok && data.verification_status === 'SUCCESS';
}

// Mounted after the global express.json() parser in server.js — unlike
// Razorpay/Calendly's webhooks, PayPal's verification method sends the
// already-parsed JSON body back to PayPal's API rather than needing the
// raw bytes for a local HMAC check, so no separate raw-body capture here.
router.post('/paypal/webhook', async (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_WEBHOOK_ID) {
    console.warn('[paypal webhook] PAYPAL_WEBHOOK_ID not set yet — rejecting (fail closed, not open, for a payment-related webhook).');
    return res.status(503).json({ ok: false });
  }

  let verified = false;
  try {
    verified = await verifyWebhookSignature(req);
  } catch (err) {
    console.error('[paypal webhook] verification request failed:', err.message);
  }
  if (!verified) {
    console.warn('[paypal webhook] Signature verification failed — rejecting.');
    return res.status(401).json({ ok: false });
  }

  // Always ack quickly — PayPal retries on non-2xx.
  res.json({ ok: true });

  const eventType = req.body?.event_type;
  if (eventType !== 'PAYMENT.CAPTURE.COMPLETED' || !supabase) return;

  const capture = req.body?.resource;
  // custom_id is set at order-creation time in routes/paypal.js — this is
  // OUR bookingId, not PayPal's own order/capture id.
  const bookingId = capture?.custom_id;
  const captureId = capture?.id;
  const amountPaidUsd = capture?.amount?.value;
  if (!bookingId || !captureId) return;

  try {
    // Belt-and-braces alongside /paypal/capture-order — in case the
    // frontend never called capture-order (tab closed right after
    // approving, etc.), the webhook still gets the booking marked Paid
    // AND sends the confirmation email.
    const { data: before } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (!before || before.payment_status === 'Paid') return; // never re-send an already-verified success

    const { data: updated, error } = await supabase.from('bookings').update({
      payment_status: 'Paid', payment_id: captureId, payment_provider: 'paypal',
      currency: 'USD', amount_paid: amountPaidUsd ? Number(amountPaidUsd) : null,
      updated_at: new Date().toISOString()
    }).eq('id', bookingId).select().maybeSingle();

    if (error) {
      console.warn('[paypal webhook] Could not record payment.captured for booking %s:', bookingId, error.message);
      return;
    }
    if (!updated) return;

    console.log('[paypal webhook] Recorded PAYMENT.CAPTURE.COMPLETED for booking %s (frontend capture-order may not have fired)', bookingId);

    if (updated.coupon_code && updated.email) {
      supabase.from('coupon_redemptions').insert({
        coupon_code: updated.coupon_code, email: updated.email.toLowerCase(), booking_id: updated.id
      }).then(({ error: redeemErr }) => {
        if (redeemErr) console.warn('[paypal webhook] Could not record coupon redemption:', redeemErr.message);
      });
    }

    const priceLabel = amountPaidUsd ? `$${Number(amountPaidUsd).toFixed(2)}` : null;
    const service = updated.service || '';
    if (service === 'Spell / Magic') {
      sendSpellBookingConfirmation({ ...updated, priceLabel }).catch(() => {});
    } else if (service === 'Energy Healing') {
      sendEnergyHealingConfirmation({ ...updated, priceLabel }).catch(() => {});
    } else if (service === 'Numerology') {
      sendNumerologyConfirmation({ ...updated, priceLabel }).catch(() => {});
    } else {
      sendCustomerBookingConfirmation(updated).catch(() => {});
    }
  } catch (err) {
    console.error('[paypal webhook] handling failed:', err.message);
  }
});

module.exports = router;
