const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const storage = require('../src/storage');

const STORAGE = path.join(__dirname, '..', 'src', 'storage.js');
// storage.js reads its settings when loaded, so each case runs in a child.
function inChild(env, code) {
  const out = spawnSync(process.execPath, ['-e', `const storage = require(${JSON.stringify(STORAGE)}); (async () => { ${code} })();`], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  assert.strictEqual(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('clean() strips spaces, line breaks and surrounding quotes', () => {
  assert.strictEqual(storage.clean('  abc  '), 'abc');
  assert.strictEqual(storage.clean('abc\n'), 'abc');
  assert.strictEqual(storage.clean('abc\r\n'), 'abc');
  assert.strictEqual(storage.clean('"abc"'), 'abc');
  assert.strictEqual(storage.clean(" 'abc' \n"), 'abc');
  assert.strictEqual(storage.clean('a b'), 'a b', 'inner spaces are kept');
  assert.strictEqual(storage.clean(undefined), '');
});

test('the S3 client signs with the cleaned key and secret', () => {
  const creds = inChild({
    S3_BUCKET: ' photos\n', S3_ENDPOINT: 'https://abc.storage.supabase.co/storage/v1/s3/', S3_REGION: 'ap-southeast-2',
    S3_ACCESS_KEY_ID: ' key123 ', S3_SECRET_ACCESS_KEY: '"secret-xyz"\n',
  }, `const c = await storage.getClient().config.credentials();
      const ep = await storage.getClient().config.endpoint();
      process.stdout.write(JSON.stringify({ id: c.accessKeyId, secret: c.secretAccessKey, path: ep.path, bucket: storage.configReport().bucket }));`);
  assert.deepStrictEqual(creds, { id: 'key123', secret: 'secret-xyz', path: '/storage/v1/s3', bucket: 'photos' });
});

test('configReport: masks the key, never shows the secret, flags pasted extras', () => {
  const r = inChild({
    S3_BUCKET: 'photos', S3_ENDPOINT: 'https://abc.storage.supabase.co/storage/v1/s3', S3_REGION: 'ap-southeast-2',
    S3_ACCESS_KEY_ID: '24c5809a873f73d14ff123b62e4a1fe8', S3_SECRET_ACCESS_KEY: 'topsecretvalue1234\n',
  }, 'process.stdout.write(JSON.stringify(storage.configReport()));');
  const by = Object.fromEntries(r.settings.map((s) => [s.name, s]));
  assert.strictEqual(by.S3_ACCESS_KEY_ID.shown, '24c5…1fe8');
  assert.strictEqual(by.S3_SECRET_ACCESS_KEY.shown, 'set (18 characters)');
  assert.ok(!JSON.stringify(r).includes('topsecret'), 'the secret never appears in the report');
  assert.strictEqual(by.S3_SECRET_ACCESS_KEY.cleaned, true);
  assert.strictEqual(by.S3_BUCKET.cleaned, false);
  assert.ok(r.warnings.some((w) => /S3_SECRET_ACCESS_KEY had extra spaces/.test(w)));
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.direct, true);
});

test('configReport: warns about Supabase endpoint/region mistakes', () => {
  const r = inChild({
    S3_BUCKET: 'photos', S3_ENDPOINT: 'https://abc.supabase.co', S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_DIRECT_UPLOADS: '0',
  }, 'process.stdout.write(JSON.stringify(storage.configReport()));');
  assert.ok(r.warnings.some((w) => /should end in \/storage\/v1\/s3/.test(w)));
  assert.ok(r.warnings.some((w) => /S3_REGION must be your project's region/.test(w)));
  assert.strictEqual(r.direct, false);
});

test('configReport: storage off, and missing keys', () => {
  assert.deepStrictEqual(inChild({}, 'process.stdout.write(JSON.stringify(storage.configReport().enabled));'), false);
  const r = inChild({ S3_BUCKET: 'photos' }, 'process.stdout.write(JSON.stringify(storage.configReport()));');
  assert.ok(r.warnings.some((w) => /must both be set/.test(w)));
});

test('explainStorageError turns storage errors into actionable sentences', () => {
  const err = (name, status, message = '') => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
  assert.match(storage.explainStorageError(err('SignatureDoesNotMatch', 403)), /secret key .* does not match/);
  assert.match(storage.explainStorageError(err('InvalidAccessKeyId', 403)), /does not recognise the access key ID/);
  assert.match(storage.explainStorageError(err('AccessDenied', 403)), /refused the key \(HTTP 403\)/);
  assert.match(storage.explainStorageError(err('HTTP403', 403, '<Error>…</Error>')), /refused the key/);
  assert.match(storage.explainStorageError(err('NotFound', 404)), /does not exist/);
  assert.match(storage.explainStorageError(err('NoSuchBucket', 404)), /does not exist/);
  assert.match(storage.explainStorageError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })), /check S3_ENDPOINT/);
  assert.match(storage.explainStorageError(err('Weird', 500, 'boom')), /Weird \(HTTP 500\): boom/);
});

test('selfTest says plainly when storage is not configured', async () => {
  const r = inChild({}, 'process.stdout.write(JSON.stringify(await storage.selfTest()));');
  assert.strictEqual(r.ok, false);
  assert.match(r.steps[0].label, /not configured/);
});
