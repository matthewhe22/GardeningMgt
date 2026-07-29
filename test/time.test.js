const test = require('node:test');
const assert = require('node:assert');
const { fmtDateTime, fmtDate, today, year, toDate, TZ } = require('../src/time');

test('defaults to the Australia/Melbourne business timezone', () => {
  assert.strictEqual(TZ, 'Australia/Melbourne');
});

test('formats a naive UTC timestamp in Melbourne winter time (AEST, +10)', () => {
  // Postgres stores now() as a naive UTC string; 09:00 UTC = 19:00 AEST.
  assert.strictEqual(fmtDateTime('2026-06-13 09:00:00'), '2026-06-13 19:00 AEST');
});

test('honours daylight saving in summer (AEDT, +11)', () => {
  // 22:30 UTC on 15 Jan = 09:30 the next day in Melbourne (AEDT).
  assert.strictEqual(fmtDateTime(new Date('2026-01-15T22:30:00Z')), '2026-01-16 09:30 AEDT');
});

test('fmtDate rolls to the local calendar day', () => {
  // 23:30 UTC is already the next day in Melbourne.
  assert.strictEqual(fmtDate('2026-06-13 23:30:00'), '2026-06-14');
});

test('today/year use the Melbourne calendar', () => {
  const t = new Date('2026-06-13T20:00:00Z'); // 06:00 next day in Melbourne
  assert.strictEqual(today(t), '2026-06-14');
  assert.strictEqual(year(t), 2026);
});

test('blank/invalid values format to an empty string', () => {
  assert.strictEqual(fmtDateTime(null), '');
  assert.strictEqual(fmtDateTime(''), '');
  assert.strictEqual(fmtDate(undefined), '');
  assert.strictEqual(toDate('not a date'), null);
});
