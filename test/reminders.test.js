const test = require('node:test');
const assert = require('node:assert');
const { sendRemindersForDateWith } = require('../src/reminders');

/** Fake DB + notify dependencies for sendRemindersForDateWith. */
function fakeDeps({ claimedRows = [], sendDelayMs = 0 } = {}) {
  const calls = { q: [], poolQuery: [], sends: [], logActivity: [] };
  const q = async (sql, params) => {
    calls.q.push({ sql, params });
    return claimedRows;
  };
  const pool = {
    query: async (sql, params) => { calls.poolQuery.push({ sql, params }); return {}; },
  };
  const send = (type) => async (...args) => {
    calls.sends.push({ type, args, start: Date.now() });
    if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
    return true;
  };
  const logActivity = async (...args) => { calls.logActivity.push(args); };
  return { deps: { q, pool, sendSms: send('sms'), sendEmail: send('email'), logActivity }, calls };
}

const SAMPLE_ROW = (n) => ({
  id: n, gardener_id: 100 + n, time_window: null,
  property_name: `Site ${n}`, address: `Addr ${n}`,
  gardener_phone: `+1555000${n}`, gardener_email: `g${n}@example.com`,
});

test('returns 0 and does no writes/sends when nothing is claimed', async () => {
  const { deps, calls } = fakeDeps({ claimedRows: [] });
  const count = await sendRemindersForDateWith(deps, '2026-07-04');
  assert.strictEqual(count, 0);
  assert.strictEqual(calls.sends.length, 0);
  assert.strictEqual(calls.poolQuery.length, 0);
  assert.strictEqual(calls.logActivity.length, 0);
});

test('fires SMS + email for every claimed visit and returns the claimed count', async () => {
  const claimedRows = [SAMPLE_ROW(1), SAMPLE_ROW(2), SAMPLE_ROW(3)];
  const { deps, calls } = fakeDeps({ claimedRows });
  const count = await sendRemindersForDateWith(deps, '2026-07-04');
  assert.strictEqual(count, 3);
  assert.strictEqual(calls.sends.length, 6); // 3 visits * (sms + email)
  assert.strictEqual(calls.sends.filter((c) => c.type === 'sms').length, 3);
  assert.strictEqual(calls.sends.filter((c) => c.type === 'email').length, 3);
});

test('dispatches sends concurrently, not one gardener at a time', async () => {
  const claimedRows = [SAMPLE_ROW(1), SAMPLE_ROW(2), SAMPLE_ROW(3)];
  const { deps, calls } = fakeDeps({ claimedRows, sendDelayMs: 30 });
  const started = Date.now();
  await sendRemindersForDateWith(deps, '2026-07-04');
  const elapsed = Date.now() - started;
  // Sequential would take 6 * 30ms = 180ms+; concurrent should finish close to one delay.
  assert.ok(elapsed < 100, `expected concurrent dispatch well under 180ms, took ${elapsed}ms`);
  // All 6 sends should have started within a few ms of each other, not staggered by sendDelayMs.
  const starts = calls.sends.map((c) => c.start);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 20, 'expected all sends to start together');
});

test('builds one multi-row INSERT for all claimed visits, not one per row', async () => {
  const claimedRows = [SAMPLE_ROW(1), SAMPLE_ROW(2)];
  const { deps, calls } = fakeDeps({ claimedRows });
  await sendRemindersForDateWith(deps, '2026-07-04');
  assert.strictEqual(calls.poolQuery.length, 1, 'expected exactly one notifications INSERT');
  assert.match(calls.poolQuery[0].sql, /VALUES \(\$1, \$2, 'reminder', \$3\), \(\$4, \$5, 'reminder', \$6\)/);
  assert.deepStrictEqual(calls.poolQuery[0].params, [
    101, 1, 'Reminder: visit Site 1, Addr 1 on 2026-07-04',
    102, 2, 'Reminder: visit Site 2, Addr 2 on 2026-07-04',
  ]);
});

test('logs a bulk vs auto activity entry depending on actorId', async () => {
  const { deps: deps1, calls: calls1 } = fakeDeps({ claimedRows: [SAMPLE_ROW(1)] });
  await sendRemindersForDateWith(deps1, '2026-07-04', { actorId: 5 });
  assert.strictEqual(calls1.logActivity[0][1], 'reminder.bulk');

  const { deps: deps2, calls: calls2 } = fakeDeps({ claimedRows: [SAMPLE_ROW(1)] });
  await sendRemindersForDateWith(deps2, '2026-07-04');
  assert.strictEqual(calls2.logActivity[0][1], 'reminder.auto');
});
