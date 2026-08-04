// ── Internal CRM notifications ─────────────────────────────────────
// One place that emails the team (Akanksha + whoever else is in
// ADMIN_NOTIFY_EMAILS) for: new booking, cancellation, reschedule, and
// (from reminders.js) the 1-hour-before reminder. Reuses the same Gmail
// transporter as customer confirmations — no new credentials needed.

const { verifyTransporter, redactSecrets } = require('./mailer');
const { buildInternalNoticeHtml } = require('./emailTemplate');

function adminRecipients() {
  return (process.env.ADMIN_NOTIFY_EMAILS || 'ocultt05tarot@gmail.com')
    .split(',').map(e => e.trim()).filter(Boolean);
}

async function sendInternalNotice({ heading, intro, rows, subject }) {
  const to = adminRecipients();
  if (!to.length) return;
  try {
    const transporter = await verifyTransporter();
    const fromName = process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot';
    const fromUser = process.env.GMAIL_USER || process.env.EMAIL_USER;
    await transporter.sendMail({
      from: `"${fromName}" <${fromUser}>`,
      to: to.join(','),
      subject,
      html: buildInternalNoticeHtml(heading, intro, rows)
    });
    console.log('[notify] Sent "%s" to %s', subject, to.join(','));
  } catch (err) {
    console.error('[notify] Failed to send "%s":', subject, redactSecrets(err.message));
  }
}

function bookingRows(b) {
  return [
    ['Booking ID', b.id],
    ['Service', b.service],
    ['Package', b.package],
    ['Name', b.name],
    ['Email', b.email],
    ['Phone', b.phone],
    ['Date', b.preferred_date || b.preferredDate],
    ['Time', b.preferred_time || b.preferredTime],
    ['Payment', b.payment_status || b.paymentStatus]
  ];
}

async function sendAdminNewBookingNotification(b) {
  return sendInternalNotice({
    heading: 'New Booking',
    intro: `A new ${b.service} booking just came in.`,
    rows: bookingRows(b),
    subject: `New Booking — ${b.service} — ${b.name}`
  });
}

async function sendAdminCancellationNotification(b) {
  return sendInternalNotice({
    heading: 'Booking Cancelled',
    intro: `A booking was cancelled.`,
    rows: bookingRows(b),
    subject: `Cancelled — ${b.service} — ${b.name}`
  });
}

async function sendAdminRescheduleNotification(b, oldDate, oldTime) {
  return sendInternalNotice({
    heading: 'Booking Rescheduled',
    intro: `A booking was moved from ${oldDate || '—'} ${oldTime || ''} to the details below.`,
    rows: bookingRows(b),
    subject: `Rescheduled — ${b.service} — ${b.name}`
  });
}

module.exports = {
  sendAdminNewBookingNotification,
  sendAdminCancellationNotification,
  sendAdminRescheduleNotification,
  sendInternalNotice,
  adminRecipients
};
