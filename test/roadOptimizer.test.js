const { test } = require('node:test');
const assert = require('node:assert');
const { optimizeRouteRoad } = require('../src/routeOptimizer');

function stubFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

const stops = [
  { id: 1, lat: -37.81, lng: 144.96 },
  { id: 2, lat: -37.82, lng: 144.97 },
  { id: 3, lat: -37.83, lng: 144.98 },
];

test('orders stops by the OSRM road-distance matrix', async () => {
  // Driving distances (metres) where 1→3→2 is cheapest: 1↔3 and 3↔2 are short,
  // 1↔2 is long — so the optimal order is [1, 3, 2], not the input order.
  const restore = stubFetch(async () => ({
    ok: true,
    json: async () => ({
      code: 'Ok',
      distances: [
        [0, 10000, 1000],
        [10000, 0, 1000],
        [1000, 1000, 0],
      ],
    }),
  }));
  try {
    const r = await optimizeRouteRoad(stops);
    assert.strictEqual(r.mode, 'road');
    assert.deepStrictEqual(r.orderedIds, [1, 3, 2]);
    assert.ok(Math.abs(r.lengthKm - 2) < 1e-9, `expected 2km, got ${r.lengthKm}`);
  } finally { restore(); }
});

test('falls back to straight-line when OSRM is unavailable', async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    const r = await optimizeRouteRoad(stops);
    assert.strictEqual(r.mode, 'straight');
    assert.strictEqual(r.orderedIds.length, 3);
    assert.deepStrictEqual([...r.orderedIds].sort(), [1, 2, 3]);
  } finally { restore(); }
});

test('a single stop needs no routing call', async () => {
  const restore = stubFetch(() => { throw new Error('should not call OSRM'); });
  try {
    const r = await optimizeRouteRoad([{ id: 9, lat: -37.8, lng: 144.9 }]);
    assert.deepStrictEqual(r.orderedIds, [9]);
  } finally { restore(); }
});
