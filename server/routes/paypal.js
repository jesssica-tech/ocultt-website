// ── PayPal checkout for international customers ──
// Razorpay's international-cards request was rejected by their banking
// partners (requires registering as a legal entity + reapplying — see the
// v190 conversation). Rather than wait on that, non-Indian customers get a
// separate PayPal checkout instead, wired the same trustworthy way
// Razorpay's is: the server independently re-validates the price, and
// PayPal's own server-to-server "capture" response — never anything the
// browser claims — is what actually marks a booking Paid.
//
// Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET set in the environment
// (Render → Environment), same pattern as RAZORPAY_KEY_ID/SECRET. Until
// both are set, every route here returns 503 rather than doing anything.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabase } = require('../db');
const { sendCustomerBookingConfirmation, sendSpellBookingConfirmation, sendEnergyHealingConfirmation, sendNumerologyConfirmation } = require('../utils/notify');
const { computeDiscount, normalizeCode } = require('./coupons');
const {
  TAROT_PRICE_PAISE, SPELL_PRICE_TIERS_RUPEES, ENERGY_HEALING_PRICE_TIERS_RUPEES,
  NUMEROLOGY_PRICE_TIERS_RUPEES, GROUP_MAGIC_PRICE_TIERS_RUPEES, URGENT_MULTIPLIER
} = require('./payments');

const router = express.Router();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const paypalConfigured = !!(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
if (!paypalConfigured) {
  console.warn('[startup] \u26a0 PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set \u2014 the international (PayPal) checkout will return 503 until both are set.');
} else {
  console.log('[startup] \u2713 PayPal configured');
}

// Live API (not sandbox) — matches the Live credentials Akanksha pulled
// from developer.paypal.com. Fixed INR→USD rate rather than a live FX
// lookup, so prices are stable and predictable — Akanksha can update
// PAYPAL_USD_RATE in Render's env whenever she wants to adjust it,
// without a code change or redeploy of anything else.
//
// International pricing = real INR→USD conversion, then a 3x markup
// (Disha's call, confirmed by Jess Aug 2026) — NOT the INR number
// reused as-is in dollars. So ₹999 → ~$11.35 at the base rate →
// ~$34.05 after the 3x. INTL_MARKUP is its own env-overridable knob,
// separate from the FX rate, so either can be adjusted independently.
const PAYPAL_API_BASE = 'https://api-m.paypal.com';
const USD_RATE = Number(process.env.PAYPAL_USD_RATE) || 88; // ₹ per $1
const INTL_MARKUP = Number(process.env.PAYPAL_INTL_MARKUP) || 3;

function toUsd(rupees) {
  return Math.round((rupees / USD_RATE) * INTL_MARKUP * 100) / 100; // 2 decimal places
}

const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const _recentOrders = new Map();

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
  _cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
  return _cachedToken;
}

// ── Server-side price re-validation — identical logic/tables to
// /payments/create-order (Razorpay), just converted to USD at the end.
// Never trust a client-supplied amount, regardless of which gateway. ──
function computeAmountRupees(body) {
  const { type, duration, basePrice, urgency } = body;
  if (type === 'booking') {
    const baseAmount = TAROT_PRICE_PAISE[duration];
    if (!baseAmount) return { error: 'Unknown or unsupported duration — cannot price this booking.' };
    const amountPaise = urgency === 'Urgent' ? Math.round((baseAmount / 100) * URGENT_MULTIPLIER) * 100 : baseAmount;
    return { amountRupees: amountPaise / 100 };
  }
  if (type === 'spell') {
    const base = Number(basePrice);
    if (!SPELL_PRICE_TIERS_RUPEES.has(base)) return { error: 'Unknown or unsupported spell price — cannot price this booking.' };
    return { amountRupees: urgency === 'Urgent' ? Math.round(base * URGENT_MULTIPLIER) : base };
  }
  if (type === 'energy_healing' || type === 'numerology' || type === 'group_magic') {
    const base = Number(basePrice);
    const tiers = type === 'energy_healing' ? ENERGY_HEALING_PRICE_TIERS_RUPEES
      : type === 'numerology' ? NUMEROLOGY_PRICE_TIERS_RUPEES
      : GROUP_MAGIC_PRICE_TIERS_RUPEES;
    if (!tiers.has(base)) return { error: 'Unknown or unsupported price — cannot price this booking.' };
    return { amountRupees: base };
  }
  return { error: 'Unsupported payment type.' };
}

