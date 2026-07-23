// Route-level regression tests for POST /visits/:id/report/send-to-owners,
// covering the error-handling hardening:
//   - a PropertyIQ lookup failure redirects to ?error=piqerror instead of
//     throwing a raw 500, and is logged;
//   - the per-recipient send loop is guarded: one recipient throwing does not
//     abort the loop or 500, successes are still counted, and the run is
//     recorded.
// External services are stubbed: sendMail is replaced before the app is
// required (routes/visits.js destructures it at load time), and
// propertyiq.getOwnerEmailsForProperty is swapped per-subtest on the shared
// module namespace. Runs only when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('PIQ send-to-owners: non-fatal errors + guarded per-recipient send', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';

  // Stub sendMail BEFORE the app is required — routes/visits.js does
  // `const { sendMail } = require('../email')`, capturing the value at load.
  const email = require('../../src/email');
  let mailBehavior = async () => ({ ok: false, skipped: true });
  email.sendMail = async (msg) => mailBehavior(msg);

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());

  const propertyiq = require('../../src/propertyiq');
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');

  async function ensureUser(emailAddr, name, role) {
    const existing = await q1('SELECT id FROM users WHERE email = $1', [emailAddr]);
    if (existing) return existing.id;
    const { id } = await q1(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, emailAddr, bcrypt.hashSync('testpass123', 10), role]);
    return id;
  }

  await ensureUser('piq-super@example.com', 'PIQ Super', 'supervisor');
  const agent = request.agent(app);
  {
    const loginPage = await agent.get('/login');
    const res = await agent.post('/login').type('form')
      .send({ email: 'piq-super@example.com', password: 'testpass123', _csrf: extractCsrf(loginPage.text) });
    assert.strictEqual(res.status, 302, 'supervisor login should succeed');
  }
  const csrf = extractCsrf((await agent.get('/')).text);

  const property = await q1(
    "INSERT INTO properties (name, address) VALUES ('PIQ Site', '40 King Street, Sydney NSW 2000') RETURNING id");
  const visit = await q1(`
    INSERT INTO visits (property_id, scheduled_date, status, started_at, finished_at, duration_minutes)
    VALUES ($1, CURRENT_DATE, 'completed', now() - interval '1 hour', now(), 60) RETURNING id`, [property.id]);

  async function latestLog() {
    return q1(
      "SELECT details FROM activity_log WHERE action = 'report.send_owners' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [visit.id]);
  }

  await t.test('a PropertyIQ lookup failure redirects to piqerror (not a 500) and is logged', async () => {
    propertyiq.getOwnerEmailsForProperty = async () => { throw new Error('simulated PIQ 500'); };
    mailBehavior = async () => { throw new Error('must not send on lookup failure'); };

    const res = await agent.post(`/visits/${visit.id}/report/send-to-owners`).type('form')
      .send({ confirm_report: 'on', _csrf: csrf });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /error=piqerror/);
    const row = await latestLog();
    assert.ok(row && /lookup failed/i.test(row.details), 'a failure should be logged');
  });

  await t.test('the send loop is guarded: a throwing recipient does not abort it or 500, successes counted', async () => {
    propertyiq.getOwnerEmailsForProperty = async () => ({
      configured: true, buildingId: '900', emails: ['a@x.com', 'b@x.com', 'c@x.com'],
    });
    const seen = [];
    mailBehavior = async (msg) => {
      seen.push(msg.to);
      if (msg.to === 'a@x.com') return { ok: true };       // delivered
      if (msg.to === 'b@x.com') throw new Error('smtp blip'); // throws mid-loop
      return { ok: false, skipped: true };                  // SMTP not configured
    };

    const res = await agent.post(`/visits/${visit.id}/report/send-to-owners`).type('form')
      .send({ confirm_report: 'on', _csrf: csrf });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /error=piqsent/, 'at least one delivered → piqsent');
    assert.deepStrictEqual(seen, ['a@x.com', 'b@x.com', 'c@x.com'], 'loop attempted all three despite the throw');

    const row = await latestLog();
    assert.ok(row && /1\/3/.test(row.details), `should record 1/3 delivered, got: ${row && row.details}`);

    const prop = await q1('SELECT piq_building_id FROM properties WHERE id = $1', [property.id]);
    assert.strictEqual(prop.piq_building_id, '900', 'matched building id cached');
  });

  await t.test('all recipients failing → piqsendfailed, still no 500', async () => {
    propertyiq.getOwnerEmailsForProperty = async () => ({
      configured: true, buildingId: '900', emails: ['only@x.com'],
    });
    mailBehavior = async () => ({ ok: false, skipped: true });

    const res = await agent.post(`/visits/${visit.id}/report/send-to-owners`).type('form')
      .send({ confirm_report: 'on', _csrf: csrf });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /error=piqsendfailed/);
  });
});
