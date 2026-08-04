// ── The Ocultt Tarot — backend API ─────────────────────────────────
// Currently handles: real Gmail sending for booking confirmations.
// This is also where future integrations (Gmail replies, Google Calendar
// event creation, Google Meet link generation) should be added as new
// routes — the frontend already calls everything through OCULTT_API,
// so adding a new endpoint here is a one-line addition on the frontend
// (see OCULTT_API usages in js/script.js).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const sendEmailRoute = require('./routes/sendEmail');
const bookingsRoute = require('./routes/bookings');
const spellsRoute = require('./routes/spells');
const availabilityRoute = require('./routes/availability');
const paymentsRoute = require('./routes/payments');
const messagesRoute = require('./routes/messages');
const remindersRoute = require('./routes/reminders');
const calendlyWebhookRoute = require('./routes/calendlyWebhook');
const calendlySetupRoute = require('./routes/calendlySetup');
const { supabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1); // needed for correct req.ip behind Railway/Render/etc. reverse proxies
app.use(helmet());

// ── CORS ── only allow the frontend origins listed in .env.
// Fails CLOSED if ALLOWED_ORIGINS isn't set — a misconfigured deploy
// should refuse cross-origin requests, never silently accept everyone.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn('[CORS] ALLOWED_ORIGINS is not set — all cross-origin browser requests will be blocked until it is configured in .env.');
}

app.use(cors({
  origin: function (origin, callback) {
    // Requests with no Origin header (curl, Postman, server-to-server) are
    // allowed through — CORS is a browser-enforced protection and doesn't
    // apply to non-browser clients anyway.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn('[CORS] Blocked request from origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  }
}));

// ── Calendly webhook — mounted BEFORE the global JSON parser below,
// because its own route needs the raw request body (for HMAC signature
// verification) which express.json() would otherwise already consume. ──
app.use('/api', calendlyWebhookRoute);

app.use(express.json({ limit: '400kb' }));

// ── Global rate limit — a light baseline across the whole API; the
// send-email route also has its own tighter, purpose-specific limit. ──
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// ── Health check — useful for confirming the server is up (e.g. Railway/Render) ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'ocultt-tarot-email-server', time: new Date().toISOString() });
});

// ── Routes ──
app.use('/api', sendEmailRoute);
app.use('/api', bookingsRoute);
app.use('/api', spellsRoute);
app.use('/api', availabilityRoute);
app.use('/api', paymentsRoute);
app.use('/api', messagesRoute);
app.use('/api', remindersRoute);
app.use('/api', calendlySetupRoute);

// ── 404 + error handling ──
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, req, res, next) => {
  // Never forward err.message to the client — CORS rejection messages,
  // JSON parse errors, etc. can hint at internal configuration.
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] Ocultt Tarot email server listening on http://localhost:${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/api/health`);

  // ── Startup diagnostics — surfaces the most common causes of "emails
  // aren't sending" immediately in the deploy logs, instead of only on
  // the first booking attempt. ──
  const gmailUser = process.env.GMAIL_USER || process.env.EMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASS;
  if (!gmailUser || !gmailPass) {
    console.warn('[startup] ⚠ Gmail credentials NOT found — checked GMAIL_USER/GMAIL_APP_PASSWORD and EMAIL_USER/EMAIL_PASS. Emails will fail until one pair is set.');
  } else {
    console.log('[startup] ✓ Gmail credentials found for %s (via %s)', gmailUser, process.env.GMAIL_USER ? 'GMAIL_USER/GMAIL_APP_PASSWORD' : 'EMAIL_USER/EMAIL_PASS');
  }
  if (allowedOrigins.length === 0) {
    console.warn('[startup] ⚠ ALLOWED_ORIGINS is empty — every browser request will be blocked by CORS until this is set.');
  } else {
    console.log('[startup] ✓ ALLOWED_ORIGINS:', allowedOrigins.join(', '));
    if (!allowedOrigins.some(o => o.includes('theocultttarot.com'))) {
      console.warn('[startup] ⚠ theocultttarot.com is not in ALLOWED_ORIGINS — requests from the live site will be blocked by CORS.');
    }
  }

  console.log(supabase ? '[startup] ✓ Supabase connected' : '[startup] ⚠ Supabase NOT configured — every DB-backed route (bookings, spells, CRM, availability) returns 503. See server/schema.sql + .env.example.');
  console.log((process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) ? '[startup] ✓ Razorpay configured' : '[startup] ⚠ Razorpay NOT configured — checkout will 503.');
  console.log((process.env.CLOUDINARY_CLOUD_NAME) ? '[startup] ✓ Cloudinary configured' : '[startup] ⚠ Cloudinary NOT configured — spell video upload / CRM attachments will 503.');
  console.log(process.env.CALENDLY_WEBHOOK_SIGNING_KEY ? '[startup] ✓ Calendly webhook signing key set' : '[startup] ⚠ CALENDLY_WEBHOOK_SIGNING_KEY not set — /api/calendly/webhook accepts unverified requests until you subscribe the webhook.');
  console.log(process.env.REMINDER_CRON_KEY ? '[startup] ✓ Reminder cron key set — /api/reminders/run is ready for your external cron ping.' : '[startup] ⚠ REMINDER_CRON_KEY not set — reminders will not run.');
  console.log((process.env.CALENDLY_API_TOKEN && process.env.CALENDLY_SETUP_KEY) ? '[startup] ✓ Calendly registration endpoint ready — GET /api/calendly/register-webhook?key=...&callbackUrl=... to run it once.' : '[startup] ⚠ CALENDLY_API_TOKEN / CALENDLY_SETUP_KEY not both set — /api/calendly/register-webhook will 503 until configured.');
});
