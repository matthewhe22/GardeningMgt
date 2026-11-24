// Fixes from the end-to-end review (batch 3: photo & storage hardening,
// off-site photo backup). Needs TEST_DATABASE_URL and TEST_S3_ENDPOINT.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_S3 = process.env.TEST_S3_ENDPOINT;
const reason = 'set TEST_DATABASE_URL and TEST_S3_ENDPOINT to run these';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('review batch 3: photo & storage hardening', { skip: !(TEST_DB && TEST_S3) && reason }, async (t) => {
  const runId = Date.now();
  const bucket = `gm-b3-${runId}`;
  const backupBucket = `gm-b3-backup-${runId}`;
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, DB_SKIP_INIT: '', SESSION_SECRET: 'test-secret-for-integration-tests',
    S3_BUCKET: bucket, S3_ENDPOINT: TEST_S3, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
    CRON_SECRET: 'b3-cron-secret',
  });
  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const { S3Client, CreateBucketCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: 'us-east-1', endpoint: TEST_S3, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await s3.send(new CreateBucketCommand({ Bucket: backupBucket }));
  const exists = async (b, key) => { try { await s3.send(new HeadObjectCommand({ Bucket: b, Key: key })); return true; } catch (_) { return false; } };
  const readObj = async (b, key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: b, Key: key }))).Body.transformToByteArray());

  const request = require('supertest');
  const app = require('../../src/server');
  const storage = require('../../src/storage');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');
  const { today } = require('../../src/time');

  async function user(tag, role) {
    const email = `b3-${tag}-${runId}@example.com`;
    const { id } = await q1('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [`B3 ${tag}`, email, bcrypt.hashSync('testpass123', 10), role]);
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    return { id, agent, csrf: extractCsrf((await agent.get('/')).text) };
  }
  const admin = await user('admin', 'admin');
  const g = await user('g', 'gardener');
  const prop = await q1("INSERT INTO properties (name, address) VALUES ('B3 Site', 'B3 St') RETURNING id");
  const newVisit = async (startedAgoMin = 5) => q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at)
    VALUES ($1, $2, $3, 'in_progress', now() - ($4 || ' minutes')::interval) RETURNING id`, [prop.id, g.id, today(), String(startedAgoMin)]);
  const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');
  const jpeg = (takenAt, color = '#2a6') => {
    const img = sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg();
    return (takenAt ? img.withExif({ IFD2: { DateTimeOriginal: stamp(takenAt), OffsetTimeOriginal: '+00:00' } }) : img).toBuffer();
  };
  const json = (path, body, who = g) => who.agent.post(path).set('X-CSRF-Token', who.csrf).send(body);
  async function directUpload(visitId, buf, extra = {}) {
    const pre = await json(`/visits/${visitId}/photo/presign`, { content_type: 'image/jpeg', size: buf.length, ...extra });
    assert.strictEqual(pre.status, 200, JSON.stringify(pre.body));
    const put = await fetch(pre.body.url, { method: 'PUT', headers: pre.body.headers, body: buf });
    assert.strictEqual(put.status, 200);
    return pre.body.ticket;
  }
  const fileOf = (ticket) => JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url').toString()).f;

  await t.test('complete stores exactly the bytes it checked, and rejects oversize uploads', async () => {
    const v = await newVisit();
    const buf = await jpeg(new Date());
    const ticket = await directUpload(v.id, buf);
    const done = await json(`/visits/${v.id}/photo/complete`, { ticket });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.ok((await readObj(bucket, `photos/${fileOf(ticket)}`)).equals(buf), 'final object = verified bytes');
    assert.ok(!(await exists(bucket, `photos/pending/${fileOf(ticket)}`)), 'pending copy removed');

    const pre = await json(`/visits/${v.id}/photo/presign`, { content_type: 'image/jpeg', size: 1000 });
    const big = Buffer.concat([buf, Buffer.alloc(10 * 1024 * 1024)]); // > 10 MB
    await fetch(pre.body.url, { method: 'PUT', headers: pre.body.headers, body: big });
    const res = await json(`/visits/${v.id}/photo/complete`, { ticket: pre.body.ticket });
    assert.strictEqual(res.status, 413);
    assert.ok(!(await exists(bucket, `photos/pending/${fileOf(pre.body.ticket)}`)), 'oversize upload deleted');
  });

  await t.test('a file swapped after it was checked is never what gets stored', async () => {
    const v = await newVisit();
    const good = await jpeg(new Date(), '#36a');
    const ticket = await directUpload(v.id, good);
    const name = fileOf(ticket);
    // Simulate the uploader overwriting the pending object (its signed link is
    // still valid) right after the server has read and checked it.
    const original = storage.getPendingBuffer;
    storage.getPendingBuffer = async (...args) => {
      const buf = await original(...args);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `photos/pending/${name}`, Body: Buffer.from('not the checked photo') }));
      return buf;
    };
    try {
      const res = await json(`/visits/${v.id}/photo/complete`, { ticket });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    } finally {
      storage.getPendingBuffer = original;
    }
    assert.ok((await readObj(bucket, `photos/${name}`)).equals(good), 'the stored photo is the checked one');
  });

  await t.test('concurrent completes of one upload all answer JSON success, one row', async () => {
    const v = await newVisit();
    const ticket = await directUpload(v.id, await jpeg(new Date(), '#a62'));
    const results = await Promise.all([1, 2, 3, 4].map(() => json(`/visits/${v.id}/photo/complete`, { ticket })));
    for (const r of results) {
      assert.match(r.headers['content-type'], /json/);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    const { c } = await q1('SELECT count(*)::int AS c FROM photos WHERE filename = $1', [fileOf(ticket)]);
    assert.strictEqual(c, 1);
  });

  await t.test('presign/complete errors are JSON with a useful message', async () => {
    const v = await newVisit();
    const res = await g.agent.post(`/visits/${v.id}/photo/presign`).send({ content_type: 'image/jpeg', size: 10 });
    assert.strictEqual(res.status, 403);
    assert.match(res.headers['content-type'], /json/);
    assert.match(res.body.error, /session expired/i);
  });

  await t.test('image/jpg is a JPEG; HEIC gets a clear "use JPG" message', async () => {
    const v = await newVisit();
    const ok = await json(`/visits/${v.id}/photo/presign`, { content_type: 'image/jpg', size: 100 });
    assert.strictEqual(ok.status, 200);
    const heic = await json(`/visits/${v.id}/photo/presign`, { content_type: 'image/heic', size: 100 });
    assert.strictEqual(heic.status, 415);
    assert.match(heic.body.error, /Most Compatible/);
  });

  await t.test('photos taken well before the job started are rejected', async () => {
    const v = await newVisit(5); // started 5 minutes ago
    const early = await jpeg(new Date(Date.now() - 2 * 3600000)); // 2 h ago, within 12 h
    let ticket = await directUpload(v.id, early);
    const res = await json(`/visits/${v.id}/photo/complete`, { ticket });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.reason, 'beforejob');
    // A "before" photo taken just before tapping Start is fine.
    ticket = await directUpload(v.id, await jpeg(new Date(Date.now() - 20 * 60000)));
    assert.strictEqual((await json(`/visits/${v.id}/photo/complete`, { ticket })).status, 200);
  });

  await t.test('where the capture time came from is recorded and shown to staff', async () => {
    const v = await newVisit();
    const t1 = await directUpload(v.id, await jpeg(new Date()));
    await json(`/visits/${v.id}/photo/complete`, { ticket: t1 });
    const t2 = await directUpload(v.id, await jpeg(null)); // no EXIF: browser's time used
    await json(`/visits/${v.id}/photo/complete`, { ticket: t2, taken_at: Date.now() - 60000 });
    const rows = await q('SELECT filename, taken_source FROM photos WHERE filename = ANY($1)', [[fileOf(t1), fileOf(t2)]]);
    const by = Object.fromEntries(rows.map((r) => [r.filename, r.taken_source]));
    assert.strictEqual(by[fileOf(t1)], 'exif');
    assert.strictEqual(by[fileOf(t2)], 'client');
    assert.match((await admin.agent.get(`/visits/${v.id}`)).text, /time from phone/);
    assert.doesNotMatch((await g.agent.get(`/visits/${v.id}`)).text, /time from phone/, 'only staff see the flag');
  });

  await t.test('a storage error is not cached as a broken photo', async () => {
    const v = await newVisit();
    const ticket = await directUpload(v.id, await jpeg(new Date()));
    await json(`/visits/${v.id}/photo/complete`, { ticket });
    const ok = await g.agent.get(`/uploads/${fileOf(ticket)}`);
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers['cache-control'], /immutable/);
    await storage.deleteObject(fileOf(ticket)); // the object goes missing
    const gone = await g.agent.get(`/uploads/${fileOf(ticket)}`);
    assert.strictEqual(gone.status, 404);
    assert.strictEqual(gone.headers['cache-control'], 'no-store', 'not cached for a year');
  });

  await t.test('orphaned photos in the bucket are swept; referenced ones and pending uploads are kept', async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `photos/orphan-${runId}.jpg`, Body: Buffer.from('x') }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `photos/pending/inflight-${runId}.jpg`, Body: Buffer.from('x') }));
    // A photo that has a row (and so must be kept).
    const kept = { filename: `kept-${runId}.jpg` };
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `photos/${kept.filename}`, Body: Buffer.from('x') }));
    await q("INSERT INTO photos (filename, data, uploaded_by) VALUES ($1, ''::bytea, $2)", [kept.filename, g.id]);
    assert.strictEqual(await storage.sweepOrphans(q), 0, 'nothing younger than 7 days is touched');
    const removed = await storage.sweepOrphans(q, { olderThanMs: 0 });
    assert.ok(removed >= 1);
    assert.ok(!(await exists(bucket, `photos/orphan-${runId}.jpg`)), 'orphan removed');
    assert.ok(await exists(bucket, `photos/${kept.filename}`), 'photo with a row kept');
    assert.ok(await exists(bucket, `photos/pending/inflight-${runId}.jpg`), 'pending uploads left to their own sweep');
  });

  await t.test('photos are copied to the backup bucket once', async () => {
    const photoBackup = require('../../src/photoBackup');
    const { setSetting } = require('../../src/settings');
    for (const [k, v] of Object.entries({ photo_backup_enabled: '1', photo_backup_bucket: backupBucket,
      photo_backup_endpoint: TEST_S3, photo_backup_region: 'us-east-1',
      photo_backup_access_key_id: 'test', photo_backup_secret_access_key: 'test' })) await setSetting(k, v);
    const first = await photoBackup.backupPhotos(q, { maxMs: 30000 });
    assert.ok(first.copied >= 1, JSON.stringify(first));
    const any = await q1(`SELECT filename FROM photos WHERE backed_up_at IS NOT NULL AND filename LIKE $1 LIMIT 1`, ['%']);
    const original = await readObj(bucket, `photos/${any.filename}`).catch(() => null);
    if (original) assert.ok((await readObj(backupBucket, `photos/${any.filename}`)).equals(original), 'backup copy matches');
    const again = await photoBackup.backupPhotos(q, { maxMs: 30000 });
    assert.strictEqual(again.copied, 0, 'nothing copied twice');
  });

  await t.test('the daily job keeps going when one step fails, and records it', async () => {
    const original = storage.sweepOrphans;
    storage.sweepOrphans = async () => { throw new Error('simulated outage'); };
    try {
      const res = await request(app).get('/cron/reminders').set('Authorization', 'Bearer b3-cron-secret');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.failed, ['sweptOrphans']);
      assert.ok('photoBackup' in res.body && 'sent' in res.body && 'pruned' in res.body, 'later and earlier steps still ran');
      const log = await q1("SELECT details FROM activity_log WHERE action = 'system.cron_failed' ORDER BY id DESC LIMIT 1");
      assert.match(log.details, /sweptOrphans failed/);
    } finally {
      storage.sweepOrphans = original;
    }
  });

  await t.test('scripts/backup.js keeps every photo column and exact timestamps', async () => {
    const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'b3-backup-'));
    const target = `b3_restore_${runId}`;
    const sock = new URL(TEST_DB);
    const adminUrl = TEST_DB;
    execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'backup.js'), out], { env: { ...process.env, DATABASE_URL: adminUrl } });
    const dump = fs.readdirSync(out).find((f) => f.endsWith('.dump'));
    assert.ok(dump, 'a .dump file was written');
    await q(`CREATE DATABASE ${target}`);
    try {
      const targetUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${target}$1`);
      // A new database already has the public schema: restore everything else
      // (the same approach as scripts/db-move.sh and backup.js's instructions).
      const list = execFileSync('pg_restore', ['--list', path.join(out, dump)]).toString()
        .split('\n').filter((l) => !/ SCHEMA - public | COMMENT - SCHEMA public /.test(l)).join('\n');
      const listFile = path.join(out, 'restore.list');
      fs.writeFileSync(listFile, list);
      execFileSync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--use-list', listFile, '-d', targetUrl, path.join(out, dump)]);
      const { Client } = require('pg');
      const c = new Client({ connectionString: targetUrl });
      await c.connect();
      const sample = await q1("SELECT id, scope_check_id, task_id, taken_at::text AS taken, created_at::text AS created FROM photos WHERE taken_at IS NOT NULL ORDER BY id DESC LIMIT 1");
      const { rows: [restored] } = await c.query('SELECT id, scope_check_id, task_id, taken_at::text AS taken, created_at::text AS created FROM photos WHERE id = $1', [sample.id]);
      await c.end();
      assert.deepStrictEqual(restored, sample, 'links and timestamps identical after restore');
    } finally {
      await q(`DROP DATABASE IF EXISTS ${target}`);
      fs.rmSync(out, { recursive: true, force: true });
    }
    assert.ok(sock);
  });
});
