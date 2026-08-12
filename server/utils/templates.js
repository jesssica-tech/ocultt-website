// ── Email template registry ─────────────────────────────────────────
// The one place every route/queue consumer should go to render an email,
// instead of each route file building its own `rows` array and calling
// buildInternalNoticeHtml directly. The two original builders in
// emailTemplate.js are untouched and still used underneath — this file
// is purely additive: a `template_type -> (data) => {subject, html, text}`
// map, so new templates can be added here without editing the queue,
// the routes, or the two existing builders.

const { buildConfirmationEmailHtml, buildInternalNoticeHtml } = require('./emailTemplate');

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  } catch { return String(iso); }
}

// Every renderer takes the `payload` stored on the email_queue row and
// returns { subject, html, text? }. Keep these pure — no I/O, no DB — so
// they're trivially testable and reusable by both the immediate-send path
// and the retry/cron path.
const TEMPLATES = {

  booking_confirmation: (d) => ({
    subject: d.subject || 'Your Ocultt Booking is Confirmed',
    html: buildConfirmationEmailHtml(d),
    text: d.body || ''
  }),

  payment_successful: (d) => ({
    subject: `Payment Received — ${d.service || 'Your Booking'}`,
    html: buildInternalNoticeHtml(
      'Payment Received',
      `Dear ${d.name || 'Valued Client'}, we've received your payment. Your booking is confirmed.`,
      [['Booking ID', d.bookingId], ['Service', d.service], ['Amount', d.amount], ['Payment ID', d.paymentId]]
    )
  }),

  payment_failed: (d) => ({
    subject: `Payment Not Received — ${d.service || 'Your Booking'}`,
    html: buildInternalNoticeHtml(
      'Payment Not Received',
      `Dear ${d.name || 'Valued Client'}, we were unable to confirm your payment for this booking, so it has not been completed. ` +
      (d.paymentLink ? 'You can complete payment using the link below.' : 'Please try booking again, or reply to this email and we\u2019ll help sort it out.'),
      [['Booking ID', d.bookingId], ['Service', d.service], d.paymentLink ? ['Payment Link', d.paymentLink] : null].filter(Boolean)
    )
  }),

  payment_pending: (d) => ({
    subject: `Payment Pending — ${d.service || 'Your Booking'}`,
    html: buildInternalNoticeHtml(
      'Payment Pending',
      `Dear ${d.name || 'Valued Client'}, we're still confirming your payment. We'll email you as soon as it's verified.`,
      [['Booking ID', d.bookingId], ['Service', d.service]]
    )
  }),

  booking_cancelled: (d) => ({
    subject: `Booking Cancelled — ${d.service || ''}`,
    html: buildInternalNoticeHtml(
      'Booking Cancelled',
      `Dear ${d.name || 'Valued Client'}, your booking has been cancelled.`,
      [['Booking ID', d.bookingId], ['Service', d.service]]
    )
  }),

  booking_rescheduled: (d) => ({
    subject: `Booking Rescheduled — ${d.service || ''}`,
    html: buildInternalNoticeHtml(
      'Booking Rescheduled',
      `Dear ${d.name || 'Valued Client'}, your booking has a new date/time.`,
      [['Booking ID', d.bookingId], ['Service', d.service], ['New Date', d.date], ['New Time (IST)', d.time]]
    )
  }),

  meet_link: (d) => ({
    subject: 'Your Google Meet Link — The Ocultt Tarot',
    html: buildInternalNoticeHtml(
      'Your Google Meet Link',
      `Dear ${d.name || 'Valued Client'}, here is your link for your upcoming session.`,
      [['Booking ID', d.bookingId], ['When (IST)', fmtDate(d.startTime)], ['Google Meet Link', d.meetLink]]
    )
  }),

  reminder: (d) => ({
    subject: `Reminder: Your session is in about an hour`,
    html: buildInternalNoticeHtml(
      'Your Session is Coming Up',
      `Dear ${d.name || 'Valued Client'}, this is a reminder that your session starts in about an hour.`,
      [['Booking ID', d.bookingId], ['Service', d.service], ['When (IST)', fmtDate(d.appointmentAt)], d.meetLink ? ['Google Meet Link', d.meetLink] : null].filter(Boolean)
    )
  }),

  delivery_ready: (d) => ({
    subject: d.title || 'Your Files Are Ready',
    html: buildInternalNoticeHtml(
      d.title || 'Your Files Are Ready',
      `Dear ${d.name || 'Valued Client'}, your ${d.serviceLabel || 'delivery'} is ready. Open the secure link below to view your files.\n\nImportant: this link will expire in 7 days.`,
      [['Booking ID', d.bookingId], ['View Your Files', d.deliveryUrl], ['Link Expires', d.expiresLabel]]
    )
  }),

  delivery_expiring_soon: (d) => ({
    subject: `Your files expire soon — ${d.serviceLabel || 'The Ocultt Tarot'}`,
    html: buildInternalNoticeHtml(
      'Your Delivery Link Expires Soon',
      `Dear ${d.name || 'Valued Client'}, your secure file link will expire soon. Please download or view your files before then.`,
      [['View Your Files', d.deliveryUrl], ['Expires', d.expiresLabel]]
    )
  }),

  admin_new_booking: (d) => ({
    subject: `New Booking — ${d.service || ''} — ${d.name || ''}`,
    html: buildInternalNoticeHtml(
      'New Booking',
      `A new ${d.service || ''} booking just came in.`,
      [['Booking ID', d.bookingId], ['Service', d.service], ['Name', d.name], ['Email', d.email], ['Phone', d.phone], ['Payment', d.paymentStatus]]
    )
  }),

  admin_payment_failed: (d) => ({
    subject: `Payment Not Received — ${d.service || ''} — ${d.name || ''}`,
    html: buildInternalNoticeHtml(
      'Payment Not Received',
      `A customer's payment did not go through.`,
      [['Booking ID', d.bookingId], ['Service', d.service], ['Name', d.name], ['Email', d.email]]
    )
  })
};

// Aliases so the same underlying template covers several of the spec's
// named cases without duplicating markup for content that only differs
// by label (audio/video/spell/numerology/energy-healing "ready" emails
// are all, structurally, "your delivery is ready").
TEMPLATES.audio_ready = TEMPLATES.delivery_ready;
TEMPLATES.video_ready = TEMPLATES.delivery_ready;
TEMPLATES.spell_ready = TEMPLATES.delivery_ready;
TEMPLATES.numerology_ready = TEMPLATES.delivery_ready;
TEMPLATES.energy_healing_ready = TEMPLATES.delivery_ready;
TEMPLATES.tarot_audio_ready = TEMPLATES.delivery_ready;

function renderTemplate(templateType, payload) {
  const renderer = TEMPLATES[templateType];
  if (!renderer) throw new Error(`Unknown email template_type: ${templateType}`);
  return renderer(payload || {});
}

module.exports = { renderTemplate, TEMPLATES: Object.keys(TEMPLATES) };
