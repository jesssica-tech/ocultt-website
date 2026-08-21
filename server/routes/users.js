// ── Customer accounts ───────────────────────────────────────────────
// Step 1 of the user-system build: save a row to Supabase for every
// customer who signs in with Google, keyed by their real Firebase uid.
//
// This is intentionally separate from server/middleware/adminAuth.js —
// that file gates the CRM (admin allowlist only). This route accepts
// ANY validly signed-in Google user, since every customer should be
// able to sync their own profile. Duplicating the small token-verify
// block here (instead of editing adminAuth.js) keeps this change purely
// additive and avoids touching existing, working CRM auth code.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const { supabase } = require('../db');

const router = express.Router();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'the-ocultt-tarot';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
// FIX: same broken placeholder URL as adminAuth.js had — see the comment
// there for the full explanation. Corrected to Google's real Firebase
// service account JWKS endpoint.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please try again shortly.' }
});

// ── POST /api/users/sync ── called by js/firebase.js right after a
// successful Google sign-in (and on every auth-state restore on reload).
// Body is empty — everything trusted (uid/name/email/picture) comes only
// from the verified ID token itself, never from the request body, so a
// user can never write another uid's row.
router.post('/users/sync', syncLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }

  let payload;
  try {
    const result = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: PROJECT_ID });
    payload = result.payload;
  } catch (err) {
    console.warn('[users/sync] token verification failed:', err.message);
    return res.status(401).json({ ok: false, error: 'Your session has expired. Please sign in again.' });
  }

  const row = {
    uid: payload.sub,
    name: payload.name || payload.email || '',
    email: (payload.email || '').toLowerCase(),
    picture: payload.picture || null,
    last_login_at: new Date().toISOString()
  };

  const { error } = await supabase.from('users').upsert(row, { onConflict: 'uid' });
  if (error) {
    console.error('[users/sync] Supabase error:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save profile.' });
  }

  res.json({ ok: true });
});

module.exports = router;
