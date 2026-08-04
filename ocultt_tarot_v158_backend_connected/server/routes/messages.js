const express = require('express');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { upload, uploadVideoBuffer, CLOUDINARY_CONFIGURED } = require('../utils/upload');
const { verifyTransporter, redactSecrets } = require('../utils/mailer');
const { buildInternalNoticeHtml } = require('../utils/emailTemplate');

const router = express.Router();

// ── GET /api/bookings/:id/messages ── admin, message thread for one booking.
router.get('/bookings/:id/messages', adminAuth, async (req, res) => {
  if (!supabase) return res.json({ messages: [] });
  const { data, error } = await supabase.from('messages').select('*').eq('booking_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data || [] });
});

// ── POST /api/bookings/:id/messages ── admin, send a message to the client
// by email (with an optional audio/video/image/pdf attachment), and log it
// in the CRM thread so nobody has to go check Gmail to know what was sent.
router.post('/bookings/:id/messages', adminAuth, upload.single('attachment'), async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const { data: booking, error: bErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (bErr || !booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  const subject = (req.body.subject || `A message from The Ocultt Tarot`).trim();
  const body = (req.body.body || '').trim();
  if (!body && !req.file) return res.status(400).json({ ok: false, error: 'Message body or attachment is required.' });

  let attachmentUrl = null;
  if (req.file) {
    if (!CLOUDINARY_CONFIGURED) return res.status(503).json({ ok: false, error: 'File storage is not configured yet (Cloudinary).' });
    try {
      const result = await uploadVideoBuffer(req.file.buffer, `message-${req.params.id}-${Date.now()}`);
      attachmentUrl = result.secure_url;
    } catch (err) {
      console.error('[messages attachment upload]', err.message);
      return res.status(502).json({ ok: false, error: 'Attachment upload failed.' });
    }
  }

  try {
    const transporter = await verifyTransporter();
    const fromName = process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot';
    const fromUser = process.env.GMAIL_USER || process.env.EMAIL_USER;
    const rows = [['Booking ID', booking.id]];
    if (attachmentUrl) rows.push(['Attachment', attachmentUrl]);

    await transporter.sendMail({
      from: `"${fromName}" <${fromUser}>`,
      to: booking.email,
      subject,
      text: body,
      html: buildInternalNoticeHtml(subject, body, rows)
    });
  } catch (err) {
    console.error('[messages send]', redactSecrets(err.message));
    return res.status(502).json({ ok: false, error: 'Failed to send the email. Please try again shortly.' });
  }

  const { data: saved, error: mErr } = await supabase.from('messages').insert({
    booking_id: req.params.id, customer_email: booking.email, direction: 'outbound', channel: 'email',
    subject, body, attachment_url: attachmentUrl, sent_by: req.adminEmail
  }).select().maybeSingle();
  if (mErr) console.warn('[messages] sent but failed to log:', mErr.message);

  res.json({ ok: true, message: saved || null });
});

module.exports = router;
