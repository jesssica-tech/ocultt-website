// ── Calendly webhook → CRM sync ────────────────────────────────────
// Phone Tarot Reading stays on Calendly exactly as implemented — this
// route does NOT create Calendar/Meet events itself. Calendly does that
// (once Akanksha connects her Google Calendar + enables the "Google Meet"
// location on each of the 6 Phone Tarot event types in her Calendly
// settings). This route just listens for Calendly telling us a booking
// happened, so the real Meet link makes it into the CRM and the
// customer's inbox automatically instead of Akanksha copying it over by
// hand.
//
// REQUIRES a Calendly plan with API/webhook access (Standard or above) —
// see server/.env.example for the 5-minute subscription setup.

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../db');
const { enqueueEmail } = require('../utils/queue');
const { sendAdminCancellationNotification } = require('../utils/notify');

const router = express.Router();

function verifySignature(req) {
  const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) return true; // not configured yet — accept (logged below)
  const sigHeader = req.headers['calendly-webhook-signature'];
  if (!sigHeader) return false;
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const signedPayload = `${parts.t}.${req.rawBody}`;
    const expected = crypto.createHmac('sha256', signingKey).update(signedPayload).digest('hex');
    return expected === parts.v1;
  } catch {
    return false;
  }
}

router.post('/calendly/webhook', express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}), async (req, res) => {
  if (!process.env.CALENDLY_WEBHOOK_SIGNING_KEY) {
    console.warn('[calendly webhook] CALENDLY_WEBHOOK_SIGNING_KEY not set — accepting unverified. Set it once you subscribe the webhook.');
  } else if (!verifySignature(req)) {
    console.warn('[calendly webhook] Signature verification failed — rejecting.');
    return res.status(401).json({ ok: false });
  }

  // Always 200 quickly — Calendly retries on non-2xx, and we never want a
  // downstream hiccup (email, DB) to look like "the webhook is broken".
  res.json({ ok: true });

  const event = req.body?.event;
  const payload = req.body?.payload;
  if (!event || !payload || !supabase) return;

  try {
    if (event === 'invitee.created') {
      const email = payload.email;
      const name = payload.name;
      const startTime = payload?.scheduled_event?.start_time || null;
      const location = payload?.scheduled_event?.location;
      const meetLink = (location && location.type === 'google_conference') ? (location.join_url || location.status) : null;
      const calendarEventId = payload?.scheduled_event?.uri || null;
      if (!email) return;

      const { data: match } = await supabase.from('bookings')
        .select('id, payment_status').eq('service', 'Tarot Reading').eq('format', 'Google Meet')
        .ilike('email', email).neq('meet_status', 'Created')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!match) {
        console.warn('[calendly webhook] No matching Phone Tarot booking found for', email);
        return;
      }

      await supabase.from('bookings').update({
        meet_status: meetLink ? 'Created' : 'Not Created',
        meet_link: meetLink || null,
        calendar_event_id: calendarEventId,
        appointment_at: startTime,
        updated_at: new Date().toISOString()
      }).eq('id', match.id);

      // By design, a Phone Tarot customer schedules their Calendly slot
      // BEFORE paying (the slot is reserved first so it can't double-book,
      // payment is collected after — see resumePhoneTarotAfterCalendly()
      // in js/script.js, which is unchanged here). That means this webhook
      // fires while the booking is still Unpaid in the ordinary case.
      // Google itself emails the customer a native calendar invite the
      // moment Calendly creates the event with them as an attendee — that
      // happens on Calendly/Google's side and isn't something this server
      // can suppress. What IS ours to control is this second, separate
      // confirmation email with the actual Meet link: only send it once
      // the booking is genuinely Paid, so it never reads as "you're
      // confirmed" before payment has gone through. If payment hasn't
      // happened yet, the meet_link is still saved on the row above — the
      // payment-confirmation step (payments.js /verify, the Razorpay
      // webhook, and the admin reconcile-payment endpoint) picks it up and
      // sends this same email at that point instead, using the identical
      // idempotencyKey below, so it's still sent exactly once either way.
      if (meetLink && match.payment_status === 'Paid') {
        await enqueueEmail({
          templateType: 'meet_link', recipient: email,
          payload: { bookingId: match.id, startTime, meetLink, name },
          idempotencyKey: `meet-link-customer-${match.id}`
        });
      }
      if (meetLink) {
        const adminTo = (process.env.ADMIN_NOTIFY_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
        if (adminTo) {
          await enqueueEmail({
            templateType: 'meet_link', recipient: adminTo,
            payload: { bookingId: match.id, startTime, meetLink, name: `${name || email} (Meet link synced from Calendly)` },
            idempotencyKey: `meet-link-admin-${match.id}`
          });
        }
      }
    } else if (event === 'invitee.canceled') {
      const email = payload.email;
      if (!email) return;
      const { data: match } = await supabase.from('bookings')
        .select('*').eq('service', 'Tarot Reading').eq('format', 'Google Meet')
        .ilike('email', email).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!match) return;
      await supabase.from('bookings').update({ status: 'Cancelled', updated_at: new Date().toISOString() }).eq('id', match.id);
      sendAdminCancellationNotification(match).catch(() => {});
    }
  } catch (err) {
    console.error('[calendly webhook] handling failed:', err.message);
  }
});

module.exports = router;
