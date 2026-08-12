// ── Real email queue ─────────────────────────────────────────────────
// Every outbound email is written to the `email_queue` table FIRST, then
// we attempt to send it immediately (so customers still get instant
// confirmations — no waiting on a cron cycle). If that immediate attempt
// fails, or if two emails land in the same second, the row stays
// `pending`/`failed` with a `next_attempt_at`, and the existing
// reminders-style cron ping (routes/queueProcess.js) sweeps it up and
// retries with backoff. This is what makes email delivery durable instead
// of "fire and forget, hope it worked."
//
// Idempotency: callers pass an `idempotencyKey` (e.g. `booking-confirm-
// <bookingId>` or `payment-failed-<bookingId>-<dayBucket>`) — a unique
// constraint on that column means enqueueing the same logical email twice
// (e.g. a double-submitted form, a retried webhook) is a no-op, not a
// duplicate send.

const { supabase } = require('../db');
const { getTransporter, verifyTransporter, redactSecrets } = require('./mailer');
const { renderTemplate } = require('./templates');

const BACKOFF_MINUTES = [1, 5, 15, 60, 240]; // attempt 1..5 delay before next retry

function backoffMinutes(attempts) {
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
}

// ── enqueue(): writes the row, then makes one immediate best-effort send
// attempt. Returns { ok, queued, sent } — queued is always true if the DB
// write succeeded (even if the immediate send then failed; it'll retry).
async function enqueueEmail({ templateType, recipient, payload, idempotencyKey }) {
  if (!supabase) {
    console.warn('[queue] Supabase not configured — cannot queue email, attempting direct send as a fallback.');
    return directSend(templateType, recipient, payload);
  }
  if (!recipient) return { ok: false, queued: false, error: 'Missing recipient' };

  const row = {
    template_type: templateType,
    recipient,
    payload: payload || {},
    idempotency_key: idempotencyKey || null,
    status: 'pending',
    next_attempt_at: new Date().toISOString()
  };

  let queuedRow;
  if (idempotencyKey) {
    // upsert on the unique idempotency_key — a repeat enqueue with the same
    // key is a no-op rather than a second row / second send.
    const { data, error } = await supabase.from('email_queue')
      .upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .select().maybeSingle();
    if (error && error.code !== '23505') {
      console.error('[queue] enqueue upsert failed:', error.message);
      return { ok: false, queued: false, error: error.message };
    }
    if (data) {
      queuedRow = data;
    } else {
      // Already existed (ignoreDuplicates hit) — fetch it so we can report status.
      const { data: existing } = await supabase.from('email_queue').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existing && existing.status === 'sent') {
        console.log('[queue] Skipped duplicate enqueue (already sent):', idempotencyKey);
        return { ok: true, queued: true, sent: true, duplicate: true };
      }
      queuedRow = existing;
    }
  } else {
    const { data, error } = await supabase.from('email_queue').insert(row).select().maybeSingle();
    if (error) {
      console.error('[queue] enqueue insert failed:', error.message);
      return { ok: false, queued: false, error: error.message };
    }
    queuedRow = data;
  }

  if (!queuedRow) return { ok: true, queued: true, sent: false };

  // Immediate best-effort attempt — keeps the "customer gets an instant
  // email" UX the site already has, while still being durable via the row.
  const sent = await attemptSend(queuedRow);
  return { ok: true, queued: true, sent };
}

async function attemptSend(row) {
  try {
    await verifyTransporter();
    const { subject, html, text } = renderTemplate(row.template_type, row.payload);
    const transporter = getTransporter();
    const fromName = process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot';
    const { resolveConfig } = require('./mailer');
    const info = await transporter.sendMail({
      from: resolveConfig().fromAddress,
      to: row.recipient,
      subject,
      html,
      text
    });
    if (supabase) {
      await supabase.from('email_queue').update({
        status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq('id', row.id);
    }
    console.log('[queue] SENT template=%s to=%s messageId=%s', row.template_type, row.recipient, info.messageId);
    return true;
  } catch (err) {
    const attempts = (row.attempts || 0) + 1;
    const nextAttempt = new Date(Date.now() + backoffMinutes(attempts) * 60 * 1000).toISOString();
    const status = attempts >= (row.max_attempts || 5) ? 'failed' : 'pending';
    console.error('[queue] SEND FAILED template=%s to=%s attempt=%d:', row.template_type, row.recipient, attempts, redactSecrets(err.message));
    if (supabase) {
      await supabase.from('email_queue').update({
        status, attempts, last_error: redactSecrets(err.message).slice(0, 500),
        next_attempt_at: nextAttempt, updated_at: new Date().toISOString()
      }).eq('id', row.id);
    }
    return false;
  }
}

// ── processDue(): called by the cron ping. Picks up anything pending
// whose next_attempt_at has arrived (immediate-send failures, or emails
// enqueued while Supabase/Resend were briefly down) and retries them.
async function processDue(limit = 20) {
  if (!supabase) return { checked: 0, sent: 0 };
  const { data: due, error } = await supabase.from('email_queue')
    .select('*').eq('status', 'pending').lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true }).limit(limit);
  if (error) {
    console.error('[queue] processDue query failed:', error.message);
    return { checked: 0, sent: 0, error: error.message };
  }
  let sent = 0;
  for (const row of (due || [])) {
    // Mark processing first so a slow send doesn't get double-picked-up
    // by an overlapping cron run.
    await supabase.from('email_queue').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', row.id);
    const ok = await attemptSend(row);
    if (ok) sent++;
  }
  return { checked: (due || []).length, sent };
}

// Fallback path only used if Supabase itself isn't configured yet (so the
// site isn't fully dead in the water during initial setup) — no retry/
// dedup possible without a DB, which is exactly why Supabase is required
// for the real queue to function.
async function directSend(templateType, recipient, payload) {
  try {
    await verifyTransporter();
    const { subject, html, text } = renderTemplate(templateType, payload);
    const transporter = getTransporter();
    const { resolveConfig } = require('./mailer');
    await transporter.sendMail({ from: resolveConfig().fromAddress, to: recipient, subject, html, text });
    return { ok: true, queued: false, sent: true };
  } catch (err) {
    console.error('[queue] directSend failed (no DB fallback path):', redactSecrets(err.message));
    return { ok: false, queued: false, sent: false, error: err.message };
  }
}

module.exports = { enqueueEmail, processDue };
