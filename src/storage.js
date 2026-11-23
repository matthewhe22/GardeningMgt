// Optional S3-compatible object storage for photo bytes.
//
// When S3_BUCKET (+ credentials) is configured, photo bytes are stored in the
// bucket and the Postgres `photos.data` column holds an empty buffer; otherwise
// bytes live in Postgres as before (the default — nothing changes until you opt
// in). Storing images out of the database keeps it small and cuts the metered
// egress of streaming megabytes of photos through the DB on every view.
//
// Provider-agnostic: works with any S3-compatible service via env vars —
//   S3_BUCKET             bucket name (presence of this enables object storage)
//   S3_REGION             region (default us-east-1; Cloudflare R2 uses "auto")
//   S3_ENDPOINT           custom endpoint for R2 / Supabase / MinIO (omit for AWS)
//   S3_ACCESS_KEY_ID      access key
//   S3_SECRET_ACCESS_KEY  secret key
//   S3_PREFIX             key prefix (default "photos/")
//
// The AWS SDK is required lazily so it never loads on cold start unless storage
// is actually used.

// Values pasted into a hosting dashboard often pick up a stray space, a
// trailing line break or surrounding quotes. In the secret, any of those makes
// every request fail with an unhelpful 403 — so every S3_* value is cleaned on
// read. configReport() says which ones needed it.
function clean(v) {
  let s = String(v == null ? '' : v).trim();
  const quoted = s.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) s = quoted[2].trim();
  return s;
}
const env = (name) => {
  const v = clean(process.env[name]);
  return name === 'S3_ENDPOINT' ? v.replace(/\/+$/, '') : v;
};

const BUCKET = env('S3_BUCKET');
const PREFIX = env('S3_PREFIX') || 'photos/';
let client = null;

const enabled = () => !!BUCKET;
const keyFor = (filename) => `${PREFIX}${filename}`;

function getClient() {
  if (client) return client;
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: env('S3_REGION') || 'us-east-1',
    endpoint: env('S3_ENDPOINT') || undefined,
    // R2 / MinIO / Supabase need path-style addressing; AWS uses virtual-host.
    forcePathStyle: !!env('S3_ENDPOINT'),
    // Only send checksums when an operation requires them. The SDK's default
    // (WHEN_SUPPORTED) signs a CRC32 of the *empty* body into presigned PUT
    // URLs, so the real photo the browser then uploads fails the check — and
    // R2 / other S3-compatible stores don't all accept the trailing checksums
    // the SDK adds to server-side uploads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: (env('S3_ACCESS_KEY_ID') && env('S3_SECRET_ACCESS_KEY'))
      ? { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') }
      : undefined,
  });
  return client;
}

async function putObject(filename, buffer, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET, Key: keyFor(filename), Body: buffer, ContentType: contentType,
  }));
}

// Returns the object's bytes as a Node Readable stream (piped to the response).
async function getObjectStream(filename) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(filename) }));
  return out.Body;
}

// Buffers one object fully — for callers (e.g. the OneDrive archive) that
// need to hand the SDK a whole Buffer rather than pipe a stream to a response.
async function getObjectBuffer(filename) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(filename) }));
  return Buffer.from(await out.Body.transformToByteArray());
}

async function deleteObject(filename) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyFor(filename) }));
}

// --- Direct browser uploads ------------------------------------------------
// The browser PUTs a photo straight to the bucket with a short-lived presigned
// URL, under a separate "pending/" prefix. The server then verifies it and
// promotes it to its final key (a server-side copy, no bytes through the app).
// Anything never finalized (dropped connection, rejected photo the browser
// didn't wait for) stays under pending/ — add a bucket lifecycle rule that
// expires that prefix after a day to sweep those up.
const pendingKey = (filename) => `${PREFIX}pending/${filename}`;

/** Presigned PUT URL for a pending upload, bound to its content type. */
async function presignPendingPut(filename, contentType, expiresIn = 600) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getClient(),
    new PutObjectCommand({ Bucket: BUCKET, Key: pendingKey(filename), ContentType: contentType }),
    // Sign the Content-Type so the upload must use the type we approved.
    { expiresIn, signableHeaders: new Set(['content-type']) });
}

/** Size (bytes) and content type of a pending upload, or null if it isn't there. */
const headPending = (filename) => headKey(pendingKey(filename));
/** Same, for a photo at its final key. */
const headObject = (filename) => headKey(keyFor(filename));

async function headKey(Key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const out = await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    return { size: Number(out.ContentLength), contentType: out.ContentType || '' };
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return null;
    throw e;
  }
}

async function getPendingBuffer(filename) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: pendingKey(filename) }));
  return Buffer.from(await out.Body.transformToByteArray());
}

