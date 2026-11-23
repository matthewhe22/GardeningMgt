/**
 * Live-capture validation for job evidence photos.
 *
 * Job photos must be fresh: taken with the camera during the job, not pulled
 * from the gallery days later. The capture time comes from, in order:
 *   1. the photo's own EXIF DateTimeOriginal (the browser re-attaches the
 *      original EXIF block after compressing, so it survives the resize), with
 *      its OffsetTimeOriginal tag, or else the phone's UTC offset sent by the
 *      browser, or else the business timezone;
 *   2. the capture time the browser read before compressing (`taken_at`, epoch
 *      ms) — only for photos with no readable EXIF (e.g. HEIC sent unchanged).
 * A photo with neither is rejected: we can't prove when it was taken.
 *
 * This is a deterrent, not tamper-proof: EXIF can be edited by a determined
 * user. It reliably stops the common case (old gallery photos).
 */
const exif = require('../public/js/exif.js');
const { TZ } = require('./time');

/** Oldest acceptable photo, in hours (PHOTO_MAX_AGE_HOURS, default 12). */
const MAX_AGE_HOURS = Number(process.env.PHOTO_MAX_AGE_HOURS) > 0 ? Number(process.env.PHOTO_MAX_AGE_HOURS) : 12;
/** Allowed phone-clock drift into the future. */
const FUTURE_SKEW_MS = 15 * 60 * 1000;

/** Current UTC offset of the business timezone, in getTimezoneOffset() style. */
function businessTzMinutes(at = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)) parts[p.type] = p.value;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((at.getTime() - wall) / 60000);
}

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

/**
 * Work out when a photo was taken and whether it's fresh enough.
 * @returns {{ ok: boolean, takenAt: Date|null, source: 'exif'|'client'|null, reason?: 'nodate'|'old'|'future' }}
 */
function checkCapture(buffer, { clientTakenAt, clientTz, now = Date.now() } = {}) {
  let takenMs = null;
  let source = null;
  const info = exif.readCapture(buffer);
  if (info) {
    const tz = Number.isFinite(num(clientTz)) && Math.abs(num(clientTz)) <= 14 * 60 ? num(clientTz) : businessTzMinutes(new Date(now));
    takenMs = exif.captureTime(info, tz);
    if (takenMs != null) source = 'exif';
  }
  if (takenMs == null && Number.isFinite(num(clientTakenAt)) && num(clientTakenAt) > 0) {
    takenMs = num(clientTakenAt);
    source = 'client';
  }
  if (takenMs == null) return { ok: false, takenAt: null, source: null, reason: 'nodate' };
  const takenAt = new Date(takenMs);
  if (takenMs > now + FUTURE_SKEW_MS) return { ok: false, takenAt, source, reason: 'future' };
  if (takenMs < now - MAX_AGE_HOURS * 3600 * 1000) return { ok: false, takenAt, source, reason: 'old' };
  return { ok: true, takenAt, source };
}

/** Field gardeners read these, so keep them plain. */
function reasonText(reason) {
  if (reason === 'old') return `That photo is more than ${MAX_AGE_HOURS} hours old. Take a new photo with the camera.`;
  if (reason === 'future') return "That photo's date is in the future. Check the phone's date and time, then take it again.";
  if (reason === 'nodate') return "We couldn't tell when that photo was taken. Take it with the camera in this app.";
  return 'That photo could not be uploaded. Take a new photo with the camera and try again.';
}

/** Pick element i of a field that may arrive as a string or an array. */
function at(field, i) {
  if (Array.isArray(field)) return field[i];
  return i === 0 ? field : undefined;
}

module.exports = { checkCapture, reasonText, businessTzMinutes, at, MAX_AGE_HOURS };
