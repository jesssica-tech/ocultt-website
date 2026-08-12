// ── Internal CRM notifications ─────────────────────────────────────
// One place that emails the team (Akanksha + whoever else is in
// ADMIN_NOTIFY_EMAILS) for: new booking, cancellation, reschedule, and
// (from reminders.js) the 1-hour-before reminder. Now routes through the
// real email queue (utils/queue.js) instead of calling the mailer
// directly, so these notifications get the same retry/dedup protection
// as customer-facing emails.

const { enqueueEmail } = require('./queue');

function adminRecipients() {
  return (process.env.ADMIN_NOTIFY_EMAILS || 'ocultt05tarot@gmail.com')
    .split(',').map(e => e.trim()).filter(Boolean);
}

async function sendAdminNewBookingNotification(b) {
  const to = adminRecipients();
  return Promise.all(to.map(recipient => enqueueEmail({
    templateType: 'admin_new_booking',
    recipient,
    payload: {
      bookingId: b.id, service: b.service, name: b.name, email: b.email,
      phone: b.phone, paymentStatus: b.payment_status || b.paymentStatus
    },
    idempotencyKey: `admin-new-booking-${b.id}-${recipient}`
  })));
}

async function sendAdminCancellationNotification(b) {
  const to = adminRecipients();
  return Promise.all(to.map(recipient => enqueueEmail({
    templateType: 'booking_cancelled',
    recipient,
    payload: { bookingId: b.id, service: b.service, name: b.name },
    idempotencyKey: `admin-cancel-${b.id}-${recipient}`
  })));
}

async function sendAdminRescheduleNotification(b, oldDate, oldTime) {
  const to = adminRecipients();
  return Promise.all(to.map(recipient => enqueueEmail({
    templateType: 'booking_rescheduled',
    recipient,
    payload: { bookingId: b.id, service: b.service, name: b.name, date: b.preferred_date, time: b.preferred_time },
    idempotencyKey: `admin-reschedule-${b.id}-${b.updated_at || Date.now()}-${recipient}`
  })));
}

module.exports = {
  sendAdminNewBookingNotification,
  sendAdminCancellationNotification,
  sendAdminRescheduleNotification,
  adminRecipients
};
