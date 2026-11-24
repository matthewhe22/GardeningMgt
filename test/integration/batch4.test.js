// Fixes from the end-to-end review (batch 4: phone experience and sessions).
// The database checks need TEST_DATABASE_URL; the script checks run anywhere.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TEST_DB = process.env.TEST_DATABASE_URL;

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf-token meta tag found');
  return m[1];
}

// A bare-bones browser window: enough for app.js to run its top level.
function fakeWindow() {
  const listeners = {};
  const intervals = new Set();
  const el = () => null;
  const document = {
    readyState: 'complete',
    querySelector: el, getElementById: el, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} }),
    body: { appendChild() {}, classList: { add() {}, remove() {}, contains: () => false } },
    documentElement: { classList: { add() {}, remove() {} } },
    addEventListener() {},
  };
  const window = {
    document,
    navigator: { onLine: true, userAgent: 'test', standalone: false },
    location: { href: 'https://example.test/visits/1', origin: 'https://example.test', pathname: '/visits/1', search: '', hash: '' },
    addEventListener(type, fn) { (listeners[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { listeners[type] && listeners[type].delete(fn); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setInterval: (fn, ms) => { const id = { fn, ms }; intervals.add(id); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ position: 'static' }),
    console, URL, URLSearchParams, Event: class {}, fetch: () => Promise.reject(new Error('offline')),
  };
  window.window = window;
  window.self = window;
  return { window, listeners, intervals };
}

test('app.js can run again in the same window (a rendered response shown with document.write)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  const { window, listeners } = fakeWindow();
  const ctx = vm.createContext(window);
  vm.runInContext(src, ctx);
  const onlineAfterFirst = listeners.online ? listeners.online.size : 0;
  // Before the fix the second run threw "Identifier 'CSRF' has already been declared".
  assert.doesNotThrow(() => vm.runInContext(src, ctx));
  assert.strictEqual(listeners.online ? listeners.online.size : 0, onlineAfterFirst, 'window listeners are not doubled');
});

test('service worker keeps job pages for offline use, not other pages', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
  const m = src.match(/const CACHEABLE_PAGE = (\/.*\/);/);
  assert.ok(m, 'CACHEABLE_PAGE defined');
  const re = vm.runInNewContext(m[1]);
  for (const p of ['/', '/visits', '/visits/12', '/visits/12/standards']) assert.ok(re.test(p), p);
  for (const p of ['/admin/settings', '/invoices/3', '/visits/12/report', '/login', '/uploads/x.jpg']) assert.ok(!re.test(p), p);
});

