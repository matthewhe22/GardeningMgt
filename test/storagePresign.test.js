const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// storage.js reads its env at load, so build the URL in a child process with
// an R2-style configuration.
function presignedUrl() {
  const out = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'storage.js'))})
      .presignPendingPut('a.jpg', 'image/jpeg').then((u) => process.stdout.write(u));`], {
    env: { ...process.env, S3_BUCKET: 'bkt', S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      S3_REGION: 'auto', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' },
    encoding: 'utf8',
  });
  assert.strictEqual(out.status, 0, out.stderr);
  return new URL(out.stdout);
}

test('presigned upload URL carries no checksum of an empty body', () => {
  const u = presignedUrl();
  // A checksum computed before the photo exists would make every real upload
  // fail (R2 / AWS reject the mismatch). Regression guard for the SDK default.
  for (const k of u.searchParams.keys()) assert.doesNotMatch(k, /checksum/i, `unexpected ${k}`);
});

test('presigned upload URL is path-style, pending/ key, and signs the content type', () => {
  const u = presignedUrl();
  assert.strictEqual(u.origin, 'https://acct.r2.cloudflarestorage.com');
  assert.strictEqual(u.pathname, '/bkt/photos/pending/a.jpg');
  assert.match(u.searchParams.get('X-Amz-SignedHeaders'), /content-type/);
  assert.strictEqual(u.searchParams.get('X-Amz-Expires'), '600');
});
