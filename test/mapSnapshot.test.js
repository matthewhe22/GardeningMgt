const test = require('node:test');
const assert = require('node:assert');
const { renderMapSnapshot, representativePoint, externalMapUrl, collectPoints } = require('../src/mapSnapshot');

const gps = [
  { lat: -36.8485, lng: 174.7633, kind: 'start' },
  { lat: -36.8487, lng: 174.7635, kind: 'ping' },
  { lat: -36.8489, lng: 174.7637, kind: 'finish' },
];

test('returns null when there is no GPS and no site coordinates', async () => {
  assert.strictEqual(await renderMapSnapshot([], { lat: null, lng: null }), null);
  assert.strictEqual(await renderMapSnapshot(null, null), null);
});

test('non-inline snapshot references OSM tiles by URL and overlays markers', async () => {
  const svg = await renderMapSnapshot(gps, { lat: null, lng: null }, { inline: false });
  assert.ok(svg.startsWith('<svg'), 'is an svg');
  assert.ok(svg.includes('https://tile.openstreetmap.org/'), 'embeds OSM street tiles');
  assert.ok(svg.includes('<image'), 'has tile image layers');
  assert.ok(svg.includes('>S<') && svg.includes('>F<'), 'has Start and Finish markers');
  assert.ok(svg.includes('<polyline'), 'draws the GPS track');
  assert.ok(svg.includes('-36.84890, 174.76370'), 'captions the finish coordinate');
  assert.ok(svg.includes('OpenStreetMap contributors'), 'has OSM attribution');
});

test('inline snapshot embeds tiles as data URIs (no external tile URLs)', async () => {
  const realFetch = global.fetch;
  // 1x1 transparent PNG bytes.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => png });
  try {
    const svg = await renderMapSnapshot(gps, null, { inline: true });
    assert.ok(svg.includes('data:image/png;base64,'), 'tiles embedded as data URIs');
    assert.ok(!svg.includes('https://tile.openstreetmap.org/'), 'no external tile URLs in self-contained mode');
    assert.ok(svg.includes('>S<') && svg.includes('>F<'), 'still overlays markers');
  } finally {
    global.fetch = realFetch;
  }
});

test('inline snapshot still renders when tiles fail to load', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('blocked'); };
  try {
    const svg = await renderMapSnapshot(gps, null, { inline: true });
    assert.ok(svg.startsWith('<svg'), 'degrades gracefully to markers-only');
    assert.ok(!svg.includes('<image'), 'no tile images when all fetches fail');
    assert.ok(svg.includes('<polyline'), 'track still drawn');
  } finally {
    global.fetch = realFetch;
  }
});

test('falls back to the site coordinates when no GPS was captured', async () => {
  const { source } = collectPoints([], { lat: -36.85, lng: 174.76 });
  assert.strictEqual(source, 'property');
  const svg = await renderMapSnapshot([], { lat: -36.85, lng: 174.76 }, { inline: false });
  assert.ok(svg.includes('no GPS captured'), 'notes the property fallback');
});

test('representativePoint prefers finish, then start', () => {
  assert.strictEqual(representativePoint(gps, null).kind, 'finish');
  const noFinish = gps.filter((g) => g.kind !== 'finish');
  assert.strictEqual(representativePoint(noFinish, null).kind, 'start');
});

test('externalMapUrl points at the finish coordinate', () => {
  const url = externalMapUrl(gps, null);
  assert.ok(url.includes('mlat=-36.848900') && url.includes('mlon=174.763700'));
});

test('ignores null-island (0,0) readings', () => {
  const { pts } = collectPoints([{ lat: 0, lng: 0, kind: 'start' }], null);
  assert.strictEqual(pts.length, 0);
});
