const test = require('node:test');
const assert = require('node:assert');
const { optimizeRoute, haversineKm } = require('../src/routeOptimizer');

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
