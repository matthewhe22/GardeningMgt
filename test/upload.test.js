const test = require('node:test');
const assert = require('node:assert');
const { sniffOk } = require('../src/upload');

// Magic-byte sniff check used by savePhoto() to reject files whose actual
// content doesn't match an allowed image format, even when the filename
// extension / declared mime type claims otherwise (src/upload.js). Pure
// function, no DB needed — same style as recurrence.test.js / time.test.js.

function bytes(...vals) {
  return Buffer.from(vals);
}

test('sniffOk: real image magic bytes are accepted', async (t) => {
  await t.test('JPEG (ffd8ffe0 + padding)', () => {
    const buf = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.jpg'), true);
  });

  await t.test('JPEG variant (ffd8ffe1, Exif)', () => {
    const buf = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe1), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.jpeg'), true);
  });

  await t.test('JPEG variant (ffd8ffdb, no APP marker)', () => {
    const buf = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xdb), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.jpg'), true);
  });

  await t.test('PNG (89504e47)', () => {
    const buf = Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.png'), true);
  });

  await t.test('GIF (GIF87a/GIF89a)', () => {
    const buf = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.gif'), true);
  });

  await t.test('WEBP (RIFF....WEBP)', () => {
    const buf = Buffer.concat([
      Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBP'), Buffer.alloc(4),
    ]);
    assert.strictEqual(sniffOk(buf, '.webp'), true);
  });

  await t.test('HEIC/HEIF (ISO-BMFF ftyp box)', () => {
    const buf = Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftyp'), Buffer.from('heic'), Buffer.alloc(4)]);
    assert.strictEqual(sniffOk(buf, '.heic'), true);
  });
});

test('sniffOk: content that does not match an image format is rejected', async (t) => {
  await t.test('plain text content masquerading as a .jpg', () => {
    const buf = Buffer.concat([Buffer.from('<?php echo "pwned"; ?>'), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.jpg'), false);
  });

  await t.test('plain text content masquerading as a .png', () => {
    const buf = Buffer.concat([Buffer.from('this is just a text file, not an image'), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.png'), false);
  });

  await t.test('empty buffer', () => {
    assert.strictEqual(sniffOk(Buffer.alloc(0), '.jpg'), false);
  });

  await t.test('buffer shorter than the minimum sniff length', () => {
    assert.strictEqual(sniffOk(Buffer.from([0xff, 0xd8, 0xff]), '.jpg'), false);
  });

  await t.test('null/undefined buffer', () => {
    assert.strictEqual(sniffOk(null, '.jpg'), false);
    assert.strictEqual(sniffOk(undefined, '.jpg'), false);
  });

  await t.test('HTML content with a .gif extension', () => {
    const buf = Buffer.concat([Buffer.from('<html><body>not a gif</body></html>'), Buffer.alloc(12)]);
    assert.strictEqual(sniffOk(buf, '.gif'), false);
  });
});
