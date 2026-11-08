// Regression tests for bugs found in the multi-role review. Real Postgres +
// the real Express app over HTTP; runs only when TEST_DATABASE_URL is set.
//
//   TEST_DATABASE_URL=postgres://localhost/gardeningmgt_test npm run test:integration
//
// Covers:
//   - saving one Settings card must not wipe the other cards' settings
//   - changing a contract's frequency / deactivating it must not 500 when a
//     future visit has a reminder notification or a linked issue, and must
//     keep visits someone has worked on (e.g. one with a task)
//   - an approved visit can still be invoiced
//   - the approval/completion lock holds for bulk actions, photo deletes and
//     invoice line items / status changes
//   - the job timer: a gardener can't reopen a completed or cancelled job,
//     re-tapping Start keeps the original start time, and only one job can
//     run at a time

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found in response HTML');
  return m[1];
}

test('locks, schedule rebuild and settings regressions', { skip: !TEST_DB && reason }, async (t) => {
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
    const token = extractCsrf((await agent.get('/login')).text);
    const res = await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: token });
    assert.strictEqual(res.status, 302, `login should succeed for ${email}`);
    return { agent, csrf: extractCsrf((await agent.get('/')).text) };
  }

  const gardenerId = await ensureUser('lock-gardener@example.com', 'Lock Gardener', 'gardener');
  const gardener2Id = await ensureUser('lock-gardener2@example.com', 'Lock Gardener 2', 'gardener');
  await ensureUser('lock-staff@example.com', 'Lock Staff', 'supervisor');
  await ensureUser('lock-admin@example.com', 'Lock Admin', 'admin');
  const [g, st, ad] = await Promise.all([
    loginAgent('lock-gardener@example.com'),
    loginAgent('lock-staff@example.com'),
    loginAgent('lock-admin@example.com'),
  ]);

  const stamp = Date.now();
  const newProperty = async (label) => (await q1(
    'INSERT INTO properties (name, address) VALUES ($1, $2) RETURNING id', [`${label} ${stamp}`, 'Addr'])).id;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

  await t.test('saving one Settings card leaves the other cards untouched', async () => {
    let r = await ad.agent.post('/admin/settings').type('form')
      .send({ _csrf: ad.csrf, invoice_business_name: 'Keep Me Pty Ltd', smtp_host: 'smtp.keep.example' });
    assert.strictEqual(r.status, 302);
    // The OneDrive card posts only its own fields.
    r = await ad.agent.post('/admin/settings').type('form')
      .send({ _csrf: ad.csrf, onedrive_tenant_id: 'tenant-1' });
    assert.strictEqual(r.status, 302);
    const rows = await q("SELECT key, value FROM settings WHERE key IN ('invoice_business_name','smtp_host','onedrive_tenant_id')");
    const got = Object.fromEntries(rows.map((x) => [x.key, x.value]));
    assert.ok(got.onedrive_tenant_id, 'the submitted card is saved');
    assert.ok(got.invoice_business_name, 'the invoice card must not be wiped');
    assert.ok(got.smtp_host, 'the email card must not be wiped');
  });

  await t.test('changing frequency / deactivating a contract survives reminders + linked issues and keeps worked-on visits', async () => {
    const propertyId = await newProperty('Rebuild Site');
    const r = await st.agent.post('/jobs').type('form').send({
      _csrf: st.csrf, property_id: propertyId, gardener_id: gardenerId, frequency: 'monthly',
      contract_years: 1, start_date: new Date().toISOString().slice(0, 10),
    });
    assert.strictEqual(r.status, 302);
    const job = await q1('SELECT id FROM jobs WHERE property_id = $1 AND active', [propertyId]);
    const future = await q(`SELECT id FROM visits WHERE job_id = $1 AND status = 'scheduled'
      AND scheduled_date > CURRENT_DATE ORDER BY scheduled_date`, [job.id]);
    assert.ok(future.length >= 3, 'precondition: several future visits booked');
    const [withReminder, withIssue, withTask] = future;
    await q("INSERT INTO notifications (user_id, visit_id, type, message) VALUES ($1, $2, 'reminder', 'r')",
      [gardenerId, withReminder.id]);
    await q("INSERT INTO issues (title, property_id, visit_id, reported_by) VALUES ('linked', $1, $2, $3)",
      [propertyId, withIssue.id, gardenerId]);
    await q("INSERT INTO tasks (visit_id, assignee_id, title) VALUES ($1, $2, 'keep me')", [withTask.id, gardenerId]);

    const upd = await st.agent.post(`/jobs/${job.id}/update`).type('form')
      .send({ _csrf: st.csrf, gardener_id: gardenerId, frequency: 'weekly', active: 'on' });
    assert.strictEqual(upd.status, 302, 'frequency change must not 500');
    assert.strictEqual((await q1('SELECT frequency FROM jobs WHERE id = $1', [job.id])).frequency, 'weekly');
    assert.ok(await q1('SELECT id FROM visits WHERE id = $1', [withTask.id]), 'a visit with a task is kept');
    assert.ok(await q1('SELECT id FROM visits WHERE id = $1', [withIssue.id]), 'a visit with a linked issue is kept');
    assert.strictEqual(await q1('SELECT id FROM visits WHERE id = $1', [withReminder.id]), null,
      'an untouched visit is replaced even though it had a reminder');
    const n = await q1('SELECT visit_id FROM notifications WHERE user_id = $1 AND message = $2 ORDER BY id DESC LIMIT 1',
      [gardenerId, 'r']);
    assert.strictEqual(n.visit_id, null, 'the reminder survives with its visit link cleared');

    const off = await st.agent.post(`/jobs/${job.id}/update`).type('form')
      .send({ _csrf: st.csrf, gardener_id: gardenerId, frequency: 'weekly' });
    assert.strictEqual(off.status, 302, 'deactivating must not 500');
    const left = await q1(`SELECT COUNT(*)::int AS n FROM visits WHERE job_id = $1 AND status = 'scheduled'
      AND scheduled_date > CURRENT_DATE AND id NOT IN ($2, $3)`, [job.id, withTask.id, withIssue.id]);
    assert.strictEqual(left.n, 0, 'untouched future visits are removed on deactivation');
  });

  // An approved visit with a photo, used by the lock tests below.
  const lockProperty = await newProperty('Lock Site');
  const approved = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at,
      finished_at, duration_minutes, approved_at)
    VALUES ($1, $2, CURRENT_DATE - 1, 'approved', now() - interval '2 hours', now() - interval '1 hour', 60, now())
    RETURNING id, scheduled_date`, [lockProperty, gardenerId]);
  const approvedPhoto = await q1(`INSERT INTO photos (filename, original_name, mime, data, visit_id, uploaded_by)
    VALUES ($1, 'a.jpg', 'image/jpeg', $2, $3, $4) RETURNING id`,
    [`lock-approved-${stamp}.jpg`, jpeg, approved.id, gardenerId]);

  await t.test('an approved visit can be invoiced', async () => {
    const r = await st.agent.post('/invoices').type('form').send({ _csrf: st.csrf, visit_id: approved.id });
    assert.strictEqual(r.status, 302);
    assert.doesNotMatch(r.headers.location, /notcompleted/);
    assert.ok(await q1("SELECT id FROM invoices WHERE visit_id = $1 AND status <> 'void'", [approved.id]));
  });

  await t.test('bulk reassign/reschedule skips approved visits', async () => {
    const open = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date)
      VALUES ($1, $2, CURRENT_DATE + 3) RETURNING id`, [lockProperty, gardenerId]);
    let r = await st.agent.post('/visits/bulk').type('form').send({
      _csrf: st.csrf, bulk_action: 'reassign', gardener_id: gardener2Id, visit_ids: [approved.id, open.id],
    });
    assert.match(r.headers.location, /error=bulklocked&skipped=1/);
    assert.strictEqual((await q1('SELECT gardener_id FROM visits WHERE id = $1', [approved.id])).gardener_id, gardenerId);
    assert.strictEqual((await q1('SELECT gardener_id FROM visits WHERE id = $1', [open.id])).gardener_id, gardener2Id);
    r = await st.agent.post('/visits/bulk').type('form').send({
      _csrf: st.csrf, bulk_action: 'reschedule', scheduled_date: '2030-01-01', visit_ids: [approved.id],
    });
    assert.match(r.headers.location, /bulklocked/);
    const v = await q1('SELECT scheduled_date FROM visits WHERE id = $1', [approved.id]);
    assert.strictEqual(v.scheduled_date, approved.scheduled_date);
  });

  await t.test('photos on locked visits: gardener blocked on completed, supervisor blocked on approved, admin allowed', async () => {
    const done = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at)
      VALUES ($1, $2, CURRENT_DATE, 'completed', now() - interval '1 hour', now()) RETURNING id`, [lockProperty, gardenerId]);
    const ph = await q1(`INSERT INTO photos (filename, original_name, mime, data, visit_id, uploaded_by)
      VALUES ($1, 'c.jpg', 'image/jpeg', $2, $3, $4) RETURNING id`, [`lock-done-${stamp}.jpg`, jpeg, done.id, gardenerId]);
    let r = await g.agent.post(`/photos/${ph.id}/delete`).type('form').send({ _csrf: g.csrf });
    assert.match(r.headers.location, /error=locked/);
    assert.ok(await q1('SELECT id FROM photos WHERE id = $1', [ph.id]), 'gardener cannot remove submitted evidence');

    r = await st.agent.post(`/photos/${approvedPhoto.id}/delete`).type('form').send({ _csrf: st.csrf });
    assert.match(r.headers.location, /error=approval/);
    assert.ok(await q1('SELECT id FROM photos WHERE id = $1', [approvedPhoto.id]), 'supervisor cannot remove approved evidence');

    r = await ad.agent.post(`/photos/${approvedPhoto.id}/delete`).type('form').send({ _csrf: ad.csrf });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(await q1('SELECT id FROM photos WHERE id = $1', [approvedPhoto.id]), null, 'admin can');
  });

  await t.test('invoice lines are locked once not a draft; paid cannot go back to draft', async () => {
    const inv = await q1("SELECT id FROM invoices WHERE visit_id = $1 AND status <> 'void'", [approved.id]);
    let r = await st.agent.post(`/invoices/${inv.id}/status`).type('form').send({ _csrf: st.csrf, status: 'paid' });
    assert.strictEqual(r.status, 302);
    r = await st.agent.post(`/invoices/${inv.id}/items`).type('form')
      .send({ _csrf: st.csrf, description: 'sneaky extra', quantity: 1, unit_price: 999 });
    assert.match(r.headers.location, /error=locked/);
    assert.strictEqual((await q1("SELECT COUNT(*)::int AS n FROM invoice_items WHERE invoice_id = $1 AND description = 'sneaky extra'",
      [inv.id])).n, 0);
    r = await st.agent.post(`/invoices/${inv.id}/status`).type('form').send({ _csrf: st.csrf, status: 'draft' });
    assert.match(r.headers.location, /error=transition/);
    r = await st.agent.post(`/invoices/${inv.id}/status`).type('form').send({ _csrf: st.csrf, status: 'sent' });
    const row = await q1('SELECT status, paid_at FROM invoices WHERE id = $1', [inv.id]);
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.paid_at, null, 'leaving "paid" clears the paid date');
  });

  await t.test('timer: re-tapping Start keeps the start time; completed/cancelled jobs cannot be restarted by a gardener', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date)
      VALUES ($1, $2, CURRENT_DATE) RETURNING id`, [lockProperty, gardenerId]);
    await g.agent.post(`/visits/${v.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    await q("UPDATE visits SET started_at = now() - interval '45 minutes' WHERE id = $1", [v.id]);
    const before = (await q1('SELECT started_at FROM visits WHERE id = $1', [v.id])).started_at;
    await g.agent.post(`/visits/${v.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    const after = (await q1('SELECT started_at, status FROM visits WHERE id = $1', [v.id]));
    assert.strictEqual(String(after.started_at), String(before), 'a second Start must not reset the timer');
    assert.strictEqual(after.status, 'in_progress');

    await q("UPDATE visits SET status = 'completed', finished_at = now() WHERE id = $1", [v.id]);
    let r = await g.agent.post(`/visits/${v.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    assert.match(r.headers.location, /error=locked/);
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [v.id])).status, 'completed');

    const c = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status)
      VALUES ($1, $2, CURRENT_DATE, 'cancelled') RETURNING id`, [lockProperty, gardenerId]);
    r = await g.agent.post(`/visits/${c.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    assert.match(r.headers.location, /error=closed/);
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [c.id])).status, 'cancelled');
  });

  await t.test('timer: a gardener cannot run two jobs at once', async () => {
    const a = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date)
      VALUES ($1, $2, CURRENT_DATE) RETURNING id`, [lockProperty, gardenerId]);
    const b = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date)
      VALUES ($1, $2, CURRENT_DATE) RETURNING id`, [lockProperty, gardenerId]);
    await g.agent.post(`/visits/${a.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    const r = await g.agent.post(`/visits/${b.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    assert.match(r.headers.location, new RegExp(`error=running&other=${a.id}`));
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [b.id])).status, 'scheduled');
    await q("UPDATE visits SET status = 'scheduled', started_at = NULL WHERE id = $1", [a.id]);
  });

  await t.test('timer: concurrent Start/Stop never lets a gardener reopen a completed job', async () => {
    for (let round = 0; round < 5; round++) {
      const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at)
        VALUES ($1, $2, CURRENT_DATE, 'in_progress', now() - interval '30 minutes') RETURNING id`, [lockProperty, gardenerId]);
      await q(`INSERT INTO photos (filename, original_name, mime, data, visit_id, uploaded_by)
        VALUES ($1, 'r.jpg', 'image/jpeg', $2, $3, $4)`, [`race-${stamp}-${round}.jpg`, jpeg, v.id, gardenerId]);
      const reqs = [];
      for (let i = 0; i < 4; i++) {
        reqs.push(g.agent.post(`/visits/${v.id}/timer/stop`).type('form').send({ _csrf: g.csrf, confirm_photos: 'on' }));
        reqs.push(g.agent.post(`/visits/${v.id}/timer/start`).type('form').send({ _csrf: g.csrf }));
      }
      await Promise.all(reqs);
      const row = await q1('SELECT status, duration_minutes FROM visits WHERE id = $1', [v.id]);
      assert.strictEqual(row.status, 'completed', `round ${round}: must end completed, not reopened`);
      assert.ok(row.duration_minutes >= 29, `round ${round}: worked time must be kept (got ${row.duration_minutes})`);
      const done = await q1(`SELECT COUNT(*)::int AS n FROM activity_log
        WHERE action = 'visit.timer.stop' AND entity_id = $1`, [v.id]);
      assert.strictEqual(done.n, 1, `round ${round}: completed exactly once`);
    }
  });
});
