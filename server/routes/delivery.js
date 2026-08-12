// ── Secure file delivery ─────────────────────────────────────────────
// Generic system used by ANY service (Spell, Audio Tarot, Numerology,
// Energy Healing, ...): Akanksha attaches one or more files to a booking,
// finalizes, and the customer gets ONE secure link that shows everything
// in that package. The link expires 7 days after sending — enforced here
// server-side (query filters on expires_at, not a frontend timer), and
// again at the storage layer via Cloudinary's own signed-URL expiry
// (see utils/upload.js) as defense in depth.
//
// Draft workflow (matches "record → preview → delete/replace → finalize"):
//   POST   /api/bookings/:id/delivery/files      — admin, add a file to the draft package
//   DELETE /api/delivery/files/:fileId           — admin, remove a file before sending
//   GET    /api/bookings/:id/delivery            — admin, view current draft/sent package + files
//   POST   /api/bookings/:id/delivery/send       — admin, finalize: generates the token, emails the customer
//   GET    /api/delivery/:token                  — PUBLIC, customer-facing — validates + lists files

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { upload, uploadFileBuffer, getSignedDeliveryUrl, CLOUDINARY_CONFIGURED } = require('../utils/upload');
const { enqueueEmail } = require('../utils/queue');

const router = express.Router();

const DELIVERY_TTL_DAYS = 7;
const MAX_FILES_PER_PACKAGE = 12;

function isNonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

async function getOrCreateDraftPackage(bookingId) {
  const { data: existing } = await supabase.from('delivery_packages')
    .select('*').eq('booking_id', bookingId).eq('status', 'draft')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase.from('delivery_packages').insert({
    booking_id: bookingId,
    token: crypto.randomBytes(24).toString('base64url'),
    status: 'draft'
  }).select().maybeSingle();
  if (error) throw new Error(error.message);
  return created;
}

