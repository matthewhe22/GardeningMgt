/**
 * Off-site copy of photo originals.
 *
 * Supabase's database backups don't include Storage, so photos kept in the
 * bucket would be lost with it (a deleted bucket, a bad key with delete
 * rights, a mistaken delete). When a second S3-compatible bucket is
 * configured, each photo is copied there once and `photos.backed_up_at` is
 * set. Deletions are never copied: the backup keeps everything.
 *
 *   BACKUP_S3_BUCKET             bucket name (enables backups)
 *   BACKUP_S3_ENDPOINT           e.g. https://<account>.r2.cloudflarestorage.com
 *   BACKUP_S3_REGION             region ("auto" for R2)
 *   BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY
 *
 * Objects use the same key as in the primary bucket (S3_PREFIX + filename).
 * The daily cron copies a time-boxed batch; `npm run backup:photos` copies the
 * whole backlog from a terminal.
 */
const storage = require('./storage');

const env = (name) => storage.clean(process.env[name]);
const enabled = () => !!env('BACKUP_S3_BUCKET') && storage.enabled();

let client = null;
function backupClient() {
  if (client) return client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const endpoint = env('BACKUP_S3_ENDPOINT').replace(/\/+$/, '');
  client = new S3Client({
    region: env('BACKUP_S3_REGION') || 'us-east-1',
    endpoint: endpoint || undefined,
    forcePathStyle: !!endpoint,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    // Don't let a hung storage server hold a request (or the daily job) open.
    requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 },
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: (env('BACKUP_S3_ACCESS_KEY_ID') && env('BACKUP_S3_SECRET_ACCESS_KEY'))
      ? { accessKeyId: env('BACKUP_S3_ACCESS_KEY_ID'), secretAccessKey: env('BACKUP_S3_SECRET_ACCESS_KEY') }
      : undefined,
  });
  return client;
}

/**
 * Copy not-yet-backed-up photos (those stored in the primary bucket) to the
 * backup bucket until `maxMs` has passed or `limit` photos are done.
 * @returns {Promise<{copied: number, failed: number, remaining: number}>}
 */
async function backupPhotos(q, { maxMs = 20000, limit = 1000 } = {}) {
  if (!enabled()) return { copied: 0, failed: 0, remaining: 0 };
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const started = Date.now();
  let copied = 0;
  let failed = 0;
  const rows = await q(`SELECT id, filename, mime FROM photos
    WHERE backed_up_at IS NULL AND octet_length(data) = 0 ORDER BY id LIMIT $1`, [limit]);
  for (const r of rows) {
    if (Date.now() - started > maxMs) break;
    try {
      const bytes = await storage.getObjectBuffer(r.filename);
      await backupClient().send(new PutObjectCommand({
        Bucket: env('BACKUP_S3_BUCKET'), Key: storage.keyFor(r.filename), Body: bytes,
        ContentType: r.mime || 'application/octet-stream',
      }));
      await q('UPDATE photos SET backed_up_at = now() WHERE id = $1', [r.id]);
      copied++;
    } catch (e) {
      failed++;
      console.warn(`[photo backup] #${r.id} ${r.filename}: ${e.name || ''} ${e.message}`);
    }
  }
  const { n } = (await q(`SELECT count(*)::int AS n FROM photos
    WHERE backed_up_at IS NULL AND octet_length(data) = 0`))[0];
  return { copied, failed, remaining: n };
}

module.exports = { enabled, backupPhotos };
