const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Razorpay = require('razorpay');
const { supabase } = require('../db');
const { sendCustomerBookingConfirmation, sendSpellBookingConfirmation, sendEnergyHealingConfirmation, sendNumerologyConfirmation } = require('../utils/notify');

const router = express.Router();

// ── Server-side price enforcement ── NEVER trust a client-supplied amount.
// This is the Phone Tarot Reading price table (the only service type that
// currently goes through Razorpay checkout) — must have all six durations
// customers can actually select (see the Call Duration <select> in
// index.html and handlePhoneReadingSelect() in js/script.js, which builds
// selectedDuration as "<mins> Min"). '10 Min' and '20 Min' were missing
// here, which meant those two durations' checkout would fail with
// "Unknown or unsupported duration" even though they're offered and
// priced on the live site. Values mirror the real prices shown there.
const TAROT_PRICE_PAISE = {
  '10 Min': 88800,
  '15 Min': 99900,
  '20 Min': 122200,
  '30 Min': 155500,
  '45 Min': 188800,
  '60 Min': 255500,
  // Audio Tarot Reading is priced by number of questions, not minutes —
  // selectedDuration is null for these (see handleAudioReadingSelect in
  // js/script.js), so the frontend sends selectedReading itself (e.g.
  // "Audio — 2 Questions") as the price-lookup key instead. This table
  // never had these entries at all, so every Audio Tarot checkout was
  // rejected with "Unknown or unsupported duration" — misreported to the
  // customer as "Could not connect to payment server" by the frontend's
  // generic catch-all (see the fix in initiateRazorpay() in js/script.js).
  // Values mirror the real prices shown in the Number of Questions dropdown.
  'Audio — 1 Question':  49900,
  'Audio — 2 Questions': 59900,
  'Audio — 3 Questions': 69900,
  'Audio — 4 Questions': 79900,
  'Audio — 5 Questions': 89900,
  'Audio — 6 Questions': 99900
};

