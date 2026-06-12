/**
 * Business-timezone date helpers. The app serves a single operating region
 * (default Pacific/Auckland); "today" and reminder scheduling must use the
 * local calendar date, not UTC, or the schedule is a day off from midday on.
 * Override with the BUSINESS_TZ env var.
 */
const TZ = process.env.BUSINESS_TZ || 'Pacific/Auckland';

/** Current date in the business timezone as 'YYYY-MM-DD'. */
function today(date = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = { today, TZ };