test('review batch 4: tasks, owner reports, sessions', { skip: !TEST_DB && 'set TEST_DATABASE_URL to run these' }, async (t) => {
  const runId = Date.now();
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, DB_SKIP_INIT: '', SESSION_SECRET: 'test-secret-for-integration-tests',
    S3_BUCKET: '', S3_ENDPOINT: '',
  });
  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());
  const request = require('supertest');
  const app = require('../../src/server');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');
  const { today } = require('../../src/time');
  const auth = require('../../src/auth');

  async function user(tag, role) {
    const email = `b4-${tag}-${runId}@example.com`;
    const { id } = await q1('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [`B4 ${tag}`, email, bcrypt.hashSync('testpass123', 10), role]);
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/login').type('form').send({ email, password: 'testpass123', _csrf: extractCsrf(lp.text) });
    return { id, email, agent, csrf: extractCsrf((await agent.get('/')).text) };
  }
  const admin = await user('admin', 'admin');
  const g = await user('g', 'gardener');
  const prop = await q1("INSERT INTO properties (name, address, piq_building_id) VALUES ('B4 Site', 'B4 St', '777') RETURNING id");
  const newVisit = async () => q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at)
    VALUES ($1, $2, $3, 'in_progress', now() - interval '5 minutes') RETURNING id`, [prop.id, g.id, today()]);
  const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');
  const jpeg = (takenAt) => sharp({ create: { width: 64, height: 48, channels: 3, background: '#2a6' } }).jpeg()
    .withExif({ IFD2: { DateTimeOriginal: stamp(takenAt), OffsetTimeOriginal: '+00:00' } }).toBuffer();
  const sendPhoto = async (visitId, fields) => {
    let r = g.agent.post(`/visits/${visitId}/photo?_csrf=${encodeURIComponent(g.csrf)}`).set('X-CSRF-Token', g.csrf);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
    return r.attach('photo', await jpeg(new Date()), { filename: 'p.jpg', contentType: 'image/jpeg' });
  };

  await t.test("a task's photo marks it done (a blocked task stays blocked)", async () => {
    const v = await newVisit();
    const pending = await q1("INSERT INTO tasks (visit_id, title, status) VALUES ($1, 'Prune roses', 'pending') RETURNING id", [v.id]);
    const blocked = await q1("INSERT INTO tasks (visit_id, title, status) VALUES ($1, 'Fix tap', 'blocked') RETURNING id", [v.id]);
    const r1 = await sendPhoto(v.id, { task_id: pending.id, tz: 0 });
    assert.strictEqual(r1.status, 200, r1.text);
    const r2 = await sendPhoto(v.id, { task_id: blocked.id, tz: 0 });
    assert.strictEqual(r2.status, 200, r2.text);
    const rows = await q('SELECT id, status, completed_at FROM tasks WHERE visit_id = $1 ORDER BY id', [v.id]);
    assert.strictEqual(rows[0].status, 'done');
    assert.ok(rows[0].completed_at);
    assert.strictEqual(rows[1].status, 'blocked');
  });

  await t.test('a scope item\'s tick and comment save without photos (after a photo was refused)', async () => {
    const v = await newVisit();
    const c = await q1("INSERT INTO visit_scope_checks (visit_id, title, position) VALUES ($1, 'Mow lawn', 1) RETURNING id", [v.id]);
    const r = await g.agent.post(`/visits/${v.id}/scope/${c.id}`).type('form')
      .send({ _csrf: g.csrf, done: 'on', comment: 'Mowed front and back' });
    assert.strictEqual(r.status, 302);
    const row = await q1('SELECT done, comment FROM visit_scope_checks WHERE id = $1', [c.id]);
    assert.strictEqual(row.done, true);
    assert.strictEqual(row.comment, 'Mowed front and back');
  });

  await t.test('an owner report already being sent is not sent again', async () => {
    const v = await q1(`INSERT INTO visits (property_id, gardener_id, scheduled_date, status, started_at, finished_at, owners_report_sending_at)
      VALUES ($1, $2, $3, 'completed', now() - interval '2 hours', now() - interval '1 hour', now()) RETURNING id`, [prop.id, g.id, today()]);
    const send = () => admin.agent.post(`/visits/${v.id}/report/send-to-owners`).type('form')
      .send({ _csrf: admin.csrf, confirm_send: 'on', building_id: '777' });
    const busy = await send();
    assert.strictEqual(busy.status, 302);
    assert.match(busy.headers.location, /error=piqbusy/);
    // A claim left by a crashed send (over 10 minutes old) is retaken, and released afterwards.
    await q("UPDATE visits SET owners_report_sending_at = now() - interval '11 minutes' WHERE id = $1", [v.id]);
    const retry = await send();
    assert.strictEqual(retry.status, 302);
    assert.doesNotMatch(retry.headers.location, /piqbusy/);
    assert.strictEqual((await q1('SELECT owners_report_sending_at FROM visits WHERE id = $1', [v.id])).owners_report_sending_at, null);
  });

  await t.test('"Sign out of all devices" stops a copied session working', async () => {
    const u = await user('lost', 'gardener');
    const copy = request.agent(app);
    copy.jar.setCookies(u.agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false }).map(String));
    // The copied cookie works...
    assert.strictEqual((await copy.get('/profile')).status, 200);
    const r = await u.agent.post('/logout/all').type('form').send({ _csrf: u.csrf });
    assert.strictEqual(r.status, 302);
    // ...until the owner signs out everywhere.
    const after = await copy.get('/profile');
    assert.strictEqual(after.status, 302);
    assert.match(after.headers.location, /\/login/);
  });

  await t.test("an admin password reset signs that user out everywhere", async () => {
    const u = await user('reset', 'gardener');
    assert.strictEqual((await u.agent.get('/profile')).status, 200);
    const r = await admin.agent.post(`/admin/users/${u.id}/password`).type('form')
      .send({ _csrf: admin.csrf, password: 'newpass12345' });
    assert.strictEqual(r.status, 302);
    const after = await u.agent.get('/profile');
    assert.strictEqual(after.status, 302);
    assert.match(after.headers.location, /\/login/);
  });

  await t.test('sessions expire 14 days after sign-in; older cookies keep working', async () => {
    const row = await q1('SELECT id, session_version FROM users WHERE id = $1', [g.id]);
    const old = { session: { userId: g.id, iat: Date.now() - auth.SESSION_MAX_AGE_MS - 1000, sv: row.session_version } };
    assert.strictEqual(await auth.currentUser(old), null);
    assert.strictEqual(old.session, null);
    const fresh = { session: { userId: g.id, iat: Date.now() - 1000, sv: row.session_version } };
    assert.strictEqual((await auth.currentUser(fresh)).id, g.id);
    // A cookie from before this change (no version, no issue time) still works and starts its clock.
    const legacy = { session: { userId: g.id } };
    assert.strictEqual((await auth.currentUser(legacy)).id, g.id);
    assert.ok(legacy.session.iat > Date.now() - 5000);
  });
});
