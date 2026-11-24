// Bulk clean-up of overdue / stuck jobs, gardeners reporting issues only on
// their own work, and dates grouped by the business (Melbourne) calendar.
// Needs TEST_DATABASE_URL.

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

test('localDateSql gives the Melbourne calendar date', () => {
  const { localDateSql } = require('../../src/time');
  assert.strictEqual(localDateSql('ph.created_at'),
    "((ph.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date");
});

test('clean-up, own-work issues, local dates', { skip: !TEST_DB && 'set TEST_DATABASE_URL to run these' }, async (t) => {
  const runId = Date.now();
  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const { today } = require('../../src/time');
  const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  const TODAY = today();

  async function user(tag, role) {
    const email = `cat-${tag}-${runId}@example.com`;
    const { id } = await q1('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [`CAT ${tag}`, email, bcrypt.hashSync('testpass123', 10), role]);
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    return { id, agent, csrf: extractCsrf((await agent.get('/')).text) };
  }
  const admin = await user('admin', 'admin');
  const sup = await user('sup', 'supervisor');
  const g = await user('g', 'gardener');
  const other = await user('other', 'gardener');
  const mySite = await q1("INSERT INTO properties (name, address) VALUES ('CAT mine', '1 Mine St') RETURNING id");
  const theirSite = await q1("INSERT INTO properties (name, address) VALUES ('CAT theirs', '2 Theirs St') RETURNING id");
  const visit = (prop, gid, date, status = 'scheduled', extra = '') => q1(
    `INSERT INTO visits (property_id, gardener_id, scheduled_date, status${extra ? ', started_at' : ''})
     VALUES ($1, $2, $3, $4${extra ? `, ${extra}` : ''}) RETURNING id`, [prop, gid, date, status]);

  await t.test('only admins can open the clean-up page', async () => {
    assert.strictEqual((await admin.agent.get('/admin/cleanup')).status, 200);
    assert.strictEqual((await sup.agent.get('/admin/cleanup')).status, 403);
    assert.strictEqual((await g.agent.get('/admin/cleanup')).status, 403);
    assert.strictEqual((await g.agent.post('/admin/cleanup/overdue').type('form')
      .send({ _csrf: g.csrf, action: 'skipped', confirm: 'on', before: TODAY })).status, 403);
  });

  await t.test('overdue visits before the cutoff are closed; recent and future ones are kept', async () => {
    const old1 = await visit(mySite.id, g.id, addDays(TODAY, -60));
    const old2 = await visit(theirSite.id, other.id, addDays(TODAY, -30));
    const recent = await visit(mySite.id, g.id, addDays(TODAY, -2));
    const future = await visit(mySite.id, g.id, addDays(TODAY, 5));
    const doneOld = await visit(mySite.id, g.id, addDays(TODAY, -40), 'completed');
    const cut = addDays(TODAY, -7);
    const page = await admin.agent.get(`/admin/cleanup?before=${cut}`);
    assert.match(page.text, /Close \d+ overdue visit\(s\)/);
    // Without the confirmation tick, nothing changes.
    const noConfirm = await admin.agent.post('/admin/cleanup/overdue').type('form')
      .send({ _csrf: admin.csrf, action: 'skipped', before: cut });
    assert.match(noConfirm.headers.location, /error=confirm/);
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [old1.id])).status, 'scheduled');
    const r = await admin.agent.post('/admin/cleanup/overdue').type('form')
      .send({ _csrf: admin.csrf, action: 'skipped', before: cut, confirm: 'on' });
    assert.match(r.headers.location, /done=overdue/);
    const st = async (v) => (await q1('SELECT status, advanced_at FROM visits WHERE id = $1', [v.id]));
    assert.strictEqual((await st(old1)).status, 'skipped');
    assert.ok((await st(old1)).advanced_at, 'marked as advanced (no duplicate booking)');
    assert.strictEqual((await st(old2)).status, 'skipped');
    assert.strictEqual((await st(recent)).status, 'scheduled');
    assert.strictEqual((await st(future)).status, 'scheduled');
    assert.strictEqual((await st(doneOld)).status, 'completed');
    const log = await q1("SELECT details FROM activity_log WHERE action = 'visit.bulk_cleanup' ORDER BY id DESC LIMIT 1");
    assert.ok(log.details.includes(`#${old1.id}`) && log.details.includes(`#${old2.id}`), 'ids recorded');
  });

  await t.test('a cutoff in the future is limited to today', async () => {
    const tomorrowVisit = await visit(mySite.id, g.id, addDays(TODAY, 1));
    await admin.agent.post('/admin/cleanup/overdue').type('form')
      .send({ _csrf: admin.csrf, action: 'cancelled', before: addDays(TODAY, 30), confirm: 'on' });
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [tomorrowVisit.id])).status, 'scheduled');
  });

  await t.test('selected stuck jobs are closed; a job running today is not stuck', async () => {
    const stuck = await visit(mySite.id, g.id, addDays(TODAY, -20), 'in_progress', "now() - interval '20 days'");
    const running = await visit(mySite.id, g.id, TODAY, 'in_progress', "now() - interval '1 hour'");
    const page = await admin.agent.get('/admin/cleanup');
    assert.ok(page.text.includes(`value="${stuck.id}"`));
    assert.ok(!page.text.includes(`value="${running.id}"`));
    const r = await admin.agent.post('/admin/cleanup/stuck').type('form')
      .send({ _csrf: admin.csrf, action: 'cancelled', ids: [String(stuck.id), String(running.id)] });
    assert.match(r.headers.location, /done=stuck&n=1/);
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [stuck.id])).status, 'cancelled');
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [running.id])).status, 'in_progress');
  });

  await t.test('gardeners can report issues only for their own jobs and sites', async () => {
    await visit(mySite.id, g.id, addDays(TODAY, 3));
    const theirVisit = await visit(theirSite.id, other.id, addDays(TODAY, 3));
    const post = (body) => g.agent.post(`/issues?_csrf=${encodeURIComponent(g.csrf)}`).field('_csrf', g.csrf)
      .field('title', body.title).field('property_id', String(body.property_id || '')).field('visit_id', String(body.visit_id || ''));
    const bad = await post({ title: 'Broken tap', property_id: theirSite.id });
    assert.match(bad.headers.location, /error=site/);
    const noSite = await post({ title: 'No site' });
    assert.match(noSite.headers.location, /error=site/);
    // Someone else's visit doesn't count either.
    const viaTheirVisit = await post({ title: 'Via their visit', property_id: theirSite.id, visit_id: theirVisit.id });
    assert.match(viaTheirVisit.headers.location, /error=site/);
    assert.strictEqual((await q1("SELECT COUNT(*)::int AS n FROM issues WHERE property_id = $1", [theirSite.id])).n, 0);
    const ok = await post({ title: 'Dead hedge', property_id: mySite.id });
    assert.match(ok.headers.location, /^\/issues\/\d+/);
    // Staff can still report anywhere.
    const staff = await admin.agent.post(`/issues?_csrf=${encodeURIComponent(admin.csrf)}`).field('_csrf', admin.csrf)
      .field('title', 'Staff note').field('property_id', String(theirSite.id));
    assert.match(staff.headers.location, /^\/issues\/\d+/);
  });

  await t.test('gardeners can still not open or start someone else\'s job', async () => {
    const theirs = await visit(theirSite.id, other.id, TODAY);
    const view = await g.agent.get(`/visits/${theirs.id}`);
    assert.notStrictEqual(view.status, 200);
    assert.ok(!view.text.includes('CAT theirs'), "someone else's job isn't shown");
    const start = await g.agent.post(`/visits/${theirs.id}/timer/start`).type('form').send({ _csrf: g.csrf });
    assert.strictEqual(start.status, 302);
    assert.strictEqual((await q1('SELECT status FROM visits WHERE id = $1', [theirs.id])).status, 'scheduled');
  });

  await t.test('photo date filter uses the Melbourne date, not the UTC date', async () => {
    // 21:30 UTC on the day before is 07:30 or 08:30 the next morning in Melbourne.
    const melbDay = addDays(TODAY, -3);
    const utcEvening = `${addDays(melbDay, -1)} 21:30:00`;
    const v = await visit(mySite.id, g.id, melbDay, 'completed');
    await q(`INSERT INTO photos (filename, original_name, mime, data, visit_id, uploaded_by, created_at)
      VALUES ($1, 'p.jpg', 'image/jpeg', '\\x00', $2, $3, $4)`, [`cat-${runId}.jpg`, v.id, g.id, utcEvening]);
    const page = await admin.agent.get(`/photos?from=${melbDay}&to=${melbDay}`);
    assert.ok(page.text.includes(`cat-${runId}.jpg`), 'found on its Melbourne day');
    const prev = await admin.agent.get(`/photos?from=${addDays(melbDay, -1)}&to=${addDays(melbDay, -1)}`);
    assert.ok(!prev.text.includes(`cat-${runId}.jpg`), 'not on the UTC day');
  });
});
