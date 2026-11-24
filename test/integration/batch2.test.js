// Fixes from the end-to-end review (batch 2: workflow integrity).
// Needs TEST_DATABASE_URL.

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

test('review batch 2: workflow integrity', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  process.env.SESSION_SECRET = 'test-secret-for-integration-tests';
  delete process.env.S3_BUCKET; // photos inline for these tests

  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const { today } = require('../../src/time');
  const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  const runId = Date.now();
  async function user(tag, role) {
    const email = `b2-${tag}-${runId}@example.com`;
    const { id } = await q1('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [`B2 ${tag}`, email, bcrypt.hashSync('testpass123', 10), role]);
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    return { id, agent, csrf: extractCsrf((await agent.get('/')).text) };
  }
  const admin = await user('admin', 'admin');
  const g = await user('g', 'gardener');
  let siteN = 0;
  const site = async () => (await q1('INSERT INTO properties (name, address) VALUES ($1, $2) RETURNING id',
    [`B2 Site ${runId}-${++siteN}`, 'B2 St'])).id;
  const post = (who, path, body) => who.agent.post(path).type('form').send({ ...body, _csrf: who.csrf });
  const status = async (id) => (await q1('SELECT status FROM visits WHERE id = $1', [id])).status;
  const T = today();
  const evidencePhoto = (visitId) => q("INSERT INTO photos (filename, data, visit_id, uploaded_by) VALUES ($1, '\\xffd8ffe0'::bytea, $2, $3)",
    [`b2-${runId}-${Math.random().toString(36).slice(2)}.jpg`, visitId, g.id]);

  await t.test('reopening a job adds only the new time to the minutes worked', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at)
      VALUES ($1, $2, $3, 'in_progress', now() - interval '30 minutes') RETURNING id`, [await site(), g.id, T]);
    await evidencePhoto(v.id);
    await post(g, `/visits/${v.id}/timer/stop`, { confirm_photos: 'on' });
    assert.strictEqual((await q1('SELECT duration_minutes FROM visits WHERE id = $1', [v.id])).duration_minutes, 30);
    // A day later a supervisor reopens it; the gardener works 10 more minutes.
    await q("UPDATE visits SET started_at = started_at - interval '1 day', finished_at = finished_at - interval '1 day' WHERE id = $1", [v.id]);
    await post(admin, `/visits/${v.id}/timer/start`, {});
    assert.strictEqual(await status(v.id), 'in_progress');
    await q("UPDATE visits SET resumed_at = now() - interval '10 minutes' WHERE id = $1", [v.id]);
    await post(g, `/visits/${v.id}/timer/stop`, { confirm_photos: 'on' });
    const row = await q1('SELECT status, duration_minutes, resumed_at FROM visits WHERE id = $1', [v.id]);
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(row.duration_minutes, 40, 'was ~1,470 before the fix');
    assert.strictEqual(row.resumed_at, null);
  });

  await t.test('completing a visit never books over a moved or pre-skipped next visit', async () => {
    const mk = async () => {
      const prop = await site();
      const job = await q1(`INSERT INTO jobs (property_id, gardener_id, frequency, start_date, end_date)
        VALUES ($1, $2, 'weekly', $3, $4) RETURNING id`, [prop, g.id, T, addDays(T, 365)]);
      const v = await q1(`INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, status, started_at)
        VALUES ($1, $2, $3, $4, 'in_progress', now() - interval '5 minutes') RETURNING id`, [job.id, prop, g.id, T]);
      await evidencePhoto(v.id);
      return { job, prop, v };
    };
    // A: next week's visit was moved a day later.
    const a = await mk();
    await q("INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, status) VALUES ($1, $2, $3, $4, 'scheduled')",
      [a.job.id, a.prop, g.id, addDays(T, 8)]);
    await post(g, `/visits/${a.v.id}/timer/stop`, { confirm_photos: 'on' });
    const aDates = (await q('SELECT scheduled_date::text AS d FROM visits WHERE job_id = $1 AND scheduled_date > $2 ORDER BY 1', [a.job.id, T])).map((r) => r.d);
    assert.deepStrictEqual(aDates, [addDays(T, 8)], 'no extra visit on the original day');
    // B: next week was skipped in advance.
    const b = await mk();
    await q("INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, status) VALUES ($1, $2, $3, $4, 'skipped')",
      [b.job.id, b.prop, g.id, addDays(T, 7)]);
    await post(g, `/visits/${b.v.id}/timer/stop`, { confirm_photos: 'on' });
    const bRows = await q('SELECT status FROM visits WHERE job_id = $1 AND scheduled_date = $2', [b.job.id, addDays(T, 7)]);
    assert.deepStrictEqual(bRows.map((r) => r.status), ['skipped'], 'the skip is not undone');
    // Normal case still books the next one.
    const c = await mk();
    await post(g, `/visits/${c.v.id}/timer/stop`, { confirm_photos: 'on' });
    const cNext = await q1("SELECT scheduled_date::text AS d FROM visits WHERE job_id = $1 AND status = 'scheduled'", [c.job.id]);
    assert.strictEqual(cNext.d, addDays(T, 7));
  });

  await t.test('Manage job: completing needs the same evidence unless overridden, and records hours', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at)
      VALUES ($1, $2, $3, 'in_progress', now() - interval '45 minutes') RETURNING id`, [await site(), g.id, T]);
    const form = { gardener_id: String(g.id), scheduled_date: T, time_window: '', notes: '', duration_minutes: '', status_was: 'in_progress' };
    const blocked = await post(admin, `/visits/${v.id}/update`, { ...form, status: 'completed' });
    assert.match(blocked.headers.location, /error=staffgaps/);
    assert.strictEqual(await status(v.id), 'in_progress');
    const page = await admin.agent.get(`/visits/${v.id}?error=staffgaps`);
    assert.match(page.text, /can't be marked completed yet: no photos/);

    await post(admin, `/visits/${v.id}/update`, { ...form, status: 'completed', force_complete: '1' });
    const row = await q1('SELECT status, duration_minutes, finished_at IS NOT NULL AS fin FROM visits WHERE id = $1', [v.id]);
    assert.deepStrictEqual(row, { status: 'completed', duration_minutes: 45, fin: true }, 'hours recorded (were null)');
    const log = await q1("SELECT details FROM activity_log WHERE action = 'visit.update' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [v.id]);
    assert.match(log.details, /completed anyway, missing: no photos/);
    const note = await q1("SELECT count(*)::int AS c FROM notifications WHERE visit_id = $1 AND type = 'job_summary'", [v.id]);
    assert.ok(note.c >= 1, 'staff notified like a normal completion');
  });

  await t.test('Manage job: an out-of-date form never puts a completed job back in progress', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at, duration_minutes)
      VALUES ($1, $2, $3, 'completed', now() - interval '1 hour', now(), 60) RETURNING id`, [await site(), g.id, T]);
    // Form drawn while it was still in progress; supervisor only edits notes.
    const form = { gardener_id: String(g.id), scheduled_date: T, time_window: '', duration_minutes: '60', status_was: 'in_progress', status: 'in_progress' };
    await post(admin, `/visits/${v.id}/update`, { ...form, notes: 'gate code 1234' });
    const row = await q1('SELECT status, notes, finished_at IS NOT NULL AS fin FROM visits WHERE id = $1', [v.id]);
    assert.deepStrictEqual(row, { status: 'completed', notes: 'gate code 1234', fin: true });
    // A deliberate status change from a stale page is refused.
    const res = await post(admin, `/visits/${v.id}/update`, { ...form, status: 'cancelled', notes: '' });
    assert.match(res.headers.location, /error=stale/);
    assert.strictEqual(await status(v.id), 'completed');
  });

  await t.test('putting a completed job back in progress reopens it for photos', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at, duration_minutes)
      VALUES ($1, $2, $3, 'completed', now() - interval '1 hour', now(), 60) RETURNING id`, [await site(), g.id, T]);
    await post(admin, `/visits/${v.id}/status`, { status: 'in_progress' });
    const row = await q1('SELECT status, finished_at, resumed_at IS NOT NULL AS resumed FROM visits WHERE id = $1', [v.id]);
    assert.deepStrictEqual(row, { status: 'in_progress', finished_at: null, resumed: true });
    const presign = await g.agent.post(`/visits/${v.id}/photo/presign`).set('X-CSRF-Token', g.csrf).send({});
    assert.strictEqual(presign.status, 200, 'photo window open again (was 409 "job is closed")');
  });

  await t.test('cancelling a completed job: refused once invoiced; a draft invoice is voided', async () => {
    const mk = async (invStatus) => {
      const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at)
        VALUES ($1, $2, $3, 'completed', now(), now()) RETURNING id`, [await site(), g.id, T]);
      const inv = await q1('INSERT INTO invoices (visit_id, number, status) VALUES ($1, $2, $3) RETURNING id',
        [v.id, `B2-${runId}-${invStatus}`, invStatus]);
      return { v, inv };
    };
    const sent = await mk('sent');
    const r1 = await post(admin, `/visits/${sent.v.id}/status`, { status: 'cancelled' });
    assert.match(r1.headers.location, /error=invoiced/);
    assert.strictEqual(await status(sent.v.id), 'completed');
    const draft = await mk('draft');
    await post(admin, `/visits/${draft.v.id}/status`, { status: 'cancelled' });
    assert.strictEqual(await status(draft.v.id), 'cancelled');
    assert.strictEqual((await q1('SELECT status FROM invoices WHERE id = $1', [draft.inv.id])).status, 'void');
  });

  await t.test('contracts: deactivating keeps follow-up tasks and never fails halfway', async () => {
    const prop = await site();
    const job = await q1(`INSERT INTO jobs (property_id, gardener_id, frequency, start_date, end_date)
      VALUES ($1, $2, 'weekly', $3, $4) RETURNING *`, [prop, g.id, T, addDays(T, 365)]);
    const vReminded = await q1("INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING id", [job.id, prop, g.id, addDays(T, 7)]);
    const vTask = await q1("INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING id", [job.id, prop, g.id, addDays(T, 14)]);
    const vPlain = await q1("INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING id", [job.id, prop, g.id, addDays(T, 21)]);
    await q("INSERT INTO notifications (user_id, visit_id, type, message) VALUES ($1, $2, 'reminder', 'x')", [g.id, vReminded.id]);
    await q("INSERT INTO tasks (visit_id, title, created_by) VALUES ($1, 'Bring mulch', $2)", [vTask.id, admin.id]);
    const res = await post(admin, `/jobs/${job.id}/update`, { gardener_id: String(g.id), frequency: 'weekly', time_window: '' /* active unticked */ });
    assert.strictEqual(res.status, 302, 'no 500');
    assert.strictEqual((await q1('SELECT active FROM jobs WHERE id = $1', [job.id])).active, false);
    const left = (await q('SELECT id FROM visits WHERE job_id = $1 ORDER BY id', [job.id])).map((r) => r.id);
    assert.deepStrictEqual(left, [vTask.id], 'reminded and plain visits removed; the one with a follow-up task kept');
    assert.ok(await q1('SELECT 1 FROM tasks WHERE visit_id = $1', [vTask.id]), 'follow-up task survives');
    assert.ok(vPlain && vReminded);
  });

  await t.test('contracts: renewing books visits now, and a clash is a message not a 500', async () => {
    const prop = await site();
    const old = await q1(`INSERT INTO jobs (property_id, gardener_id, frequency, start_date, end_date, active)
      VALUES ($1, $2, 'weekly', $3, $4, false) RETURNING id`, [prop, g.id, addDays(T, -400), addDays(T, -35)]);
    // Renew: the contract term restarts from its old end and books from today.
    await post(admin, `/jobs/${old.id}/renew`, { contract_years: '1' });
    const booked = await q1("SELECT count(*)::int AS c FROM visits WHERE job_id = $1 AND status = 'scheduled' AND scheduled_date >= $2", [old.id, T]);
    assert.ok(booked.c > 0, 'upcoming visits booked straight away');
    // Another contract for the same site is active: renewing a second inactive one clashes.
    const other = await q1(`INSERT INTO jobs (property_id, gardener_id, frequency, start_date, end_date, active)
      VALUES ($1, $2, 'weekly', $3, $4, false) RETURNING id`, [prop, g.id, addDays(T, -400), addDays(T, -35)]);
    const res = await post(admin, `/jobs/${other.id}/renew`, { contract_years: '1' });
    assert.strictEqual(res.headers.location, '/jobs?error=duplicate');
  });

  await t.test('bulk actions leave started/finished work alone and report date clashes', async () => {
    const prop = await site();
    const approved = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, approved_at)
      VALUES ($1, $2, $3, 'approved', now()) RETURNING id`, [prop, g.id, addDays(T, -3)]);
    const sched = await q1('INSERT INTO visits (property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3) RETURNING id', [prop, g.id, addDays(T, 2)]);
    const res = await admin.agent.post('/visits/bulk').type('form')
      .send(`_csrf=${encodeURIComponent(admin.csrf)}&bulk_action=reschedule&scheduled_date=${addDays(T, 5)}&visit_ids=${approved.id}&visit_ids=${sched.id}`);
    assert.match(res.headers.location, /error=bulkskipped&n=1/);
    assert.strictEqual((await q1('SELECT scheduled_date::text AS d FROM visits WHERE id = $1', [approved.id])).d, addDays(T, -3), 'paid work not moved');
    assert.strictEqual((await q1('SELECT scheduled_date::text AS d FROM visits WHERE id = $1', [sched.id])).d, addDays(T, 5));
    // Two occurrences of one contract onto one day.
    const job = await q1(`INSERT INTO jobs (property_id, gardener_id, frequency, start_date, end_date, active)
      VALUES ($1, $2, 'weekly', $3, $4, false) RETURNING id`, [prop, g.id, T, addDays(T, 365)]);
    const a = await q1('INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING id', [job.id, prop, g.id, addDays(T, 7)]);
    const b = await q1('INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING id', [job.id, prop, g.id, addDays(T, 14)]);
    const clash = await admin.agent.post('/visits/bulk').type('form')
      .send(`_csrf=${encodeURIComponent(admin.csrf)}&bulk_action=reschedule&scheduled_date=${addDays(T, 9)}&visit_ids=${a.id}&visit_ids=${b.id}`);
    assert.strictEqual(clash.headers.location, '/visits?error=dateclash');
    assert.strictEqual((await q1('SELECT scheduled_date::text AS d FROM visits WHERE id = $1', [a.id])).d, addDays(T, 7), 'nothing moved');
  });

  await t.test('invoices: lines only on drafts, sensible status changes, approved work invoiceable', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, approved_at)
      VALUES ($1, $2, $3, 'approved', now()) RETURNING id`, [await site(), g.id, T]);
    const created = await post(admin, '/invoices', { visit_id: String(v.id) });
    const invId = Number((created.headers.location.match(/\/invoices\/(\d+)/) || [])[1]);
    assert.ok(invId, 'an approved visit can be invoiced (was "not completed")');
    await post(admin, `/invoices/${invId}/items`, { description: 'Mowing', quantity: '1', unit_price: '80' });
    await post(admin, `/invoices/${invId}/status`, { status: 'paid' });
    const add = await post(admin, `/invoices/${invId}/items`, { description: 'Extra', quantity: '1', unit_price: '500' });
    assert.match(add.headers.location, /error=notdraftedit/);
    const total = await q1('SELECT sum(quantity * unit_price)::float AS t FROM invoice_items WHERE invoice_id = $1', [invId]);
    assert.strictEqual(total.t, 80, 'paid invoice unchanged');
    const back = await post(admin, `/invoices/${invId}/status`, { status: 'draft' });
    assert.match(back.headers.location, /error=transition/);
    await post(admin, `/invoices/${invId}/status`, { status: 'sent' }); // mark unpaid
    const row = await q1('SELECT status, paid_at FROM invoices WHERE id = $1', [invId]);
    assert.deepStrictEqual(row, { status: 'sent', paid_at: null });
    await post(admin, `/invoices/${invId}/status`, { status: 'void' });
    const unvoid = await post(admin, `/invoices/${invId}/status`, { status: 'paid' });
    assert.match(unvoid.headers.location, /error=transition/);
  });

  await t.test('disabling a gardener unassigns their upcoming work and stops their reminders', async () => {
    const leaver = await user('leaver', 'gardener');
    const prop = await site();
    const job = await q1(`INSERT INTO jobs (property_id, gardener_id, frequency, start_date, end_date)
      VALUES ($1, $2, 'weekly', $3, $4) RETURNING id`, [prop, leaver.id, T, addDays(T, 365)]);
    const tomorrow = addDays(T, 1);
    const v = await q1('INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING id', [job.id, prop, leaver.id, tomorrow]);
    // Another of their visits on that day stays assigned only if not scheduled (e.g. history) — none here.
    const res = await post(admin, `/admin/users/${leaver.id}/toggle`, {});
    assert.match(res.headers.location, /unassigned=1&contracts=1/);
    assert.strictEqual((await q1('SELECT gardener_id FROM visits WHERE id = $1', [v.id])).gardener_id, null);
    assert.strictEqual((await q1('SELECT gardener_id FROM jobs WHERE id = $1', [job.id])).gardener_id, null);
    // Even if something is still assigned to them, no reminder goes out.
    await q('UPDATE visits SET gardener_id = $1 WHERE id = $2', [leaver.id, v.id]);
    const { sendRemindersForDate } = require('../../src/reminders');
    await sendRemindersForDate(tomorrow, { force: true });
    const n = await q1('SELECT count(*)::int AS c FROM notifications WHERE user_id = $1', [leaver.id]);
    assert.strictEqual(n.c, 0, 'disabled gardener got no reminder');
  });

  await t.test('a submitted job is locked for the gardener: tasks, GPS, and comment photos', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at)
      VALUES ($1, $2, $3, 'completed', now(), now()) RETURNING id`, [await site(), g.id, T]);
    const task = await q1("INSERT INTO tasks (visit_id, title, created_by, created_at) VALUES ($1, 'Prune', $2, now() - interval '1 hour') RETURNING id, status", [v.id, admin.id]);
    await post(g, `/tasks/${task.id}/status`, { status: 'blocked' });
    assert.strictEqual((await q1('SELECT status FROM tasks WHERE id = $1', [task.id])).status, task.status);
    const add = await post(g, `/visits/${v.id}/tasks`, { title: 'Late task' });
    assert.match(add.headers.location, /error=locked/);
    assert.ok(!(await q1("SELECT 1 FROM tasks WHERE visit_id = $1 AND title = 'Late task'", [v.id])));
    const gps = await g.agent.post(`/visits/${v.id}/gps`).set('X-CSRF-Token', g.csrf).send({ lat: -37.8, lng: 145 });
    assert.strictEqual(gps.status, 409);

    // A comment photo doesn't satisfy "at least one photo".
    const running = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at)
      VALUES ($1, $2, $3, 'in_progress', now()) RETURNING id`, [await site(), g.id, T]);
    const c = await q1('INSERT INTO visit_comments (visit_id, user_id, body) VALUES ($1, $2, $3) RETURNING id', [running.id, g.id, 'see photo']);
    await q("INSERT INTO photos (filename, data, visit_id, visit_comment_id, uploaded_by) VALUES ($1, '\\xffd8ffe0'::bytea, $2, $3, $4)",
      [`b2-c-${runId}.jpg`, running.id, c.id, g.id]);
    const stop = await post(g, `/visits/${running.id}/timer/stop`, { confirm_photos: 'on' });
    assert.match(stop.headers.location, /error=photos/);
    assert.strictEqual(await status(running.id), 'in_progress');
  });
});
