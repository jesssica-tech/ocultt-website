// ── Razorpay webhook ──────────────────────────────────────────────────
// WHY THIS ROUTE EXISTS: routes/payments.js's /payments/verify is only
// ever called by the FRONTEND, and only on the success path (Razorpay's
// checkout.js calls our success handler, which then calls /verify). If a
// customer closes the tab, loses connection, or their payment is
// declined, the frontend never calls anything — the booking is just
// silently left at payment_status:'Unpaid' forever, with no record of
// WHY. That's the actual bug behind "the frontend result can't be
// trusted": it's not that success can be spoofed (HMAC verification
// already prevents that) — it's that FAILURE has no reporting path at
// all without the customer's browser cooperating.
//
// This webhook is Razorpay calling US directly, server-to-server,
// regardless of what the customer's browser does — so a genuinely failed
// or cancelled payment gets recorded every time.
//
// REQUIRES: a webhook configured in the Razorpay Dashboard → Settings →
// Webhooks, pointing at POST https://<your-render-url>/api/razorpay/webhook,
// subscribed to at minimum: payment.failed, payment.captured. Razorpay
// gives you a webhook secret at creation time — set RAZORPAY_WEBHOOK_SECRET.

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../db');
const { sendAdminNewBookingNotification } = require('../utils/notify');

const router = express.Router();

function verifySignature(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // timingSafeEqual requires equal-length buffers — guard first.
  if (expected.length !== (signature || '').length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

router.post('/razorpay/webhook', express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  if (!secret) {
    console.warn('[razorpay webhook] RAZORPAY_WEBHOOK_SECRET not set — rejecting (fail closed, not open, for a payment-related webhook).');
    return res.status(503).json({ ok: false });
  }
  if (!signature || !verifySignature(req.rawBody, signature, secret)) {
    console.warn('[razorpay webhook] Signature verification failed — rejecting.');
    return res.status(401).json({ ok: false });
  }

  // Always ack quickly — Razorpay retries on non-2xx.
  res.json({ ok: true });

  const event = req.body?.event;
  const entity = req.body?.payload?.payment?.entity;
  if (!entity || !supabase) return;

  const bookingId = entity.notes?.bookingId; // set at order-creation time in payments.js
  if (!bookingId) return;

  try {
    if (event === 'payment.failed') {
      const { data: before } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
      if (!before || before.payment_status === 'Paid') return; // never downgrade an already-verified success

      await supabase.from('bookings').update({
        payment_status: 'Failed',
        payment_failure_reason: entity.error_description || entity.error_reason || 'Payment failed',
        updated_at: new Date().toISOString()
      }).eq('id', bookingId);

      console.log('[razorpay webhook] Recorded payment.failed for booking %s', bookingId);
    } else if (event === 'payment.captured') {
      // Belt-and-braces alongside /payments/verify — in case the frontend
      // never called verify (tab closed right after payment, etc.), the
      // webhook still gets the booking marked Paid.
      const { data: before } = await supabase.from('bookings').select('payment_status').eq('id', bookingId).maybeSingle();
      if (before && before.payment_status !== 'Paid') {
        await supabase.from('bookings').update({
          payment_status: 'Paid', payment_id: entity.id, updated_at: new Date().toISOString()
        }).eq('id', bookingId);
        console.log('[razorpay webhook] Recorded payment.captured for booking %s (frontend verify may not have fired)', bookingId);
      }
    }
  } catch (err) {
    console.error('[razorpay webhook] handling failed:', err.message);
  }
});

module.exports = router;
