// ── 1-hour-before reminders ─────────────────────────────────────────
// This server has no built-in scheduler (Render's free tier doesn't run
// background cron reliably), so a free external cron service pings this
// URL every 10-15 minutes: https://cron-job.org (or similar) →
//   GET https://<your-render-url>/api/reminders/run?key=YOUR_REMINDER_CRON_KEY
//
// Each run finds bookings whose appointment is 55-70 minutes away AND
// haven't been reminded yet, emails the customer + Akanksha, and marks
// reminder_sent so a booking is only ever reminded once even if the cron
// pings again a few minutes later.

const express = require('express');
const { supabase } = require('../db');
const { verifyTransporter, redactSecrets } = require('../utils/mailer');
const { buildInternalNoticeHtml } = require('../utils/emailTemplate');

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

  let sent = 0;
  for (const b of (due || [])) {
    try {
      const transporter = await verifyTransporter();
      const fromName = process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot';
      const fromUser = process.env.GMAIL_USER || process.env.EMAIL_USER;
      const when = new Date(b.appointment_at).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
      const rows = [
        ['Booking ID', b.id], ['Service', b.service], ['When (IST)', when]
      ];
      if (b.meet_link) rows.push(['Google Meet Link', b.meet_link]);

      // Customer reminder
      await transporter.sendMail({
        from: `"${fromName}" <${fromUser}>`, to: b.email,
        subject: `Reminder: Your session is in about an hour`,
        html: buildInternalNoticeHtml('Your Session is Coming Up', `Dear ${b.name || 'Valued Client'}, this is a reminder that your session starts in about an hour.`, rows)
      });

      // Admin reminder
      const adminTo = (process.env.ADMIN_NOTIFY_EMAILS || fromUser).split(',');
      await transporter.sendMail({
        from: `"${fromName}" <${fromUser}>`, to: adminTo.join(','),
        subject: `Reminder: ${b.name}'s session is in about an hour`,
        html: buildInternalNoticeHtml('Upcoming Session', `${b.name}'s session starts in about an hour.`, [...rows, ['Client Email', b.email], ['Client Phone', b.phone]])
      });

      await supabase.from('bookings').update({ reminder_sent: true, updated_at: new Date().toISOString() }).eq('id', b.id);
      sent++;
    } catch (err) {
      console.error('[reminders] failed for booking %s:', b.id, redactSecrets(err.message));
      // Leave reminder_sent = false so the next cron ping retries it.
    }
  }

  res.json({ ok: true, checked: (due || []).length, sent });
});

module.exports = router;
