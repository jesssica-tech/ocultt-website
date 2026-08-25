// ── Booking attachments (images/documents) + "Send Everything to Client" ──
// V190. Two things this file does, both admin-only:
//
// 1. Real storage for images/documents dropped into a booking's Files &
//    Attachments panel. Previously these only existed as browser blob:
//    URLs — gone the moment the tab reloaded, never actually reaching
//    anyone. Now they upload to the same Cloudinary storage the video/
//    audio recorder already uses (see utils/upload.js), so they persist
//    and can genuinely be sent later.
//
// 2. POST /send-all — one real, server-sent email (not a mailto: link)
//    containing whatever Akanksha typed, the video/audio recording link
//    (sending it now too if it hasn't gone out yet), and the actual
//    image/document files as real attachments. She never leaves the CRM;
//    the button just shows a real success/failure state.

const express = require('express');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { upload, uploadFileBuffer, getSignedDeliveryUrl, CLOUDINARY_CONFIGURED } = require('../utils/upload');
const { getTransporter, resolveConfig } = require('../utils/mailer');

const router = express.Router();

// Keep a real email from silently failing because Resend (or the
// recipient's own mail server) rejects an oversized message — cap the
// TOTAL attached bytes per send generously below common ~25MB provider
// limits, and tell Akanksha plainly if something had to be skipped
// rather than let the whole send fail with no explanation.
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function isNonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