// ── POST /api/bookings/:id/delivery/files ── admin, multipart 'file' field.
// resourceType (video/image/raw) and label come as form fields alongside
// the file itself.
router.post('/bookings/:id/delivery/files', adminAuth, upload.single('file'), async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  if (!CLOUDINARY_CONFIGURED) return res.status(503).json({ ok: false, error: 'File storage is not configured yet (Cloudinary).' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });

  try {
    const pkg = await getOrCreateDraftPackage(req.params.id);

    const { count } = await supabase.from('delivery_files').select('id', { count: 'exact', head: true }).eq('package_id', pkg.id);
    if ((count || 0) >= MAX_FILES_PER_PACKAGE) {
      return res.status(400).json({ ok: false, error: `A single delivery is capped at ${MAX_FILES_PER_PACKAGE} files.` });
    }

    const fileType = (req.body.fileType || 'video').toLowerCase(); // video | audio | image | document
    const resourceType = fileType === 'image' ? 'image' : (fileType === 'document' ? 'raw' : 'video'); // audio uses Cloudinary's 'video' resource type
    const publicId = `${req.params.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await uploadFileBuffer(req.file.buffer, publicId, resourceType);

    const { data: fileRow, error } = await supabase.from('delivery_files').insert({
      package_id: pkg.id,
      file_type: fileType,
      label: (req.body.label || '').trim() || null,
      cloud_public_id: result.public_id,
      cloud_resource_type: resourceType
    }).select().maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });

    res.json({ ok: true, file: fileRow, packageId: pkg.id });
  } catch (err) {
    console.error('[delivery] file upload failed:', err.message);
    res.status(502).json({ ok: false, error: 'Upload failed. Please try again.' });
  }
});

// ── DELETE /api/delivery/files/:fileId ── admin, remove before finalizing.
router.delete('/delivery/files/:fileId', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  // Only allow deleting files that belong to a package that hasn't been sent yet —
  // once sent, the customer link is live and files shouldn't vanish under it.
  const { data: file } = await supabase.from('delivery_files').select('*, delivery_packages!inner(status)').eq('id', req.params.fileId).maybeSingle();
  if (!file) return res.status(404).json({ ok: false, error: 'File not found.' });
  if (file.delivery_packages?.status === 'sent') {
    return res.status(400).json({ ok: false, error: 'This delivery has already been sent — files can no longer be removed.' });
  }
  const { error } = await supabase.from('delivery_files').delete().eq('id', req.params.fileId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ── GET /api/bookings/:id/delivery ── admin, current draft/sent package + files.
router.get('/bookings/:id/delivery', adminAuth, async (req, res) => {
  if (!supabase) return res.json({ package: null, files: [] });
  const { data: pkg } = await supabase.from('delivery_packages').select('*').eq('booking_id', req.params.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!pkg) return res.json({ package: null, files: [] });
  const { data: files } = await supabase.from('delivery_files').select('*').eq('package_id', pkg.id).order('sort_order', { ascending: true });
  res.json({ package: pkg, files: files || [] });
});

// ── POST /api/bookings/:id/delivery/send ── admin, finalize + email customer.
router.post('/bookings/:id/delivery/send', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });

  const { data: booking, error: bErr } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (bErr || !booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  const { data: pkg } = await supabase.from('delivery_packages').select('*').eq('booking_id', req.params.id).eq('status', 'draft').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!pkg) return res.status(400).json({ ok: false, error: 'No draft delivery found — add at least one file first.' });

  const { data: files } = await supabase.from('delivery_files').select('id').eq('package_id', pkg.id);
  if (!files || !files.length) return res.status(400).json({ ok: false, error: 'This delivery has no files yet.' });

  const expiresAt = new Date(Date.now() + DELIVERY_TTL_DAYS * 24 * 60 * 60 * 1000);
  const title = (req.body.title || `Your ${booking.service || 'Ocultt Tarot'} is Ready`).trim();

  const { data: sentPkg, error: updErr } = await supabase.from('delivery_packages').update({
    status: 'sent', title, expires_at: expiresAt.toISOString(), sent_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }).eq('id', pkg.id).select().maybeSingle();
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  const deliveryUrl = `${(process.env.PUBLIC_SITE_URL || 'https://theocultttarot.com')}/delivery.html?token=${sentPkg.token}`;
  const expiresLabel = expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  await enqueueEmail({
    templateType: 'delivery_ready',
    recipient: booking.email,
    payload: { bookingId: booking.id, name: booking.name, title, serviceLabel: booking.service, deliveryUrl, expiresLabel },
    idempotencyKey: `delivery-ready-${sentPkg.id}`
  });

  await supabase.from('bookings').update({
    status: 'Sent', updated_at: new Date().toISOString()
  }).eq('id', booking.id);

  res.json({ ok: true, package: sentPkg, deliveryUrl });
});

// ── GET /api/delivery/:token ── PUBLIC, customer-facing. Rate-limited to
// blunt token-guessing/enumeration attempts (tokens are 24 random bytes,
// already infeasible to brute-force, but this is cheap defense in depth).
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

router.get('/delivery/:token', publicLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Not available yet.' });
  if (!isNonEmpty(req.params.token)) return res.status(400).json({ ok: false, error: 'Invalid link.' });

  const { data: pkg } = await supabase.from('delivery_packages').select('*').eq('token', req.params.token).eq('status', 'sent').maybeSingle();
  // Deliberately generic error for both "doesn't exist" and "expired" — no
  // hint to an attacker probing tokens about which case they hit.
  if (!pkg) return res.status(404).json({ ok: false, error: 'This link is invalid or has expired.' });
  if (pkg.expires_at && new Date(pkg.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ ok: false, error: 'This link has expired.' });
  }

  const { data: files } = await supabase.from('delivery_files').select('*').eq('package_id', pkg.id).order('sort_order', { ascending: true });

  const expiresAtSeconds = Math.floor(new Date(pkg.expires_at).getTime() / 1000);
  const signedFiles = (files || []).map(f => ({
    id: f.id,
    label: f.label || f.file_type,
    fileType: f.file_type,
    url: getSignedDeliveryUrl(f.cloud_public_id, f.cloud_resource_type, expiresAtSeconds)
  }));

  // Best-effort access tracking — never blocks the response.
  supabase.from('delivery_packages').update({
    accessed_count: (pkg.accessed_count || 0) + 1, last_accessed_at: new Date().toISOString()
  }).eq('id', pkg.id).then(() => {}, () => {});

  res.json({ ok: true, title: pkg.title, expiresAt: pkg.expires_at, files: signedFiles });
});

module.exports = router;
