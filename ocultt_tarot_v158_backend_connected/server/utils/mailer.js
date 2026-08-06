// ── Gmail sending — via the Gmail API (OAuth2), not SMTP ──────────────
// Render's free tier blocks outbound SMTP ports (25/465/587) — see
// https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports
// The Gmail API sends over plain HTTPS (port 443), which is never
// blocked, and lets us keep sending as the real ocult05tarot@gmail.com
// (or whichever Gmail account you authorize) — no domain verification,
// no "from" address change, nothing customers would notice differently.
//
// One-time setup (see server/routes/gmailAuthSetup.js + .env.example):
//   1. Google Cloud Console → enable Gmail API → OAuth client (Web app)
//   2. Visit /api/gmail/authorize once, sign in with the Gmail account,
//      approve → copy the refresh token it shows you into
//      GMAIL_REFRESH_TOKEN on Render.
// After that, everything below just works — same interface every other
// file already calls (getTransporter().sendMail({...})), so nothing in
// spells.js / messages.js / notify.js / reminders.js / calendlyWebhook.js
// / sendEmail.js needed to change.

const { google } = require('googleapis');

function resolveOAuthConfig() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    redirectUri: process.env.GMAIL_REDIRECT_URI || '',
    fromAddress: process.env.GMAIL_USER || process.env.EMAIL_USER || ''
  };
}

function buildOAuth2Client() {
  const { clientId, clientSecret, refreshToken, redirectUri } = resolveOAuthConfig();
  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      '[mailer] Gmail API not configured. Need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and ' +
      'GMAIL_REFRESH_TOKEN — see server/.env.example and run the one-time /api/gmail/authorize flow.'
    );
    throw new Error(
      'Gmail sending is not set up yet. Run the one-time authorization at /api/gmail/authorize ' +
      '(see server/.env.example), then set GMAIL_REFRESH_TOKEN on Render.'
    );
  }
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri || undefined);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Encodes a MIME email exactly the way the Gmail API's messages.send
// expects: a base64url string of the raw RFC 822 message.
function buildRawMessage({ from, to, subject, html, text }) {
  const isHtml = !!html;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject || '', 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: 7bit',
    '',
    html || text || ''
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same shape as the old Nodemailer transporter (getTransporter().sendMail(...))
// so every other file in the codebase calls this exactly as before.
function buildTransporter() {
  const { fromAddress } = resolveOAuthConfig();
  const auth = buildOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  return {
    async sendMail({ from, to, subject, html, text }) {
      const raw = buildRawMessage({ from: from || fromAddress, to, subject, html, text });
      const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      return { messageId: result.data.id };
    }
  };
}

let _transporter = null;
function getTransporter() {
  if (!_transporter) _transporter = buildTransporter();
  return _transporter;
}

// Lightweight real check that the refresh token actually works — calls
// Gmail's own getProfile endpoint (cheap, no email sent) so failures are
// caught before a real send attempt, same purpose as the old SMTP verify().
async function verifyTransporter() {
  const transporter = getTransporter();
  try {
    const auth = buildOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log('[mailer] Gmail API auth OK — sending as %s', profile.data.emailAddress);
    return transporter;
  } catch (err) {
    console.error('[mailer] Gmail API authentication FAILED:', redactSecrets(err.message));
    throw err;
  }
}

// Defense in depth — strips the refresh token/client secret out of any
// string before it's ever logged.
function redactSecrets(text) {
  const { refreshToken, clientSecret } = resolveOAuthConfig();
  if (typeof text !== 'string') return text;
  let out = text;
  if (refreshToken) out = out.split(refreshToken).join('[REDACTED]');
  if (clientSecret) out = out.split(clientSecret).join('[REDACTED]');
  return out;
}

module.exports = { getTransporter, verifyTransporter, redactSecrets, buildOAuth2Client, resolveOAuthConfig };