// ── POST /api/paypal/create-order ──
router.post('/paypal/create-order', orderLimiter, async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'International payments are not configured yet.' });

  const { bookingId, type, name, email, phone, duration, urgency } = req.body || {};
  if (!bookingId || typeof bookingId !== 'string') return res.status(400).json({ error: 'Missing bookingId.' });

  const priced = computeAmountRupees(req.body || {});
  if (priced.error) return res.status(400).json({ error: priced.error });
  let amountRupees = priced.amountRupees;

  // Coupon — same re-check as Razorpay's flow, just carried through in USD.
  let couponCode = null, discountAmountRupees = 0;
  const requestedCoupon = normalizeCode(req.body.couponCode);
  if (requestedCoupon) {
    if (!supabase) return res.status(503).json({ error: 'Coupons are not available right now.' });
    if (!email) return res.status(400).json({ error: 'An email is required to use a coupon.' });
    const { data: coupon, error: cErr } = await supabase.from('coupons').select('*').eq('code', requestedCoupon).maybeSingle();
    if (cErr) return res.status(500).json({ error: 'Could not check this coupon right now.' });
    if (!coupon || !coupon.active) return res.status(400).json({ error: 'This coupon code is invalid or no longer active.' });
    if (amountRupees < Number(coupon.min_amount)) {
      return res.status(400).json({ error: `This coupon needs a minimum order of \u20b9${Number(coupon.min_amount).toLocaleString('en-IN')}.` });
    }
    const { data: existingRedemption } = await supabase.from('coupon_redemptions').select('id').eq('coupon_code', requestedCoupon).eq('email', email.toLowerCase()).maybeSingle();
    if (existingRedemption) return res.status(400).json({ error: 'You\u2019ve already used this coupon.' });
    const { discountAmount, finalAmount } = computeDiscount(coupon, amountRupees);
    couponCode = requestedCoupon;
    discountAmountRupees = discountAmount;
    amountRupees = finalAmount;
  }

  const amountUsd = toUsd(amountRupees);
  if (_recentOrders.has(bookingId)) return res.json(_recentOrders.get(bookingId));

  try {
    const token = await getAccessToken();
    const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: bookingId, amount: { currency_code: 'USD', value: amountUsd.toFixed(2) } }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const order = await orderRes.json();
    if (!orderRes.ok) throw new Error(order.message || 'PayPal order creation failed');

    const payload = { orderId: order.id, amountUsd, clientId: PAYPAL_CLIENT_ID };
    _recentOrders.set(bookingId, payload);
    setTimeout(() => _recentOrders.delete(bookingId), 30 * 60 * 1000);

    // Same placeholder-row-at-order-time pattern as Razorpay — see the
    // long comment in payments.js for why this closes the "charged but
    // never appeared in the CRM" gap.
    if (supabase && name && email) {
      const serviceLabel = type === 'booking' ? 'Tarot Reading'
        : type === 'spell' ? 'Spell / Magic'
        : type === 'energy_healing' ? 'Energy Healing'
        : type === 'numerology' ? 'Numerology'
        : 'Group Magic';
      supabase.from('bookings').upsert({
        id: bookingId, service: serviceLabel, duration: duration || null,
        name, email, phone: phone || null,
        payment_status: 'Unpaid', status: 'Booking Received',
        payment_provider: 'paypal', currency: 'USD',
        coupon_code: couponCode, discount_amount: couponCode ? discountAmountRupees : null
      }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.warn('[paypal create-order] Could not create placeholder booking row:', error.message);
      });
    }

    res.json(payload);
  } catch (err) {
    console.error('[paypal create-order]', err.message);
    res.status(502).json({ error: 'Could not create payment order. Please try again.' });
  }
});

// ── POST /api/paypal/capture-order ── the actual authority: only PayPal's
// own server-to-server "COMPLETED" response marks a booking Paid — never
// anything the browser reports back after the buyer approves.
router.post('/paypal/capture-order', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ success: false, error: 'International payments are not configured yet.' });

  const { orderId, bookingId, bookingType } = req.body || {};
  if (!orderId || !bookingId) return res.status(400).json({ success: false, error: 'Missing capture fields.' });

  try {
    const token = await getAccessToken();
    const capRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const capture = await capRes.json();
    const status = capture.status
      || capture.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (!capRes.ok || status !== 'COMPLETED') {
      console.warn('[paypal capture-order] Not completed for bookingId=%s, status=%s', bookingId, status);
      return res.status(400).json({ success: false, error: 'Payment was not completed.' });
    }

    const captureId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId;
    const amountPaidUsd = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || null;

    if (supabase) {
      const { data: updated, error } = await supabase.from('bookings').update({
        payment_status: 'Paid', payment_id: captureId, payment_provider: 'paypal',
        currency: 'USD', amount_paid: amountPaidUsd ? Number(amountPaidUsd) : null,
        updated_at: new Date().toISOString()
      }).eq('id', bookingId).select().maybeSingle();

      if (error) {
        console.warn('[paypal capture-order] Could not sync payment status to bookings row:', error.message);
      } else if (updated) {
        if (updated.coupon_code && updated.email) {
          supabase.from('coupon_redemptions').insert({
            coupon_code: updated.coupon_code, email: updated.email.toLowerCase(), booking_id: updated.id
          }).then(({ error: redeemErr }) => {
            if (redeemErr) console.warn('[paypal capture-order] Could not record coupon redemption:', redeemErr.message);
          });
        }
        const priceLabel = amountPaidUsd ? `$${Number(amountPaidUsd).toFixed(2)}` : null;
        if (bookingType === 'spell') {
          sendSpellBookingConfirmation({ ...updated, priceLabel }).catch(() => {});
        } else if (bookingType === 'energy_healing' || bookingType === 'numerology') {
          const sender = bookingType === 'energy_healing' ? sendEnergyHealingConfirmation : sendNumerologyConfirmation;
          sender({ ...updated, priceLabel }).catch(() => {});
        } else {
          sendCustomerBookingConfirmation(updated).catch(() => {});
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[paypal capture-order]', err.message);
    res.status(502).json({ success: false, error: 'Could not confirm payment. Please try again.' });
  }
});

module.exports = router;
