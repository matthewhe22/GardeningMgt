// Integration tests that need a real Postgres, driven over real HTTP via
// supertest against the actual Express app (src/server.js). They run only
// when TEST_DATABASE_URL is set, and skip otherwise.
//
//   TEST_DATABASE_URL=postgres://localhost/gardeningmgt_test npm run test:integration
//
// Locks in the double-submit CSRF protection (src/csrf.js) at the protocol
// level: any state-changing POST missing a valid `_csrf` field must be
// rejected with a 403 (EBADCSRFTOKEN), and the SAME request with the real
// token (pulled from the session, exactly like a real form render) must
// succeed. This was previously verified only by hand (curl) with zero
// automated coverage.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found in response HTML');
  return m[1];
}

test('CSRF double-submit protection', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';

  const { ready, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());

  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');

  const testEmail = 'csrf-test-gardener@example.com';
  const testPassword = 'testpass123';
  const existing = await q1('SELECT id FROM users WHERE email = $1', [testEmail]);
  if (!existing) {
    await q1('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      ['Csrf Test Gardener', testEmail, bcrypt.hashSync(testPassword, 10), 'gardener']);
  }

  async function login() {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login');
    const token = extractCsrf(loginPage.text);
    const res = await agent.post('/login').type('form')
      .send({ email: testEmail, password: testPassword, _csrf: token });
    assert.strictEqual(res.status, 302, 'login should succeed with the deterministic test password');
    const homePage = await agent.get('/');
    return { agent, csrf: extractCsrf(homePage.text) };
  }

  await t.test('POST /logout with no _csrf field is rejected (403 EBADCSRFTOKEN)', async () => {
    const { agent } = await login();
    const res = await agent.post('/logout').type('form').send({});
    assert.strictEqual(res.status, 403);

    // The session must survive the rejected request — prove it by hitting an
    // authenticated page and confirming we're still logged in, not bounced to
    // /login.
    const check = await agent.get('/profile');
    assert.strictEqual(check.status, 200, 'the (rejected) logout attempt must not have logged the user out');
  });

  await t.test('POST /logout with a garbage _csrf value is rejected (403 EBADCSRFTOKEN)', async () => {
    const { agent } = await login();
    const res = await agent.post('/logout').type('form').send({ _csrf: 'not-the-real-token-at-all' });
    assert.strictEqual(res.status, 403);

    const check = await agent.get('/profile');
    assert.strictEqual(check.status, 200, 'the (rejected) logout attempt must not have logged the user out');
  });

  await t.test('POST /logout with the real session token succeeds', async () => {
    const { agent, csrf } = await login();
    const res = await agent.post('/logout').type('form').send({ _csrf: csrf });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/login');

    // Confirm the session really did end: an authenticated page now bounces
    // to /login instead of rendering.
    const check = await agent.get('/profile');
    assert.strictEqual(check.status, 302);
    assert.strictEqual(check.headers.location, '/login');
  });

  await t.test('a state-changing GET-adjacent route (POST /visits/:id/status) is also CSRF-gated', async () => {
    const { agent, csrf } = await login();
    const property = await q1(
      "INSERT INTO properties (name, address) VALUES ('Csrf Site', 'Csrf Addr') RETURNING id");
    const me = await q1('SELECT id FROM users WHERE email = $1', [testEmail]);
    const visit = await q1(`
      INSERT INTO visits (property_id, gardener_id, scheduled_date, status)
      VALUES ($1, $2, CURRENT_DATE, 'scheduled') RETURNING id`, [property.id, me.id]);

    const rejected = await agent.post(`/visits/${visit.id}/status`).type('form').send({ status: 'skipped' });
    assert.strictEqual(rejected.status, 403);
    const untouched = await q1('SELECT status FROM visits WHERE id = $1', [visit.id]);
    assert.strictEqual(untouched.status, 'scheduled', 'the status must not change without a valid CSRF token');

    const accepted = await agent.post(`/visits/${visit.id}/status`).type('form')
      .send({ status: 'skipped', _csrf: csrf });
    assert.strictEqual(accepted.status, 302);
    const changed = await q1('SELECT status FROM visits WHERE id = $1', [visit.id]);
    assert.strictEqual(changed.status, 'skipped', 'the status must change with a valid CSRF token');
  });
});
