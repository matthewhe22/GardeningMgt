const test = require('node:test');
const assert = require('node:assert');
const { nextDate, occurrence, nextOccurrenceAfter, nextOccurrenceOnOrAfter, occurrencesBetween, contractEnd, isValidDate } = require('../src/recurrence');

test('weekly and fortnightly add days', () => {
  assert.strictEqual(nextDate('2026-06-11', 'weekly'), '2026-06-18');
  assert.strictEqual(nextDate('2026-06-28', 'weekly'), '2026-07-05');
  assert.strictEqual(nextDate('2026-06-11', 'fortnightly'), '2026-06-25');
});

test('monthly is anchored to the start, no drift', () => {
  // From a Jan 31 anchor, each occurrence keeps the 31st where the month allows.
  assert.strictEqual(occurrence('2026-01-31', 'monthly', 1), '2026-02-28');
  assert.strictEqual(occurrence('2026-01-31', 'monthly', 2), '2026-03-31'); // NOT Mar 28
  assert.strictEqual(occurrence('2026-01-31', 'monthly', 3), '2026-04-30');
  assert.strictEqual(occurrence('2028-01-31', 'monthly', 1), '2028-02-29'); // leap year
});

test('nextOccurrenceAfter walks forward from the anchor', () => {
  assert.strictEqual(nextOccurrenceAfter('2026-01-31', 'monthly', '2026-02-28'), '2026-03-31');
  assert.strictEqual(nextOccurrenceAfter('2026-06-01', 'weekly', '2026-06-10'), '2026-06-15');
});

test('nextOccurrenceOnOrAfter includes the date itself when it lands on an occurrence', () => {
  // 2026-07-03 is exactly 26 weeks after the anchor — must return today, not skip to next week.
  assert.strictEqual(nextOccurrenceOnOrAfter('2026-01-02', 'weekly', '2026-07-03'), '2026-07-03');
  // A date that falls between occurrences still rolls forward to the next one.
  assert.strictEqual(nextOccurrenceOnOrAfter('2026-01-02', 'weekly', '2026-07-04'), '2026-07-10');
  // A date on/before the anchor returns the anchor itself.
  assert.strictEqual(nextOccurrenceOnOrAfter('2026-01-02', 'weekly', '2025-12-01'), '2026-01-02');
});

test('occurrencesBetween generates the in-term schedule', () => {
  const dates = occurrencesBetween('2026-06-01', 'weekly', '2026-06-29');
  assert.deepStrictEqual(dates, ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']);
});

test('contract end adds years; date validation', () => {
  assert.strictEqual(contractEnd('2026-06-11', 1), '2027-06-11');
  assert.strictEqual(contractEnd('2026-06-11', 2), '2028-06-11');
  assert.ok(isValidDate('2026-06-11'));
  assert.ok(!isValidDate('2026-13-40'));
  assert.ok(!isValidDate('garbage'));
});
