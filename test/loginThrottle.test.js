const test = require('node:test');
const assert = require('node:assert');
const { WINDOW_MS, STALE_AFTER_MS, throttleKey, recordAttempt, clearAttempts } = require('../src/loginThrottle');

/** A fake {q, q1} pair that records every call and answers from a fixture. */
function fakeDb({ count } = { count: 1 }) {
  const calls = [];
  const q1 = async (sql, params) => { calls.push({ sql, params }); return { count }; };
  const q = async (sql, params) => { calls.push({ sql, params }); return []; };
  return { db: { q, q1 }, calls };
}

test('throttleKey combines IP and normalized email', () => {
  assert.strictEqual(throttleKey({ ip: '1.2.3.4' }, 'a@b.com'), '1.2.3.4|a@b.com');
});

test('recordAttempt sends an atomic UPSERT with the key bound once, RETURNING count', async () => {
  const { db, calls } = fakeDb({ count: 3 });
  const result = await recordAttempt(db, 'k1');
  assert.strictEqual(result, 3); // passes through whatever the DB returns
  const upsert = calls.find((c) => /INSERT INTO login_attempts/.test(c.sql));
  assert.ok(upsert, 'expected an INSERT ... ON CONFLICT statement');
  assert.match(upsert.sql, /ON CONFLICT \(key\) DO UPDATE SET/);
  assert.match(upsert.sql, /RETURNING count/);
  assert.deepStrictEqual(upsert.params, ['k1']); // key is the only bound param
});

test('recordAttempt interpolates the throttle window (not the stale-cleanup window) into the UPSERT', async () => {
  const { db, calls } = fakeDb();
  await recordAttempt(db, 'k1');
  const upsert = calls.find((c) => /INSERT INTO login_attempts/.test(c.sql));
  assert.ok(upsert.sql.includes(`interval '${WINDOW_MS} milliseconds'`));
  assert.ok(!upsert.sql.includes(`${STALE_AFTER_MS}`));
});

test('recordAttempt occasionally issues a stale-row cleanup DELETE, gated by Math.random', async () => {
  const origRandom = Math.random;
  try {
    Math.random = () => 0; // force the cleanup branch to fire
    const { db, calls } = fakeDb();
    await recordAttempt(db, 'k1');
    const cleanup = calls.find((c) => /DELETE FROM login_attempts WHERE first_at/.test(c.sql));
    assert.ok(cleanup, 'expected a stale-row cleanup DELETE when Math.random() is below the threshold');
    assert.ok(cleanup.sql.includes(`interval '${STALE_AFTER_MS} milliseconds'`));

    Math.random = () => 0.99; // force the cleanup branch to be skipped
    const { db: db2, calls: calls2 } = fakeDb();
    await recordAttempt(db2, 'k1');
    assert.strictEqual(calls2.length, 1, 'no cleanup query should run when Math.random() is above the threshold');
  } finally {
    Math.random = origRandom;
  }
});

test('clearAttempts deletes by key', async () => {
  const { db, calls } = fakeDb();
  await clearAttempts(db, 'k1');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM login_attempts WHERE key = \$1/);
  assert.deepStrictEqual(calls[0].params, ['k1']);
});
