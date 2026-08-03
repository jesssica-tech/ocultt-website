// ── Input validation & sanitization ─────────────────────────────────
// Everything here defends against two separate risk classes:
//   1. Garbage/oversized input (wrong types, absurd lengths) crashing
//      or degrading the server.
//   2. Email header injection — a classic mail-sending vulnerability
//      where a client sneaks \r\n into a header-bound field (e.g. "to"
//      or "subject") to inject extra headers like Bcc, turning your
//      transactional mailer into an open relay for spam.

const validator = require('validator');

const MAX_LENGTHS = {
  to: 254,          // RFC 5321 max mailbox length
  toName: 120,
  subject: 200,
  service: 120,
  package: 160,
  duration: 60,
  date: 60,
  time: 60,
  bookingId: 60,
  body: 5000
};

// Strips characters that have no legitimate reason to appear in a
// single-line header value and would only be there to inject headers.
function hasHeaderInjection(value) {
  return /[\r\n]/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates and normalizes the incoming payload.
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function validateEmailPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  // ── "to" — required, must look like a real email, no header injection ──
  if (!isNonEmptyString(raw.to)) {
    return { ok: false, error: 'Missing or invalid "to" address.' };
  }
  const to = raw.to.trim();
  if (hasHeaderInjection(to)) {
    return { ok: false, error: 'Invalid "to" address.' };
  }
  if (to.length > MAX_LENGTHS.to || !validator.isEmail(to)) {
    return { ok: false, error: 'Invalid "to" address.' };
  }

  // ── subject — optional, but if present must be a clean single line ──
  let subject = isNonEmptyString(raw.subject) ? raw.subject.trim() : '';
  if (subject) {
    if (hasHeaderInjection(subject) || subject.length > MAX_LENGTHS.subject) {
      return { ok: false, error: 'Invalid "subject".' };
    }
  }

  // ── Remaining fields — free text used only in the HTML/plain body,
  // which is HTML-escaped downstream, so we only enforce type + length
  // here (not full sanitization) to keep booking data intact. ──
  const textFields = ['toName', 'service', 'package', 'duration', 'date', 'time', 'bookingId', 'body'];
  const clean = { to, subject };
  for (const field of textFields) {
    const value = raw[field];
    if (value == null) { clean[field] = ''; continue; }
    if (typeof value !== 'string') {
      return { ok: false, error: `Field "${field}" must be a string.` };
    }
    if (value.length > MAX_LENGTHS[field]) {
      return { ok: false, error: `Field "${field}" is too long.` };
    }
    clean[field] = value;
  }

  // bookingId is also used to correlate CRM state — keep it as-is but
  // reject anything with control characters that shouldn't be in an ID.
  if (clean.bookingId && /[\r\n\t]/.test(clean.bookingId)) {
    return { ok: false, error: 'Invalid "bookingId".' };
  }

  return { ok: true, payload: clean };
}

module.exports = { validateEmailPayload };
