const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { makeThumbnail } = require('../src/upload');

// makeThumbnail() runs at upload time (src/upload.js) so gallery pages stop
// serving up-to-10MB originals as list-view thumbnails. Pure function
// (buffer in, buffer/null out), no DB needed — same style as sniffOk's tests.

test('makeThumbnail: real image shrinks to a small JPEG', async (t) => {
  await t.test('large JPEG is resized down and re-encoded as JPEG', async () => {
    const original = await sharp({
      create: { width: 2000, height: 1500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } },
    }).jpeg({ quality: 90 }).toBuffer();

    const thumb = await makeThumbnail(original);
    assert.ok(Buffer.isBuffer(thumb));
    assert.ok(thumb.length < original.length, 'thumbnail should be smaller than the original');

    const meta = await sharp(thumb).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.strictEqual(meta.width, 480);
    assert.strictEqual(meta.height, 360);
  });

  await t.test('PNG input is accepted and re-encoded as JPEG', async () => {
    const original = await sharp({
      create: { width: 900, height: 600, channels: 4, background: { r: 10, g: 200, b: 60, alpha: 1 } },
    }).png().toBuffer();

    const thumb = await makeThumbnail(original);
    const meta = await sharp(thumb).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.strictEqual(meta.width, 480);
  });

  await t.test('image narrower than the target width is not upscaled', async () => {
    const original = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 1, g: 1, b: 1 } },
    }).jpeg().toBuffer();

    const thumb = await makeThumbnail(original);
    const meta = await sharp(thumb).metadata();
    assert.strictEqual(meta.width, 200);
    assert.strictEqual(meta.height, 150);
  });
});

test('makeThumbnail: undecodable input yields null instead of throwing', async (t) => {
  await t.test('plain text content', async () => {
    const thumb = await makeThumbnail(Buffer.from('this is not an image, just text padded out a bit'));
    assert.strictEqual(thumb, null);
  });

  await t.test('empty buffer', async () => {
    const thumb = await makeThumbnail(Buffer.alloc(0));
    assert.strictEqual(thumb, null);
  });

  await t.test('truncated/corrupt JPEG header', async () => {
    const thumb = await makeThumbnail(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    assert.strictEqual(thumb, null);
  });
});
