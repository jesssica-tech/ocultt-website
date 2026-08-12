// ── One-time Calendly webhook registration ─────────────────────────
// This is a SETUP tool, not something that runs on every request. Hit it
// once (from a browser or curl) after CALENDLY_API_TOKEN is set on Render,
// and it subscribes THIS backend's /api/calendly/webhook to Calendly's
// invitee.created / invitee.canceled events.
//
// It does not touch, replace, or duplicate routes/calendlyWebhook.js —
// that file keeps handling incoming events exactly as before. This file
// only talks to Calendly's API to register where those events get sent.
//
// Usage (after deploying with CALENDLY_API_TOKEN + CALENDLY_SETUP_KEY set):
//   GET /api/calendly/register-webhook
//       ?key=YOUR_CALENDLY_SETUP_KEY
//       &callbackUrl=https://ocultt-website.onrender.com/api/calendly/webhook
//
// callbackUrl is required on every call (never hardcoded/guessed here) —
// double-check it against your real Render URL before running this.

const express = require('express');
const router = express.Router();

const CALENDLY_API = 'https://api.calendly.com';

router.get('/calendly/register-webhook', async (req, res) => {
  const setupKey = process.env.CALENDLY_SETUP_KEY;
  if (!setupKey) return res.status(503).json({ ok: false, error: 'CALENDLY_SETUP_KEY not configured yet — set it in your env vars, then retry.' });
  if (req.query.key !== setupKey) return res.status(401).json({ ok: false, error: 'Invalid key.' });

  const token = process.env.CALENDLY_API_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: 'CALENDLY_API_TOKEN not configured yet.' });

  const callbackUrl = req.query.callbackUrl;
  if (!callbackUrl || !/^https:\/\//.test(callbackUrl)) {
    return res.status(400).json({ ok: false, error: 'Pass ?callbackUrl=https://your-real-render-url/api/calendly/webhook — double-check the exact domain, this is not guessed for you.' });
  }

  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // Step 1 — who am I / what org am I in (needed for an org-scope subscription).
    const meResp = await fetch(`${CALENDLY_API}/users/me`, { headers: authHeaders });
    const me = await meResp.json();
    if (!meResp.ok) {
      return res.status(502).json({ ok: false, error: 'Calendly rejected CALENDLY_API_TOKEN.', detail: me });
    }
    const organization = me?.resource?.current_organization;
    if (!organization) {
      return res.status(502).json({ ok: false, error: 'Could not determine your Calendly organization from /users/me.', detail: me });
    }

    // Step 2 — create the subscription.
    const subResp = await fetch(`${CALENDLY_API}/webhook_subscriptions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: callbackUrl,
        events: ['invitee.created', 'invitee.canceled'],
        organization,
        scope: 'organization'
      })
    });
    const sub = await subResp.json();

    if (!subResp.ok) {
      // Calendly returns 409-style errors if a subscription already exists
      // for this URL — surfaced as-is so it's obvious what happened.
      return res.status(subResp.status).json({ ok: false, error: 'Calendly rejected the webhook subscription request.', detail: sub });
    }

    const signingKey = sub?.resource?.signing_key || null;

    res.json({
      ok: true,
      subscriptionUri: sub?.resource?.uri || null,
      callbackUrl,
      signingKey,
      nextStep: signingKey
        ? `Set CALENDLY_WEBHOOK_SIGNING_KEY=${signingKey} in your Render env vars, then redeploy. This is shown only once — Calendly will not display it again.`
        : 'Calendly did not return a signing key in this response — check the full "detail" logged above; some Calendly plans omit it on the create call, in which case invitee events will still be accepted but signature verification stays off until you locate it another way.'
    });
  } catch (err) {
    console.error('[calendly register-webhook] failed:', err.message);
    res.status(502).json({ ok: false, error: 'Could not reach Calendly\u2019s API. Please try again shortly.' });
  }
});

module.exports = router;
