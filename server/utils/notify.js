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

// ── Customer-facing "your booking is confirmed" email ───────────────
// Deliberately the ONLY path that sends this email. Called exclusively
// from routes/payments.js (/payments/verify, after real HMAC signature
// verification) and routes/razorpayWebhook.js (payment.captured) — never
// from a client-supplied paymentStatus, and never for request-type
// services (Group Magic, Numerology, Energy Healing, Spell / Magic),
// which have no online payment step and instead get 'request_received'
// (see js/script.js's sendRequestReceivedEmail / routes/sendEmail.js).
// Both callers pass the same idempotencyKey so a genuine payment can
// never trigger this twice even if verify AND the webhook both fire.
async function sendCustomerBookingConfirmation(booking) {
  if (!booking || !booking.email) return { ok: false, queued: false, error: 'Missing recipient' };
  return enqueueEmail({
    templateType: 'booking_confirmation',
    recipient: booking.email,
    payload: {
      toName: booking.name, bookingId: booking.id, service: booking.service,
      package: booking.package, duration: booking.duration,
      date: booking.preferred_date, time: booking.preferred_time
    },
    idempotencyKey: `booking-confirm-${booking.id}`
  });
}

// ── Spell / Magic "your booking is confirmed" email ──────────────────
// Called exclusively from routes/payments.js (/payments/verify, after
// real HMAC signature verification, bookingType === 'spell') — mirrors
// sendCustomerBookingConfirmation's trust model exactly, just with
// spell-specific wording (Akanksha performs the ritual herself; there's
// no live session to attend) and a dynamic delivery window driven by
// the customer's own urgency selection rather than one fixed range.
const SPELL_DELIVERY_WINDOWS = {
  'Urgent':         'the same day to 2 days',
  'Within a month': '5\u201330 days',
  'No rush':        '5\u201360 days'
};
async function sendSpellBookingConfirmation(booking) {
  if (!booking || !booking.email) return { ok: false, queued: false, error: 'Missing recipient' };
  return enqueueEmail({
    templateType: 'spell_confirmed',
    recipient: booking.email,
    payload: {
      name: booking.name, bookingId: booking.id, service: booking.service,
      package: booking.package, price: booking.priceLabel,
      deliveryWindow: SPELL_DELIVERY_WINDOWS[booking.urgency] || SPELL_DELIVERY_WINDOWS['No rush']
    },
    idempotencyKey: `spell-confirm-${booking.id}`
  });
}

// ── Energy Healing / Numerology "your booking is confirmed" emails ───
// Same trust model as the two above: called exclusively from
// routes/payments.js (/payments/verify, after real HMAC verification,
// bookingType 'energy_healing' / 'numerology').
async function sendEnergyHealingConfirmation(booking) {
  if (!booking || !booking.email) return { ok: false, queued: false, error: 'Missing recipient' };
  return enqueueEmail({
    templateType: 'energy_healing_confirmed',
    recipient: booking.email,
    payload: { name: booking.name, bookingId: booking.id, package: booking.package, price: booking.priceLabel },
    idempotencyKey: `eh-confirm-${booking.id}`
  });
}

async function sendNumerologyConfirmation(booking) {
  if (!booking || !booking.email) return { ok: false, queued: false, error: 'Missing recipient' };
  return enqueueEmail({
    templateType: 'numerology_confirmed',
    recipient: booking.email,
    payload: { name: booking.name, bookingId: booking.id, package: booking.package, price: booking.priceLabel },
    idempotencyKey: `numerology-confirm-${booking.id}`
  });
}

module.exports = {
  sendAdminNewBookingNotification,
  sendAdminCancellationNotification,
  sendAdminRescheduleNotification,
  sendCustomerBookingConfirmation,
  sendSpellBookingConfirmation,
  sendEnergyHealingConfirmation,
  sendNumerologyConfirmation,
  adminRecipients
};
