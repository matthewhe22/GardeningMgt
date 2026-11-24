/**
 * Off-site copy of photo originals.
 *
 * Supabase's database backups don't include Storage, so photos kept in the
 * bucket would be lost with it (a deleted bucket, a bad key with delete
 * rights, a mistaken delete). When switched on in Settings, each photo is
 * copied once to a second S3-compatible bucket (e.g. Cloudflare R2) and
 * `photos.backed_up_at` is set. Deletions are never copied: the backup keeps
 * everything.
 *
 * Settings (/admin/settings → Off-site photo backup):
 *   photo_backup_enabled            '1' = on (off by default)
 *   photo_backup_bucket             bucket name
 *   photo_backup_endpoint           e.g. https://<account>.r2.cloudflarestorage.com
 *   photo_backup_region             region ("auto" for R2)
 *   photo_backup_access_key_id / photo_backup_secret_access_key (encrypted)
 *
 * Objects use the same key as in the primary bucket (S3_PREFIX + filename).
 * The daily cron copies a time-boxed batch; `npm run backup:photos` copies the
 * whole backlog from a terminal.
 */
const storage = require('./storage');

const SETTING_KEYS = ['photo_backup_enabled', 'photo_backup_bucket', 'photo_backup_endpoint', 'photo_backup_region',
  'photo_backup_access_key_id', 'photo_backup_secret_access_key'];

/** The backup settings, or null when switched off or incomplete. */
async function getConfig() {
  const { getSettings } = require('./settings');
  const s = await getSettings(SETTING_KEYS);
  const v = (k) => storage.clean(s[k]);
  const cfg = {
    on: s.photo_backup_enabled === '1',
    bucket: v('photo_backup_bucket'),
    endpoint: v('photo_backup_endpoint').replace(/\/+$/, ''),
    region: v('photo_backup_region') || 'auto',
    accessKeyId: v('photo_backup_access_key_id'),
    secretAccessKey: v('photo_backup_secret_access_key'),
  };
  cfg.complete = !!(cfg.bucket && cfg.endpoint && cfg.accessKeyId && cfg.secretAccessKey);
  return cfg;
}

/** True when backups are switched on, fully configured, and there's a photo bucket to copy from. */
async function enabled() {
  const cfg = await getConfig();
  return cfg.on && cfg.complete && storage.enabled();
}

let cached = { key: '', client: null };
function backupClient(cfg) {
  const key = [cfg.endpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey].join('|');
  if (cached.key === key) return cached.client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    // Don't let a hung storage server hold a request (or the daily job) open.
    requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 },
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  cached = { key, client };
  return client;
}

/**
 * Copy not-yet-backed-up photos (those stored in the primary bucket) to the
 * backup bucket until `maxMs` has passed or `limit` photos are done.
 * Does nothing while backups are switched off.
 * @returns {Promise<{copied: number, failed: number, remaining: number, off?: boolean}>}
 */
async function backupPhotos(q, { maxMs = 20000, limit = 1000 } = {}) {
  const cfg = await getConfig();
  if (!(cfg.on && cfg.complete && storage.enabled())) return { copied: 0, failed: 0, remaining: 0, off: true };
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
      await backupClient(cfg).send(new PutObjectCommand({
        Bucket: cfg.bucket, Key: storage.keyFor(r.filename), Body: bytes,
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

/**
 * Settings "Test backup": write, read back and delete a small object in the
 * backup bucket with the saved settings (works whether or not backups are on).
 */
async function selfTest() {
  const cfg = await getConfig();
  if (!cfg.complete) return { ok: false, message: 'Fill in the bucket, endpoint, access key ID and secret first.' };
  const { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const Key = storage.keyFor(`backup-selftest-${Date.now()}.txt`);
  const s3 = backupClient(cfg);
  try {
    await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body: 'GardeningMgt backup test', ContentType: 'text/plain' }));
    await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key }));
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key }));
    return { ok: true, message: `Wrote, read and deleted a test file in "${cfg.bucket}".`
      + (cfg.on ? '' : ' Backups are still switched off — tick "Back up photos daily" to start.') };
  } catch (e) {
    const status = e.$metadata && e.$metadata.httpStatusCode;
    const hint = status === 403 || e.name === 'AccessDenied' ? ' — check the access key and secret, and that the token may write to this bucket.'
      : status === 404 || e.name === 'NoSuchBucket' ? ' — check the bucket name.'
        : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|TimeoutError/i.test(`${e.name} ${e.code} ${e.message}`) ? ' — check the endpoint URL.' : '';
    return { ok: false, message: `${e.name || 'Error'}: ${e.message}${hint}` };
  }
}

module.exports = { enabled, backupPhotos, selfTest, getConfig, SETTING_KEYS };
