const express = require('express');
const rateLimit = require('express-rate-limit');
const { validateEmailPayload } = require('../utils/validate');
const { enqueueEmail } = require('../utils/queue');

const router = express.Router();

// ── Rate limiting ────────────────────────────────────────────────────
// A single booking should only ever trigger one email. 10/hour per IP
// comfortably covers a genuine customer retrying a failed booking a few
// times while still being a real spam/abuse guard for this endpoint.
const sendEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many email requests. Please try again later.' },
  handler: (req, res, next, options) => {
    console.warn('[send-email] Rate limit hit for IP:', req.ip);
    res.status(options.statusCode).json(options.message);
  }
});

// POST /api/send-email
// Body: the exact payload object built by sendBookingConfirmation() in
// js/script.js — { id, bookingId, to, toName, subject, service, package,
// duration, date, time, body, status, queuedAt, sentAt }
//
// Now goes through the real email queue (utils/queue.js) instead of
// sending inline: still attempts immediate delivery (same instant-email
// UX as before), but the attempt is now durable — a transient Resend/
// network failure gets retried automatically instead of the email just
// disappearing, and resubmitting the same booking id can't double-send.
router.post('/send-email', sendEmailLimiter, async (req, res) => {
  console.log('[send-email] Incoming request for bookingId=%s, to=%s', req.body?.bookingId || '—', req.body?.to || '—');

  const validation = validateEmailPayload(req.body);
  if (!validation.ok) {
    console.error('[send-email] Payload validation FAILED:', validation.error);
    return res.status(400).json({ ok: false, error: validation.error });
  }
  const payload = validation.payload;

  const result = await enqueueEmail({
    templateType: 'booking_confirmation',
    recipient: payload.to,
    payload,
    idempotencyKey: payload.bookingId ? `booking-confirm-${payload.bookingId}` : undefined
  });

  if (!result.ok) {
    console.error('[send-email] Could not queue/send for bookingId=%s:', payload.bookingId || '—', result.error);
    return res.status(502).json({ ok: false, error: 'Failed to send email. Please try again shortly.' });
  }

  // We report success once the email is durably queued — even if the
  // immediate attempt hasn't succeeded yet, it WILL be retried rather than
  // lost, so the booking flow shouldn't be blocked/failed on it.
  return res.json({ ok: true, queued: result.queued, sentImmediately: !!result.sent });
});

module.exports = router;
