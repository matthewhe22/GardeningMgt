/**
 * Route optimization for a gardener's daily visits.
 *
 * Distances are great-circle (haversine). The tour is built with a
 * nearest-neighbour heuristic from the depot (or first stop) and then
 * improved with 2-opt until no improving swap remains. This is exact enough
 * for the 5-30 stops a gardener handles per day and needs no external API.
 */

const EARTH_RADIUS_KM = 6371;

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function tourLength(points, order, depot) {
  let len = 0;
  let prev = depot || points[order[0]];
  for (const i of order) {
    len += haversineKm(prev, points[i]);
    prev = points[i];
  }
  return len;
}

function nearestNeighbourOrder(points, depot) {
  const n = points.length;
  const unvisited = new Set(points.map((_, i) => i));
  const order = [];
  let current = depot || null;
  if (!current) {
    order.push(0);
    unvisited.delete(0);
    current = points[0];
  }
  while (unvisited.size) {
    let best = -1;
    let bestDist = Infinity;
    for (const i of unvisited) {
      const d = haversineKm(current, points[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    order.push(best);
    unvisited.delete(best);
    current = points[best];
  }
  return order;
}

function twoOptImprove(points, order, depot) {
  let improved = true;
  let best = order.slice();
  let bestLen = tourLength(points, best, depot);
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const len = tourLength(points, candidate, depot);
        if (len < bestLen - 1e-9) {
          best = candidate;
          bestLen = len;
          improved = true;
        }
      }
    }
  }
  return { order: best, lengthKm: bestLen };
}

/**
 * @param {Array<{id:number, lat:number, lng:number}>} stops
 * @param {{lat:number,lng:number}|null} depot optional start point (e.g. office)
 * @returns {{orderedIds:number[], lengthKm:number}}
 */
function optimizeRoute(stops, depot = null) {
  const points = stops.filter((s) => s.lat != null && s.lng != null);
  if (points.length === 0) return { orderedIds: stops.map((s) => s.id), lengthKm: 0 };
  if (points.length === 1) return { orderedIds: stops.map((s) => s.id), lengthKm: 0 };

  const nn = nearestNeighbourOrder(points, depot);
  const { order, lengthKm } = twoOptImprove(points, nn, depot);
  const orderedIds = order.map((i) => points[i].id);
  // Stops without coordinates go to the end of the day, unoptimized.
  for (const s of stops) if (s.lat == null || s.lng == null) orderedIds.push(s.id);
  return { orderedIds, lengthKm };
}

module.exports = { optimizeRoute, haversineKm };
