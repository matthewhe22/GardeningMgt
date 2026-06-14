const { test } = require('node:test');
const assert = require('node:assert');
const { geocodeAddress } = require('../src/geocode');

function stubFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

test('returns null for an empty address without calling the network', async () => {
  const restore = stubFetch(() => { throw new Error('should not be called'); });
  try {
    assert.strictEqual(await geocodeAddress(''), null);
    assert.strictEqual(await geocodeAddress('   '), null);
  } finally { restore(); }
});

test('parses lat/lng from the first result', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    json: async () => [{ lat: '-37.8136', lon: '144.9631', display_name: 'Melbourne VIC' }],
  }));
  try {
    const r = await geocodeAddress('Melbourne VIC');
    assert.deepStrictEqual({ lat: r.lat, lng: r.lng }, { lat: -37.8136, lng: 144.9631 });
  } finally { restore(); }
});

test('returns null when the geocoder finds no match', async () => {
  const restore = stubFetch(async () => ({ ok: true, json: async () => [] }));
  try {
    assert.strictEqual(await geocodeAddress('nowhere at all zzz'), null);
  } finally { restore(); }
});

test('throws on a non-OK HTTP response (so callers can distinguish outages)', async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    await assert.rejects(() => geocodeAddress('somewhere'), /503/);
  } finally { restore(); }
});
