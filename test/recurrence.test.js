const test = require('node:test');
const assert = require('node:assert');
const { nextDate, contractEnd } = require('../src/recurrence');

test('weekly and fortnightly add days', () => {
  assert.strictEqual(nextDate('2026-06-11', 'weekly'), '2026-06-18');
  assert.strictEqual(nextDate('2026-06-28', 'weekly'), '2026-07-05');
  assert.strictEqual(nextDate('2026-06-11', 'fortnightly'), '2026-06-25');
  assert.strictEqual(nextDate('2026-12-25', 'fortnightly'), '2027-01-08');
});

test('monthly keeps day, clamps at month end', () => {
  assert.strictEqual(nextDate('2026-06-15', 'monthly'), '2026-07-15');
  assert.strictEqual(nextDate('2026-01-31', 'monthly'), '2026-02-28');
  assert.strictEqual(nextDate('2027-12-31', 'monthly'), '2028-01-31');
  assert.strictEqual(nextDate('2028-01-31', 'monthly'), '2028-02-29'); // leap year
});

test('contract end adds years', () => {
  assert.strictEqual(contractEnd('2026-06-11', 1), '2027-06-11');
  assert.strictEqual(contractEnd('2026-06-11', 2), '2028-06-11');
});
