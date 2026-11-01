const test = require('node:test');
const assert = require('node:assert');
const { deviceLabel } = require('../src/device');

test('phones are reported as mobile', () => {
  assert.strictEqual(deviceLabel(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'), 'mobile');
  assert.strictEqual(deviceLabel(
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), 'mobile');
});

test('tablets are told apart from phones', () => {
  assert.strictEqual(deviceLabel(
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'), 'tablet');
  // Android tablets omit "Mobile" from the token that phones carry.
  assert.strictEqual(deviceLabel(
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'tablet');
});

test('everything else is desktop, and a missing header is unknown', () => {
  assert.strictEqual(deviceLabel(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'desktop');
  assert.strictEqual(deviceLabel(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'desktop');
  assert.strictEqual(deviceLabel(undefined), 'unknown device');
  assert.strictEqual(deviceLabel(''), 'unknown device');
});
