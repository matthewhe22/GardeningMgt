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
  limits: { fileSize: 10 * 1024 * 1024 },
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

/** Insert one uploaded file; returns the generated filename key (or null if rejected). */
async function savePhoto(file, { caption = null, visitId = null, issueId = null, commentId = null, userId, shared = true }) {
  const ext = path.extname(file.originalname).toLowerCase();
  // Content sniff: reject files whose bytes don't match an allowed image type.
  if (!sniffOk(file.buffer, ext)) return null;
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const mime = ALLOWED.get(ext) || 'application/octet-stream';
  // Thumbnail generation reads the original buffer before it's potentially
  // pushed to object storage below, so this needs the pre-upload bytes.
  const thumbData = await makeThumbnail(file.buffer);
  // With object storage on, push the bytes to the bucket and keep an empty
  // buffer in `data` (the marker the serve path uses); otherwise store inline.
  // The (small) thumbnail always stays in Postgres regardless of storage mode
  // — cheap enough to keep the DB small while still avoiding a second
  // bucket round-trip on every gallery page view.
  let data = file.buffer;
  if (storage.enabled()) {
    await storage.putObject(filename, file.buffer, mime);
    data = Buffer.alloc(0);
  }
  await pool.query(
    `INSERT INTO photos (filename, original_name, mime, data, thumb_data, caption, visit_id, issue_id, visit_comment_id, uploaded_by, shared)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [filename, file.originalname, mime, data, thumbData, caption, visitId, issueId, commentId, userId, shared]
  );
  return filename;
}

module.exports = { upload, savePhoto, sniffOk, makeThumbnail };
