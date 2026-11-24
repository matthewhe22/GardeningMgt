// Fixes from the end-to-end review (batch 5: hardening). The database checks
// need TEST_DATABASE_URL; the rest run anywhere.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const TEST_DB = process.env.TEST_DATABASE_URL;
const ROOT = path.join(__dirname, '../..');
// Set before anything loads src/db (reports.js does).
if (TEST_DB) Object.assign(process.env, { DATABASE_URL: TEST_DB, DB_SKIP_INIT: '', SESSION_SECRET: 'test-secret-for-integration-tests' });

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('CSV exports show formula-like text as plain text', () => {
  const { toCsv } = require('../../src/routes/reports');
  const out = toCsv(['site', 'amount'], [
    ['=HYPERLINK("http://x","click")', 10], ['+61 400 000 000', -5], ['@SUM(A1)', '-12.50'], ['\tTab', 'Plain'],
  ]).split('\r\n');
  assert.strictEqual(out[1], '"\'=HYPERLINK(""http://x"",""click"")","10"');
  assert.strictEqual(out[2], '"\'+61 400 000 000","-5"');
  assert.strictEqual(out[3], '"\'@SUM(A1)","-12.50"');
  assert.strictEqual(out[4], '"\'\tTab","Plain"');
});

test('the demo-data script refuses live databases', () => {
  const { seedRefusal } = require('../../scripts/seed');
  assert.ok(seedRefusal({ DATABASE_URL: 'postgres://u:p@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres' }));
  assert.ok(seedRefusal({ DATABASE_URL: 'postgres://u:p@localhost/x', VERCEL: '1' }));
  assert.ok(seedRefusal({ DATABASE_URL: 'postgres://u:p@localhost/x', NODE_ENV: 'production' }));
  assert.strictEqual(seedRefusal({ DATABASE_URL: 'postgres://u:p@localhost:5433/x' }), null);
  assert.strictEqual(seedRefusal({ DATABASE_URL: 'postgres://u:p@db.example.com/x', SEED_ALLOW_REMOTE: '1' }), null);
});

test("Supabase's session-mode pooler (port 5432) is not treated as pooled on Vercel", () => {
  const risk = (url) => execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/db').dbPoolerRisk))"], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: url, VERCEL: '1', REQUIRE_DB_POOLER: '1', SESSION_SECRET: 'x' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
  assert.strictEqual(risk('postgres://u:p@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres'), 'true');
  assert.strictEqual(risk('postgres://u:p@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres'), 'false');
  assert.strictEqual(risk('postgres://u:p@ep-cool-1-pooler.us-east-2.aws.neon.tech/db'), 'false');
});

test('review batch 5: settings secrets, migrations', { skip: !TEST_DB && 'set TEST_DATABASE_URL to run these' }, async (t) => {
  const runId = Date.now();
  const db = require('../../src/db');
  const { ready, q, q1, pool } = db;
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const { getSettings, setSetting } = require('../../src/settings');

  const email = `b5-admin-${runId}@example.com`;
  await q1("INSERT INTO users (name, email, password_hash, role) VALUES ('B5 admin', $1, $2, 'admin') RETURNING id",
    [email, bcrypt.hashSync('testpass123', 10)]);
  const agent = request.agent(app);
  const lp = await agent.get('/login');
  await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
  const csrf = extractCsrf((await agent.get('/')).text);

  await t.test('a saved secret is not kept when its server address changes', async () => {
    await setSetting('piq_base_url', 'https://tocs.propertyiq.com.au');
    await setSetting('piq_client_secret', 'real-secret');
    const save = (body) => agent.post('/admin/settings').type('form').send({ _csrf: csrf, piq_client_id: 'id', piq_scope: '', ...body });
    const r = await save({ piq_base_url: 'https://evil.example.com', piq_client_secret: '********' });
    assert.match(r.headers.location, /secretneeded=piq_base_url/);
    let s = await getSettings(['piq_base_url', 'piq_client_secret']);
    assert.strictEqual(s.piq_base_url, 'https://tocs.propertyiq.com.au');
    const page = await agent.get('/admin/settings?secretneeded=piq_base_url');
    assert.match(page.text, /type the PropertyIQ client secret again/);
    // Same address with the masked secret: saves, secret kept.
    const same = await save({ piq_base_url: 'https://tocs.propertyiq.com.au', piq_client_secret: '********' });
    assert.match(same.headers.location, /saved=1/);
    // New address with the secret typed again: saves.
    const typed = await save({ piq_base_url: 'https://new.propertyiq.com.au', piq_client_secret: 'real-secret' });
    assert.match(typed.headers.location, /saved=1/);
    s = await getSettings(['piq_base_url', 'piq_client_secret']);
    assert.strictEqual(s.piq_base_url, 'https://new.propertyiq.com.au');
    assert.strictEqual(s.piq_client_secret, 'real-secret');
  });

  await t.test('two servers upgrading the schema at once both succeed', async () => {
    await q("UPDATE settings SET value = '1' WHERE key = 'schema_version'");
    const results = await Promise.allSettled([db.runMigrations(), db.runMigrations(), db.runMigrations()]);
    assert.deepStrictEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled'],
      results.map((r) => r.reason && r.reason.message).join('; '));
    const v = await q1("SELECT value FROM settings WHERE key = 'schema_version'");
    assert.ok(Number(v.value) >= 20);
  });
});
