const express = require('express');
const rateLimit = require('express-rate-limit');
const { getTransporter, verifyTransporter, redactSecrets } = require('../utils/mailer');
const { buildConfirmationEmailHtml } = require('../utils/emailTemplate');
const { validateEmailPayload } = require('../utils/validate');

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
router.post('/send-email', sendEmailLimiter, async (req, res) => {
  console.log('[send-email] Incoming request for bookingId=%s, to=%s', req.body?.bookingId || '—', req.body?.to || '—');

  const validation = validateEmailPayload(req.body);
  if (!validation.ok) {
    console.error('[send-email] Payload validation FAILED:', validation.error);
    return res.status(400).json({ ok: false, error: validation.error });
  }
  const payload = validation.payload;

  // ── Stage 1: SMTP connection + authentication ──
  let transporter;
  try {
    transporter = await verifyTransporter();
  } catch (err) {
    console.error('[send-email] Aborting — SMTP connection/authentication failed for bookingId=%s:', payload.bookingId || '—', redactSecrets(err.message));
    return res.status(502).json({ ok: false, error: 'Email server connection failed. Please try again shortly.' });
  }

  // ── Stage 2: actually send ──
  try {
    const fromName = process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot';
    const fromUser = process.env.GMAIL_USER || process.env.EMAIL_USER;

    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromUser}>`,
      to: payload.to,
      subject: payload.subject || 'Your Ocultt Booking is Confirmed',
      text: payload.body || '',                       // plain-text fallback, already built on the frontend
      html: buildConfirmationEmailHtml(payload)
    });

    console.log('[send-email] SUCCESS — sent to %s — messageId=%s (bookingId=%s)', payload.to, info.messageId, payload.bookingId || '—');
    return res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    // Full detail stays server-side only. The client only ever gets a
    // generic message — SMTP responses can contain server banners,
    // internal hostnames, or (in misconfigured setups) auth hints, none
    // of which should ever reach the browser.
    console.error('[send-email] SEND FAILED for bookingId=%s:', payload.bookingId || '—', redactSecrets(err.message));
    return res.status(502).json({ ok: false, error: 'Failed to send email. Please try again shortly.' });
  }
});

module.exports = router;
