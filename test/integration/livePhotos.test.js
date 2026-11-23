// Integration tests for live job photos: photos only while the job runs,
// fresh capture time required, and every scope item needs a photo before the
// job can be completed. Runs only when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('live job photos', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());

  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');

  const runId = Date.now();
  const email = `lp-g-${runId}@example.com`;
  const { id: gid } = await q1(
    "INSERT INTO users (name, email, password_hash, role) VALUES ('LP Gardener', $1, $2, 'gardener') RETURNING id",
    [email, bcrypt.hashSync('testpass123', 10)]);
  const agent = request.agent(app);
  const lp = await agent.get('/login');
  await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
  const csrf = extractCsrf((await agent.get('/')).text);

  const prop = await q1("INSERT INTO properties (name, address) VALUES ('LP Site', 'LP St') RETURNING id");
  const job = await q1(
    "INSERT INTO jobs (property_id, gardener_id, start_date, end_date) VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 365) RETURNING id",
    [prop.id, gid]);
  await q("INSERT INTO job_scopes (job_id, position, title) VALUES ($1, 1, 'Mow lawn'), ($1, 2, 'Weed beds')", [job.id]);
  const visit = await q1(
    "INSERT INTO visits (property_id, gardener_id, job_id, scheduled_date, status) VALUES ($1, $2, $3, CURRENT_DATE, 'scheduled') RETURNING id",
    [prop.id, gid, job.id]);

  const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');
  const photo = (takenAt) => {
    const img = sharp({ create: { width: 40, height: 30, channels: 3, background: '#285' } }).jpeg();
    return (takenAt ? img.withExif({ IFD2: { DateTimeOriginal: stamp(takenAt), OffsetTimeOriginal: '+00:00' } }) : img).toBuffer();
  };
  const send = async (buf, fields = {}) => {
    let r = agent.post(`/visits/${visit.id}/photo?_csrf=${csrf}`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('photo', buf, 'p.jpg');
  };
  const photoCount = async () => (await q1('SELECT COUNT(*)::int AS c FROM photos WHERE visit_id = $1', [visit.id])).c;

  const task = await q1("INSERT INTO tasks (visit_id, assignee_id, title, created_by) VALUES ($1, $2, 'Fix tap', $2) RETURNING id",
    [visit.id, gid]);

  // Render once so the checklist rows exist.
  await agent.get(`/visits/${visit.id}`);
  const checks = await q('SELECT id FROM visit_scope_checks WHERE visit_id = $1 ORDER BY position', [visit.id]);
  assert.strictEqual(checks.length, 2);

  await t.test('photos are refused before the job is started', async () => {
    const res = await send(await photo(new Date()));
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(await photoCount(), 0);
  });

  await t.test('start the job', async () => {
    const res = await agent.post(`/visits/${visit.id}/timer/start`).type('form').send({ _csrf: csrf });
    assert.strictEqual(res.status, 302);
  });

  await t.test('a days-old photo is rejected, even with a fresh client taken_at', async () => {
    const res = await send(await photo(new Date(Date.now() - 3 * 86400000)), { taken_at: String(Date.now()) });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.reason, 'old');
    assert.strictEqual(await photoCount(), 0);
  });

  await t.test('a photo with no capture time at all is rejected', async () => {
    const res = await send(await photo(null));
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.reason, 'nodate');
  });

  await t.test('a request without the CSRF token gets a JSON 403', async () => {
    const res = await agent.post(`/visits/${visit.id}/photo`).attach('photo', await photo(new Date()), 'p.jpg');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.ok, false);
  });

  await t.test('a fresh photo for item 1 is saved with its capture time', async () => {
    const taken = new Date(Date.now() - 10 * 60000);
    const res = await send(await photo(taken), { check_id: String(checks[0].id) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    const row = await q1(`SELECT scope_check_id, shared,
      EXTRACT(EPOCH FROM taken_at AT TIME ZONE 'UTC')::float8 * 1000 AS taken_ms
      FROM photos WHERE filename = $1`, [res.body.filename]);
    assert.strictEqual(row.scope_check_id, checks[0].id);
    assert.strictEqual(row.shared, false);
    assert.ok(Math.abs(row.taken_ms - taken.getTime()) < 1000, 'taken_at is the EXIF capture time (UTC)');
  });

  await t.test('an EXIF-less photo (e.g. HEIC sent as-is) is accepted on the browser capture time', async () => {
    const res = await send(await photo(null), { taken_at: String(Date.now() - 60000) });
    assert.strictEqual(res.status, 200);
  });

  await t.test('tick both items done', async () => {
    for (const c of checks) {
      const res = await agent.post(`/visits/${visit.id}/scope/${c.id}?_csrf=${csrf}`).field('done', 'on');
      assert.strictEqual(res.status, 302);
    }
    const { n } = await q1('SELECT COUNT(*)::int AS n FROM visit_scope_checks WHERE visit_id = $1 AND done', [visit.id]);
    assert.strictEqual(n, 2);
  });

  await t.test('cannot complete while item 2 has no photo', async () => {
    const res = await agent.post(`/visits/${visit.id}/timer/stop`).type('form').send({ _csrf: csrf, confirm_photos: 'on' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, new RegExp(`error=scopephotos&item=${checks[1].id}`));
    const v = await q1('SELECT status FROM visits WHERE id = $1', [visit.id]);
    assert.strictEqual(v.status, 'in_progress');
  });

  await t.test('the page tells the gardener which item needs a photo', async () => {
    const res = await agent.get(`/visits/${visit.id}?error=scopephotos`);
    assert.match(res.text, /1 scope item\(s\) still need a photo/);
    assert.match(res.text, /📷 needed/);
    assert.doesNotMatch(res.text, /Choose from library/);
  });

  await t.test('cannot complete while the ad-hoc task has no photo', async () => {
    const up = await send(await photo(new Date()), { check_id: String(checks[1].id) });
    assert.strictEqual(up.status, 200);
    const res = await agent.post(`/visits/${visit.id}/timer/stop`).type('form').send({ _csrf: csrf, confirm_photos: 'on' });
    assert.match(res.headers.location, /error=taskphotos/);
    const page = await agent.get(`/visits/${visit.id}?error=taskphotos`);
    assert.match(page.text, /1 task\(s\) still need a photo: Fix tap/);
    assert.match(page.text, /data-task-id="\d+"/);
  });

  await t.test('a task id from another job is refused', async () => {
    const other = await q1("INSERT INTO tasks (title, created_by) VALUES ('Elsewhere', $1) RETURNING id", [gid]);
    const res = await send(await photo(new Date()), { task_id: String(other.id) });
    assert.strictEqual(res.status, 404);
  });

  await t.test('after a task photo, the job completes', async () => {
    const up = await send(await photo(new Date()), { task_id: String(task.id) });
    assert.strictEqual(up.status, 200);
    const row = await q1('SELECT task_id, shared, caption FROM photos WHERE filename = $1', [up.body.filename]);
    assert.deepStrictEqual(row, { task_id: task.id, shared: false, caption: 'Fix tap' });
    const res = await agent.post(`/visits/${visit.id}/timer/stop`).type('form').send({ _csrf: csrf, confirm_photos: 'on' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, `/visits/${visit.id}`);
    const v = await q1('SELECT status FROM visits WHERE id = $1', [visit.id]);
    assert.strictEqual(v.status, 'completed');
  });

  await t.test('no more photos once the job is completed', async () => {
    const before = await photoCount();
    const res = await send(await photo(new Date()));
    assert.strictEqual(res.status, 409);
    const legacy = await agent.post(`/visits/${visit.id}/photos?_csrf=${csrf}`).attach('photos', await photo(new Date()), 'x.jpg');
    assert.match(legacy.headers.location, /error=locked/);
    assert.strictEqual(await photoCount(), before);
  });

  await t.test('the gardener cannot delete evidence photos once the job is submitted', async () => {
    const ph = await q1('SELECT id FROM photos WHERE task_id = $1', [task.id]);
    const res = await agent.post(`/photos/${ph.id}/delete`).type('form').send({ _csrf: csrf });
    assert.match(res.headers.location, /error=locked/);
    assert.ok(await q1('SELECT 1 FROM photos WHERE id = $1', [ph.id]));
  });

  await t.test('without a bucket, presign tells the browser to use the app upload', async () => {
    const res = await agent.post(`/visits/${visit.id}/photo/presign`).set('X-CSRF-Token', csrf).send({});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.direct, false);
  });
});