/** Move a verified pending upload to its final key (copy inside the bucket, then delete). */
async function promotePending(filename) {
  const { CopyObjectCommand } = require('@aws-sdk/client-s3');
  // The copy keeps the Content-Type the presigned PUT was bound to. (No
  // MetadataDirective: Supabase Storage only partly supports it.)
  await getClient().send(new CopyObjectCommand({
    Bucket: BUCKET, Key: keyFor(filename), CopySource: `${BUCKET}/${pendingKey(filename)}`,
  }));
  await deletePending(filename);
}

async function deletePending(filename) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: pendingKey(filename) }));
  } catch (_) { /* best-effort: the lifecycle rule sweeps leftovers */ }
}

/**
 * Delete unfinished uploads under pending/ older than `olderThanMs` (default
 * one day). Providers without bucket lifecycle rules (Supabase Storage) rely
 * on this — it runs from the daily cron job — and it's harmless elsewhere.
 * Returns how many objects were removed.
 */
async function sweepPending({ olderThanMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  if (!enabled()) return 0;
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const Prefix = pendingKey('');
  let removed = 0;
  let ContinuationToken;
  do {
    const out = await getClient().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, ContinuationToken }));
    for (const obj of out.Contents || []) {
      if (!obj.LastModified || now - obj.LastModified.getTime() < olderThanMs) continue;
      await deletePending(obj.Key.slice(Prefix.length));
      removed++;
    }
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return removed;
}

/** Create the bucket if it doesn't exist yet (private). Returns true if it was created. */
async function ensureBucket() {
  const { HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: BUCKET }));
    return false;
  } catch (e) {
    const code = e && (e.$metadata?.httpStatusCode);
    if (code !== 404 && e.name !== 'NotFound' && e.name !== 'NoSuchBucket') throw e;
  }
  await getClient().send(new CreateBucketCommand({ Bucket: BUCKET }));
  return true;
}

/**
 * Origins the browser PUTs to, for the page's CSP connect-src. Path-style
 * custom endpoints (R2/MinIO/Supabase) use the endpoint's origin; AWS uses the
 * bucket's virtual-host names. S3_UPLOAD_ORIGIN overrides (comma-separated).
 */
function uploadOrigins() {
  if (!enabled()) return [];
  if (env('S3_UPLOAD_ORIGIN')) return env('S3_UPLOAD_ORIGIN').split(',').map(clean).filter(Boolean);
  if (env('S3_ENDPOINT')) {
    try { return [new URL(env('S3_ENDPOINT')).origin]; } catch (_) { return []; }
  }
  const region = env('S3_REGION') || 'us-east-1';
  return [`https://${BUCKET}.s3.${region}.amazonaws.com`, `https://${BUCKET}.s3.amazonaws.com`];
}

/** Direct browser uploads are on unless S3_DIRECT_UPLOADS=0 (e.g. no bucket CORS yet). */
const directUploads = () => enabled() && env('S3_DIRECT_UPLOADS') !== '0';

// --- Diagnostics (admin "Test photo storage" button, setup script) ---------

const SETTING_NAMES = ['S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'S3_PREFIX', 'S3_DIRECT_UPLOADS'];
const mask = (v) => (v.length <= 8 ? '•'.repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-4)}`);

/**
 * What the app is using, without revealing secrets, plus plain-language
 * warnings about settings that look wrong. Safe to show to an admin.
 */
function configReport() {
  const settings = SETTING_NAMES.map((name) => {
    const raw = process.env[name];
    const value = env(name);
    const shown = !value ? ''
      : name === 'S3_SECRET_ACCESS_KEY' ? `set (${value.length} characters)`
        : name === 'S3_ACCESS_KEY_ID' ? mask(value) : value;
    return { name, set: !!value, shown, cleaned: raw != null && raw !== value && raw.trim() !== '' };
  });
  const warnings = [];
  const endpoint = env('S3_ENDPOINT');
  const region = env('S3_REGION');
  let host = '';
  try { host = endpoint ? new URL(endpoint).hostname : ''; } catch (_) {
    warnings.push('S3_ENDPOINT is not a valid web address (it should start with https://).');
  }
  if (enabled()) {
    if (!env('S3_ACCESS_KEY_ID') || !env('S3_SECRET_ACCESS_KEY')) warnings.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must both be set.');
    if (/(^|\.)supabase\.co$/.test(host)) {
      if (!/\/storage\/v1\/s3$/.test(endpoint)) warnings.push('For Supabase, S3_ENDPOINT should end in /storage/v1/s3.');
      if (!region || region === 'auto' || region === 'us-east-1') {
        warnings.push(`For Supabase, S3_REGION must be your project's region (e.g. ap-southeast-2), not "${region || 'unset'}".`);
      }
    }
  }
  for (const s of settings) {
    if (s.cleaned) warnings.push(`${s.name} had extra spaces, a line break or quotes around it — the app now ignores them, but tidy the value in your hosting settings.`);
  }
  return { enabled: enabled(), direct: directUploads(), bucket: BUCKET, prefix: PREFIX, settings, warnings };
}

