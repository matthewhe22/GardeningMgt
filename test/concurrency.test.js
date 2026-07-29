const test = require('node:test');
const assert = require('node:assert');
const { mapWithConcurrency } = require('../src/concurrency');

test('mapWithConcurrency preserves result order regardless of completion order', async () => {
  const completedOrder = [];
  const results = await mapWithConcurrency([50, 10, 30], 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    completedOrder.push(ms);
    return ms * 2;
  });
  assert.deepStrictEqual(results, [100, 20, 60]); // matches input order, not completion order
  assert.notDeepStrictEqual(completedOrder, [50, 10, 30]); // sanity: completion order actually differed
});

test('mapWithConcurrency never runs more than `limit` tasks at once', async () => {
  let active = 0;
  let maxActive = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });
  assert.ok(maxActive <= 2, `expected at most 2 concurrent, saw ${maxActive}`);
});

test('mapWithConcurrency handles empty input and limit >= items.length', async () => {
  assert.deepStrictEqual(await mapWithConcurrency([], 3, async (x) => x), []);
  assert.deepStrictEqual(await mapWithConcurrency([1, 2], 10, async (x) => x + 1), [2, 3]);
});

test('mapWithConcurrency propagates a rejection without hanging', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('boom');
      return x;
    }),
    /boom/
  );
});
