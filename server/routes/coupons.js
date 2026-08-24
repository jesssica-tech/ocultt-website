// ── Coupons ──────────────────────────────────────────────────────────
// Rules (as specified): a coupon can be percentage-off or a fixed rupee
// amount off; each customer (by email) may use a given code only once,
// enforced by a real unique DB constraint (coupon_redemptions), not just
// an application-level check; every code has a minimum order amount
// (default ₹1,000) below which it can't be applied.
//
// Two-phase like everything else here: /coupons/validate (public, called
// at checkout) only PREVIEWS the discount — it does not mark the coupon
// as used. The actual redemption is recorded in routes/payments.js's
// /payments/verify, after a real payment has actually succeeded — the
// same "don't consume anything until payment is confirmed" principle
// already used for booking creation everywhere else in this codebase.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const validateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

function normalizeCode(code) {
  return (code || '').trim().toUpperCase();
}

// Shared by /coupons/validate (preview) and routes/payments.js (real
// charge) — the exact same computation must run in both places so what
// the customer previews always matches what they're actually charged.
// amountRupees is the ORIGINAL (pre-discount, already urgency-adjusted if
// applicable) price. Returns { discountAmount, finalAmount } in rupees.
function computeDiscount(coupon, amountRupees) {
  let discountAmount;
  if (coupon.discount_type === 'percent') {
    discountAmount = Math.round(amountRupees * (Number(coupon.discount_value) / 100));
  } else {
    discountAmount = Math.round(Number(coupon.discount_value));
  }
  // Never let a discount exceed the order itself (no negative totals),
  // and never let it reduce the order to ₹0 — Razorpay requires a
  // positive amount.
  discountAmount = Math.max(0, Math.min(discountAmount, amountRupees - 1));
  return { discountAmount, finalAmount: amountRupees - discountAmount };
}

// ── POST /api/coupons/validate ── public, called at checkout to preview
// a discount before payment. Does NOT redeem the coupon.
router.post('/coupons/validate', validateLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ valid: false, error: 'Not available right now.' });
  const code = normalizeCode(req.body.code);
  const email = (req.body.email || '').trim().toLowerCase();
  const amountRupees = Number(req.body.amount);
  if (!code) return res.status(400).json({ valid: false, error: 'Please enter a coupon code.' });
  if (!email || !amountRupees) return res.status(400).json({ valid: false, error: 'Missing details to check this code.' });

  try {
    const { data: coupon, error } = await supabase.from('coupons').select('*').eq('code', code).maybeSingle();
    if (error) return res.status(500).json({ valid: false, error: 'Could not check this code right now.' });
    if (!coupon) return res.status(404).json({ valid: false, error: 'This coupon code doesn\u2019t exist.' });
    if (!coupon.active) return res.status(400).json({ valid: false, error: 'This coupon is no longer active.' });
    if (amountRupees < Number(coupon.min_amount)) {
      return res.status(400).json({ valid: false, error: `This coupon needs a minimum order of \u20b9${Number(coupon.min_amount).toLocaleString('en-IN')}.` });
    }
    const { data: existing } = await supabase.from('coupon_redemptions').select('id').eq('coupon_code', code).eq('email', email).maybeSingle();
    if (existing) return res.status(400).json({ valid: false, error: 'You\u2019ve already used this coupon.' });

    const { discountAmount, finalAmount } = computeDiscount(coupon, amountRupees);
    res.json({ valid: true, discountAmount, finalAmount, discountType: coupon.discount_type, discountValue: Number(coupon.discount_value) });
  } catch (err) {
    console.error('[coupons validate]', err.message);
    res.status(500).json({ valid: false, error: 'Could not check this code right now.' });
  }
});

// ── GET /api/coupons ── admin, list all coupons for the CRM screen.
router.get('/coupons', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured yet.' });
  const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ coupons: data || [] });
});

// ── POST /api/coupons ── admin, create a new coupon.
router.post('/coupons', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured yet.' });
  const code = normalizeCode(req.body.code);
  const discountType = req.body.discountType === 'fixed' ? 'fixed' : 'percent';
  const discountValue = Number(req.body.discountValue);
  const minAmount = req.body.minAmount != null ? Number(req.body.minAmount) : 1000;

  if (!code) return res.status(400).json({ error: 'Please enter a coupon code.' });
  if (!discountValue || discountValue <= 0) return res.status(400).json({ error: 'Please enter a valid discount value.' });
  if (discountType === 'percent' && discountValue > 100) return res.status(400).json({ error: 'A percentage discount can\u2019t exceed 100.' });

  const { data, error } = await supabase.from('coupons').insert({
    code, discount_type: discountType, discount_value: discountValue, min_amount: minAmount, active: true
  }).select().maybeSingle();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A coupon with this code already exists.' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ coupon: data });
});

// ── PATCH /api/coupons/:code ── admin, toggle active/inactive.
router.patch('/coupons/:code', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured yet.' });
  const code = normalizeCode(req.params.code);
  const { data, error } = await supabase.from('coupons').update({ active: !!req.body.active }).eq('code', code).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Coupon not found.' });
  res.json({ coupon: data });
});

module.exports = { router, computeDiscount, normalizeCode };
