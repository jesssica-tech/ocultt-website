// ── Booking confirmation email — HTML template ─────────────────────
// Deliberately plain inline-styled HTML (tables, inline CSS only) rather
// than the site's real stylesheet — most email clients (Gmail, Outlook,
// Apple Mail) strip <style> blocks and modern CSS, so inline styles on
// table-based markup is the only style guaranteed to render everywhere.

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function row(label, value) {
  if (!value) return '';
  return (
    '<tr>' +
      '<td style="padding:10px 0;border-bottom:1px solid #E3EFE9;font-family:Georgia,\'Times New Roman\',serif;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#6B8F7F;width:140px;vertical-align:top">' +
        esc(label) +
      '</td>' +
      '<td style="padding:10px 0;border-bottom:1px solid #E3EFE9;font-family:Georgia,\'Times New Roman\',serif;font-size:15px;color:#1A3329;vertical-align:top">' +
        esc(value) +
      '</td>' +
    '</tr>'
  );
}

/**
 * @param {Object} payload - the exact object sendBookingConfirmation() in
 *   js/script.js sends to POST /api/send-email. Expected fields:
 *   { toName, bookingId, service, package, duration, date, time, subject }
 */
function buildConfirmationEmailHtml(payload) {
  const name = payload.toName || 'Valued Client';

  return (
    '<!DOCTYPE html>' +
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml">' +
    '<head>' +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
      '<meta name="color-scheme" content="light">' +
      '<meta name="supported-color-schemes" content="light">' +
      '<title>Your Ocultt Booking is Confirmed</title>' +
      // Prevents iOS Mail / Outlook mobile from auto-resizing text, the
      // single most common cause of an email looking "broken" on phones.
      '<style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}img{-ms-interpolation-mode:bicubic}</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:#F7FAF8;width:100%!important">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7FAF8;padding:32px 16px">' +
        '<tr><td align="center">' +
          // Explicit width="560" alongside style max-width: Outlook's Word
          // rendering engine honors the HTML attribute, not the CSS property.
          '<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#FFFFFF;border:1px solid #E3EFE9;border-radius:8px;overflow:hidden">' +

            // Header band
            '<tr><td style="background:#123D30;padding:28px 32px;text-align:center">' +
              '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:12px;letter-spacing:0.35em;color:#B8DCCE;text-transform:uppercase;margin-bottom:6px">The Ocultt Tarot</div>' +
              '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:22px;color:#FFFFFF">Your Booking is Confirmed</div>' +
            '</td></tr>' +

            // Body
            '<tr><td style="padding:32px">' +
              '<p style="margin:0 0 18px;font-family:Georgia,\'Times New Roman\',serif;font-size:15px;line-height:1.7;color:#1A3329">' +
                'Dear ' + esc(name) + ',<br><br>' +
                'Thank you for booking with The Ocultt Tarot. Here are your session details:' +
              '</p>' +

              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">' +
                row('Booking ID', payload.bookingId) +
                row('Service', payload.service) +
                row('Package', payload.package) +
                row('Duration', payload.duration) +
                row('Date', payload.date) +
                row('Time (IST)', payload.time) +
              '</table>' +

              '<p style="margin:0 0 6px;font-family:Georgia,\'Times New Roman\',serif;font-size:14px;line-height:1.7;color:#4A6B5B">' +
                'Akankshaa will send your session link to this email address before your appointment.' +
              '</p>' +
              '<p style="margin:0;font-family:Georgia,\'Times New Roman\',serif;font-size:14px;line-height:1.7;color:#4A6B5B">' +
                'If you have any questions, simply reply to this email.' +
              '</p>' +
            '</td></tr>' +

            // Footer
            '<tr><td style="padding:20px 32px;background:#F0F8F4;border-top:1px solid #E3EFE9;text-align:center">' +
              '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:13px;color:#6B8F7F">With love &amp; light,<br>Akankshaa · The Ocultt Tarot</div>' +
            '</td></tr>' +

          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>'
  );
}

module.exports = { buildConfirmationEmailHtml };
