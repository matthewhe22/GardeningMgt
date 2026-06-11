/** Date helpers for recurring site jobs. All dates are 'YYYY-MM-DD' strings. */

const FREQUENCIES = ['weekly', 'fortnightly', 'monthly'];

/**
 * The next occurrence date after `date` for a frequency.
 * Monthly keeps the day-of-month, clamped to the target month's length
 * (Jan 31 -> Feb 28/29 -> Mar 31 is avoided by clamping from the original).
 */
function nextDate(date, frequency) {
  const [y, m, d] = date.split('-').map(Number);
  if (frequency === 'weekly' || frequency === 'fortnightly') {
    const days = frequency === 'weekly' ? 7 : 14;
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return t.toISOString().slice(0, 10);
  }
  // monthly
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m, Math.min(d, lastOfNext)));
  return t.toISOString().slice(0, 10);
}

/** Contract end date: start + 1 or 2 years. */
function contractEnd(startDate, years) {
  const [y, m, d] = startDate.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

module.exports = { nextDate, contractEnd, FREQUENCIES };
