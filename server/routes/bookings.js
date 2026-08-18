const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { sendAdminNewBookingNotification, sendAdminCancellationNotification, sendAdminRescheduleNotification } = require('../utils/notify');
const { enqueueEmail } = require('../utils/queue');

const router = express.Router();

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many booking attempts. Please try again shortly.' }
});

function isNonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

// ── POST /api/bookings ── public, called by every internal booking form
// (Audio Tarot, Group Magic, Numerology, Energy Healing). Phone Tarot is
// handled by Calendly (see routes/calendlyWebhook.js); Spell requests use
// routes/spells.js instead, since they carry spell-specific fields.
router.post('/bookings', createLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const b = req.body || {};
  if (!isNonEmpty(b.id) || !isNonEmpty(b.name) || !isNonEmpty(b.email) || !isNonEmpty(b.service)) {
    return res.status(400).json({ ok: false, error: 'Missing required booking fields (id, name, email, service).' });
  }

  const row = {
    id: b.id.trim(),
    service: b.service.trim(),
    package: b.package || null,
    duration: b.duration || null,
    preferred_date: b.preferredDate || null,
    preferred_time: b.preferredTime || null,
    format: b.format || null,
    intention: b.intention || null,
    name: b.name.trim(),
    email: b.email.trim(),
    phone: b.phone || null,
    status: 'Booking Received'
    // payment_status / payment_id are deliberately NOT set here — payment
    // status is backend-authoritative only, written exclusively by
    // /payments/verify (signature-checked) or the Razorpay webhook. A
    // browser-supplied paymentStatus/paymentId is never trusted or
    // written: on first insert the column defaults to 'Unpaid' (see
    // schema.sql); on conflict (row already exists, e.g. the Tarot
    // placeholder created at order time) omitting the field here means
    // this upsert leaves whatever value verify/webhook already set
    // untouched, instead of overwriting it with client input.
  };

  const { error } = await supabase.from('bookings').upsert(row, { onConflict: 'id' });
  if (error) {
    console.error('[bookings POST] Supabase error:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save booking.' });
  }

  // Best-effort — never blocks the booking from succeeding.
  sendAdminNewBookingNotification(row).catch(() => {});

  res.json({ ok: true, id: row.id });
});

// ── GET /api/bookings ── admin, list with optional search — every non-spell
// booking. (Spells have their own richer GET /api/spells with the workflow
// fields the Spell Requests tab needs.)
router.get('/bookings', adminAuth, async (req, res) => {
  if (!supabase) return res.json({ bookings: [] });

  const search = (req.query.search || '').trim();
  let query = supabase.from('bookings').select('*').neq('service', 'Spell / Magic').order('created_at', { ascending: false });
  if (search) {
    const safe = search.replace(/[%,]/g, '');
    query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%,id.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ bookings: data });
});

// ── GET /api/bookings/:id ── admin, single booking + its message thread
// (used by the CRM's per-client history / meet-summary panel).
router.get('/bookings/:id', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured yet.' });
  const { data: booking, error: bErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (bErr) return res.status(500).json({ error: bErr.message });
  if (!booking) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase.from('messages').select('*').eq('booking_id', req.params.id).order('created_at', { ascending: true });

  // "Previous history of that particular person" — every other booking by this email.
  const { data: history } = await supabase.from('bookings').select('id,service,status,created_at').eq('email', booking.email).neq('id', req.params.id).order('created_at', { ascending: false });

  res.json({ booking, messages: messages || [], history: history || [] });
});

// ── PATCH /api/bookings/:id ── admin, update status / priority / notes /
// meet fields / appointment time. Sends cancellation/reschedule notices
// to the team when status or the appointment date/time actually change.
router.patch('/bookings/:id', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const allowedFields = ['status', 'priority', 'notes', 'meet_status', 'meet_link', 'calendar_event_id',
    'meet_summary', 'appointment_at', 'preferred_date', 'preferred_time', 'payment_status'];
  const patch = {};
  for (const k of allowedFields) if (k in req.body) patch[k] = req.body[k];
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'No valid fields to update.' });
  patch.updated_at = new Date().toISOString();

  const { data: before } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  const { data: after, error } = await supabase.from('bookings').update(patch).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  if (before && after) {
    if (patch.status && /cancel/i.test(patch.status) && !/cancel/i.test(before.status || '')) {
      sendAdminCancellationNotification(after).catch(() => {});
    } else if ((patch.preferred_date && patch.preferred_date !== before.preferred_date) ||
               (patch.preferred_time && patch.preferred_time !== before.preferred_time)) {
      sendAdminRescheduleNotification(after, before.preferred_date, before.preferred_time).catch(() => {});
    }
  }

  res.json({ ok: true, booking: after });
});

// ── POST /api/bookings/:id/notify-payment-failed ── admin, the "Message
// Customer" action for a Payment Not Received booking. Guarded against
// repeat sends: refuses to re-notify the same booking within 24h unless
// `force: true` is explicitly passed, so a customer can't get spammed by
// Akanksha clicking the button a few times.
router.post('/bookings/:id/notify-payment-failed', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const { data: booking, error: bErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (bErr || !booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  const lastNotified = booking.payment_failure_notified_at ? new Date(booking.payment_failure_notified_at).getTime() : 0;
  const hoursSince = (Date.now() - lastNotified) / (1000 * 60 * 60);
  if (lastNotified && hoursSince < 24 && !req.body?.force) {
    return res.status(429).json({
      ok: false,
      error: `This customer was already messaged about their payment ${Math.round(hoursSince)}h ago. Pass force:true to send again anyway.`
    });
  }

  const paymentLink = (req.body?.paymentLink || '').trim() || null;

  const result = await enqueueEmail({
    templateType: 'payment_failed',
    recipient: booking.email,
    payload: { bookingId: booking.id, name: booking.name, service: booking.service, paymentLink },
    // Bucketed by hour so a genuine resend a day later isn't silently
    // deduped by idempotency, but rapid double-clicks within the same
    // request are.
    idempotencyKey: `payment-failed-${booking.id}-${Math.floor(Date.now() / (60 * 60 * 1000))}`
  });

  if (!result.ok) return res.status(502).json({ ok: false, error: 'Failed to send. Please try again shortly.' });

  await supabase.from('bookings').update({
    payment_failure_notified_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }).eq('id', booking.id);

  res.json({ ok: true });
});

module.exports = router;
