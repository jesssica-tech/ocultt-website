// ── Transactional email — via Resend's HTTPS API ───────────────────────
// Replaces the Gmail OAuth2 approach. Reasoning:
//   - Gmail OAuth requires a refresh token that can silently break (consent
//     revoked, project changes, token expiry edge cases) with no easy way
//     to see WHY from inside the app — exactly the repeated-patching
//     problem this migration is meant to end.
//   - Resend is a real transactional email provider (like the "dedicated
//     Email/Notification API" architecture originally proposed) — it gives
//     delivery logs, bounce/complaint handling, and a stable HTTPS API key
//     instead of a fragile OAuth refresh cycle.
//   - It sends over HTTPS (443), same as the Gmail API fix — still works
//     on Render's free tier despite the SMTP port block.
//   - Sending FROM your own verified domain (noreply@theocultttarot.com)
//     is a better long-term choice than sending from a personal Gmail
//     address: more professional, avoids Gmail's per-account sending-
//     reputation/rate quirks, doesn't depend on one person's Google
//     account staying authorized forever.
//
// One-time setup (see server/.env.example):
//   1. Create a Resend account, verify theocultttarot.com as a sending
//      domain (they give you DNS records to add — SPF/DKIM/DMARC).
//   2. Create an API key, set RESEND_API_KEY on Render.
//   3. Set RESEND_FROM_EMAIL to something like
//      "The Ocultt Tarot <noreply@theocultttarot.com>".
//
// Same interface as before (getTransporter().sendMail({...}),
// verifyTransporter()) — so spells.js / messages.js / notify.js /
// reminders.js / calendlyWebhook.js / sendEmail.js / queue.js all call
// this exactly as they did with the old Gmail-based mailer. Nothing in
// those files needed to change.

const RESEND_API_URL = 'https://api.resend.com/emails';

function resolveConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY || '',
    fromAddress: process.env.RESEND_FROM_EMAIL ||
      `"${process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot'}" <noreply@theocultttarot.com>`
  };
}

function assertConfigured() {
  const { apiKey } = resolveConfig();
  if (!apiKey) {
    throw new Error(
      'Email sending is not set up yet. Set RESEND_API_KEY (and RESEND_FROM_EMAIL) on Render — ' +
      'see server/.env.example for the one-time Resend account + domain-verification steps.'
    );
  }
}

function buildTransporter() {
  return {
    async sendMail({ from, to, subject, html, text }) {
      assertConfigured();
      const { apiKey, fromAddress } = resolveConfig();

      const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: from || fromAddress,
          to: [to],
          subject: subject || '',
          html: html || undefined,
          text: text || (html ? undefined : '')
        }),
        signal: AbortSignal.timeout(10000)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || `Resend API returned ${res.status}`;
        throw new Error(msg);
      }
      return { messageId: data.id };
    }
  };
}

let _transporter = null;
function getTransporter() {
  if (!_transporter) _transporter = buildTransporter();
  return _transporter;
}

// Lightweight real check that the API key actually works — calls Resend's
// own domains list endpoint (cheap, no email sent), same purpose as the
// old Gmail getProfile() check: fail fast and visibly rather than only
// discovering it's broken when a real customer email silently disappears.
async function verifyTransporter() {
  const transporter = getTransporter();
  assertConfigured();
  const { apiKey } = resolveConfig();
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend auth check failed (${res.status}): ${body.slice(0, 200)}`);
    }
    console.log('[mailer] Resend API key OK.');
    return transporter;
  } catch (err) {
    console.error('[mailer] Resend authentication FAILED:', redactSecrets(err.message));
    throw err;
  }
}

// Defense in depth — strips the API key out of any string before it's
// ever logged.
function redactSecrets(text) {
  const { apiKey } = resolveConfig();
  if (typeof text !== 'string') return text;
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out;
}

module.exports = { getTransporter, verifyTransporter, redactSecrets, resolveConfig };
