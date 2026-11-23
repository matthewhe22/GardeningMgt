// Integration tests for direct-to-bucket job photo uploads (presign -> PUT ->
// complete). Needs a database AND an S3-compatible endpoint, e.g.
//   moto_server -p 5055   (pip install "moto[server]")   or MinIO, then
//   TEST_DATABASE_URL=... TEST_S3_ENDPOINT=http://127.0.0.1:5055 npm run test:integration
// Skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_S3 = process.env.TEST_S3_ENDPOINT;
const reason = 'set TEST_DATABASE_URL and TEST_S3_ENDPOINT to run direct-upload tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('direct-to-bucket photo uploads', { skip: !(TEST_DB && TEST_S3) && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';
  const bucket = `gm-direct-${Date.now()}`;
  Object.assign(process.env, {
    S3_BUCKET: bucket, S3_ENDPOINT: TEST_S3, S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
  });

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const { S3Client, CreateBucketCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: 'us-east-1', endpoint: TEST_S3, forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const exists = async (key) => {
    try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch (_) { return false; }
  };

  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');

  const runId = Date.now();
  async function gardener(tag) {
    const email = `du-${tag}-${runId}@example.com`;
    const { id } = await q1(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'gardener') RETURNING id",
      [`DU ${tag}`, email, bcrypt.hashSync('testpass123', 10)]);
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    return { id, agent, csrf: extractCsrf((await agent.get('/')).text) };
  }
  const g = await gardener('a');
  const other = await gardener('b');

  const prop = await q1("INSERT INTO properties (name, address) VALUES ('DU Site', 'DU St') RETURNING id");
  const visit = await q1(
    "INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at) VALUES ($1, $2, CURRENT_DATE, 'in_progress', now()) RETURNING id",
    [prop.id, g.id]);
  const otherVisit = await q1(
    "INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at) VALUES ($1, $2, CURRENT_DATE, 'in_progress', now()) RETURNING id",
    [prop.id, other.id]);
  const task = await q1("INSERT INTO tasks (visit_id, title, created_by) VALUES ($1, 'Prune roses', $2) RETURNING id", [visit.id, g.id]);

  const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');
  const photo = (takenAt) => sharp({ create: { width: 48, height: 36, channels: 3, background: '#2a5' } }).jpeg()
    .withExif({ IFD2: { DateTimeOriginal: stamp(takenAt), OffsetTimeOriginal: '+00:00' } }).toBuffer();
  const post = (who, path, body) => who.agent.post(path).set('X-CSRF-Token', who.csrf).send(body);
  const presign = (body, who = g, v = visit) => post(who, `/visits/${v.id}/photo/presign`, body);
  const complete = (body, who = g, v = visit) => post(who, `/visits/${v.id}/photo/complete`, body);
  const put = (url, headers, buf) => fetch(url, { method: 'PUT', headers, body: buf });
  const pendingKey = (f) => `photos/pending/${f}`;
  const fileOf = (ticket) => JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url').toString()).f;

  await t.test('the page CSP lets the browser reach the bucket', async () => {
    const res = await g.agent.get(`/visits/${visit.id}`);
    assert.match(res.headers['content-security-policy'], new RegExp(`connect-src 'self' ${new URL(TEST_S3).origin}`));
    assert.match(res.text, /data-photo-direct="1"/);
  });

  await t.test('presign turns away a stale photo before it is uploaded', async () => {
    const res = await presign({ content_type: 'image/jpeg', size: 1000, taken_at: Date.now() - 3 * 86400000 });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.reason, 'old');
  });

  await t.test('presign rejects unsupported types and oversize files', async () => {
    assert.strictEqual((await presign({ content_type: 'application/pdf', size: 1000 })).status, 415);
    assert.strictEqual((await presign({ content_type: 'image/jpeg', size: 11 * 1024 * 1024 })).status, 413);
  });

  let first;
  await t.test('presign -> PUT -> complete stores a task photo in the bucket', async () => {
    const buf = await photo(new Date(Date.now() - 60000));
    const pre = await presign({ content_type: 'image/jpeg', size: buf.length, task_id: task.id, taken_at: Date.now() });
    assert.strictEqual(pre.status, 200);
    assert.strictEqual(pre.body.direct, true);
    assert.match(pre.body.url, /pending\//);
    const up = await put(pre.body.url, pre.body.headers, buf);
    assert.strictEqual(up.status, 200);
    const done = await complete({ ticket: pre.body.ticket, tz: 0 });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    first = done.body.filename;
    const row = await q1(`SELECT task_id, shared, caption, octet_length(data) AS dlen, thumb_data IS NOT NULL AS thumb,
      taken_at IS NOT NULL AS dated FROM photos WHERE filename = $1`, [first]);
    assert.deepStrictEqual(row, { task_id: task.id, shared: false, caption: 'Prune roses', dlen: 0, thumb: true, dated: true });
    assert.ok(await exists(`photos/${first}`), 'promoted to its final key');
    assert.ok(!(await exists(pendingKey(first))), 'pending copy removed');
  });

  await t.test('completing twice is harmless', async () => {
    const before = (await q1('SELECT COUNT(*)::int AS c FROM photos WHERE visit_id = $1', [visit.id])).c;
    // Re-issue the same ticket by presigning is not possible; reuse is the realistic retry.
    const pre = await presign({ content_type: 'image/jpeg', size: 10 });
    const buf = await photo(new Date());
    await put(pre.body.url, pre.body.headers, buf);
    assert.strictEqual((await complete({ ticket: pre.body.ticket })).status, 200);
    assert.strictEqual((await complete({ ticket: pre.body.ticket })).status, 200);
    const after = (await q1('SELECT COUNT(*)::int AS c FROM photos WHERE visit_id = $1', [visit.id])).c;
    assert.strictEqual(after, before + 1);
  });

  await t.test('the stored photo is served from the bucket', async () => {
    const res = await g.agent.get(`/uploads/${first}`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body[0], 0xff);
    assert.strictEqual(res.body[1], 0xd8);
  });

  await t.test('an old photo is rejected at complete even if the browser said it was new', async () => {
    const buf = await photo(new Date(Date.now() - 5 * 86400000));
    const pre = await presign({ content_type: 'image/jpeg', size: buf.length, taken_at: Date.now() });
    await put(pre.body.url, pre.body.headers, buf);
    const res = await complete({ ticket: pre.body.ticket, taken_at: Date.now() });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.reason, 'old');
    assert.ok(!(await exists(pendingKey(fileOf(pre.body.ticket)))), 'rejected upload deleted');
    assert.ok(!(await q1('SELECT 1 FROM photos WHERE filename = $1', [fileOf(pre.body.ticket)])));
  });

  await t.test('a non-image upload is rejected and deleted', async () => {
    const pre = await presign({ content_type: 'image/jpeg', size: 20, taken_at: Date.now() });
    await put(pre.body.url, pre.body.headers, Buffer.from('definitely not a jpeg'));
    const res = await complete({ ticket: pre.body.ticket, taken_at: Date.now() });
    assert.strictEqual(res.status, 415);
    assert.ok(!(await exists(pendingKey(fileOf(pre.body.ticket)))));
  });

  await t.test('complete without the upload having reached the bucket', async () => {
    const pre = await presign({ content_type: 'image/jpeg', size: 20 });
    const res = await complete({ ticket: pre.body.ticket });
    assert.strictEqual(res.status, 404);
  });

  await t.test('tickets cannot be tampered with or used by someone else', async () => {
    const pre = await presign({ content_type: 'image/jpeg', size: 20 });
    const [payload, sig] = pre.body.ticket.split('.');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = `${Buffer.from(JSON.stringify({ ...data, t: null, c: 999 })).toString('base64url')}.${sig}`;
    assert.strictEqual((await complete({ ticket: forged })).status, 400);
    // Another gardener, on their own job, holding this ticket.
    assert.strictEqual((await complete({ ticket: pre.body.ticket }, other, otherVisit)).status, 400);
    // ...or on this job, which isn't theirs.
    assert.strictEqual((await complete({ ticket: pre.body.ticket }, other)).status, 403);
  });

  await t.test('a task on another job cannot be targeted', async () => {
    const t2 = await q1("INSERT INTO tasks (visit_id, title, created_by) VALUES ($1, 'Other', $2) RETURNING id", [otherVisit.id, other.id]);
    assert.strictEqual((await presign({ content_type: 'image/jpeg', size: 20, task_id: t2.id })).status, 404);
  });

  await t.test('the presign request needs the CSRF token', async () => {
    const res = await g.agent.post(`/visits/${visit.id}/photo/presign`).send({ content_type: 'image/jpeg', size: 20 });
    assert.strictEqual(res.status, 403);
  });
});

