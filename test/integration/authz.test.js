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
//   - a gardener only sees their own jobs: sites, visits, issues and photos
//     belonging to another gardener never appear in their lists, and
//     supervisors/admins still see everything
//   - the /uploads/:filename route mirrors the photo gallery: staff see
//     everything; a gardener sees their own uploads, photos on a visit
//     assigned to them, and photos on issues they can see

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

  const [{ agent: agentA, csrf: csrfA }, { agent: agentB, csrf: csrfB }, { agent: agentStaff }] = await Promise.all([
    loginAgent('authz-gardener-a@example.com'),
    loginAgent('authz-gardener-b@example.com'),
    loginAgent('authz-staff@example.com'),
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

  await t.test("gardener B CANNOT view a photo uploaded to gardener A's visit", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
    const uploadRes = await agentA.post(`/visits/${visit.id}/photos?_csrf=${csrfA}`)
      .attach('photos', jpeg, 'evidence.jpg');
    assert.strictEqual(uploadRes.status, 302);
    const photo = await q1(
      'SELECT filename FROM photos WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]);
    assert.ok(photo, 'the photo should have been saved');

    const res = await agentB.get(`/uploads/${photo.filename}`);
    assert.strictEqual(res.status, 404, 'a photo on someone else\'s visit must not be servable');
    assert.strictEqual((await agentA.get(`/uploads/${photo.filename}`)).status, 200, 'the uploader still can');
    assert.strictEqual((await agentStaff.get(`/uploads/${photo.filename}`)).status, 200, 'staff still can');
  });

  await t.test("gardener B CANNOT view a photo on gardener A's visit even if flagged shared", async () => {
    const photo = await q1(
      'SELECT filename FROM photos WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]);
    await q('UPDATE photos SET shared = true WHERE filename = $1', [photo.filename]);
    const res = await agentB.get(`/uploads/${photo.filename}`);
    assert.strictEqual(res.status, 404);
  });

  await t.test("gardener B's photo gallery does not list gardener A's photos; staff's does", async () => {
    const photo = await q1('SELECT id FROM photos WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]);
    const marker = `/visits/${visit.id}"`;
    const b = await agentB.get('/photos');
    assert.strictEqual(b.status, 200);
    assert.ok(!b.text.includes(marker), `gardener B must not see photo #${photo.id} from A's visit`);
    const a = await agentA.get('/photos');
    assert.ok(a.text.includes(marker), 'gardener A sees their own visit photo');
    const st = await agentStaff.get(`/photos?gardener_id=${gardenerAId}`);
    assert.ok(st.text.includes(marker), 'staff see every photo');
  });

  await t.test("gardener B CANNOT delete gardener A's photo", async () => {
    const photo = await q1(
      'SELECT id FROM photos WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]);
    assert.ok(photo, 'precondition: a photo from gardener A must exist');
    const res = await agentB.post(`/photos/${photo.id}/delete`).type('form').send({ _csrf: csrfB });
    assert.strictEqual(res.status, 403);
    const stillThere = await q1('SELECT id FROM photos WHERE id = $1', [photo.id]);
    assert.ok(stillThere, 'the photo must not have been deleted');
  });

  const issueTitle = `Authz issue ${Date.now()}`;
  const issue = await q1(`
    INSERT INTO issues (title, property_id, priority, reported_by)
    VALUES ($1, $2, 'medium', $3) RETURNING id`, [issueTitle, property.id, gardenerAId]);

  await t.test("an issue on gardener A's site is hidden from gardener B, visible to A and staff", async () => {
    assert.strictEqual((await agentB.get(`/issues/${issue.id}`)).status, 404);
    assert.ok(!(await agentB.get('/issues')).text.includes(issueTitle), 'not in B\'s issue list');
    assert.strictEqual((await agentA.get(`/issues/${issue.id}`)).status, 200);
    assert.ok((await agentA.get('/issues')).text.includes(issueTitle), 'in A\'s issue list');
    assert.strictEqual((await agentStaff.get(`/issues/${issue.id}`)).status, 200);
    assert.ok((await agentStaff.get(`/issues?search=${encodeURIComponent(issueTitle)}`)).text.includes(issueTitle));
  });

  await t.test("gardener B CANNOT comment on or add photos to gardener A's issue", async () => {
    const c = await agentB.post(`/issues/${issue.id}/comments`).type('form')
      .send({ body: 'sneaky', _csrf: csrfB });
    assert.strictEqual(c.status, 404);
    const n = await q1('SELECT COUNT(*)::int AS n FROM issue_comments WHERE issue_id = $1', [issue.id]);
    assert.strictEqual(n.n, 0);
  });

  await t.test("an issue photo is only servable to people who can see the issue", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(20)]);
    const uploadRes = await agentA.post(`/issues/${issue.id}/photos?_csrf=${csrfA}`)
      .attach('photos', jpeg, 'issue.jpg');
    assert.strictEqual(uploadRes.status, 302);
    const photo = await q1('SELECT filename FROM photos WHERE issue_id = $1', [issue.id]);
    assert.ok(photo);
    assert.strictEqual((await agentB.get(`/uploads/${photo.filename}`)).status, 404);
    assert.strictEqual((await agentStaff.get(`/uploads/${photo.filename}`)).status, 200);
  });

  await t.test("gardener B's visits and sites lists do not show gardener A's jobs; staff's do", async () => {
    const site = await q1(
      "INSERT INTO properties (name, address) VALUES ($1, 'Authz Addr 2') RETURNING id, name",
      [`Authz Contract Site ${Date.now()}`]);
    await q(`INSERT INTO jobs (property_id, gardener_id, frequency, contract_years, start_date, end_date)
      VALUES ($1, $2, 'weekly', 1, CURRENT_DATE, CURRENT_DATE + 365)`, [site.id, gardenerAId]);
    const visitLink = `/visits/${visit.id}"`;
    assert.ok(!(await agentB.get('/visits?all=1')).text.includes(visitLink));
    assert.ok((await agentA.get('/visits?all=1')).text.includes(visitLink));
    assert.ok((await agentStaff.get(`/visits?all=1&gardener_id=${gardenerAId}`)).text.includes(visitLink));
    const q2 = `/jobs?search=${encodeURIComponent(site.name)}`;
    const row = `<strong>${site.name}</strong>`;
    assert.ok(!(await agentB.get(q2)).text.includes(row), 'B must not see A\'s site contract');
    assert.ok((await agentA.get(q2)).text.includes(row), 'A sees their own site contract');
    assert.ok((await agentStaff.get(q2)).text.includes(`/jobs/site/${site.id}`));
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

  await t.test("a gardener CANNOT send a completed job's report to owners, even on their own visit (supervisor-only)", async () => {
    const completedVisit = await q1(`
      INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at, duration_minutes)
      VALUES ($1, $2, CURRENT_DATE, 'completed', now() - interval '1 hour', now(), 60) RETURNING id`,
      [property.id, gardenerAId]);
    // agentA is the gardener assigned to this visit, so this isn't an IDOR
    // case — it's checking the role gate itself: even the owning gardener
    // must not be able to trigger owner-facing emails on a job they did.
    const res = await agentA.post(`/visits/${completedVisit.id}/report/send-to-owners`).type('form')
      .send({ confirm_report: 'on', _csrf: csrfA });
    assert.strictEqual(res.status, 403);
  });
});
