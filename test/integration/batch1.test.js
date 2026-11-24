// Fixes from the end-to-end review (batch 1). Needs TEST_DATABASE_URL; the
// report-photo checks also need TEST_S3_ENDPOINT (an S3-compatible emulator).

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_S3 = process.env.TEST_S3_ENDPOINT;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('review batch 1', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';
  const bucket = `gm-b1-${Date.now()}`;
  if (TEST_S3) {
    Object.assign(process.env, { S3_BUCKET: bucket, S3_ENDPOINT: TEST_S3, S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test' });
  }

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');
  const { today } = require('../../src/time');

  const runId = Date.now();
  async function user(tag, role) {
    const email = `b1-${tag}-${runId}@example.com`;
    const { id } = await q1('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [`B1 ${tag}`, email, bcrypt.hashSync('testpass123', 10), role]);
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    return { id, agent, csrf: extractCsrf((await agent.get('/')).text) };
  }
  const admin = await user('admin', 'admin');
  const g = await user('g', 'gardener');
  const prop = await q1("INSERT INTO properties (name, address, billing_email) VALUES ('B1 Site', 'B1 St', 'billing@example.com') RETURNING id");

  await t.test('indexes added for invoice items, notifications and issues', async () => {
    const rows = await q("SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_invoice_items_invoice','idx_notifications_visit','idx_issues_visit')");
    assert.strictEqual(rows.length, 3);
  });

  await t.test('saving one Settings section leaves the other sections alone', async () => {
    const save = (fields) => admin.agent.post('/admin/settings').type('form').send({ ...fields, _csrf: admin.csrf });
    await save({ smtp_host: 'smtp.example.com', smtp_port: '587', smtp_user: 'u', smtp_password: 'pw', smtp_from: 'a@example.com' });
    await save({ invoice_business_name: 'B1 Gardening', invoice_abn: '123' });
    const { getSettings } = require('../../src/settings');
    const s = await getSettings(['smtp_host', 'smtp_password', 'invoice_business_name']);
    assert.strictEqual(s.smtp_host, 'smtp.example.com', 'SMTP host kept after saving Invoice details');
    assert.strictEqual(s.smtp_password, 'pw', 'SMTP password kept');
    assert.strictEqual(s.invoice_business_name, 'B1 Gardening');
    // A field the form did send, left empty, is still cleared.
    await save({ smtp_host: '', smtp_port: '587', smtp_user: 'u', smtp_password: '********', smtp_from: 'a@example.com' });
    const s2 = await getSettings(['smtp_host', 'smtp_password', 'invoice_business_name']);
    assert.strictEqual(s2.smtp_host, null);
    assert.strictEqual(s2.smtp_password, 'pw', 'masked placeholder keeps the stored secret');
    assert.strictEqual(s2.invoice_business_name, 'B1 Gardening');
  });

  await t.test('no auto-invoice when the contract has no fee; one when it has', async () => {
    const { autoInvoiceAndEmail } = require('../../src/invoicing');
    const noFeeJob = await q1("INSERT INTO jobs (property_id, start_date, end_date, active) VALUES ($1, CURRENT_DATE - 30, CURRENT_DATE + 300, false) RETURNING id", [prop.id]);
    const v1 = await q1("INSERT INTO visits (property_id, job_id, scheduled_date, status, finished_at) VALUES ($1, $2, CURRENT_DATE - 1, 'completed', now()) RETURNING id", [prop.id, noFeeJob.id]);
    const oneOff = await q1("INSERT INTO visits (property_id, scheduled_date, status, finished_at) VALUES ($1, CURRENT_DATE - 2, 'completed', now()) RETURNING id", [prop.id]);
    await autoInvoiceAndEmail(v1.id);
    await autoInvoiceAndEmail(oneOff.id);
    const none = await q1('SELECT count(*)::int AS c FROM invoices WHERE visit_id = ANY($1)', [[v1.id, oneOff.id]]);
    assert.strictEqual(none.c, 0, 'no $0 invoices');

    const feeJob = await q1("INSERT INTO jobs (property_id, start_date, end_date, active, gardening_fee) VALUES ($1, CURRENT_DATE - 30, CURRENT_DATE + 300, false, 120) RETURNING id", [prop.id]);
    const v2 = await q1("INSERT INTO visits (property_id, job_id, scheduled_date, status, finished_at) VALUES ($1, $2, CURRENT_DATE - 3, 'completed', now()) RETURNING id", [prop.id, feeJob.id]);
    await autoInvoiceAndEmail(v2.id);
    const inv = await q1('SELECT i.id, (SELECT sum(quantity * unit_price) FROM invoice_items WHERE invoice_id = i.id)::float AS total FROM invoices i WHERE visit_id = $1', [v2.id]);
    assert.ok(inv, 'invoice created when there is a fee');
    assert.strictEqual(inv.total, 120);
  });

  await t.test('"Awaiting review" lists completed jobs from earlier days, and approving confirms', async () => {
    const old = await q1("INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at, duration_minutes) VALUES ($1, $2, CURRENT_DATE - 9, 'completed', now() - interval '1 hour', now(), 60) RETURNING id", [prop.id, g.id]);
    await q("INSERT INTO photos (filename, data, visit_id, uploaded_by) VALUES ($1, '\\xffd8ffe0'::bytea, $2, $3)", [`b1-old-${runId}.jpg`, old.id, g.id]);
    const list = await admin.agent.get('/visits?status=completed');
    assert.match(list.text, new RegExp(`href="/visits/${old.id}"`), 'a completed job from 9 days ago is in the queue');
    const res = await admin.agent.post(`/visits/${old.id}/approve`).type('form').send({ next: 'review', _csrf: admin.csrf });
    assert.strictEqual(res.headers.location, `/visits?status=completed&approved=${old.id}`);
    const after = await admin.agent.get(res.headers.location);
    assert.match(after.text, new RegExp(`Job #${old.id} approved for payment`));
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [old.id])).status, 'approved');
    // The plain list still defaults to today onwards.
    const plain = await admin.agent.get('/visits');
    assert.doesNotMatch(plain.text, new RegExp(`href="/visits/${old.id}"`));
  });

  await t.test('a gardener cannot restart a cancelled or skipped visit; staff can', async () => {
    for (const st of ['cancelled', 'skipped']) {
      const v = await q1('INSERT INTO visits (property_id, gardener_id, scheduled_date, status) VALUES ($1, $2, $3, $4) RETURNING id', [prop.id, g.id, today(), st]);
      const res = await g.agent.post(`/visits/${v.id}/timer/start`).type('form').send({ _csrf: g.csrf });
      assert.match(res.headers.location, /error=notactive/);
      assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [v.id])).status, st, `${st} visit unchanged`);
      const page = await g.agent.get(`/visits/${v.id}`);
      assert.doesNotMatch(page.text, /▶ Start job/, 'no Start button for the gardener');
      const staffRes = await admin.agent.post(`/visits/${v.id}/timer/start`).type('form').send({ _csrf: admin.csrf });
      assert.strictEqual(staffRes.headers.location, `/visits/${v.id}`);
      assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [v.id])).status, 'in_progress', 'staff may restart it');
    }
    // A normal scheduled visit still starts for the gardener.
    const ok = await q1("INSERT INTO visits (property_id, gardener_id, scheduled_date, status) VALUES ($1, $2, $3, 'scheduled') RETURNING id", [prop.id, g.id, today()]);
    await g.agent.post(`/visits/${ok.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [ok.id])).status, 'in_progress');
  });

  await t.test('reports embed photos stored in the bucket (PDF and self-contained HTML)', { skip: !TEST_S3 && 'set TEST_S3_ENDPOINT' }, async () => {
    const storage = require('../../src/storage');
    await storage.ensureBucket();
    const { loadReportData, renderReportPdf, renderReportHtml } = require('../../src/report');
    const v = await q1("INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at) VALUES ($1, $2, CURRENT_DATE, 'completed', now(), now()) RETURNING id", [prop.id, g.id]);
    const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#3a7' } }).jpeg().toBuffer();
    const thumb = await sharp(jpeg).resize({ width: 480 }).jpeg().toBuffer();
    // (a) bucket photo with a thumbnail, (b) bucket photo without one (migrated before thumbnails existed).
    const fa = `b1-a-${runId}.jpg`; const fb = `b1-b-${runId}.jpg`;
    await storage.putObject(fa, jpeg, 'image/jpeg');
    await storage.putObject(fb, jpeg, 'image/jpeg');
    await q("INSERT INTO photos (filename, mime, data, thumb_data, visit_id, uploaded_by) VALUES ($1, 'image/jpeg', ''::bytea, $2, $3, $4)", [fa, thumb, v.id, g.id]);
    await q("INSERT INTO photos (filename, mime, data, thumb_data, visit_id, uploaded_by) VALUES ($1, 'image/jpeg', ''::bytea, NULL, $2, $3)", [fb, v.id, g.id]);

    const data = await loadReportData(v.id);
    const pdf = await renderReportPdf(data);
    const images = (pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
    assert.ok(images >= 2, `both photos embedded in the PDF (found ${images} images)`);
    assert.doesNotMatch(pdf.toString('latin1'), new RegExp(fa), 'no filename placeholder for photo a');
    assert.ok(pdf.length < 1.5 * 1024 * 1024, 'PDF stays email-sized');

    const html = await renderReportHtml(data, { inlinePhotos: true });
    const uris = html.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]*)/g) || [];
    assert.ok(uris.filter((u) => u.length > 100).length >= 2, 'both photos inlined with real bytes');
    assert.ok(!/data:image\/jpeg;base64,"/.test(html), 'no empty data URIs');
  });

  await t.test('a dropped idle database connection no longer crashes the process', async () => {
    const script = `
      const { pool } = require(${JSON.stringify(require.resolve('../../src/db'))});
      (async () => {
        const c = await pool.connect();
        const { rows } = await c.query('SELECT pg_backend_pid() AS pid');
        c.release(); // now idle in the pool
        process.stdout.write('PID ' + rows[0].pid + '\\n');
        setTimeout(async () => {
          try { const r = await pool.query('SELECT 1 AS ok'); process.stdout.write('ALIVE ' + r.rows[0].ok + '\\n'); }
          catch (e) { process.stdout.write('QUERYFAIL ' + e.message + '\\n'); }
          await pool.end();
        }, 1500);
      })();`;
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, DATABASE_URL: TEST_DB } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // Kill its idle backend as soon as we learn the pid.
    await new Promise((resolve) => {
      const iv = setInterval(async () => {
        const m = out.match(/PID (\d+)/);
        if (m) { clearInterval(iv); await q('SELECT pg_terminate_backend($1)', [Number(m[1])]); resolve(); }
      }, 50);
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.strictEqual(code, 0, `process exited cleanly (stderr: ${err.slice(0, 300)})`);
    assert.match(out, /ALIVE 1/, 'still serving queries after the connection was dropped');
    assert.match(err, /idle connection error/, 'the drop was logged');
  });
});
