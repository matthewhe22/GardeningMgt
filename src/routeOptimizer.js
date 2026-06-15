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

/** Mean position of a set of points. Fine for clustering at city scale. */
function meanCentroid(members) {
  let lat = 0;
  let lng = 0;
  for (const m of members) {
    lat += m.lat;
    lng += m.lng;
  }
  return { lat: lat / members.length, lng: lng / members.length };
}

/**
 * Pick k spread-out initial centroids deterministically (farthest-first
 * traversal): start from the point nearest the overall centroid, then keep
 * adding the point farthest from every seed chosen so far. Determinism keeps
 * day allocations stable between runs (and testable).
 */
function farthestFirstSeeds(points, k) {
  const overall = meanCentroid(points);
  let firstIdx = 0;
  let firstDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineKm(overall, points[i]);
    if (d < firstDist) {
      firstDist = d;
      firstIdx = i;
    }
  }
  const seeds = [firstIdx];
  while (seeds.length < k) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < points.length; i++) {
      if (seeds.includes(i)) continue;
      let nearest = Infinity;
      for (const s of seeds) {
        const d = haversineKm(points[s], points[i]);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    seeds.push(bestIdx);
  }
  return seeds.map((i) => ({ lat: points[i].lat, lng: points[i].lng }));
}

/**
 * Group sites into k geographic clusters with k-means over haversine distance.
 * Sites without coordinates are ignored. Returns at most k non-empty clusters,
 * each `{ centroid, members }`.
 * @param {Array<{id:number, lat:number, lng:number}>} sites
 * @param {number} k desired number of clusters
 */
function clusterByLocation(sites, k) {
  const points = sites.filter((s) => s.lat != null && s.lng != null);
  if (points.length === 0) return [];
  const kk = Math.max(1, Math.min(Math.floor(k) || 1, points.length));

  let centroids = farthestFirstSeeds(points, kk);
  const assignment = new Array(points.length).fill(-1);

  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = haversineKm(centroids[c], points[i]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
    }
    const groups = centroids.map(() => []);
    for (let i = 0; i < points.length; i++) groups[assignment[i]].push(points[i]);
    centroids = groups.map((g, idx) => (g.length ? meanCentroid(g) : centroids[idx]));
    if (!changed) break;
  }

  const groups = centroids.map(() => []);
  for (let i = 0; i < points.length; i++) groups[assignment[i]].push(points[i]);
  const clusters = [];
  for (let c = 0; c < centroids.length; c++) {
    if (groups[c].length) clusters.push({ centroid: meanCentroid(groups[c]), members: groups[c] });
  }
  return clusters;
}

/**
 * Segment a whole portfolio of sites into `segmentCount` location-based groups,
 * one per service day. Segments are ordered geographically (south-to-north,
 * then west-to-east) so consecutive days cover adjacent areas. Sites without
 * coordinates can't be placed by location and are returned separately.
 * @param {Array<{id:number, lat:number, lng:number}>} sites
 * @param {number} segmentCount number of days to spread the portfolio across
 * @returns {{segments: Array<{centroid:{lat:number,lng:number}, sites:Array}>, unlocated:Array}}
 */
function segmentByLocation(sites, segmentCount) {
  const located = sites.filter((s) => s.lat != null && s.lng != null);
  const unlocated = sites.filter((s) => s.lat == null || s.lng == null);
  const clusters = clusterByLocation(located, segmentCount);
  clusters.sort((a, b) => a.centroid.lat - b.centroid.lat || a.centroid.lng - b.centroid.lng);
  return {
    segments: clusters.map((c) => ({ centroid: c.centroid, sites: c.members })),
    unlocated,
  };
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

module.exports = { optimizeRoute, haversineKm, clusterByLocation, segmentByLocation };
