// SMTP2GO email sending and the off-site photo backup switch, both set in
// Settings. Needs TEST_DATABASE_URL (SMTP2GO's API is replaced by a stub).

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) Object.assign(process.env, { DATABASE_URL: TEST_DB, DB_SKIP_INIT: '', SESSION_SECRET: 'test-secret-for-integration-tests' });

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('email via SMTP2GO and the photo backup switch', { skip: !TEST_DB && 'set TEST_DATABASE_URL to run these' }, async (t) => {
  const runId = Date.now();
  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const { getSettings, setSetting } = require('../../src/settings');
  const email = require('../../src/email');
  const notify = require('../../src/notify');
  const photoBackup = require('../../src/photoBackup');

  const adminEmail = `ebs-admin-${runId}@example.com`;
  await q1("INSERT INTO users (name, email, password_hash, role) VALUES ('EBS admin', $1, $2, 'admin') RETURNING id",
    [adminEmail, bcrypt.hashSync('testpass123', 10)]);
  const agent = request.agent(app);
  const lp = await agent.get('/login');
  await agent.post('/login').type('form').send({ email: adminEmail, password: 'testpass123', _csrf: extractCsrf(lp.text) });
  const csrf = extractCsrf((await agent.get('/')).text);
  const save = (body) => agent.post('/admin/settings').type('form').send({ _csrf: csrf, ...body });

  // Stand-in for SMTP2GO's API; every other fetch goes through.
  const realFetch = global.fetch;
  let calls = [];
  let reply = { status: 200, body: { request_id: 'r1', data: { succeeded: 1, failed: 0, failures: [], email_id: 'e1' } } };
  global.fetch = async (url, init) => {
    if (String(url) !== email.SMTP2GO_URL) return realFetch(url, init);
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { global.fetch = realFetch; });

  await t.test('Settings saves SMTP2GO as the email provider, keeping the key secret', async () => {
    const r = await save({ email_provider: 'smtp2go', smtp2go_api_key: 'api-TESTKEY', smtp_from_email: 'jobs@greenthumb.test',
      smtp_from_name: 'Green Thumb', smtp_host: '', smtp_port: '587', smtp_user: '', smtp_password: '' });
    assert.match(r.headers.location, /saved=1/);
    const s = await getSettings(['email_provider', 'smtp2go_api_key']);
    assert.strictEqual(s.email_provider, 'smtp2go');
    assert.strictEqual(s.smtp2go_api_key, 'api-TESTKEY');
    const raw = await q1("SELECT value FROM settings WHERE key = 'smtp2go_api_key'");
    assert.ok(!raw.value.includes('api-TESTKEY'), 'stored encrypted');
    const page = await agent.get('/admin/settings');
    assert.ok(!page.text.includes('api-TESTKEY'), 'never shown on the page');
    assert.match(page.text, /SMTP2GO \(API key\)/);
    assert.match(page.text, /Send a test email to me/);
  });

  await t.test('emails (with attachments) go to SMTP2GO in its format', async () => {
    calls = [];
    const r = await email.sendMail({ to: 'a@x.test, b@y.test', subject: 'Invoice INV-1', text: 'Hi', html: '<p>Hi</p>',
      attachments: [{ filename: 'inv.pdf', content: Buffer.from('%PDF-1'), contentType: 'application/pdf' }] });
    assert.deepStrictEqual(r, { ok: true, messageId: 'e1' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].headers['X-Smtp2go-Api-Key'], 'api-TESTKEY');
    const b = calls[0].body;
    assert.strictEqual(b.sender, 'Green Thumb <jobs@greenthumb.test>');
    assert.deepStrictEqual(b.to, ['a@x.test', 'b@y.test']);
    assert.strictEqual(b.subject, 'Invoice INV-1');
    assert.strictEqual(b.text_body, 'Hi');
    assert.strictEqual(b.html_body, '<p>Hi</p>');
    assert.deepStrictEqual(b.attachments, [{ filename: 'inv.pdf', fileblob: Buffer.from('%PDF-1').toString('base64'), mimetype: 'application/pdf' }]);
    assert.ok(!('api_key' in b), 'key goes in the header, not the body');
  });

  await t.test("SMTP2GO's refusal reason is reported", async () => {
    reply = { status: 400, body: { data: { error_code: 'E_ApiResponseCodes.API_EXCEPTION', error: 'Sender not verified' } } };
    await assert.rejects(() => email.sendMail({ to: 'a@x.test', subject: 's', text: 't' }), /Sender not verified/);
    const test1 = await agent.post('/admin/settings/test-email').type('form').send({ _csrf: csrf });
    assert.match(test1.text, /Sender not verified/);
    reply = { status: 200, body: { data: { succeeded: 1, failed: 0, failures: [], email_id: 'e2' } } };
  });

  await t.test('the test button sends a test email to the signed-in admin', async () => {
    calls = [];
    const r = await agent.post('/admin/settings/test-email').type('form').send({ _csrf: csrf });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Sent a test email to/);
    assert.deepStrictEqual(calls[0].body.to, [adminEmail]);
  });

  await t.test('visit reminders use the Settings email too', async () => {
    calls = [];
    assert.strictEqual(await notify.sendEmail('g@x.test', 'Visit reminder', 'Tomorrow 9am'), true);
    assert.deepStrictEqual(calls[0].body.to, ['g@x.test']);
  });

  await t.test('photo backup is off by default and the switch turns it on and off', async () => {
    // (Other test files share this database and may have set these.)
    for (const k of photoBackup.SETTING_KEYS) await setSetting(k, null);
    let cfg = await photoBackup.getConfig();
    assert.strictEqual(cfg.on, false);
    const fields = { photo_backup_bucket: 'gm-backup', photo_backup_endpoint: 'https://acct.r2.cloudflarestorage.com',
      photo_backup_region: 'auto', photo_backup_access_key_id: 'AKID', photo_backup_secret_access_key: 'SECRET' };
    // Unticked: the form sends only the hidden "0".
    await save({ photo_backup_enabled: '0', ...fields });
    cfg = await photoBackup.getConfig();
    assert.strictEqual(cfg.on, false);
    assert.strictEqual(cfg.complete, true);
    assert.deepStrictEqual(await photoBackup.backupPhotos(q), { copied: 0, failed: 0, remaining: 0, off: true });
    // Ticked: hidden "0" then the checkbox "1".
    await save({ photo_backup_enabled: ['0', '1'], ...fields, photo_backup_secret_access_key: '********' });
    cfg = await photoBackup.getConfig();
    assert.strictEqual(cfg.on, true);
    assert.strictEqual(cfg.secretAccessKey, 'SECRET', 'masked secret kept');
    await save({ photo_backup_enabled: '0', ...fields, photo_backup_secret_access_key: '********' });
    assert.strictEqual((await photoBackup.getConfig()).on, false);
    const page = await agent.get('/admin/settings');
    assert.match(page.text, /Off-site photo backup/);
    assert.match(page.text, /<strong>Off<\/strong>/);
    assert.ok(!page.text.includes('SECRET'));
  });

  await t.test('changing the backup endpoint needs the secret typed again', async () => {
    const r = await save({ photo_backup_enabled: '0', photo_backup_endpoint: 'https://evil.example.com',
      photo_backup_secret_access_key: '********' });
    assert.match(r.headers.location, /secretneeded=photo_backup_endpoint/);
    assert.strictEqual((await photoBackup.getConfig()).endpoint, 'https://acct.r2.cloudflarestorage.com');
  });

  await t.test('the backup test explains a bad endpoint', async () => {
    await setSetting('photo_backup_endpoint', 'http://127.0.0.1:9');
    const r = await agent.post('/admin/settings/test-backup').type('form').send({ _csrf: csrf });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /alert-error/);
  });
});
