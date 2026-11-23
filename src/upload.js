const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { pool } = require('./db');
const storage = require('./storage');

const THUMB_WIDTH = 480;

// Best-effort: any format sharp can't decode (or a corrupt file that passed
// the magic-byte sniff) just yields no thumbnail — the serve route falls
// back to the original, so a failure here never blocks an upload.
async function makeThumbnail(buffer) {
  try {
    return await sharp(buffer, { failOn: 'none' })
      .rotate() // apply EXIF orientation before resizing, since the thumbnail drops the EXIF block
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch (e) {
    return null;
  }
}

const ALLOWED = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],   // iPhone default — accept rather than silently drop
  ['.heif', 'image/heif'],
]);

// Magic-byte signatures so we don't trust the extension alone.
function sniffOk(buf, ext) {
  if (!buf || buf.length < 12) return false;
  const hex = buf.subarray(0, 4).toString('hex');
  if (hex === 'ffd8ffe0' || hex === 'ffd8ffe1' || hex === 'ffd8ffe2' || hex.startsWith('ffd8ff')) return true; // jpeg
  if (hex === '89504e47') return true; // png
  if (buf.subarray(0, 3).toString() === 'GIF') return true; // gif
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return true; // webp
  if (buf.subarray(4, 8).toString() === 'ftyp') return true; // heic/heif (ISO-BMFF)
  return false;
}

// Files are held in memory and written to the photos table (bytea) — works
// on serverless hosts where the local filesystem is not persistent.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // = MAX_BYTES
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(path.extname(file.originalname).toLowerCase())) {
      const err = new Error('Unsupported image type. Use JPG, PNG, GIF, WEBP or HEIC.');
      err.code = 'LIMIT_UNEXPECTED_FILE';
      err.status = 415;
      return cb(err);
    }
    cb(null, true);
  },
});

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_EXT = new Map([...ALLOWED].filter(([e]) => e !== '.jpeg').map(([e, m]) => [m, e]));

function newFilename(ext) {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

/**
 * Record a photo row. `buffer` is the image (for the thumbnail); `inline`
 * says whether its bytes are stored in Postgres or already in the bucket.
 * Idempotent on filename (a repeated finalize is a no-op).
 */
async function insertPhotoRow({
  filename, originalName, mime, buffer, inline,
  caption = null, visitId = null, issueId = null, commentId = null,
  jobScopeId = null, scopeCheckId = null, libraryScopeId = null, taskId = null, userId, shared = true,
  takenAt = null,
}) {
  // The (small) thumbnail always stays in Postgres regardless of storage mode
  // — cheap enough to keep the DB small while still avoiding a second
  // bucket round-trip on every gallery page view.
  const thumbData = await makeThumbnail(buffer);
  await pool.query(
    `INSERT INTO photos (filename, original_name, mime, data, thumb_data, caption, visit_id, issue_id, visit_comment_id,
                         job_scope_id, scope_check_id, library_scope_id, uploaded_by, shared, taken_at, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             ($15::timestamptz AT TIME ZONE 'UTC'), $16)
     ON CONFLICT (filename) DO NOTHING`,
    [filename, originalName, mime, inline ? buffer : Buffer.alloc(0), thumbData, caption, visitId, issueId, commentId,
      jobScopeId, scopeCheckId, libraryScopeId, userId, shared, takenAt ? takenAt.toISOString() : null, taskId]
  );
  return filename;
}

/** Insert one uploaded file; returns the generated filename key (or null if rejected). */
async function savePhoto(file, opts) {
  const ext = path.extname(file.originalname).toLowerCase();
  // Content sniff: reject files whose bytes don't match an allowed image type.
  if (!sniffOk(file.buffer, ext)) return null;
  const filename = newFilename(ext);
  const mime = ALLOWED.get(ext) || 'application/octet-stream';
  // With object storage on, push the bytes to the bucket and keep an empty
  // buffer in `data` (the marker the serve path uses); otherwise store inline.
  if (storage.enabled()) await storage.putObject(filename, file.buffer, mime);
  return insertPhotoRow({ ...opts, filename, originalName: file.originalname, mime, buffer: file.buffer, inline: !storage.enabled() });
}

module.exports = { upload, savePhoto, insertPhotoRow, newFilename, sniffOk, makeThumbnail, MAX_BYTES, MIME_EXT };
