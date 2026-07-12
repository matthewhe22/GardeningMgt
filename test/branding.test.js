const test = require('node:test');
const assert = require('node:assert');
process.env.ALLOW_INSECURE_SECRET = process.env.ALLOW_INSECURE_SECRET || '1';
const sharp = require('sharp');
const { imageToDataUri } = require('../src/branding');

// Pure image-processing helper behind the admin Settings "Branding" upload
// (src/routes/admin.js's POST /admin/settings/branding) — resizes/re-encodes
// to a PNG data URI with no DB involved, so it's tested directly here rather
// than via saveLogo/saveFavicon (which also call setSetting() against a real
// Postgres — covered by this session's manual end-to-end verification instead).

async function pngBuffer(width, height) {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 120, b: 60, alpha: 1 } } })
    .png()
    .toBuffer();
}

test('imageToDataUri: produces a valid PNG data URI', async () => {
  const buf = await pngBuffer(200, 200);
  const uri = await imageToDataUri(buf, { width: 64, height: 64, fit: 'contain' });
  assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
});

test('imageToDataUri: "contain" pads a non-square source into a square box', async () => {
  const buf = await pngBuffer(300, 100); // 3:1 landscape
  const uri = await imageToDataUri(buf, { width: 64, height: 64, fit: 'contain' });
  const png = Buffer.from(uri.split(',')[1], 'base64');
  const meta = await sharp(png).metadata();
  assert.strictEqual(meta.width, 64);
  assert.strictEqual(meta.height, 64);
});

test('imageToDataUri: "inside" never upscales past the source size', async () => {
  const buf = await pngBuffer(40, 20); // smaller than the target box
  const uri = await imageToDataUri(buf, { width: 320, height: 96, fit: 'inside' });
  const png = Buffer.from(uri.split(',')[1], 'base64');
  const meta = await sharp(png).metadata();
  assert.strictEqual(meta.width, 40);
  assert.strictEqual(meta.height, 20);
});

test('imageToDataUri: "inside" fits a large wide source within the box, preserving aspect', async () => {
  const buf = await pngBuffer(1000, 250); // 4:1
  const uri = await imageToDataUri(buf, { width: 320, height: 96, fit: 'inside' });
  const png = Buffer.from(uri.split(',')[1], 'base64');
  const meta = await sharp(png).metadata();
  assert.ok(meta.width <= 320 && meta.height <= 96);
  assert.strictEqual(meta.width, 320); // width is the binding constraint at this aspect ratio
});