test('storage housekeeping: ensureBucket and sweeping stale pending uploads', { skip: !TEST_S3 && 'set TEST_S3_ENDPOINT' }, async () => {
  const bucket = `gm-sweep-${Date.now()}`;
  Object.assign(process.env, {
    S3_BUCKET: bucket, S3_ENDPOINT: TEST_S3, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
  });
  // storage.js reads its env at load: use a fresh copy.
  delete require.cache[require.resolve('../../src/storage')];
  const storage = require('../../src/storage');

  assert.strictEqual(await storage.ensureBucket(), true, 'creates a missing bucket');
  assert.strictEqual(await storage.ensureBucket(), false, 'leaves an existing bucket alone');

  const put = (key) => storage.putObject(key, Buffer.from('x'), 'image/jpeg');
  await put('keep.jpg');                       // a finished photo — never swept
  await storage.putObject('pending/a.jpg', Buffer.from('x'), 'image/jpeg').catch(() => {});
  // putObject writes under photos/; pending uploads live under photos/pending/.
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: 'us-east-1', endpoint: TEST_S3, forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  for (const n of ['p1.jpg', 'p2.jpg', 'p3.jpg']) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: storage.pendingKey(n), Body: Buffer.from('x') }));
  }
  assert.ok(await storage.headPending('p1.jpg'));

  assert.strictEqual(await storage.sweepPending(), 0, 'fresh pending uploads are left alone');
  const removed = await storage.sweepPending({ olderThanMs: 0 });
  assert.strictEqual(removed, 4, 'all pending uploads removed once they are "old" (3 + the stray one)');
  assert.strictEqual(await storage.headPending('p1.jpg'), null);
  assert.ok(await storage.headObject('keep.jpg'), 'finished photos are never touched');
});
