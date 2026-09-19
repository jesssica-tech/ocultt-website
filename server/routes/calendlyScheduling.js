// ── Calendly Scheduling API — Phone Tarot: book AFTER payment, not before ──
//
// Replaces the old flow (real Calendly widget embedded during Step 3, which
// created the actual appointment — and sent Calendly's own invitation — the
// moment the customer picked a time, before they'd paid) with:
//
//   customer picks a time (Step 3) → we show it as "reserved", nothing is
//   booked on Calendly's side yet → Payment (Step 4) → payment verified →
//   ONLY THEN do we call Calendly's API to actually create the appointment.
//
// Two things live here:
//   1. GET /api/calendly/available-times — read-only, used by the frontend's
//      custom date/time picker instead of the real widget. Never creates
//      anything.
//   2. createCalendlyBookingForPaidBooking(bookingId) — called from
//      routes/payments.js (/payments/verify, /bookings/:id/reconcile-payment),
//      routes/razorpayWebhook.js (payment.captured), and
//      routes/paypalWebhook.js (PAYMENT.CAPTURE.COMPLETED) — every place that
//      already marks a booking Paid — right after payment_status flips to
//      'Paid'. This is the ONLY place that ever creates a real Calendly
//      appointment for a Phone Tarot booking made through the new flow.
//
// The existing routes/calendlyWebhook.js is untouched — once this creates
// the real Calendly appointment, Calendly fires its normal invitee.created
// webhook exactly as before, which that file already handles correctly
// (syncing the Meet link, sending the confirmation email once
// payment_status is already 'Paid' — which it now always is by the time
// this runs).
//
// The Calendly token never reaches the frontend — every Calendly API call
// happens here, server-side only.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabase } = require('../db');
const { adminRecipients } = require('../utils/notify');
const { enqueueEmail } = require('../utils/queue');

const router = express.Router();
const CALENDLY_API = 'https://api.calendly.com';

// Same six scheduling-page URLs already used by the old widget flow (see
// PHONE_TAROT_CALENDLY_LINKS in js/script.js) — kept identical and
// duplicated here (not shared across frontend/backend) so this file has no
// new build step or shared-config dependency; if a duration's URL ever
// changes, update both places, same as the price tables already are.
const PHONE_TAROT_CALENDLY_LINKS = {
  '10': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-10-minutes',
  '15': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-15-minutes',
  '20': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-20-minutes',
  '30': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-30-minutes',
  '45': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-45-minutes',
  '60': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-60-minutes'
};

