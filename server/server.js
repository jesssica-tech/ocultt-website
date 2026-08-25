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
const razorpayWebhookRoute = require('./routes/razorpayWebhook');
const deliveryRoute = require('./routes/delivery');
const usersRoute = require('./routes/users');
const mediaRoute = require('./routes/media');
const couponsRoute = require('./routes/coupons');
const attachmentsRoute = require('./routes/attachments');
const { supabase } = require('./db');
// gmailAuthSetup.js is no longer mounted — email now sends via Resend
// (see utils/mailer.js) instead of Gmail OAuth. The file itself is left
// in place, untouched, rather than deleted, in case it's ever needed
// again; it's simply not wired into the app anymore.

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1); // needed for correct req.ip behind Railway/Render/etc. reverse proxies
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────
// Allowed origins come from ALLOWED_ORIGINS in .env (comma-separated).
// Fails CLOSED if it isn't set — a misconfigured deploy should refuse
// cross-origin requests, never silently accept everyone.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn('[CORS] ALLOWED_ORIGINS is not set — all cross-origin browser requests will be blocked until it is configured in .env.');
}

// "null" origin ── when a page is opened straight from disk (file://
// index.html, no local server) instead of via http://, browsers send the
// literal header Origin: null. This is what produced the
// "CORS Blocked request from origin: null" log line. Allowing it makes
// local double-click-to-open testing work, but it is NOT something to
// leave on in production: any local HTML file on anyone's machine, or a
// sandboxed iframe/PDF, also sends "null" and would be let in too — it's
// a real, well-known way to widen an API's attack surface, not a normal
// browser origin like theocultttarot.com. It's therefore gated behind
// its own explicit opt-in (ALLOW_NULL_ORIGIN=true) rather than being
// silently enabled by NODE_ENV, so it can never turn on by accident.
const allowNullOrigin = process.env.ALLOW_NULL_ORIGIN === 'true';
if (allowNullOrigin) {
  console.warn('[CORS] ⚠ ALLOW_NULL_ORIGIN=true — requests with Origin: null (e.g. local file:// testing) are being accepted. Turn this OFF on the production Render env once local testing is done.');
}

