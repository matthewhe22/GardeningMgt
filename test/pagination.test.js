const test = require('node:test');
const assert = require('node:assert');
const { pageParam, paginate } = require('../src/pagination');

/**
 * A fake `q` that behaves like a real Postgres connection for the two SQL
 * shapes paginate() emits: the combined LIMIT/OFFSET + COUNT(*) OVER() query
 * (the common case, one round trip), and the plain COUNT(*) fallback query
 * used only when a page comes back entirely empty (e.g. a stale ?page= past
 * the last page, where the window function has no row to ride along on).
 * `allRows` stands in for "every row the WHERE clause matches" so this can
 * apply LIMIT/OFFSET itself and hand back a realistic slice + total, and
 * records every call for assertions on the emitted SQL/params.
 */
function fakeQ(allRows) {
  const calls = [];
  const q = async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\) OVER\(\)/.test(sql)) {
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return allRows.slice(offset, offset + limit).map((r) => ({ ...r, __paginate_total: allRows.length }));
    }
    return [{ c: allRows.length }]; // plain fallback count query
  };
  return { q, calls };
}

const mainCall = (calls) => calls.find((c) => /COUNT\(\*\) OVER\(\)/.test(c.sql));

test('pageParam clamps invalid/missing values to 1', () => {
  assert.strictEqual(pageParam({ query: {} }), 1);
  assert.strictEqual(pageParam({ query: { page: '0' } }), 1);
  assert.strictEqual(pageParam({ query: { page: '-1' } }), 1);
  assert.strictEqual(pageParam({ query: { page: 'abc' } }), 1);
  assert.strictEqual(pageParam({ query: { page: '3' } }), 3);
});

test('paginate numbers LIMIT/OFFSET placeholders after any existing args', async () => {
  const { q, calls } = fakeQ([{ id: 1 }]);
  const args = ['%foo%']; // one existing bound param before paginate appends its own
  await paginate(q, 'SELECT * FROM t WHERE x ILIKE $1 ORDER BY id', args, 1, 10);
  const call = mainCall(calls);
  assert.match(call.sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepStrictEqual(call.params, ['%foo%', 10, 0]);
});

test('paginate computes the correct offset for page 1 vs page N', async () => {
  const { q, calls } = fakeQ(Array.from({ length: 100 }, (_, i) => ({ id: i })));
  await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  await paginate(q, 'SELECT * FROM t ORDER BY id', [], 3, 10);
  const offsets = calls.filter((c) => /COUNT\(\*\) OVER\(\)/.test(c.sql)).map((c) => c.params[c.params.length - 1]);
  assert.deepStrictEqual(offsets, [0, 20]);
});

test('paginate wraps the exact same SQL/args for the combined query (no duplicated WHERE)', async () => {
  const { q, calls } = fakeQ(Array.from({ length: 42 }, (_, i) => ({ id: i })));
  const args = ['x', 'y'];
  await paginate(q, 'SELECT * FROM t WHERE a = $1 AND b = $2 ORDER BY id', args, 1, 10);
  const call = mainCall(calls);
  assert.match(call.sql, /FROM \(SELECT \* FROM t WHERE a = \$1 AND b = \$2 ORDER BY id\) paginate_t/);
  assert.deepStrictEqual(call.params, ['x', 'y', 10, 0]);
});

test('paginate strips the internal __paginate_total column from returned rows', async () => {
  const { q, calls } = fakeQ([{ id: 1 }, { id: 2 }]);
  const result = await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  assert.deepStrictEqual(result.rows, [{ id: 1 }, { id: 2 }]);
  assert.strictEqual(result.total, 2);
  assert.strictEqual(calls.length, 1); // one round trip in the common (non-empty) case
});

test('paginate reports totalPages: 1 for zero results, never 0', async () => {
  const { q } = fakeQ([]);
  const result = await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.totalPages, 1);
  assert.deepStrictEqual(result.rows, []);
});

test('paginate rounds up totalPages for a partial last page', async () => {
  const { q } = fakeQ(Array.from({ length: 25 }, (_, i) => ({ id: i })));
  const result = await paginate(q, 'SELECT * FROM t ORDER BY id', [], 1, 10);
  assert.strictEqual(result.totalPages, 3); // 25 rows / 10 per page -> 3 pages
});

test('paginate falls back to a plain count query when the requested page is empty', async () => {
  // Only one page of data exists (5 rows), but page 3 is requested — the
  // window-function query returns zero rows, so it can't report a total;
  // this is the one case that still costs a second round trip.
  const { q, calls } = fakeQ(Array.from({ length: 5 }, (_, i) => ({ id: i })));
  const result = await paginate(q, 'SELECT * FROM t ORDER BY id', [], 3, 10);
  assert.deepStrictEqual(result.rows, []);
  assert.strictEqual(result.total, 5);
  assert.strictEqual(result.totalPages, 1);
  assert.strictEqual(calls.length, 2);
});
