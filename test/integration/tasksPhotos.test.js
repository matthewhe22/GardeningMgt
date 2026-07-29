// Integration tests for staff task editing and the staff photo-gallery
// filters. Runs only when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('task editing + photo filters', { skip: !TEST_DB && reason }, async (t) => {
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
  async function login(email) {
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    assert.strictEqual(res.status, 302, `login should succeed for ${email}`);
    return { agent, csrf: extractCsrf((await agent.get('/')).text) };
  }

  // The test DB persists between runs, so scope users/filenames/dates to this
  // run to stay isolated and idempotent (no unique-constraint clashes, no
  // accumulation from prior runs bleeding into filter assertions). A far-future
  // year keeps our photos out of every other test's date windows.
  const runId = Date.now();
  const yr = 3000 + (runId % 900);
  const supId = await ensureUser('tp-sup@example.com', 'TP Supervisor', 'supervisor');
  const g1 = await ensureUser(`tp-g1-${runId}@example.com`, 'TP Gardener One', 'gardener');
  const g2 = await ensureUser(`tp-g2-${runId}@example.com`, 'TP Gardener Two', 'gardener');
  const { agent: sup, csrf } = await login('tp-sup@example.com');
  const { agent: gardener, csrf: gcsrf } = await login(`tp-g1-${runId}@example.com`);

  // --- Task editing (staff) ---
  const task = await q1(
    'INSERT INTO tasks (title, created_by) VALUES ($1, $2) RETURNING id', ['Hard rubbish', supId]);

  await t.test('supervisor can edit a task: assignee, due date, title, description', async () => {
    const res = await sup.post(`/tasks/${task.id}/update`).type('form').send({
      title: 'Hard rubbish pickup', description: 'bins overflowing',
      assignee_id: String(g1), due_date: '2026-06-20', _csrf: csrf,
    });
    assert.strictEqual(res.status, 302);
    const row = await q1('SELECT title, description, assignee_id, due_date FROM tasks WHERE id = $1', [task.id]);
    assert.strictEqual(row.title, 'Hard rubbish pickup');
    assert.strictEqual(row.description, 'bins overflowing');
    assert.strictEqual(row.assignee_id, g1);
    assert.strictEqual(String(row.due_date), '2026-06-20');
  });

  await t.test('an empty title is rejected (task unchanged)', async () => {
    const res = await sup.post(`/tasks/${task.id}/update`).type('form')
      .send({ title: '   ', assignee_id: String(g2), _csrf: csrf });
    assert.strictEqual(res.status, 302);
    const row = await q1('SELECT title, assignee_id FROM tasks WHERE id = $1', [task.id]);
    assert.strictEqual(row.title, 'Hard rubbish pickup', 'title unchanged');
    assert.strictEqual(row.assignee_id, g1, 'assignee unchanged');
  });

  await t.test('an invalid due date is stored as null, not a bogus value', async () => {
    const res = await sup.post(`/tasks/${task.id}/update`).type('form')
      .send({ title: 'Hard rubbish pickup', due_date: 'not-a-date', _csrf: csrf });
    assert.strictEqual(res.status, 302);
    const row = await q1('SELECT due_date FROM tasks WHERE id = $1', [task.id]);
    assert.strictEqual(row.due_date, null);
  });

  await t.test('a gardener cannot edit a task (supervisor-only)', async () => {
    const res = await gardener.post(`/tasks/${task.id}/update`).type('form')
      .send({ title: 'HACKED', assignee_id: String(g1), _csrf: gcsrf });
    assert.strictEqual(res.status, 403);
    const row = await q1('SELECT title FROM tasks WHERE id = $1', [task.id]);
    assert.strictEqual(row.title, 'Hard rubbish pickup', 'title must be unchanged');
  });

  // --- Photo gallery filters (staff) ---
  const propA = await q1("INSERT INTO properties (name, address) VALUES ('Site A', 'A St') RETURNING id");
  const propB = await q1("INSERT INTO properties (name, address) VALUES ('Site B', 'B St') RETURNING id");
  const visitA = await q1("INSERT INTO visits (property_id, gardener_id, scheduled_date, status) VALUES ($1,$2,CURRENT_DATE,'completed') RETURNING id", [propA.id, g1]);
  const visitB = await q1("INSERT INTO visits (property_id, gardener_id, scheduled_date, status) VALUES ($1,$2,CURRENT_DATE,'completed') RETURNING id", [propB.id, g2]);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  async function addPhoto(filename, visitId, uploadedBy, createdAt) {
    await q('INSERT INTO photos (filename, data, visit_id, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5)',
      [filename, bytes, visitId, uploadedBy, createdAt]);
  }
  const fA = `tp-a-${runId}.jpg`; // site A, gardener 1, early
  const fB = `tp-b-${runId}.jpg`; // site B, gardener 2, later
  await addPhoto(fA, visitA.id, g1, `${yr}-03-01 10:00:00`);
  await addPhoto(fB, visitB.id, g2, `${yr}-05-01 10:00:00`);

  const has = (html, f) => html.includes(`/uploads/${f}`);

  await t.test('filter by site returns only that site\'s photos', async () => {
    const res = await sup.get(`/photos?property_id=${propA.id}`);
    assert.strictEqual(res.status, 200);
    assert.ok(has(res.text, fA), 'site A photo present');
    assert.ok(!has(res.text, fB), 'site B photo excluded');
  });

  await t.test('filter by gardener returns only that uploader\'s photos', async () => {
    const res = await sup.get(`/photos?gardener_id=${g2}`);
    assert.ok(has(res.text, fB) && !has(res.text, fA));
  });

  await t.test('filter by date range narrows to that window', async () => {
    const res = await sup.get(`/photos?from=${yr}-04-01&to=${yr}-06-01`);
    assert.ok(has(res.text, fB) && !has(res.text, fA));
  });

  await t.test('combined filters AND together', async () => {
    const res = await sup.get(`/photos?property_id=${propA.id}&gardener_id=${g2}`);
    assert.ok(!has(res.text, fA) && !has(res.text, fB), 'no photo matches site A + gardener 2');
  });

  await t.test('the filter UI is shown to staff but not to gardeners', async () => {
    const staffPage = await sup.get('/photos');
    assert.ok(staffPage.text.includes('name="property_id"') && staffPage.text.includes('name="gardener_id"'));
    const gardenerPage = await gardener.get('/photos');
    assert.strictEqual(gardenerPage.status, 200);
    assert.ok(!gardenerPage.text.includes('name="property_id"'), 'gardeners get no filter form');
  });
});
