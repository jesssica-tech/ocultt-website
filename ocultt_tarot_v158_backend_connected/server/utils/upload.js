// ── Video storage for Spell ritual videos ──────────────────────────
// Uses Cloudinary's free tier. Set CLOUDINARY_* in .env — see
// server/.env.example for the 2-minute account setup.

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
  console.warn('[upload] CLOUDINARY_* env vars not set — spell video upload/record will return 503 until configured.');
}

// Keep the file in memory (not on disk) — Render's filesystem is ephemeral
// anyway, and these videos are small enough (client already limits size).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function uploadVideoBuffer(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: 'ocultt-spell-videos', public_id: publicId, overwrite: true },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

module.exports = { upload, uploadVideoBuffer, CLOUDINARY_CONFIGURED };
