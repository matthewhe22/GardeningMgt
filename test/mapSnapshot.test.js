const test = require('node:test');
const assert = require('node:assert');
const { renderMapSnapshot, representativePoint, externalMapUrl, collectPoints } = require('../src/mapSnapshot');

const gps = [
  { lat: -36.8485, lng: 174.7633, kind: 'start' },
  { lat: -36.8487, lng: 174.7635, kind: 'ping' },
  { lat: -36.8489, lng: 174.7637, kind: 'finish' },
];

test('returns null when there is no GPS and no site coordinates', () => {
  assert.strictEqual(renderMapSnapshot([], { lat: null, lng: null }), null);
  assert.strictEqual(renderMapSnapshot(null, null), null);
});

test('renders a self-contained SVG with start and finish markers from GPS', () => {
  const svg = renderMapSnapshot(gps, { lat: null, lng: null });
  assert.ok(svg.startsWith('<svg'), 'is an svg');
  assert.ok(!/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')),
    'no external resource URLs (CSP-safe / self-contained)');
  assert.ok(svg.includes('>S<') && svg.includes('>F<'), 'has Start and Finish markers');
  assert.ok(svg.includes('<polyline'), 'draws the GPS track');
  assert.ok(svg.includes('-36.84890, 174.76370'), 'captions the finish coordinate');
});

test('falls back to the site coordinates when no GPS was captured', () => {
  const { source } = collectPoints([], { lat: -36.85, lng: 174.76 });
  assert.strictEqual(source, 'property');
  const svg = renderMapSnapshot([], { lat: -36.85, lng: 174.76 });
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
