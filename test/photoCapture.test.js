const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const exif = require('../public/js/exif.js');
const { checkCapture, MAX_AGE_HOURS } = require('../src/photoCapture');

// Real JPEGs with EXIF written by sharp/libvips, so the parser is exercised
// against the same layout cameras produce (TIFF header, IFD0 -> Exif IFD).
function exifStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
async function jpeg({ dto, offset, orientation } = {}) {
  let img = sharp({ create: { width: 64, height: 32, channels: 3, background: '#4a7' } }).jpeg();
  if (dto) {
    const IFD2 = { DateTimeOriginal: dto };
    if (offset) IFD2.OffsetTimeOriginal = offset;
    img = img.withExif({ IFD0: { Make: 'TestCam' }, IFD2 });
    if (orientation) img = img.withMetadata({ orientation });
  }
  return img.toBuffer();
}

test('readCapture: DateTimeOriginal and OffsetTimeOriginal', async () => {
  const buf = await jpeg({ dto: '2026:11:23 09:15:30', offset: '+11:00' });
  const info = exif.readCapture(buf);
  assert.deepStrictEqual(info, { dateTimeOriginal: '2026:11:23 09:15:30', offset: '+11:00' });
  assert.strictEqual(exif.captureTime(info), Date.parse('2026-11-23T09:15:30+11:00'));
});

test('readCapture: no EXIF / not a JPEG -> null', async () => {
  assert.strictEqual(exif.readCapture(await jpeg()), null);
  assert.strictEqual(exif.readCapture(Buffer.from('not an image at all')), null);
  assert.strictEqual(exif.readCapture(Buffer.alloc(0)), null);
});

test('captureTime: falls back to the given tz offset when no offset tag', () => {
  // getTimezoneOffset style: -660 = UTC+11
  assert.strictEqual(exif.captureTime({ dateTimeOriginal: '2026:11:23 09:00:00', offset: null }, -660),
    Date.parse('2026-11-23T09:00:00+11:00'));
  assert.strictEqual(exif.captureTime({ dateTimeOriginal: '2026:11:23 09:00:00', offset: null }), null);
});

test('extract + inject APP1 survives a re-encode and resets orientation', async () => {
  const original = await jpeg({ dto: '2026:11:23 10:00:00', offset: '+11:00', orientation: 6 });
  const app1 = exif.extractApp1(original);
  assert.ok(app1 && app1[0] === 0xff && app1[1] === 0xe1);
  // Simulate the browser's canvas re-encode: a fresh JPEG with no EXIF.
  const reencoded = await sharp({ create: { width: 32, height: 64, channels: 3, background: '#a74' } }).jpeg().toBuffer();
  assert.strictEqual(exif.readCapture(reencoded), null);
  const merged = Buffer.from(exif.injectApp1(reencoded, app1));
  assert.strictEqual(exif.readCapture(merged).dateTimeOriginal, '2026:11:23 10:00:00');
  const meta = await sharp(merged).metadata();
  assert.strictEqual(meta.orientation, 1, 'pixels are already upright, so orientation must be 1');
  assert.strictEqual(meta.width, 32);
  // The source keeps its own orientation (we copy before patching).
  assert.strictEqual((await sharp(original).metadata()).orientation, 6);
});

test('checkCapture: fresh EXIF photo is accepted', async () => {
  const now = Date.now();
  const taken = new Date(now - 30 * 60 * 1000);
  const buf = await jpeg({ dto: exifStamp(taken), offset: '+00:00' });
  const r = checkCapture(buf, { now });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'exif');
  assert.strictEqual(r.takenAt.getTime(), Math.floor(taken.getTime() / 1000) * 1000);
});

test('checkCapture: days-old photo is rejected even if the client claims it is new', async () => {
  const now = Date.now();
  const buf = await jpeg({ dto: exifStamp(new Date(now - 3 * 86400000)), offset: '+00:00' });
  const r = checkCapture(buf, { now, clientTakenAt: now });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'old');
});

test('checkCapture: the age limit boundary', async () => {
  const now = Date.now();
  const justIn = await jpeg({ dto: exifStamp(new Date(now - (MAX_AGE_HOURS * 3600 - 60) * 1000)), offset: '+00:00' });
  const justOut = await jpeg({ dto: exifStamp(new Date(now - (MAX_AGE_HOURS * 3600 + 60) * 1000)), offset: '+00:00' });
  assert.strictEqual(checkCapture(justIn, { now }).ok, true);
  assert.strictEqual(checkCapture(justOut, { now }).reason, 'old');
});

test('checkCapture: future-dated photo is rejected beyond clock skew', async () => {
  const now = Date.now();
  const buf = await jpeg({ dto: exifStamp(new Date(now + 3 * 3600000)), offset: '+00:00' });
  assert.strictEqual(checkCapture(buf, { now }).reason, 'future');
});

test('checkCapture: uses the phone tz when EXIF has no offset tag', async () => {
  const now = Date.now();
  // Wall-clock time in UTC+10, no offset tag; phone reports tz -600.
  const wall = new Date(now + 10 * 3600000 - 5 * 60000);
  const buf = await jpeg({ dto: exifStamp(wall) });
  assert.strictEqual(checkCapture(buf, { now, clientTz: -600 }).ok, true);
  // Interpreted as UTC-10 instead, the same stamp lands 20 h in the future.
  assert.strictEqual(checkCapture(buf, { now, clientTz: 600 }).reason, 'future');
});

test('checkCapture: no EXIF -> client capture time, or rejected without one', async () => {
  const now = Date.now();
  const buf = await jpeg();
  assert.deepStrictEqual(
    (({ ok, source }) => ({ ok, source }))(checkCapture(buf, { now, clientTakenAt: String(now - 60000) })),
    { ok: true, source: 'client' });
  assert.strictEqual(checkCapture(buf, { now, clientTakenAt: String(now - 2 * 86400000) }).reason, 'old');
  assert.strictEqual(checkCapture(buf, { now }).reason, 'nodate');
  assert.strictEqual(checkCapture(buf, { now, clientTakenAt: 'garbage' }).reason, 'nodate');
});