/** Turn a storage error into a sentence an admin can act on. */
function explainStorageError(e) {
  const name = (e && (e.name || e.Code || e.code)) || '';
  const status = e && e.$metadata && e.$metadata.httpStatusCode;
  const msg = String((e && e.message) || '');
  if (/SignatureDoesNotMatch/i.test(name + msg)) {
    return 'The secret key (S3_SECRET_ACCESS_KEY) does not match the access key ID. Copy it again exactly, or create a new access key and update both values.';
  }
  if (/InvalidAccessKeyId|InvalidKey|access key/i.test(name + msg)) {
    return 'Storage does not recognise the access key ID (S3_ACCESS_KEY_ID). It may have been deleted — create a new access key and update both values.';
  }
  if (/AuthorizationHeaderMalformed|InvalidRegion|region/i.test(name + msg) && status !== 403) {
    return `The region (S3_REGION) looks wrong: ${msg.slice(0, 160)}`;
  }
  if (/NoSuchBucket/i.test(name) || status === 404) {
    return `The bucket "${BUCKET}" does not exist. Create it (private), or fix S3_BUCKET.`;
  }
  if (status === 403 || /AccessDenied|Forbidden/i.test(name)) {
    return 'Storage refused the key (HTTP 403). Almost always the secret key does not match the access key ID (a typo, or a different key) — create a new access key and update S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(name + msg)) return 'Cannot find the storage server — check S3_ENDPOINT.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout|aborted/i.test(name + msg)) return 'Could not connect to the storage server in time — check S3_ENDPOINT, then try again.';
  return `${name || 'Error'}${status ? ` (HTTP ${status})` : ''}: ${msg.slice(0, 200)}`;
}

// A valid 1×1 JPEG, used as the test photo.
const TEST_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

/**
 * Exercise every call photo uploads make, from this server, with the settings
 * it is actually running with: bucket, server-side upload, a presigned upload
 * (what a phone does, minus the browser), head, promote, read back, delete.
 * Stops at the first failure. Leaves nothing behind.
 * @returns {{ ok: boolean, steps: {label: string, ok: boolean, detail?: string}[] }}
 */
async function selfTest() {
  const steps = [];
  if (!enabled()) return { ok: false, steps: [{ label: 'Photo storage is not configured (S3_BUCKET is empty) — photos are kept in the database.', ok: false }] };
  const name = `selftest-${Date.now()}.jpg`;
  const run = async (label, fn) => {
    try {
      const detail = await fn();
      steps.push({ label, ok: true, detail: detail || undefined });
      return true;
    } catch (e) {
      steps.push({ label, ok: false, detail: explainStorageError(e) });
      return false;
    }
  };
  const { HeadBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const ok = await run('Reach the bucket', () => getClient().send(new HeadBucketCommand({ Bucket: BUCKET })).then(() => null))
    && await run('Upload from the server (used when phones upload through the app)', () => getClient().send(new PutObjectCommand({
      Bucket: BUCKET, Key: pendingKey(name), Body: TEST_JPEG, ContentType: 'image/jpeg' })).then(() => deletePending(name)))
    && await run('Upload with a signed link (what phones do for direct uploads)', async () => {
      const url = await presignPendingPut(name, 'image/jpeg', 120);
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: TEST_JPEG });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1];
        throw Object.assign(new Error(body.replace(/\s+/g, ' ')), { name: code || `HTTP${res.status}`, $metadata: { httpStatusCode: res.status } });
      }
    })
    && await run('Check the uploaded photo', async () => {
      const head = await headPending(name);
      if (!head || head.size !== TEST_JPEG.length) throw new Error(`unexpected size ${head ? head.size : 'none'}`);
    })
    && await run('Move it into place', () => promotePending(name))
    && await run('Read it back', async () => {
      const back = await getObjectBuffer(name);
      if (!back.equals(TEST_JPEG)) throw new Error('read back different bytes');
    })
    && await run('Delete the test photo', () => deleteObject(name));
  if (!ok) { await deletePending(name); try { await deleteObject(name); } catch (_) { /* best-effort */ } }
  return { ok, steps };
}

module.exports = {
  clean, configReport, explainStorageError, selfTest, getClient,
  enabled, keyFor, putObject, getObjectStream, getObjectBuffer, deleteObject,
  headObject, pendingKey, presignPendingPut, headPending, getPendingBuffer, promotePending, deletePending,
  sweepPending, ensureBucket, uploadOrigins, directUploads,
};
