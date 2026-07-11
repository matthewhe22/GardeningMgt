// Integration tests that need a real Postgres, driven over real HTTP via
// supertest against the actual Express app (src/server.js). They run only
// when TEST_DATABASE_URL is set, and skip otherwise.
//
//   TEST_DATABASE_URL=postgres://localhost/gardeningmgt_test npm run test:integration
//
// Covers the check-then-insert races closed by uq_invoices_visit_open and
// uq_jobs_property_active: firing several concurrent creates for the same
// visit/property must leave exactly one live row, and every request — winner
// or loser — must get a normal redirect, never an uncaught 500.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found in response HTML');
  return m[1];
}

test('concurrent create races leave exactly one live row and never 500', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());

  const request = require('supertest');
  const app = require('../../src/server');

  // Don't rely on the bootstrap admin — another integration test file may
  // have already run ready() against this same DB and created one with a
  // different (or randomly generated) password. Create our own deterministic
  // user instead, so this test is self-contained regardless of run order.
  const bcrypt = require('bcryptjs');
  const testEmail = 'race-test-admin@example.com';
  const testPassword = 'testpass123';
  const existing = await q1('SELECT id FROM users WHERE email = $1', [testEmail]);
  if (!existing) {
    await q("INSERT INTO users (name, email, password_hash, role) VALUES ('Race Test Admin', $1, $2, 'admin')",
      [testEmail, bcrypt.hashSync(testPassword, 10)]);
  }

  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  const loginToken = extractCsrf(loginPage.text);
  const loginRes = await agent.post('/login').type('form')
    .send({ email: testEmail, password: testPassword, _csrf: loginToken });
  assert.strictEqual(loginRes.status, 302, 'login should succeed with the deterministic test admin password');

  // A single csrf token survives for the life of the session (it's not
  // rotated per-request), so one capture covers every request below.
  const homePage = await agent.get('/');
  const csrf = extractCsrf(homePage.text);

  await t.test('POST /invoices: concurrent creates for one visit yield exactly one live invoice', async () => {
    const property = await q1("INSERT INTO properties (name, address) VALUES ('Race Site A', 'Addr') RETURNING id");
    const visit = await q1(
      "INSERT INTO visits (property_id, scheduled_date, status, duration_minutes) " +
      "VALUES ($1, CURRENT_DATE, 'completed', 60) RETURNING id",
      [property.id]);

    const N = 8;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        agent.post('/invoices').type('form').send({ visit_id: visit.id, _csrf: csrf }))
    );

    for (const res of responses) {
      assert.strictEqual(res.status, 302, `expected a redirect, got ${res.status}: ${res.text.slice(0, 200)}`);
      assert.match(res.headers.location, /^\/invoices\/\d+$/);
    }
    // Every response should point at the SAME winning invoice.
    const targets = new Set(responses.map((r) => r.headers.location));
    assert.strictEqual(targets.size, 1, `all requests should redirect to the same invoice, got ${[...targets]}`);

    const { c } = await q1(
      "SELECT COUNT(*)::int AS c FROM invoices WHERE visit_id = $1 AND status <> 'void'", [visit.id]);
    assert.strictEqual(c, 1, 'exactly one live invoice should exist for this visit');
  });

  await t.test('POST /jobs: concurrent creates for one property yield exactly one active job', async () => {
    const property = await q1("INSERT INTO properties (name, address) VALUES ('Race Site B', 'Addr') RETURNING id");

    const N = 8;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        agent.post('/jobs').type('form').send({
          property_id: property.id, frequency: 'weekly', contract_years: '1',
          start_date: '2026-01-01', _csrf: csrf,
        }))
    );

    for (const res of responses) {
      assert.strictEqual(res.status, 302, `expected a redirect, got ${res.status}: ${res.text.slice(0, 200)}`);
      assert.match(res.headers.location, /^\/jobs(\?error=duplicate)?$/);
    }

    const { c } = await q1(
      "SELECT COUNT(*)::int AS c FROM jobs WHERE property_id = $1 AND active", [property.id]);
    assert.strictEqual(c, 1, 'exactly one active job should exist for this property');
  });
});
