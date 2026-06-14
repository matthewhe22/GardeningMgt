// Road-distance matrix via OSRM (Open Source Routing Machine) — free, no API
// key. Defaults to the public demo server; override with OSRM_URL (e.g. a
// self-hosted instance for production volume).
//
// Returns an N×N matrix of driving distances in kilometres, or null when the
// service can't be reached or errors — callers then fall back to straight-line
// distance. OSRM uses the static road network (no live traffic), which is
// exactly what we want for stable, repeatable route planning.
const DEFAULT_OSRM = 'https://router.project-osrm.org';
const USER_AGENT = process.env.OSRM_USER_AGENT || 'GardeningMgt/1.0 (route planning)';

/**
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {Promise<number[][]|null>} distances in km, or null on failure
 */
async function roadMatrixKm(points, { timeoutMs = 9000 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const base = (process.env.OSRM_URL || DEFAULT_OSRM).replace(/\/+$/, '');
  // OSRM expects lon,lat order.
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${base}/table/v1/driving/${coords}?annotations=distance`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !Array.isArray(data.distances)) return null;
    // distances are in metres; null means unroutable.
    return data.distances.map((row) => row.map((m) => (m == null ? Infinity : m / 1000)));
  } catch (e) {
    console.error('[osrm] table request failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { roadMatrixKm };