const corsOptions = {
  origin: function (origin, callback) {
    // No Origin header at all (curl, Postman, server-to-server calls,
    // the Calendly webhook) — CORS is a browser-enforced protection and
    // doesn't apply to non-browser clients anyway.
    if (!origin) return callback(null, true);

    if (origin === 'null') {
      if (allowNullOrigin) return callback(null, true);
      console.warn('[CORS] Blocked request from origin: null (set ALLOW_NULL_ORIGIN=true in your env to allow this for local file:// testing only)');
      return callback(new Error('Not allowed by CORS'));
    }

    if (allowedOrigins.includes(origin)) return callback(null, true);

    console.warn('[CORS] Blocked request from origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  // Content-Type/Authorization cover the standard cases; x-admin-key is
  // the header the existing CRM/admin routes actually send today
  // (see adminHeaders() in js/script.js) — omitting it would silently
  // break every admin/CRM API call under strict header checking, which
  // is exactly the kind of breakage this task said not to cause.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
// Explicit preflight handling for every route, so OPTIONS requests never
// fall through to the 404/rate-limit/body-parser logic below.
app.options('*', cors(corsOptions));

// ── Webhooks — mounted BEFORE the global JSON parser below, because each
// applies its own express.json({verify}) to capture the raw request body
// for HMAC signature verification, which the global parser would
// otherwise already have consumed. ──
app.use('/api', calendlyWebhookRoute);
app.use('/api', razorpayWebhookRoute);

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

// ── Supabase keep-alive — Supabase's free tier pauses a project after 7
// days with zero API activity (the whole project goes offline until
// someone manually restores it in the dashboard — everything breaks at
// once, not gracefully). This is a real risk for a low/irregular-traffic
// launch period. This endpoint exists purely to be pinged periodically
// (e.g. by a free external monitor like UptimeRobot or cron-job.org,
// every 2–3 days for a safe margin) — it makes one trivial real query
// against Supabase, which counts as activity and resets that 7-day
// clock. /api/health above does NOT do this — it never touches Supabase
// at all, so pinging it alone would not prevent the pause.
app.get('/api/keepalive', async (req, res) => {
  if (!supabase) return res.json({ ok: true, supabase: false, note: 'Supabase not configured — nothing to keep alive.' });
  try {
    const { error } = await supabase.from('crm_users').select('email').limit(1);
    if (error) throw error;
    res.json({ ok: true, supabase: true, time: new Date().toISOString() });
  } catch (err) {
    console.warn('[keepalive] Supabase ping failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
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
app.use('/api', deliveryRoute);
app.use('/api', usersRoute);
app.use('/api', mediaRoute);
app.use('/api', couponsRoute.router);
app.use('/api', attachmentsRoute);

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
  // (Gmail's own status is logged further below, alongside the other
  // integrations — see the Gmail API line.)
  if (allowedOrigins.length === 0) {
    console.warn('[startup] ⚠ ALLOWED_ORIGINS is empty — every browser request will be blocked by CORS until this is set.');
  } else {
    console.log('[startup] ✓ ALLOWED_ORIGINS:', allowedOrigins.join(', '));
    if (!allowedOrigins.some(o => o.includes('theocultttarot.com'))) {
      console.warn('[startup] ⚠ theocultttarot.com is not in ALLOWED_ORIGINS — requests from the live site will be blocked by CORS.');
    }
  }
  console.log(allowNullOrigin ? '[startup] ⚠ ALLOW_NULL_ORIGIN=true (null-origin/file:// requests accepted — dev only)' : '[startup] ✓ ALLOW_NULL_ORIGIN not set — null-origin requests are blocked (production-safe default)');

console.log((process.env.RESEND_API_KEY)
  ? '[startup] ✓ Resend configured — email sending is live.'
  : '[startup] ⚠ Resend NOT configured — RESEND_API_KEY needed (and RESEND_FROM_EMAIL once your domain is verified). See server/.env.example.');
  console.log(supabase ? '[startup] ✓ Supabase connected' : '[startup] ⚠ Supabase NOT configured — every DB-backed route (bookings, spells, CRM, availability, email queue, delivery) returns 503. See server/schema.sql + .env.example.');
  console.log((process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) ? '[startup] ✓ Razorpay configured' : '[startup] ⚠ Razorpay NOT configured — checkout will 503.');
  console.log(process.env.RAZORPAY_WEBHOOK_SECRET ? '[startup] ✓ Razorpay webhook secret set — /api/razorpay/webhook is verifying signatures.' : '[startup] ⚠ RAZORPAY_WEBHOOK_SECRET not set — /api/razorpay/webhook will reject everything until configured (fails closed, not open).');
  console.log((process.env.CLOUDINARY_CLOUD_NAME) ? '[startup] ✓ Cloudinary configured' : '[startup] ⚠ Cloudinary NOT configured — spell video upload / CRM attachments / delivery packages will 503.');
  console.log(process.env.CALENDLY_WEBHOOK_SIGNING_KEY ? '[startup] ✓ Calendly webhook signing key set' : '[startup] ⚠ CALENDLY_WEBHOOK_SIGNING_KEY not set — /api/calendly/webhook accepts unverified requests until you subscribe the webhook.');
  console.log(process.env.REMINDER_CRON_KEY ? '[startup] ✓ Reminder cron key set — /api/reminders/run is ready for your external cron ping (this also drives email queue retries — see utils/queue.js).' : '[startup] ⚠ REMINDER_CRON_KEY not set — reminders AND email queue retries will not run.');
  console.log((process.env.CALENDLY_API_TOKEN && process.env.CALENDLY_SETUP_KEY) ? '[startup] ✓ Calendly registration endpoint ready — GET /api/calendly/register-webhook?key=...&callbackUrl=... to run it once.' : '[startup] ⚠ CALENDLY_API_TOKEN / CALENDLY_SETUP_KEY not both set — /api/calendly/register-webhook will 503 until configured.');
  console.log(process.env.PUBLIC_SITE_URL ? '[startup] ✓ PUBLIC_SITE_URL set — delivery links will point to ' + process.env.PUBLIC_SITE_URL : '[startup] ⚠ PUBLIC_SITE_URL not set — delivery links default to https://theocultttarot.com, double-check this matches your real domain.');
});