// ── Spell / Magic price enforcement ── same principle as above: NEVER
// trust a client-supplied final amount. Spells have ~50 individually
// named packages (see SPELL_CATEGORIES in js/script.js) sharing only a
// handful of distinct price points — rather than duplicating that whole
// naming list here (which would silently drift out of sync the next time
// a spell is added/renamed on the frontend), the server instead trusts
// only the price VALUE the client sends, and requires it to exactly match
// one of the real, published tiers below. This still fully blocks price
// tampering (a customer can only select among real published prices, not
// invent a lower one) without a second copy of the whole spell catalog to
// maintain. Update this list if new price tiers are ever introduced.
const SPELL_PRICE_TIERS_RUPEES = new Set([1555, 1666, 1888, 1999, 2222, 2999, 4444, 5555, 6666, 8888]);
// Energy Healing / Numerology — same principle: trust only a known,
// published price value, never a client-computed final amount. Neither
// has an urgency/multiplier option, so the base tier IS the final price.
const ENERGY_HEALING_PRICE_TIERS_RUPEES = new Set([555, 599, 666, 777, 899, 1199, 1650]);
const NUMEROLOGY_PRICE_TIERS_RUPEES = new Set([2222, 5555]);
// "Urgent" (Spell only) adds up to 20% — computed here server-side from
// the verified base tier above, never from a client-sent final total.
const URGENT_MULTIPLIER = 1.2;

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

  const { bookingId, duration, type, name, email, phone, basePrice, urgency } = req.body || {};
  if (!bookingId || typeof bookingId !== 'string') return res.status(400).json({ error: 'Missing bookingId.' });
  if (type !== 'booking' && type !== 'spell' && type !== 'energy_healing' && type !== 'numerology') {
    return res.status(400).json({ error: 'Unsupported payment type.' });
  }

  let amount;
  if (type === 'booking') {
    const baseAmount = TAROT_PRICE_PAISE[duration];
    if (!baseAmount) return res.status(400).json({ error: 'Unknown or unsupported duration — cannot price this booking.' });
    // Urgent/same-day delivery (+20%) — only ever sent by the frontend for
    // Audio Tarot Reading (see onTarotUrgencyChange/renderAudioQuestionInputs
    // in js/script.js; Phone Tarot's UI never shows this option since it's
    // a live scheduled call, not a delivered recording). Rounded to the
    // nearest RUPEE first (matching what the frontend displays to the
    // customer before checkout), then converted to paise — rounding the
    // paise amount directly instead would occasionally charge a few paise
    // off from the total the customer actually saw on screen.
    amount = urgency === 'Urgent' ? Math.round((baseAmount / 100) * URGENT_MULTIPLIER) * 100 : baseAmount;
  } else if (type === 'spell') {
    const base = Number(basePrice);
    if (!SPELL_PRICE_TIERS_RUPEES.has(base)) {
      return res.status(400).json({ error: 'Unknown or unsupported spell price — cannot price this booking.' });
    }
    const finalRupees = urgency === 'Urgent' ? Math.round(base * URGENT_MULTIPLIER) : base;
    amount = finalRupees * 100;
  } else {
    // type === 'energy_healing' | 'numerology' — no urgency option on
    // either form, so the base tier IS the final price.
    const base = Number(basePrice);
    const tiers = type === 'energy_healing' ? ENERGY_HEALING_PRICE_TIERS_RUPEES : NUMEROLOGY_PRICE_TIERS_RUPEES;
    if (!tiers.has(base)) {
      return res.status(400).json({ error: 'Unknown or unsupported price — cannot price this booking.' });
    }
    amount = base * 100;
  }

  if (_recentOrders.has(bookingId)) {
    return res.json(_recentOrders.get(bookingId));
  }

  try {
    const order = await razorpay.orders.create({
      amount, currency: 'INR', receipt: bookingId,
      notes: { bookingId, duration: duration || null, type, urgency: urgency || null }
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
    // Only for type 'booking' (Tarot) — a 'spell' booking's row already
    // exists at this point (created by POST /spells before the customer
    // ever reaches payment), so upserting here would risk clobbering real
    // fields (spell_category, urgency, intention, etc.) with blanks.
    if (type === 'booking' && supabase && name && email) {
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
  // else in this codebase sends that email for a Tarot or Spell booking.
  if (supabase) {
    const { data: updated, error } = await supabase.from('bookings').update({
      payment_status: 'Paid', payment_id: razorpay_payment_id, updated_at: new Date().toISOString()
    }).eq('id', bookingId).select().maybeSingle();
    if (error) {
      console.warn('[payments verify] Could not sync payment status to bookings row:', error.message);
    } else if (updated) {
      if (bookingType === 'spell') {
        // Spell / Magic gets its own confirmation wording (see
        // sendSpellBookingConfirmation) — Akanksha performs the ritual
        // herself rather than holding a live session, and the email needs
        // the customer's own urgency selection (already on the row) plus
        // the real amount actually paid. That amount isn't stored as its
        // own column (no schema change needed for this) — Razorpay's own
        // order object is the authoritative source, fetched fresh here.
        let priceLabel = null;
        try {
          const order = await razorpay.orders.fetch(razorpay_order_id);
          if (order && typeof order.amount === 'number') {
            priceLabel = '\u20b9' + (order.amount / 100).toLocaleString('en-IN');
          }
        } catch (e) {
          console.warn('[payments verify] Could not fetch order for price label:', e.message);
        }
        sendSpellBookingConfirmation({ ...updated, priceLabel }).catch(() => {});
      } else if (bookingType === 'energy_healing' || bookingType === 'numerology') {
        let priceLabel = null;
        try {
          const order = await razorpay.orders.fetch(razorpay_order_id);
          if (order && typeof order.amount === 'number') {
            priceLabel = '\u20b9' + (order.amount / 100).toLocaleString('en-IN');
          }
        } catch (e) {
          console.warn('[payments verify] Could not fetch order for price label:', e.message);
        }
        const sender = bookingType === 'energy_healing' ? sendEnergyHealingConfirmation : sendNumerologyConfirmation;
        sender({ ...updated, priceLabel }).catch(() => {});
      } else {
        sendCustomerBookingConfirmation(updated).catch(() => {});
      }
    }
  }

  res.json({ success: true });
});

module.exports = router;
