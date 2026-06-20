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

async function deleteObject(filename) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyFor(filename) }));
}

module.exports = { enabled, keyFor, putObject, getObjectStream, deleteObject };
