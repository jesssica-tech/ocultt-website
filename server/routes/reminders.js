// ── 1-hour-before reminders + email queue processor ─────────────────
// This server has no built-in scheduler (Render's free tier doesn't run
// background cron reliably), so a free external cron service pings this
// URL every 10-15 minutes: https://cron-job.org (or similar) →
//   GET https://<your-render-url>/api/reminders/run?key=YOUR_REMINDER_CRON_KEY
//
// Each run does two things:
//   1. Finds bookings whose appointment is 55-70 minutes away AND haven't
//      been reminded yet, and enqueues the reminder email (customer +
//      Akanksha), marking reminder_sent so it's only ever queued once.
//   2. Processes any due/retryable rows in the email queue (see
//      utils/queue.js) — this is what makes the whole email system
//      retry instead of silently dropping a failed send.

const express = require('express');
const { supabase } = require('../db');
const { enqueueEmail, processDue } = require('../utils/queue');

const router = express.Router();

router.get('/reminders/run', async (req, res) => {
  const key = process.env.REMINDER_CRON_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'REMINDER_CRON_KEY not configured yet.' });
  if (req.query.key !== key) return res.status(401).json({ ok: false, error: 'Invalid key.' });
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const now = Date.now();
  const windowStart = new Date(now + 55 * 60 * 1000).toISOString();
  const windowEnd = new Date(now + 70 * 60 * 1000).toISOString();

  const { data: due, error } = await supabase.from('bookings')
    .select('*')
    .gte('appointment_at', windowStart)
    .lte('appointment_at', windowEnd)
    .eq('reminder_sent', false)
    .not('status', 'ilike', '%cancel%');

  if (error) {
    console.error('[reminders] query failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  let remindersQueued = 0;
  for (const b of (due || [])) {
    try {
      await enqueueEmail({
        templateType: 'reminder', recipient: b.email,
        payload: { bookingId: b.id, service: b.service, appointmentAt: b.appointment_at, meetLink: b.meet_link, name: b.name },
        idempotencyKey: `reminder-customer-${b.id}`
      });
      const adminTo = (process.env.ADMIN_NOTIFY_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const admin of adminTo) {
        await enqueueEmail({
          templateType: 'reminder', recipient: admin,
          payload: { bookingId: b.id, service: b.service, appointmentAt: b.appointment_at, meetLink: b.meet_link, name: b.name },
          idempotencyKey: `reminder-admin-${b.id}-${admin}`
        });
      }
      await supabase.from('bookings').update({ reminder_sent: true, updated_at: new Date().toISOString() }).eq('id', b.id);
      remindersQueued++;
    } catch (err) {
      console.error('[reminders] failed to queue for booking %s:', b.id, err.message);
      // Leave reminder_sent = false so the next cron ping retries it.
    }
  }

  // Sweep any pending/retryable emails in the same run — no separate cron
  // job needed for this.
  const queueResult = await processDue(30);

  res.json({ ok: true, remindersChecked: (due || []).length, remindersQueued, queue: queueResult });
});

module.exports = router;
