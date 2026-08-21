// ── CRM admin auth ──────────────────────────────────────────────────
// The frontend already signs admins in with Google (Firebase Auth) —
// js/firebase.js. Rather than inventing a second password system, this
// middleware verifies the REAL Firebase ID token the browser already
// has after sign-in, using Google's public keys (no service-account
// credential file needed — see FIREBASE_PROJECT_ID in .env.example).
//
// Frontend just needs to send that ID token as the x-admin-key header
// (see the getAdminKey()/adminHeaders() wiring in js/script.js).

const { jwtVerify, createRemoteJWKSet } = require('jose');
const { supabase } = require('../db');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'the-ocultt-tarot';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

// Google's public JWKS for Firebase Auth tokens — no credentials required.
// FIX: this was pointing at a broken placeholder URL
// ('[email protected]') instead of Google's real Firebase service
// account — every single admin-authenticated request (loading bookings,
// spells, everything in the CRM) has been failing token verification
// because of this since before this codebase was ever handed over. It may
// have appeared to work intermittently because jose's createRemoteJWKSet
// caches keys in memory — if a fetch ever succeeded once, it kept working
// off that cache until the next Render restart/redeploy wiped it, at
// which point every fresh verification attempt would fail outright. This
// is the real cause behind today's "CRM won't load bookings" reports.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

// Fallback allowlist if Supabase isn't configured yet — keep in sync with
// ADMIN_EMAILS in js/script.js.
const FALLBACK_EMAILS = (process.env.CRM_ADMIN_EMAILS ||
  'ocultt05tarot@gmail.com,akankshachoudhary10@gmail.com,dishasoni99@gmail.com,the.ocultt.tarot@gmail.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

async function adminAuth(req, res, next) {
  const token = req.headers['x-admin-key'];
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Not signed in. Please sign in to the CRM again.' });
  }

  let payload;
  try {
    const result = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: PROJECT_ID });
    payload = result.payload;
  } catch (err) {
    console.warn('[adminAuth] token verification failed:', err.message);
    return res.status(401).json({ ok: false, error: 'Your session has expired. Please sign in again.' });
  }

  const email = (payload.email || '').toLowerCase();
  if (!email || !payload.email_verified) {
    return res.status(403).json({ ok: false, error: 'Google account email is not verified.' });
  }

  let allowed = false;
  if (supabase) {
    const { data, error } = await supabase.from('crm_users').select('active').eq('email', email).maybeSingle();
    if (error) console.warn('[adminAuth] crm_users lookup failed, falling back to env allowlist:', error.message);
    allowed = data ? data.active !== false : FALLBACK_EMAILS.includes(email);
  } else {
    allowed = FALLBACK_EMAILS.includes(email);
  }

  if (!allowed) {
    console.warn('[adminAuth] Rejected non-CRM account:', email);
    return res.status(403).json({ ok: false, error: 'This Google account does not have CRM access.' });
  }

  req.adminEmail = email;
  next();
}

module.exports = adminAuth;
