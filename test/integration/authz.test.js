// Integration tests that need a real Postgres, driven over real HTTP via
// supertest against the actual Express app (src/server.js). They run only
// when TEST_DATABASE_URL is set, and skip otherwise.
//
//   TEST_DATABASE_URL=postgres://localhost/gardeningmgt_test npm run test:integration
//
// A prior code review verified these authorization (IDOR) gates by hand
// (curl / live probing) but they had zero automated coverage. This file locks
// in the current, verified-correct behaviour so a future regression is
// caught by CI instead of only by a human re-testing manually:
//   - a gardener cannot view or act on another gardener's visit, task,
//     comment or photo
//   - a gardener cannot reach staff-only routes (/invoices, /admin/*, /reports)
//   - the /uploads/:filename route's current sharing rules (mirrors the
//     photo gallery: staff see everything; everyone else sees shared photos,
//     their own uploads, photos on a visit assigned to them, and any issue
//     photo since issues are team-wide)

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found in response HTML');
  return m[1];
}

test('authorization / IDOR gates', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());

  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');

  async function ensureUser(email, name, role) {
    const existing = await q1('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return existing.id;
    const { id } = await q1(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, email, bcrypt.hashSync('testpass123', 10), role]);
    return id;
  }

  async function loginAgent(email) {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login');
    const token = extractCsrf(loginPage.text);
    const res = await agent.post('/login').type('form')
      .send({ email, password: 'testpass123', _csrf: token });
    assert.strictEqual(res.status, 302, `login should succeed for ${email}`);
    const homePage = await agent.get('/');
    return { agent, csrf: extractCsrf(homePage.text) };
  }

  const gardenerAId = await ensureUser('authz-gardener-a@example.com', 'Authz Gardener A', 'gardener');
  const gardenerBId = await ensureUser('authz-gardener-b@example.com', 'Authz Gardener B', 'gardener');
  await ensureUser('authz-staff@example.com', 'Authz Staff', 'supervisor');

  const [{ agent: agentA, csrf: csrfA }, { agent: agentB, csrf: csrfB }] = await Promise.all([
    loginAgent('authz-gardener-a@example.com'),
    loginAgent('authz-gardener-b@example.com'),
  ]);

  const property = await q1(
    "INSERT INTO properties (name, address) VALUES ('Authz Site', 'Authz Addr') RETURNING id");
  const visit = await q1(`
    INSERT INTO visits (property_id, gardener_id, scheduled_date, status)
    VALUES ($1, $2, CURRENT_DATE, 'scheduled') RETURNING id`,
    [property.id, gardenerAId]);

  await t.test("gardener A (the assigned gardener) CAN view their own visit", async () => {
    const res = await agentA.get(`/visits/${visit.id}`);
    assert.strictEqual(res.status, 200);
  });

  await t.test("gardener B CANNOT view gardener A's visit", async () => {
    const res = await agentB.get(`/visits/${visit.id}`);
    assert.strictEqual(res.status, 403);
    assert.doesNotMatch(res.text, /Authz Site/, 'the forbidden response must not leak the property name');
  });

  await t.test("gardener B CANNOT reschedule gardener A's visit (silently no-ops)", async () => {
    const res = await agentB.post(`/visits/${visit.id}/reschedule`).type('form')
      .send({ scheduled_date: '2030-01-01', _csrf: csrfB });
    assert.strictEqual(res.status, 302);
    const row = await q1('SELECT scheduled_date FROM visits WHERE id = $1', [visit.id]);
    assert.notStrictEqual(String(row.scheduled_date), '2030-01-01', 'the date must be unchanged');
  });

  await t.test("gardener B CANNOT comment on gardener A's visit", async () => {
    const before = await q1('SELECT COUNT(*)::int AS c FROM visit_comments WHERE visit_id = $1', [visit.id]);
    const res = await agentB.post(`/visits/${visit.id}/comments`).type('form')
      .send({ body: 'sneaky comment', _csrf: csrfB });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/visits', 'should bounce to the list, not the visit');
    const after = await q1('SELECT COUNT(*)::int AS c FROM visit_comments WHERE visit_id = $1', [visit.id]);
    assert.strictEqual(after.c, before.c, 'no comment should have been inserted');
  });

  await t.test("gardener B CANNOT change the status of a task assigned via gardener A's visit", async () => {
    const task = await q1(`
      INSERT INTO tasks (visit_id, assignee_id, title, created_by)
      VALUES ($1, $2, 'Authz task', $3) RETURNING id, status`,
      [visit.id, gardenerAId, gardenerAId]);
    const res = await agentB.post(`/tasks/${task.id}/status`).type('form')
      .send({ status: 'done', _csrf: csrfB });
    assert.strictEqual(res.status, 302);
    const row = await q1('SELECT status FROM tasks WHERE id = $1', [task.id]);
    assert.strictEqual(row.status, task.status, 'the task status must be unchanged');
  });

  await t.test("gardener B CANNOT view a private photo uploaded to gardener A's visit", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
    const uploadRes = await agentA.post(`/visits/${visit.id}/photos?_csrf=${csrfA}`)
      .field('shared', '') // private: not shared
      .attach('photos', jpeg, 'evidence.jpg');
    assert.strictEqual(uploadRes.status, 302);
    const photo = await q1(
      'SELECT filename FROM photos WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]);
    assert.ok(photo, 'the photo should have been saved');

    const res = await agentB.get(`/uploads/${photo.filename}`);
    assert.strictEqual(res.status, 404, 'a private photo on someone else\'s visit must not be servable');
  });

  await t.test("gardener B CAN view a photo shared on gardener A's visit (current sharing rule)", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
    const uploadRes = await agentA.post(`/visits/${visit.id}/photos?_csrf=${csrfA}`)
      .field('shared', 'on')
      .attach('photos', png, 'shared.png');
    assert.strictEqual(uploadRes.status, 302);
    const photo = await q1(
      'SELECT filename FROM photos WHERE visit_id = $1 AND shared ORDER BY id DESC LIMIT 1', [visit.id]);
    assert.ok(photo);

    const res = await agentB.get(`/uploads/${photo.filename}`);
    assert.strictEqual(res.status, 200);
  });

  await t.test("gardener B CANNOT delete gardener A's private photo", async () => {
    const photo = await q1(
      "SELECT id FROM photos WHERE visit_id = $1 AND NOT shared ORDER BY id DESC LIMIT 1", [visit.id]);
    assert.ok(photo, 'precondition: a private photo from gardener A must exist');
    const res = await agentB.post(`/photos/${photo.id}/delete`).type('form').send({ _csrf: csrfB });
    assert.strictEqual(res.status, 403);
    const stillThere = await q1('SELECT id FROM photos WHERE id = $1', [photo.id]);
    assert.ok(stillThere, 'the photo must not have been deleted');
  });

  await t.test('an issue photo is visible to any authenticated user regardless of uploader (current, team-wide rule)', async () => {
    const issue = await q1(`
      INSERT INTO issues (title, property_id, priority, reported_by)
      VALUES ('Authz issue', $1, 'medium', $2) RETURNING id`, [property.id, gardenerAId]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(20)]);
    const uploadRes = await agentA.post(`/issues/${issue.id}/photos?_csrf=${csrfA}`)
      .attach('photos', jpeg, 'issue.jpg');
    assert.strictEqual(uploadRes.status, 302);
    const photo = await q1('SELECT filename FROM photos WHERE issue_id = $1', [issue.id]);
    assert.ok(photo);

    const res = await agentB.get(`/uploads/${photo.filename}`);
    assert.strictEqual(res.status, 200, 'issue photos are team-wide by current design');
  });

  await t.test('a gardener CANNOT reach /invoices (staff-only)', async () => {
    const res = await agentB.get('/invoices');
    assert.strictEqual(res.status, 403);
  });

  await t.test('a gardener CANNOT reach /reports (staff-only)', async () => {
    const res = await agentB.get('/reports');
    assert.strictEqual(res.status, 403);
  });

  await t.test('a gardener CANNOT reach /admin/users (admin-only)', async () => {
    const res = await agentB.get('/admin/users');
    assert.strictEqual(res.status, 403);
  });

  await t.test('a gardener CANNOT reach /admin/properties (supervisor-only)', async () => {
    const res = await agentB.get('/admin/properties');
    assert.strictEqual(res.status, 403);
  });
});