// ── POST /api/bookings/:id/attachments/upload ── admin, multipart 'file'
// field, body also has category: 'image' | 'document'.
router.post('/bookings/:id/attachments/upload', adminAuth, upload.single('file'), async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  if (!CLOUDINARY_CONFIGURED) return res.status(503).json({ success: false, error: 'File storage is not configured yet (Cloudinary).' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No file received.' });

  const category = req.body.category === 'document' ? 'document' : 'image';
  const resourceType = category === 'document' ? 'raw' : 'image';

  try {
    const { data: booking, error: bErr } = await supabase.from('bookings').select('attachments_json').eq('id', req.params.id).maybeSingle();
    if (bErr || !booking) return res.status(404).json({ success: false, error: 'Booking not found.' });

    const publicId = `attach-${req.params.id}-${category}-${Date.now()}`;
    const result = await uploadFileBuffer(req.file.buffer, publicId, resourceType);

    const entry = {
      id: 'A-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      category,
      publicId: result.public_id,
      resourceType,
      originalName: req.file.originalname || (category === 'image' ? 'image' : 'document'),
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    const current = Array.isArray(booking.attachments_json) ? booking.attachments_json : [];
    const updated = [...current, entry];

    const { error: uErr } = await supabase.from('bookings').update({
      attachments_json: updated, updated_at: new Date().toISOString()
    }).eq('id', req.params.id);
    if (uErr) return res.status(500).json({ success: false, error: uErr.message });

    res.json({ success: true, attachment: entry, attachments: updated });
  } catch (err) {
    console.error('[attachments upload]', err.message);
    res.status(502).json({ success: false, error: 'Upload failed. Please try again.' });
  }
});

// ── DELETE /api/bookings/:id/attachments/:attachmentId ── admin, removes
// one entry (Cloudinary asset itself is just left as an orphaned file in
// the authenticated folder — not publicly reachable, and cheap enough on
// the free tier that a cleanup job isn't worth building for this).
router.delete('/bookings/:id/attachments/:attachmentId', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  const { data: booking, error: bErr } = await supabase.from('bookings').select('attachments_json').eq('id', req.params.id).maybeSingle();
  if (bErr || !booking) return res.status(404).json({ success: false, error: 'Booking not found.' });

  const current = Array.isArray(booking.attachments_json) ? booking.attachments_json : [];
  const updated = current.filter(a => a.id !== req.params.attachmentId);

  const { error: uErr } = await supabase.from('bookings').update({
    attachments_json: updated, updated_at: new Date().toISOString()
  }).eq('id', req.params.id);
  if (uErr) return res.status(500).json({ success: false, error: uErr.message });

  res.json({ success: true, attachments: updated });
});

// ── POST /api/bookings/:id/send-all ── admin. Body: { message? }.
// One real email, sent server-side: Akanksha's typed note, the video/
// audio recording link (sent now too if it hasn't gone out yet), and
// every stored image/document as a genuine attachment. Never leaves the
// CRM — the frontend just shows the success/failure this returns.
router.post('/bookings/:id/send-all', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  const { data: booking, error: bErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (bErr || !booking) return res.status(404).json({ success: false, error: 'Booking not found.' });

  const message = isNonEmpty(req.body.message) ? req.body.message.trim() : '';
  const attachmentsList = Array.isArray(booking.attachments_json) ? booking.attachments_json : [];

  if (!message && !booking.video_cloud_public_id && !attachmentsList.length) {
    return res.status(400).json({ success: false, error: 'Nothing to send yet — write a note, upload a recording, or attach a file first.' });
  }

  try {
    // ── Recording link (video or audio) — mint fresh if one exists ──
    let recordingUrl = null, recordingLabel = null, expiresLabel = null;
    if (booking.video_cloud_public_id) {
      const expiresAtDate = booking.video_link_expires_at ? new Date(booking.video_link_expires_at) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      expiresLabel = expiresAtDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      recordingUrl = getSignedDeliveryUrl(booking.video_cloud_public_id, booking.video_cloud_resource_type || 'video', Math.floor(expiresAtDate.getTime() / 1000));
      recordingLabel = booking.video_media_type === 'audio' ? 'audio recording' : 'video recording';
    }

    // ── Real attachments — download each from Cloudinary server-side,
    // base64-encode, stop once the size cap is hit rather than fail the
    // whole send; anything skipped is reported back so Akanksha knows. ──
    const attachmentsForEmail = [];
    const skipped = [];
    let totalBytes = 0;
    for (const a of attachmentsList) {
      if (totalBytes >= MAX_TOTAL_ATTACHMENT_BYTES) { skipped.push(a.originalName); continue; }
      try {
        const url = getSignedDeliveryUrl(a.publicId, a.resourceType, Math.floor(Date.now() / 1000) + 300); // 5-min self-use link
        const fileRes = await fetch(url);
        if (!fileRes.ok) throw new Error('fetch failed: ' + fileRes.status);
        const buf = Buffer.from(await fileRes.arrayBuffer());
        if (totalBytes + buf.length > MAX_TOTAL_ATTACHMENT_BYTES) { skipped.push(a.originalName); continue; }
        totalBytes += buf.length;
        attachmentsForEmail.push({ filename: a.originalName, content: buf.toString('base64') });
      } catch (fileErr) {
        console.warn('[send-all] could not fetch attachment', a.id, fileErr.message);
        skipped.push(a.originalName);
      }
    }

    // ── Compose and send the one email ──
    const { fromAddress } = resolveConfig();
    const subject = `The Ocultt Tarot — ${booking.service || 'your booking'}${booking.id ? ' (' + booking.id + ')' : ''}`;
    let text = `Hi ${booking.name || 'there'},\n\n`;
    if (message) text += `${message}\n\n`;
    if (recordingUrl) text += `Here is the link to your ${recordingLabel}: ${recordingUrl}\n(This link expires ${expiresLabel}.)\n\n`;
    if (attachmentsForEmail.length) text += `Attached: ${attachmentsForEmail.map(a => a.filename).join(', ')}\n\n`;
    text += `— The Ocultt Tarot`;

    await getTransporter().sendMail({
      from: fromAddress,
      to: booking.email,
      subject,
      text,
      attachments: attachmentsForEmail
    });

    // Mark the recording sent (same bookkeeping the existing /media/send does)
    const updates = { updated_at: new Date().toISOString() };
    if (booking.video_cloud_public_id && !booking.video_sent) {
      updates.video_sent = true;
      updates.video_sent_at = new Date().toISOString();
      updates.status = 'Completed';
    }
    await supabase.from('bookings').update(updates).eq('id', req.params.id);

    res.json({
      success: true,
      recordingIncluded: !!recordingUrl,
      attachmentsSent: attachmentsForEmail.length,
      skipped
    });
  } catch (err) {
    console.error('[send-all]', err.message);
    res.status(502).json({ success: false, error: err.message || 'Failed to send. Please try again shortly.' });
  }
});

module.exports = router;
