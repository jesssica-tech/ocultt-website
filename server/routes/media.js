// ── Generic recording delivery (video OR audio) ────────────────────────
// Extends the exact same proven pattern already used for Spell / Magic
// (see routes/spells.js's /video/upload, /video/record, /video/send) to
// every other service that can now have a recording delivered: Energy
// Healing, Numerology, and Audio Tarot Reading. Deliberately does NOT
// touch or replace the existing Spell routes — those keep working exactly
// as they already do; this is a new, separate, additive set of routes
// that operate on the same shared `bookings` table by id, the same way.
//
// The email templates this uses (energy_healing_ready, numerology_ready,
// tarot_audio_ready, spell_ready — all aliases of the same generic
// delivery_ready template) already existed in utils/templates.js before
// this file was written; nothing needed to change there.

const express = require('express');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { upload, uploadFileBuffer, getSignedDeliveryUrl, CLOUDINARY_CONFIGURED } = require('../utils/upload');
const { enqueueEmail } = require('../utils/queue');

const router = express.Router();

// Which "ready" email template alias applies to each service, and the
// human-readable label used in that email's subject/body.
const SERVICE_EMAIL = {
  'Spell / Magic':   { template: 'spell_ready',          label: 'Spell Ritual' },
  'Energy Healing':  { template: 'energy_healing_ready',  label: 'Energy Healing Session' },
  'Numerology':      { template: 'numerology_ready',      label: 'Numerology Reading' },
  'Tarot Reading':   { template: 'tarot_audio_ready',      label: 'Tarot Reading' },
  'Group Magic':     { template: 'delivery_ready',         label: 'Group Ritual' }
};

function resolveServiceEmail(service) {
  return SERVICE_EMAIL[service] || { template: 'delivery_ready', label: service || 'Recording' };
}

// ── POST /api/bookings/:id/media/upload  and  /media/record ── admin,
// multipart 'file' field, body also has mediaType: 'video' | 'audio' →
// Cloudinary (authenticated, signed-URL-only — see utils/upload.js) →
// stores the public_id + 7-day expiry on the booking row.
async function handleMediaUpload(req, res) {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  if (!CLOUDINARY_CONFIGURED) return res.status(503).json({ success: false, error: 'File storage is not configured yet (Cloudinary).' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No file received.' });

  const mediaType = req.body.mediaType === 'audio' ? 'audio' : 'video';
  // Cloudinary's own convention: audio uploads use resource_type 'video'
  // too (there's no separate 'audio' resource type) — see uploadFileBuffer.

  try {
    const publicId = `media-${req.params.id}-${Date.now()}`;
    const result = await uploadFileBuffer(req.file.buffer, publicId, 'video');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('bookings').update({
      video_url: result.public_id,
      video_cloud_public_id: result.public_id,
      video_cloud_resource_type: 'video',
      video_media_type: mediaType,   // 'video' or 'audio' — for CRM display only
      video_link_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, mediaType, publicId: result.public_id, expiresAt });
  } catch (err) {
    console.error('[media upload]', err.message);
    res.status(502).json({ success: false, error: 'Upload failed. Please try again.' });
  }
}
router.post('/bookings/:id/media/upload', adminAuth, upload.single('file'), handleMediaUpload);
router.post('/bookings/:id/media/record', adminAuth, upload.single('file'), handleMediaUpload);

// ── POST /api/bookings/:id/media/send ── admin, emails the client the
// secure recording link (video or audio) and marks the booking Completed.
router.post('/bookings/:id/media/send', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  const { data: booking, error: bErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (bErr || !booking) return res.status(404).json({ success: false, error: 'Booking not found.' });
  if (!booking.video_cloud_public_id) return res.status(400).json({ success: false, error: 'No recording uploaded yet for this booking.' });

  try {
    const expiresAtDate = booking.video_link_expires_at ? new Date(booking.video_link_expires_at) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const expiresLabel = expiresAtDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const deliveryUrl = getSignedDeliveryUrl(booking.video_cloud_public_id, booking.video_cloud_resource_type || 'video', Math.floor(expiresAtDate.getTime() / 1000));
    const { template, label } = resolveServiceEmail(booking.service);

    const result = await enqueueEmail({
      templateType: template,
      recipient: booking.email,
      payload: {
        bookingId: booking.id, name: booking.name,
        title: `Your ${label} is Ready`, serviceLabel: label,
        deliveryUrl, expiresLabel
      },
      idempotencyKey: `media-send-${booking.id}`
    });
    if (!result.ok) return res.status(502).json({ success: false, error: 'Failed to queue the email. Please try again shortly.' });

    const sentAt = new Date().toISOString();
    await supabase.from('bookings').update({
      video_sent: true, video_sent_at: sentAt, status: 'Completed', updated_at: sentAt
    }).eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('[media send]', err.message);
    res.status(502).json({ success: false, error: 'Failed to email the recording link. Please try again shortly.' });
  }
});

module.exports = router;
