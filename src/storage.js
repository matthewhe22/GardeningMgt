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

const BUCKET = process.env.S3_BUCKET || '';
const PREFIX = process.env.S3_PREFIX || 'photos/';
let client = null;

const enabled = () => !!BUCKET;
const keyFor = (filename) => `${PREFIX}${filename}`;

function getClient() {
  if (client) return client;
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    // R2 / MinIO / Supabase need path-style addressing; AWS uses virtual-host.
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
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
    { expiresIn });
}

/** Size (bytes) and content type of a pending upload, or null if it isn't there. */
async function headPending(filename) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const out = await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: pendingKey(filename) }));
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
 * Origins the browser PUTs to, for the page's CSP connect-src. Path-style
 * custom endpoints (R2/MinIO/Supabase) use the endpoint's origin; AWS uses the
 * bucket's virtual-host names. S3_UPLOAD_ORIGIN overrides (comma-separated).
 */
function uploadOrigins() {
  if (!enabled()) return [];
  if (process.env.S3_UPLOAD_ORIGIN) return process.env.S3_UPLOAD_ORIGIN.split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.S3_ENDPOINT) {
    try { return [new URL(process.env.S3_ENDPOINT).origin]; } catch (_) { return []; }
  }
  const region = process.env.S3_REGION || 'us-east-1';
  return [`https://${BUCKET}.s3.${region}.amazonaws.com`, `https://${BUCKET}.s3.amazonaws.com`];
}

/** Direct browser uploads are on unless S3_DIRECT_UPLOADS=0 (e.g. no bucket CORS yet). */
const directUploads = () => enabled() && process.env.S3_DIRECT_UPLOADS !== '0';

module.exports = {
  enabled, keyFor, putObject, getObjectStream, getObjectBuffer, deleteObject,
  pendingKey, presignPendingPut, headPending, getPendingBuffer, promotePending, deletePending,
  uploadOrigins, directUploads,
};
