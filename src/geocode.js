// Lightweight forward geocoder: turn a street address into { lat, lng }.
//
// Defaults to OpenStreetMap's Nominatim (no API key, free). Its usage policy
// requires identifying the app via a User-Agent and staying under ~1 request
// per second, so bulk callers space requests out with sleep(). Point at a
// different/commercial geocoder with GEOCODER_URL if you outgrow it.
const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = process.env.GEOCODER_USER_AGENT
  || 'GardeningMgt/1.0 (gardening job management; property geocoding)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a free-text address to coordinates.
 * Returns { lat, lng, display_name } or null when there's no confident match.
 * Throws on network/HTTP errors so callers can distinguish "no match" from
 * "couldn't reach the geocoder".
 */
async function geocodeAddress(address, { timeoutMs = 8000 } = {}) {
  const query = (address || '').trim();
  if (!query) return null;

  const url = new URL(process.env.GEOCODER_URL || DEFAULT_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  if (process.env.GEOCODER_EMAIL) url.searchParams.set('email', process.env.GEOCODER_EMAIL);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`geocoder responded ${res.status}`);
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, display_name: hit.display_name || null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { geocodeAddress, sleep };
