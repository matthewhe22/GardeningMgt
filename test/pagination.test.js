const test = require('node:test');
const assert = require('node:assert');
const { pageParam, paginate } = require('../src/pagination');

/** A fake `q` that records every call and answers from canned fixtures. */
function fakeQ(rowsFixture, countFixture) {
  const calls = [];
  const q = async (sql, params) => {
    calls.push({ sql, params });
    return /COUNT\(\*\)/.test(sql) ? [{ c: countFixture }] : rowsFixture;
  };
  return { q, calls };
}

test('pageParam clamps invalid/missing values to 1', () => {
  assert.strictEqual(pageParam({ query: {} }), 1);
  assert.strictEqual(pageParam({ query: { page: '0' } }), 1);
  assert.strictEqual(pageParam({ query: { page: '-1' } }), 1);
  assert.strictEqual(pageParam({ query: { page: 'abc' } }), 1);
  assert.strictEqual(pageParam({ query: { page: '3' } }), 3);
});

test('paginate numbers LIMIT/OFFSET placeholders after any existing args', async () => {
  const { q, calls } = fakeQ([{ id: 1 }], 5);
  const args = ['%foo%']; // one existing bound param before paginate appends its own
  await paginate(q, 'SELECT * FROM t WHERE x ILIKE $1 ORDER BY id', args, 1, 10);
  const rowsCall = calls.find((c) => !/COUNT/.test(c.sql));
  assert.match(rowsCall.sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepStrictEqual(rowsCall.params, ['%foo%', 10, 0]);
});

test('paginate computes the correct offset for page 1 vs page N', async () => {
  const { q, calls } = fakeQ([], 0);
  await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  await paginate(q, 'SELECT * FROM t ORDER BY id', [], 3, 10);
  const offsets = calls.filter((c) => !/COUNT/.test(c.sql)).map((c) => c.params[c.params.length - 1]);
  assert.deepStrictEqual(offsets, [0, 20]);
});

test('paginate wraps the exact same SQL/args for the count subquery (no duplicated WHERE)', async () => {
  const { q, calls } = fakeQ([], 42);
  const args = ['x', 'y'];
  await paginate(q, 'SELECT * FROM t WHERE a = $1 AND b = $2 ORDER BY id', args, 1, 10);
  const countCall = calls.find((c) => /COUNT/.test(c.sql));
  assert.match(countCall.sql, /FROM \(SELECT \* FROM t WHERE a = \$1 AND b = \$2 ORDER BY id\)/);
  assert.deepStrictEqual(countCall.params, args);
});

test('paginate reports totalPages: 1 for zero results, never 0', async () => {
  const { q } = fakeQ([], 0);
  const result = await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.totalPages, 1);
  assert.deepStrictEqual(result.rows, []);
});

test('paginate rounds up totalPages for a partial last page', async () => {
  const { q } = fakeQ([], 25);
  const result = await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  assert.strictEqual(result.totalPages, 3); // 25 rows / 10 per page -> 3 pages
});
