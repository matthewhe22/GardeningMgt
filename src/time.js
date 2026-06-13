/**
 * Business-timezone date/time helpers. The app serves a single operating
 * region (Australia/Melbourne by default); "today", reminder scheduling and
 * every timestamp shown to users use this local calendar, not UTC, or the
 * schedule is a day off and timestamps read in the wrong zone.
 * Override with the BUSINESS_TZ env var.
 */
const TZ = process.env.BUSINESS_TZ || 'Australia/Melbourne';

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const DATETIME_FMT = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

/**
 * Coerce a DB value to a Date instant. Timestamps come back from Postgres as
 * naive 'YYYY-MM-DD HH:MM:SS' strings stored in UTC (via now()), so a naive
 * string is interpreted as UTC; ISO strings and Date objects pass through.
 */
function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim().replace(' ', 'T');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z'; // naive -> UTC
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Current calendar date in the business timezone as 'YYYY-MM-DD'. */
function today(date = new Date()) {
  return DATE_FMT.format(date); // en-CA -> YYYY-MM-DD
}

/** Current year in the business timezone. */
function year(date = new Date()) {
  return Number(today(date).slice(0, 4));
}

/** Format a timestamp in the business timezone, e.g. '2026-06-13 19:00 AEST'. */
function fmtDateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = {};
  for (const part of DATETIME_FMT.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** Format just the calendar date of a timestamp in the business timezone. */
function fmtDate(value) {
  const d = toDate(value);
  return d ? DATE_FMT.format(d) : '';
}

module.exports = { today, year, fmtDateTime, fmtDate, toDate, TZ };
