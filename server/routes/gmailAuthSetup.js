// ── One-time Gmail OAuth2 authorization ─────────────────────────────
// Run this exactly once per Gmail account. It's a standard OAuth "get a
// refresh token" dance:
//   1. GET /api/gmail/authorize?key=YOUR_GMAIL_SETUP_KEY
//      → redirects you to Google's sign-in/consent screen
//   2. Sign in with the Gmail account you want to send FROM
//      (e.g. ocult05tarot@gmail.com), approve access
//   3. Google redirects back to /api/gmail/oauth2callback, which shows
//      you the refresh token — copy it into GMAIL_REFRESH_TOKEN on
//      Render and redeploy. That's it, permanent until you revoke it.
//
// Does not touch mailer.js's sending logic — this file only handles the
// one-time handshake to obtain the token mailer.js then uses.

const express = require('express');
const { google } = require('googleapis');
const { resolveOAuthConfig } = require('../utils/mailer');

const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

function buildClient() {
  const { clientId, clientSecret, redirectUri } = resolveOAuthConfig();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI must all be set first.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

router.get('/gmail/authorize', (req, res) => {
  const setupKey = process.env.GMAIL_SETUP_KEY;
  if (!setupKey) return res.status(503).send('GMAIL_SETUP_KEY not configured yet — set it in your env vars, then retry.');
  if (req.query.key !== setupKey) return res.status(401).send('Invalid key.');

  try {
    const client = buildClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',   // required to get a refresh_token back
      prompt: 'consent',        // forces Google to re-issue a refresh_token even on repeat runs
      scope: SCOPES
    });
    res.redirect(url);
  } catch (err) {
    res.status(503).send(err.message);
  }
});

router.get('/gmail/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code — Google should have provided one. Try /api/gmail/authorize again.');

  try {
    const client = buildClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(200).send(
        '<h3>No refresh token returned.</h3>' +
        '<p>This usually means you\'ve already authorized this app before. Go to ' +
        '<a href="https://myaccount.google.com/permissions" target="_blank">Google Account → Security → Third-party access</a>, ' +
        'remove access for this app, then visit /api/gmail/authorize again — Google only issues a fresh refresh token on first-time consent.</p>'
      );
    }
    res.send(
      '<h3>Success — copy this into GMAIL_REFRESH_TOKEN on Render, then redeploy:</h3>' +
      '<pre style="padding:16px;background:#f2f2f2;border-radius:6px;word-break:break-all">' + tokens.refresh_token + '</pre>' +
      '<p>Google shows this value only once — save it now.</p>'
    );
  } catch (err) {
    res.status(502).send('Token exchange failed: ' + err.message);
  }
});

module.exports = router;
