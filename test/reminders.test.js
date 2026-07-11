const test = require('node:test');
const assert = require('node:assert');
const { sendRemindersForDateWith } = require('../src/reminders');

/**
 * Fake DB + notify dependencies for sendRemindersForDateWith. Mimics db.js's
 * real withTransaction: runs fn(tx) against a fake tx.q, and only flips
 * `committed` to true if fn resolves — mirroring how a real Postgres
 * transaction only persists its writes (the claim, the notification insert,
 * the final reminder_sent_at update) if it reaches COMMIT. If fn throws,
 * `committed` stays false and nothing the fn did through tx.q is treated as
 * having taken effect, matching a real ROLLBACK.
 */
function fakeDeps({ claimedRows = [], sendDelayMs = 0 } = {}) {
  const calls = { txQueries: [], sends: [], logActivity: [], committed: false };
  const withTransaction = async (fn) => {
    const tx = {
      q: async (sql, params) => {
        calls.txQueries.push({ sql, params });
        if (/^\s*SELECT/i.test(sql)) return claimedRows;
        return [];
      },
    };
    const result = await fn(tx); // a throw here propagates uncommitted, like a ROLLBACK
    calls.committed = true;
    return result;
  };
  const send = (type) => async (...args) => {
    calls.sends.push({ type, args, start: Date.now() });
    if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
    return true;
  };
  const logActivity = async (...args) => { calls.logActivity.push(args); };
  return { deps: { withTransaction, sendSms: send('sms'), sendEmail: send('email'), logActivity }, calls };
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
  assert.strictEqual(calls.logActivity.length, 0);
  // Only the claim SELECT ran; no notification insert, no reminder_sent_at update.
  assert.strictEqual(calls.txQueries.length, 1);
  assert.match(calls.txQueries[0].sql, /^\s*SELECT/i);
});

test('fires SMS + email for every claimed visit and returns the claimed count', async () => {
  const claimedRows = [SAMPLE_ROW(1), SAMPLE_ROW(2), SAMPLE_ROW(3)];
  const { deps, calls } = fakeDeps({ claimedRows });
  const count = await sendRemindersForDateWith(deps, '2026-07-04');
  assert.strictEqual(count, 3);
  assert.strictEqual(calls.sends.length, 6); // 3 visits * (sms + email)
  assert.strictEqual(calls.sends.filter((c) => c.type === 'sms').length, 3);
  assert.strictEqual(calls.sends.filter((c) => c.type === 'email').length, 3);
  assert.strictEqual(calls.committed, true);
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

test('builds one multi-row INSERT for all claimed visits, and only then marks reminder_sent_at', async () => {
  const claimedRows = [SAMPLE_ROW(1), SAMPLE_ROW(2)];
  const { deps, calls } = fakeDeps({ claimedRows });
  await sendRemindersForDateWith(deps, '2026-07-04');
  // claim SELECT, one notifications INSERT, one reminder_sent_at UPDATE.
  assert.strictEqual(calls.txQueries.length, 3);
  const insertCall = calls.txQueries.find((c) => /^\s*INSERT INTO notifications/i.test(c.sql));
  assert.ok(insertCall, 'expected exactly one notifications INSERT');
  assert.match(insertCall.sql, /VALUES \(\$1, \$2, 'reminder', \$3\), \(\$4, \$5, 'reminder', \$6\)/);
  assert.deepStrictEqual(insertCall.params, [
    101, 1, 'Reminder: visit Site 1, Addr 1 on 2026-07-04',
    102, 2, 'Reminder: visit Site 2, Addr 2 on 2026-07-04',
  ]);
  const updateCall = calls.txQueries.find((c) => /^\s*UPDATE visits/i.test(c.sql));
  assert.ok(updateCall, 'expected exactly one reminder_sent_at UPDATE');
  assert.match(updateCall.sql, /reminder_sent_at\s*=\s*now\(\)/i);
  assert.deepStrictEqual(updateCall.params, [[1, 2]]);
  // The UPDATE must be the last query issued — after the insert, so it can
  // only ever run once the notification insert (and the sends, awaited
  // beforehand) have completed.
  assert.strictEqual(calls.txQueries[calls.txQueries.length - 1], updateCall);
});

test('logs a bulk vs auto activity entry depending on actorId', async () => {
  const { deps: deps1, calls: calls1 } = fakeDeps({ claimedRows: [SAMPLE_ROW(1)] });
  await sendRemindersForDateWith(deps1, '2026-07-04', { actorId: 5 });
  assert.strictEqual(calls1.logActivity[0][1], 'reminder.bulk');

  const { deps: deps2, calls: calls2 } = fakeDeps({ claimedRows: [SAMPLE_ROW(1)] });
  await sendRemindersForDateWith(deps2, '2026-07-04');
  assert.strictEqual(calls2.logActivity[0][1], 'reminder.auto');
});

test('a crash between claim and final commit leaves visits reclaimable, not lost forever', async () => {
  // Simulate the serverless process being killed (timeout/crash) after an
  // external send has fired but before the transaction can commit: make
  // sendSms throw so the withTransaction callback rejects. A real Postgres
  // transaction that never reaches COMMIT rolls back everything written
  // through it — including the reminder_sent_at update, which (per the fix)
  // only happens as the very last statement — so the visit's reminder_sent_at
  // never actually gets persisted as "sent".
  const claimedRows = [SAMPLE_ROW(1)];
  const { deps, calls } = fakeDeps({ claimedRows });
  deps.sendSms = async () => { throw new Error('simulated mid-flight crash'); };

  await assert.rejects(() => sendRemindersForDateWith(deps, '2026-07-04'));
  assert.strictEqual(calls.committed, false, 'the transaction must not have committed');
  // The final reminder_sent_at UPDATE must never have been reached, since it
  // only runs after the sends complete.
  assert.ok(!calls.txQueries.some((c) => /^\s*UPDATE visits/i.test(c.sql)),
    'reminder_sent_at must not be set when a crash happens before commit');

  // Retry: since the (real) DB transaction rolled back, reminder_sent_at is
  // still NULL, so the same visit is claimed and reminded again on the next
  // run instead of being silently lost forever (worst case here: a duplicate
  // SMS, which is the accepted tradeoff — see sendRemindersForDateWith's doc
  // comment).
  const { deps: retryDeps, calls: retryCalls } = fakeDeps({ claimedRows });
  const count = await sendRemindersForDateWith(retryDeps, '2026-07-04');
  assert.strictEqual(count, 1);
  assert.ok(retryCalls.txQueries.some((c) => /^\s*UPDATE visits/i.test(c.sql)));
  assert.strictEqual(retryCalls.committed, true);
});