function calendlyHeaders() {
  const token = process.env.CALENDLY_API_TOKEN;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Resolves a scheduling_url (the public calendly.com/... link) to its
// event_type URI (https://api.calendly.com/event_types/<uuid>), which is
// what the Scheduling API actually needs. Cached in memory for 30 minutes —
// this rarely changes and avoids hitting Calendly's API on every request.
let _eventTypeUriCache = null; // Map<scheduling_url, uri>
let _eventTypeUriCacheAt = 0;
const EVENT_TYPE_CACHE_MS = 30 * 60 * 1000;

async function resolveEventTypeUri(schedulingUrl) {
  const headers = calendlyHeaders();
  if (!headers) throw new Error('CALENDLY_API_TOKEN not configured.');

  if (_eventTypeUriCache && (Date.now() - _eventTypeUriCacheAt) < EVENT_TYPE_CACHE_MS) {
    const cached = _eventTypeUriCache.get(schedulingUrl);
    if (cached) return cached;
  }

  const meResp = await fetch(`${CALENDLY_API}/users/me`, { headers });
  const me = await meResp.json();
  if (!meResp.ok) throw new Error('Could not identify Calendly account: ' + (me.message || meResp.status));
  const userUri = me.resource.uri;

  const map = new Map();
  let nextPage = `${CALENDLY_API}/event_types?user=${encodeURIComponent(userUri)}&count=100`;
  while (nextPage) {
    const resp = await fetch(nextPage, { headers });
    const data = await resp.json();
    if (!resp.ok) throw new Error('Could not list Calendly event types: ' + (data.message || resp.status));
    for (const et of (data.collection || [])) {
      if (et.scheduling_url) map.set(et.scheduling_url, et.uri);
    }
    nextPage = data.pagination && data.pagination.next_page ? data.pagination.next_page : null;
  }
  _eventTypeUriCache = map;
  _eventTypeUriCacheAt = Date.now();

  const uri = map.get(schedulingUrl);
  if (!uri) throw new Error('No Calendly event type found matching ' + schedulingUrl);
  return uri;
}

// Real Calendly availability for one event type, next 7 days from now
// (Calendly's available-times range is capped at 7 days per call).
async function fetchAvailableSlots(eventTypeUri) {
  const headers = calendlyHeaders();
  if (!headers) throw new Error('CALENDLY_API_TOKEN not configured.');
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const url = `${CALENDLY_API}/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${encodeURIComponent(start.toISOString())}&end_time=${encodeURIComponent(end.toISOString())}`;
  const resp = await fetch(url, { headers });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Could not fetch Calendly availability: ' + (data.message || resp.status));
  return (data.collection || [])
    .filter(s => s.status === 'available')
    .map(s => s.start_time);
}

const availabilityLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// GET /api/calendly/available-times?duration=10|15|20|30|45|60
// Read-only. Never creates a Calendly booking.
router.get('/calendly/available-times', availabilityLimiter, async (req, res) => {
  const duration = String(req.query.duration || '');
  const schedulingUrl = PHONE_TAROT_CALENDLY_LINKS[duration];
  if (!schedulingUrl) return res.status(400).json({ ok: false, error: 'Unknown call duration.' });
  if (!process.env.CALENDLY_API_TOKEN) return res.status(503).json({ ok: false, error: 'Scheduling is not configured yet.' });

  try {
    const eventTypeUri = await resolveEventTypeUri(schedulingUrl);
    const slots = await fetchAvailableSlots(eventTypeUri);
    res.json({ ok: true, eventTypeUri, slots });
  } catch (err) {
    console.error('[calendly available-times]', err.message);
    res.status(502).json({ ok: false, error: 'Could not load available times right now. Please try again in a moment.' });
  }
});

// ── The actual post-payment booking creation ─────────────────────────
// Called fire-and-forget (never awaited by the payment response itself —
// a Calendly hiccup must never make a real, captured payment look like it
// failed) from every place that marks a booking Paid. Idempotent: safe to
// call more than once for the same booking (verify + webhook + a reconcile
// could all fire for the same payment).
async function createCalendlyBookingForPaidBooking(bookingId) {
  if (!supabase) return;
  const headers = calendlyHeaders();
  if (!headers) { console.error('[calendly booking] CALENDLY_API_TOKEN not configured — cannot book', bookingId); return; }

  // Re-fetch fresh (never trust a stale row passed in) and claim it before
  // calling Calendly, so a near-simultaneous second call (verify AND the
  // webhook landing seconds apart) backs off instead of double-booking.
  const { data: booking, error: fetchErr } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
  if (fetchErr || !booking) { console.error('[calendly booking] Could not load booking', bookingId, fetchErr && fetchErr.message); return; }
  if (!booking.calendly_event_type_uri || !booking.calendly_selected_start) return; // not a new-flow Phone Tarot booking — nothing to do
  if (booking.calendly_invitee_uri) return; // already booked — idempotent no-op
  if (booking.calendly_booking_status === 'creating') return; // another call is already in flight

  const { data: claimed } = await supabase.from('bookings')
    .update({ calendly_booking_status: 'creating' })
    .eq('id', bookingId)
    .is('calendly_invitee_uri', null)
    .neq('calendly_booking_status', 'creating')
    .select().maybeSingle();
  if (!claimed) return; // someone else claimed it first (or it's already booked) — back off

  try {
    // Revalidate immediately before booking — the slot the customer picked
    // minutes/hours ago (at Step 3) may have been taken by someone else in
    // the meantime. Never silently pick a different time.
    const slots = await fetchAvailableSlots(booking.calendly_event_type_uri);
    const stillAvailable = slots.some(s => s === booking.calendly_selected_start);

    if (!stillAvailable) {
      await supabase.from('bookings').update({ calendly_booking_status: 'slot_unavailable' }).eq('id', bookingId);
      console.error('[calendly booking] Slot no longer available for PAID booking %s — needs manual follow-up', bookingId);
      await notifySlotProblem(booking, 'slot_unavailable');
      return;
    }

    const body = {
      event_type: booking.calendly_event_type_uri,
      start_time: booking.calendly_selected_start,
      invitee: { name: booking.name || 'Valued Client', email: booking.email, timezone: 'Asia/Kolkata' }
    };
    const resp = await fetch(`${CALENDLY_API}/invitees`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await resp.json();

    if (!resp.ok || !data.resource) {
      await supabase.from('bookings').update({ calendly_booking_status: 'failed' }).eq('id', bookingId);
      console.error('[calendly booking] Calendly rejected booking creation for %s:', bookingId, resp.status, data.message || data);
      await notifySlotProblem(booking, 'failed');
      return;
    }

    await supabase.from('bookings').update({
      calendly_invitee_uri: data.resource.uri,
      calendly_booking_status: 'booked'
    }).eq('id', bookingId);
    console.log('[calendly booking] Created real Calendly appointment for booking %s', bookingId);
    // Nothing further to do here — Calendly's own invitee.created webhook
    // will fire momentarily and routes/calendlyWebhook.js (unchanged) picks
    // it up from there: Meet link sync + the confirmation email, exactly as
    // it already does today.
  } catch (err) {
    await supabase.from('bookings').update({ calendly_booking_status: 'failed' }).eq('id', bookingId).catch(() => {});
    console.error('[calendly booking] Unexpected error booking %s:', bookingId, err.message);
    await notifySlotProblem(booking, 'failed');
  }
}

// Payment succeeded but the real Calendly booking could not be created
// (slot taken in the meantime, or a Calendly API failure). The payment is
// real and stays Paid — this only ever tells the admin team + customer,
// never touches payment_status, and never auto-refunds or auto-rebooks a
// different time.
async function notifySlotProblem(booking, reason) {
  try {
    // Deliberately NOT reusing sendAdminNewBookingNotification here — it
    // hardcodes an idempotencyKey of `admin-new-booking-${bookingId}-...`,
    // the exact same key already used (and likely already sent) for this
    // booking's normal "new booking" admin email — reusing it would get
    // this urgent alert silently deduped away by the email queue. This
    // needs its own distinct key.
    const recipients = adminRecipients();
    await Promise.all(recipients.map(recipient => enqueueEmail({
      templateType: 'admin_new_booking',
      recipient,
      payload: {
        bookingId: booking.id,
        service: booking.service + ' \u2014 \u26a0 CALENDLY BOOKING FAILED (' + reason + ', payment already captured \u2014 contact customer to reschedule or refund)',
        name: booking.name, email: booking.email, phone: booking.phone,
        paymentStatus: booking.payment_status
      },
      idempotencyKey: `calendly-booking-problem-${booking.id}-${reason}-${recipient}`
    })));
  } catch (e) { console.error('[calendly booking] admin alert failed:', e.message); }
  // Deliberately no automated customer-facing email here — the only
  // generic template available (booking_confirmation) is hardcoded to
  // headline "Your Booking is Confirmed", which would be actively
  // misleading to send during an actual problem. The admin alert above
  // is the recovery path: a human reaches out to reschedule/refund,
  // which also reads better to the customer than a mismatched automated
  // email would. Payment status itself is untouched either way — it
  // stays Paid, nothing here ever risks that record.
}

module.exports = router;
module.exports.createCalendlyBookingForPaidBooking = createCalendlyBookingForPaidBooking;
