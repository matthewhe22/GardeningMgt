const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { pool } = require('./db');

const ALLOWED = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

// Files are held in memory and written to the photos table (bytea) — works
// on serverless hosts where the local filesystem is not persistent.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED.has(path.extname(file.originalname).toLowerCase()));
  },
});

/** Insert one uploaded file; returns the generated filename key. */
async function savePhoto(file, { caption = null, visitId = null, issueId = null, userId, shared = true }) {
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  await pool.query(
    `INSERT INTO photos (filename, original_name, mime, data, caption, visit_id, issue_id, uploaded_by, shared)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [filename, file.originalname, ALLOWED.get(ext) || 'application/octet-stream',
      file.buffer, caption, visitId, issueId, userId, shared]
  );
  return filename;
}

module.exports = { upload, savePhoto };
