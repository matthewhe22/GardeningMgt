const test = require('node:test');
const assert = require('node:assert');
const { optimizeRoute, haversineKm, clusterByLocation, segmentByLocation } = require('../src/routeOptimizer');

test('haversine distance is sane', () => {
  // Auckland CBD to Mt Eden is roughly 4 km
  const d = haversineKm({ lat: -36.8485, lng: 174.7633 }, { lat: -36.8775, lng: 174.7643 });
  assert.ok(d > 2 && d < 5, `expected ~3-4km, got ${d}`);
});

test('optimizeRoute orders stops along a line', () => {
  // Four stops on a north-south line, given shuffled. Optimal tour visits
  // them in monotonic order (either direction).
  const stops = [
    { id: 3, lat: -36.88, lng: 174.76 },
    { id: 1, lat: -36.84, lng: 174.76 },
    { id: 4, lat: -36.90, lng: 174.76 },
    { id: 2, lat: -36.86, lng: 174.76 },
  ];
  const { orderedIds } = optimizeRoute(stops);
  const asc = JSON.stringify([1, 2, 3, 4]);
  const desc = JSON.stringify([4, 3, 2, 1]);
  const got = JSON.stringify(orderedIds);
  assert.ok(got === asc || got === desc, `unexpected order ${got}`);
});

test('stops without coordinates go last', () => {
  const stops = [
    { id: 1, lat: null, lng: null },
    { id: 2, lat: -36.84, lng: 174.76 },
    { id: 3, lat: -36.85, lng: 174.76 },
  ];
  const { orderedIds } = optimizeRoute(stops);
  assert.strictEqual(orderedIds[orderedIds.length - 1], 1);
  assert.strictEqual(orderedIds.length, 3);
});

test('single and empty input', () => {
  assert.deepStrictEqual(optimizeRoute([]).orderedIds, []);
  assert.deepStrictEqual(optimizeRoute([{ id: 7, lat: 0, lng: 0 }]).orderedIds, [7]);
});

test('clusterByLocation groups nearby sites together', () => {
  // Two tight clusters ~150 km apart (Auckland vs Hamilton).
  const sites = [
    { id: 1, lat: -36.85, lng: 174.76 },
    { id: 2, lat: -36.86, lng: 174.77 },
    { id: 3, lat: -36.84, lng: 174.75 },
    { id: 4, lat: -37.78, lng: 175.28 },
    { id: 5, lat: -37.79, lng: 175.27 },
    { id: 6, lat: -37.77, lng: 175.29 },
  ];
  const clusters = clusterByLocation(sites, 2);
  assert.strictEqual(clusters.length, 2);
  const groups = clusters.map((c) => c.members.map((m) => m.id).sort((a, b) => a - b));
  // Each input cluster lands wholly in one output cluster (order-independent).
  const has = (g) => groups.some((x) => JSON.stringify(x) === JSON.stringify(g));
  assert.ok(has([1, 2, 3]), `north group not intact: ${JSON.stringify(groups)}`);
  assert.ok(has([4, 5, 6]), `south group not intact: ${JSON.stringify(groups)}`);
});

test('clusterByLocation caps k at the number of located sites', () => {
  const sites = [
    { id: 1, lat: -36.85, lng: 174.76 },
    { id: 2, lat: -37.78, lng: 175.28 },
  ];
  assert.strictEqual(clusterByLocation(sites, 5).length, 2);
  assert.strictEqual(clusterByLocation([], 5).length, 0);
});

test('segmentByLocation orders segments geographically and sets aside unlocated sites', () => {
  const sites = [
    { id: 1, lat: -37.78, lng: 175.28 }, // south
    { id: 2, lat: -37.79, lng: 175.27 },
    { id: 3, lat: -36.85, lng: 174.76 }, // north
    { id: 4, lat: -36.84, lng: 174.75 },
    { id: 9, lat: null, lng: null },     // no coordinates
  ];
  const { segments, unlocated } = segmentByLocation(sites, 2);
  assert.strictEqual(segments.length, 2);
  // Sorted south-to-north by latitude (more negative first).
  assert.ok(segments[0].centroid.lat < segments[1].centroid.lat);
  assert.deepStrictEqual(segments[0].sites.map((s) => s.id).sort((a, b) => a - b), [1, 2]);
  assert.deepStrictEqual(segments[1].sites.map((s) => s.id).sort((a, b) => a - b), [3, 4]);
  assert.deepStrictEqual(unlocated.map((s) => s.id), [9]);
});
