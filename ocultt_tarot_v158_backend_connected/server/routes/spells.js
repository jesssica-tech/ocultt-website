const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { upload, uploadVideoBuffer, CLOUDINARY_CONFIGURED } = require('../utils/upload');
const { verifyTransporter, redactSecrets } = require('../utils/mailer');
const { buildInternalNoticeHtml } = require('../utils/emailTemplate');
const { sendAdminNewBookingNotification } = require('../utils/notify');

const router = express.Router();

const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function isNonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

// ── POST /api/spells ── public, called by the Spell / Magic request form.
router.post('/spells', createLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  const b = req.body || {};
  if (!isNonEmpty(b.id) || !isNonEmpty(b.name) || !isNonEmpty(b.email)) {
    return res.status(400).json({ ok: false, error: 'Missing required fields (id, name, email).' });
  }

  const row = {
    id: b.id.trim(), service: 'Spell / Magic', package: b.spellCategory || 'Custom',
    name: b.name.trim(), email: b.email.trim(), phone: b.phone || null,
    spell_category: b.spellCategory || 'Custom', urgency: b.urgency || 'No rush',
    intention: b.goal || null, detail: b.detail || null, notes: b.notes || null,
    status: 'Booking Received', payment_status: 'Unpaid', workflow_stage: 'New Request'
  };
  const { error } = await supabase.from('bookings').upsert(row, { onConflict: 'id' });
  if (error) { console.error('[spells POST]', error.message); return res.status(500).json({ ok: false, error: 'Could not save request.' }); }
  sendAdminNewBookingNotification(row).catch(() => {});
  res.json({ ok: true, id: row.id });
});

// ── GET /api/spells ── admin, list + search — feeds the Spell Requests tab.
router.get('/spells', adminAuth, async (req, res) => {
  if (!supabase) return res.json({ spells: [] });
  const search = (req.query.search || '').trim();
  let query = supabase.from('bookings').select('*').eq('service', 'Spell / Magic').order('created_at', { ascending: false });
  if (search) {
    const safe = search.replace(/[%,]/g, '');
    query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%,id.ilike.%${safe}%`);
  }
  const { data, error } = await query;
  if (error) return res.json({ spells: [], error: error.message });
  // Map snake_case DB columns to the camelCase-ish shape renderAdminSpells() expects.
  const spells = (data || []).map(s => ({
    id: s.id, name: s.name, email: s.email, phone: s.phone,
    spell_category: s.spell_category, urgency: s.urgency,
    goal: s.intention, status: s.status, payment_status: s.payment_status,
    video_sent: s.video_sent, video_url: s.video_url,
    video_sent_at: s.video_sent_at, video_link_expires_at: s.video_link_expires_at,
    workflowStage: s.workflow_stage, stageHistory: s.stage_history,
    created_at: s.created_at
  }));
  res.json({ spells });
});

// ── PATCH /api/spells/:id/status ── admin
router.patch('/spells/:id/status', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  const status = (req.body || {}).status;
  if (!isNonEmpty(status)) return res.status(400).json({ ok: false, error: 'Missing status.' });
  const { error } = await supabase.from('bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ── POST /api/spells/:id/video/upload  and  /video/record ── admin,
// multipart 'video' field → Cloudinary → stores the URL + 7-day expiry.
async function handleVideoUpload(req, res) {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  if (!CLOUDINARY_CONFIGURED) return res.status(503).json({ success: false, error: 'Video storage is not configured yet (Cloudinary).' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No video file received.' });

  try {
    const result = await uploadVideoBuffer(req.file.buffer, `spell-${req.params.id}-${Date.now()}`);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('bookings').update({
      video_url: result.secure_url, video_link_expires_at: expiresAt, updated_at: new Date().toISOString()
    }).eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, spell: { video_url: result.secure_url }, expiresAt });
  } catch (err) {
    console.error('[spells video upload]', err.message);
    res.status(502).json({ success: false, error: 'Video upload failed. Please try again.' });
  }
}
router.post('/spells/:id/video/upload', adminAuth, upload.single('video'), handleVideoUpload);
router.post('/spells/:id/video/record', adminAuth, upload.single('video'), handleVideoUpload);

// ── POST /api/spells/:id/video/send ── admin, emails the client the video
// link and marks the request Completed.
router.post('/spells/:id/video/send', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: 'Database not configured yet.' });
  const { data: spell, error: sErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (sErr || !spell) return res.status(404).json({ success: false, error: 'Spell request not found.' });
  if (!spell.video_url) return res.status(400).json({ success: false, error: 'No video uploaded yet for this request.' });

  try {
    const transporter = await verifyTransporter();
    const fromName = process.env.GMAIL_FROM_NAME || 'The Ocultt Tarot';
    const fromUser = process.env.GMAIL_USER || process.env.EMAIL_USER;
    const expiresLabel = spell.video_link_expires_at ? new Date(spell.video_link_expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : 'in 7 days';

    await transporter.sendMail({
      from: `"${fromName}" <${fromUser}>`,
      to: spell.email,
      subject: `Your ${spell.spell_category || 'Spell'} Ritual Video is Ready`,
      html: buildInternalNoticeHtml(
        'Your Ritual Video is Ready',
        `Dear ${spell.name || 'Valued Client'}, your ritual video is ready to view.`,
        [
          ['Booking ID', spell.id],
          ['Spell', spell.spell_category],
          ['Video Link', spell.video_url],
          ['Link Expires', expiresLabel]
        ]
      )
    });

    const sentAt = new Date().toISOString();
    await supabase.from('bookings').update({
      video_sent: true, video_sent_at: sentAt, status: 'Completed', workflow_stage: 'Completed', updated_at: sentAt
    }).eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('[spells video send]', redactSecrets(err.message));
    res.status(502).json({ success: false, error: 'Failed to email the video link. Please try again shortly.' });
  }
});

module.exports = router;
