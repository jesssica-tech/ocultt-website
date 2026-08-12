// ── File storage for deliveries (Spell videos, CRM attachments, and the
// new generic delivery-package system) ──────────────────────────────
// Uses Cloudinary's free tier. Set CLOUDINARY_* in .env — see
// server/.env.example for the 2-minute account setup.
//
// Files are uploaded as Cloudinary "authenticated" delivery type (NOT the
// default public "upload" type). An authenticated asset has no public
// URL at all — every access requires a fresh, signed URL with its own
// expiry, generated server-side by getSignedDeliveryUrl() below. This is
// what actually enforces "the link stops working after 7 days" at the
// storage layer, on top of our own delivery_packages/token expiry check —
// two independent layers instead of relying on either alone.

const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

const CLOUDINARY_CONFIGURED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (CLOUDINARY_CONFIGURED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn('[upload] CLOUDINARY_* env vars not set — file upload/delivery will return 503 until configured.');
}

// Keep the file in memory (not on disk) — Render's filesystem is ephemeral
// anyway, and these files are small enough (client already limits size).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// resourceType: 'video' (covers audio too, per Cloudinary's own convention),
// 'image', or 'raw' (PDFs/reports/other documents).
function uploadFileBuffer(buffer, publicId, resourceType = 'video') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        type: 'authenticated',        // no public URL — access only via signed links
        folder: 'ocultt-deliveries',
        public_id: publicId,
        overwrite: true
      },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// Backward-compatible name used by the existing Spell video endpoints.
function uploadVideoBuffer(buffer, publicId) {
  return uploadFileBuffer(buffer, publicId, 'video');
}

// Mints a fresh, signed, time-limited URL for an authenticated asset.
// expiresAtUnixSeconds must be a Unix timestamp (seconds, not ms).
// Cloudinary itself rejects requests to this URL once expires_at has
// passed — this is the storage-layer half of the 7-day enforcement; the
// delivery_packages.token/expires_at check in delivery.js is the other,
// independent half (checked first, before we ever mint this URL).
function getSignedDeliveryUrl(publicId, resourceType, expiresAtUnixSeconds) {
  return cloudinary.url(publicId, {
    resource_type: resourceType || 'video',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    expires_at: expiresAtUnixSeconds
  });
}

module.exports = { upload, uploadFileBuffer, uploadVideoBuffer, getSignedDeliveryUrl, CLOUDINARY_CONFIGURED };
