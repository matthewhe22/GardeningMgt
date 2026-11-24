// Report photos link to the full-size original (in-app report, emailed report,
// staff PDF), and signing in returns to the photo. Needs TEST_DATABASE_URL.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) {
  Object.assign(process.env, { DATABASE_URL: TEST_DB, DB_SKIP_INIT: '', SESSION_SECRET: 'test-secret-for-integration-tests',
    S3_BUCKET: '', S3_ENDPOINT: '' });
}

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('report photos link to the full-size original', { skip: !TEST_DB && 'set TEST_DATABASE_URL to run these' }, async (t) => {
  const runId = Date.now();
  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');
  const { today } = require('../../src/time');
  const { insertPhotoRow } = require('../../src/upload');
  const report = require('../../src/report');
  const { setSetting } = require('../../src/settings');
  const email = require('../../src/email');
  const { emailJobReport } = require('../../src/jobReport');

  const adminEmail = `rpl-admin-${runId}@greenthumb.example.org`;
  const admin = await q1("INSERT INTO users (name, email, password_hash, role) VALUES ('RPL admin', $1, $2, 'admin') RETURNING id",
    [adminEmail, bcrypt.hashSync('testpass123', 10)]);
  const prop = await q1("INSERT INTO properties (name, address) VALUES ('RPL Site', '1 RPL St') RETURNING id");
  const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at, duration_minutes)
    VALUES ($1, $2, $3, 'completed', now() - interval '1 hour', now(), 60) RETURNING id`, [prop.id, admin.id, today()]);
  const buf = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3a7' } }).jpeg().toBuffer();
  const filename = `rpl-${runId}.jpg`;
  await insertPhotoRow({ filename, originalName: 'p.jpg', mime: 'image/jpeg', buffer: buf, inline: true,
    visitId: v.id, userId: admin.id, caption: 'Front lawn', shared: false });
  const data = await report.loadReportData(v.id);

  await t.test('in-app report: each photo opens its original', async () => {
    const html = await report.renderReportHtml(data);
    assert.ok(html.includes(`<a href="/uploads/${filename}" target="_blank"`), 'photo links to /uploads/<file>');
  });

  await t.test('emailed report: small embedded preview linking to the app', async () => {
    const html = await report.renderReportHtml(data, { inlinePhotos: true, photoHref: report.appPhotoHref('https://app.example.org') });
    assert.ok(html.includes(`<a href="https://app.example.org/uploads/${filename}"`));
    assert.match(html, /src="data:image\/jpeg;base64,/, 'preview still embedded');
    assert.match(html, /Click any photo to open the full-size original/);
  });

  await t.test('no links when told not to (copies for people without an account)', async () => {
    const html = await report.renderReportHtml(data, { inlinePhotos: true, photoHref: null });
    assert.ok(!html.includes('/uploads/'));
    assert.doesNotMatch(html, /Click any photo/);
  });

  await t.test('staff PDF links photos; the owners PDF does not', async () => {
    const staff = (await report.renderReportPdf(data, { photoLinkBase: 'https://app.example.org' })).toString('latin1');
    assert.ok(staff.includes(`https://app.example.org/uploads/${filename}`), 'link annotation in the PDF');
    const owners = (await report.renderReportPdf(data)).toString('latin1');
    assert.ok(!owners.includes('/uploads/'));
  });

  await t.test('the job summary email attaches a report whose photos link to the app', async () => {
    await q("UPDATE users SET receive_job_reports = false WHERE id <> $1", [admin.id]);
    for (const [k, val] of Object.entries({ email_provider: 'smtp2go', smtp2go_api_key: 'api-X', smtp_from_email: 'jobs@greenthumb.test' })) {
      await setSetting(k, val);
    }
    const realFetch = global.fetch;
    let sent = null;
    global.fetch = async (url, init) => {
      if (String(url) !== email.SMTP2GO_URL) return realFetch(url, init);
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0, failures: [], email_id: 'e' } }), { status: 200 });
    };
    try {
      assert.strictEqual(await emailJobReport(v.id, 'https://app.example.org'), 1);
    } finally {
      global.fetch = realFetch;
      await setSetting('email_provider', null);
      await setSetting('smtp2go_api_key', null);
    }
    const att = sent.attachments.find((a) => a.mimetype === 'text/html');
    const html = Buffer.from(att.fileblob, 'base64').toString();
    assert.ok(html.includes(`<a href="https://app.example.org/uploads/${filename}"`));
  });

  await t.test('opening a photo link signed out comes back to the photo after sign-in', async () => {
    const agent = request.agent(app);
    const first = await agent.get(`/uploads/${filename}`);
    assert.strictEqual(first.status, 302);
    assert.strictEqual(first.headers.location, `/login?next=${encodeURIComponent(`/uploads/${filename}`)}`);
    const lp = await agent.get(first.headers.location);
    assert.ok(lp.text.includes(`name="next" value="/uploads/${filename}"`));
    const login = await agent.post('/login').type('form')
      .send({ email: adminEmail, password: 'testpass123', next: `/uploads/${filename}`, _csrf: extractCsrf(lp.text) });
    assert.strictEqual(login.headers.location, `/uploads/${filename}`);
    const photo = await agent.get(`/uploads/${filename}`);
    assert.strictEqual(photo.status, 200);
    assert.strictEqual(photo.headers['content-type'], 'image/jpeg');
    assert.strictEqual(photo.body.length, buf.length, 'the full-size original, not the preview');
  });

  await t.test('sign-in never redirects to another site', async () => {
    const agent = request.agent(app);
    const lp = await agent.get('/login?next=//evil.example.com');
    assert.ok(!lp.text.includes('evil.example.com'));
    const login = await agent.post('/login').type('form')
      .send({ email: adminEmail, password: 'testpass123', next: 'https://evil.example.com', _csrf: extractCsrf(lp.text) });
    assert.strictEqual(login.headers.location, '/');
  });
});
