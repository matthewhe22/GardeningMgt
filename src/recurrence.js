/** Date helpers for recurring site jobs. All dates are 'YYYY-MM-DD' strings. */

const FREQUENCIES = ['weekly', 'fortnightly', 'monthly'];

function toUTC(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(dt) {
  return dt.toISOString().slice(0, 10);
}

/**
 * The Nth occurrence on/after the anchor for a frequency (n = 0 is the anchor).
 * Anchoring every occurrence to the contract start avoids drift: e.g. a
 * monthly job starting Jan 31 yields Feb 28, Mar 31, Apr 30 … (the 31st is
 * preserved, only clamped within each shorter month), instead of marching
 * earlier every month.
 */
function occurrence(anchor, frequency, n) {
  const [y, m, d] = anchor.split('-').map(Number);
  if (frequency === 'weekly' || frequency === 'fortnightly') {
    const step = frequency === 'weekly' ? 7 : 14;
    return fmt(new Date(Date.UTC(y, m - 1, d + step * n)));
  }
  // monthly: advance n months from the anchor, clamping the day to month length
  const targetMonthLast = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m - 1 + n, Math.min(d, targetMonthLast))));
}

/**
 * The next occurrence strictly after `afterDate`, anchored to `anchor`.
 * Used when scheduling the follow-up visit after one completes.
 */
function nextOccurrenceAfter(anchor, frequency, afterDate) {
  let n = 1;
  let date = occurrence(anchor, frequency, n);
  // Walk forward from the anchor until we pass afterDate (bounded for safety).
  while (date <= afterDate && n < 10000) {
    n += 1;
    date = occurrence(anchor, frequency, n);
  }
  return date;
}

/**
 * The next occurrence on/after `date` (inclusive), anchored to `anchor`.
 * Unlike nextOccurrenceAfter, this correctly returns `date` itself when it
 * lands exactly on an occurrence, instead of skipping ahead a full cycle.
 */
function nextOccurrenceOnOrAfter(anchor, frequency, date) {
  if (anchor >= date) return anchor;
  const dayBefore = fmt(new Date(toUTC(date).getTime() - 86400000));
  return nextOccurrenceAfter(anchor, frequency, dayBefore);
}

/**
 * Backwards-compatible single-step helper (still anchored-safe for weekly/
 * fortnightly; monthly now derives from the given date treated as anchor).
 */
function nextDate(date, frequency) {
  return occurrence(date, frequency, 1);
}

/** All occurrence dates from start through end (inclusive), capped at `limit`. */
function occurrencesBetween(anchor, frequency, endDate, limit = 500) {
  const out = [];
  for (let n = 0; n < limit; n++) {
    const date = occurrence(anchor, frequency, n);
    if (date > endDate) break;
    out.push(date);
  }
  return out;
}

/** Contract end date: start + 1 or 2 years. */
function contractEnd(startDate, years) {
  const [y, m, d] = startDate.split('-').map(Number);
  return fmt(new Date(Date.UTC(y + years, m - 1, d)));
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  // Reject rollover (e.g. 2026-13-40): the parsed date must format back to s.
  return fmt(toUTC(s)) === s;
}

// A free-text "time window" (e.g. "08:00-10:00") displayed as-is on route
// plans and job lists — validate the shape server-side too, since the
// client-side `pattern` attribute on these inputs is only a UX nicety and
// can't be trusted alone.
const TIME_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
function isValidTimeWindow(s) {
  return TIME_WINDOW_RE.test(s || '');
}

module.exports = {
  nextDate, occurrence, nextOccurrenceAfter, nextOccurrenceOnOrAfter, occurrencesBetween,
  contractEnd, isValidDate, isValidTimeWindow, FREQUENCIES,
};
