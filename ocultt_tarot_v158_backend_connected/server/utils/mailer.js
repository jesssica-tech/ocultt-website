// ── Gmail transporter ──────────────────────────────────────────────
// Credentials come ONLY from process.env (populated from .env, which is
// never committed — see .env.example). Nothing here is ever sent to the
// frontend; the browser only ever talks to POST /api/send-email.

const nodemailer = require('nodemailer');

// Accepts either naming convention — GMAIL_USER/GMAIL_APP_PASSWORD (the
// documented names in .env.example) or EMAIL_USER/EMAIL_PASS (a common
// alternative some hosts/dashboards default to) — so a Railway project
// configured with either pair still works, instead of silently failing
// because of a naming mismatch.
function resolveCredentials() {
  const user = process.env.GMAIL_USER || process.env.EMAIL_USER || '';
  const rawPass = process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASS || '';
  const pass = rawPass.replace(/\s+/g, '');
  const usedNames = process.env.GMAIL_USER ? 'GMAIL_USER/GMAIL_APP_PASSWORD'
    : process.env.EMAIL_USER ? 'EMAIL_USER/EMAIL_PASS'
    : null;
  return { user, pass, usedNames };
}

function buildTransporter() {
  const { user, pass, usedNames } = resolveCredentials();

  if (!user || !pass) {
    console.error(
      '[mailer] No Gmail credentials found. Checked GMAIL_USER/GMAIL_APP_PASSWORD ' +
      'and EMAIL_USER/EMAIL_PASS — neither pair is set in this environment\'s variables.'
    );
    throw new Error(
      'Gmail credentials are not set. Set GMAIL_USER + GMAIL_APP_PASSWORD (or ' +
      'EMAIL_USER + EMAIL_PASS) in this server\'s environment variables — see ' +
      'server/.env.example for how to generate a Gmail App Password.'
    );
  }

  console.log('[mailer] Using credentials from %s — user=%s, app password length=%d chars',
    usedNames, user, pass.length);

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

// Built lazily (not at require-time) so a missing .env fails with a clear
// error on the first actual send attempt, not on server boot.
let _transporter = null;
function getTransporter() {
  if (!_transporter) _transporter = buildTransporter();
  return _transporter;
}

// Explicit SMTP connection + authentication check, run before every send
// attempt so failures are reported at the exact stage they happen instead
// of one generic "failed to send" message covering three different causes.
async function verifyTransporter() {
  const transporter = getTransporter();
  try {
    await transporter.verify();
    console.log('[mailer] SMTP connection + authentication: OK');
    return transporter;
  } catch (err) {
    console.error('[mailer] SMTP connection/authentication FAILED:', redactSecrets(err.message));
    throw err;
  }
}

// Defense in depth: strips the app password out of any string before it's
// ever logged, in case a future SMTP error message happens to echo part of
// the auth attempt back. Callers should still prefer err.message over the
// raw error object, but this is a safety net either way.
function redactSecrets(text) {
  const { pass } = resolveCredentials();
  if (!pass || typeof text !== 'string') return text;
  return text.split(pass).join('[REDACTED]');
}

module.exports = { getTransporter, verifyTransporter, redactSecrets };
