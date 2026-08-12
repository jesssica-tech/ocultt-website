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
        .select('id').eq('service', 'Tarot Reading').eq('format', 'Google Meet')
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

      if (meetLink) {
        await enqueueEmail({
          templateType: 'meet_link', recipient: email,
          payload: { bookingId: match.id, startTime, meetLink, name },
          idempotencyKey: `meet-link-customer-${match.id}`
        });
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
