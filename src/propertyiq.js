/**
 * PropertyIQ Strata API client (OAuth2 client-credentials flow).
 *
 * Used to find the PIQ building that matches one of our sites (by address)
 * and fetch the lot owners' email addresses for that building, so a
 * completed job report can be emailed straight to the owners.
 *
 * Admins configure these settings on /admin/settings:
 *   piq_base_url      Base URL of the PIQ instance, e.g. https://tocs.propertyiq.com.au
 *   piq_client_id     OAuth2 client_id
 *   piq_client_secret OAuth2 client_secret
 *   piq_scope         OAuth2 scopes (defaults to "buildings lots")
 *
 * Best-effort, same convention as onedrive.js/email.js: callers treat
 * failures as non-fatal and surface a message rather than throwing into a
 * request path.
 */
const { getSettings } = require('./settings');

const SETTING_KEYS = ['piq_base_url', 'piq_client_id', 'piq_client_secret', 'piq_scope'];
const DEFAULT_SCOPE = 'buildings lots';

async function getConfig() {
  const s = await getSettings(SETTING_KEYS);
  if (!s.piq_base_url || !s.piq_client_id || !s.piq_client_secret) return null; // not configured
  s.piq_base_url = s.piq_base_url.replace(/\/+$/, '');
  s.piq_scope = s.piq_scope || DEFAULT_SCOPE;
  return s;
}

// Cached in-process for the life of the serverless instance, keyed by
// base URL + client ID so a config change picks up a fresh token. Access
// tokens are short-lived, so this only saves the token round-trip for
// requests that land on a warm instance moments apart.
let tokenCache = null; // { key, token, expiresAt }

async function getAccessToken(cfg) {
  const key = `${cfg.piq_base_url}|${cfg.piq_client_id}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 5000) {
    return tokenCache.token;
  }
  const url = `${cfg.piq_base_url}/oauth/access_token?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(cfg.piq_client_id)}` +
    `&client_secret=${encodeURIComponent(cfg.piq_client_secret)}` +
    `&scope=${encodeURIComponent(cfg.piq_scope)}`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`PropertyIQ token request failed (${res.status}): ${data.error_description || data.error || res.statusText}`);
  }
  tokenCache = {
    key, token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  return data.access_token;
}

async function apiGet(cfg, path, token) {
  const res = await fetch(`${cfg.piq_base_url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PropertyIQ API ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Loose normalisation for address matching: lowercase, strip punctuation,
// collapse whitespace. Building/site addresses are free-text on both sides
// (our properties.address vs PIQ's streetNo/streetName/suburb fields), so an
// exact match isn't realistic — this matches on the significant tokens
// instead (street number + enough of the remaining text in common).
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Find the PIQ building whose address best matches the given site address.
 * Paginates through /api/buildings (no address search param on this API) and
 * scores each candidate by shared tokens with the site address, requiring
 * the street number to match when the site address has one.
 * Returns the raw PIQ Building object, or null if nothing scores a match.
 */
async function findBuildingByAddress(address) {
  const cfg = await getConfig();
  if (!cfg) return null;
  const token = await getAccessToken(cfg);
  const target = normalize(address);
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  const streetNoMatch = target.match(/^\d+[a-z]?/);
  const targetStreetNo = streetNoMatch ? streetNoMatch[0] : null;

  let best = null;
  let bestScore = 0;
  let page = 1;
  // Bounded pagination so a misconfigured/huge PIQ instance can't hang a
  // report send indefinitely — 50 pages * 200/page covers 10,000 buildings.
  for (; page <= 50; page++) {
    const resp = await apiGet(cfg, `/api/buildings?number=200&page=${page}`, token);
    const buildings = resp.data || [];
    if (!buildings.length) break;
    for (const b of buildings) {
      const candidate = normalize([b.streetNo, b.streetName, b.suburb, b.state, b.postcode].filter(Boolean).join(' '));
      if (!candidate) continue;
      if (targetStreetNo && b.streetNo && normalize(b.streetNo) !== normalize(targetStreetNo)) continue;
      const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
      let shared = 0;
      for (const t of candidateTokens) if (targetTokens.has(t)) shared++;
      if (shared > bestScore) { bestScore = shared; best = b; }
    }
    if (!resp.links || !resp.links.next) break;
  }
  // Require at least the street number plus one more shared token (street
  // name or suburb) — a bare street-number match alone is too weak to trust.
  return bestScore >= 2 ? best : null;
}

/** Fetch the Building object (with lots + owner contacts) for a known PIQ building ID. */
async function getBuildingLots(buildingId) {
  const cfg = await getConfig();
  if (!cfg) return [];
  const token = await getAccessToken(cfg);
  const lots = [];
  let page = 1;
  for (; page <= 50; page++) {
    const resp = await apiGet(cfg, `/api/buildings/${encodeURIComponent(buildingId)}/lots?number=200&page=${page}&include=ownerContact`, token);
    const batch = resp.data || [];
    lots.push(...batch);
    if (!batch.length || !resp.links || !resp.links.next) break;
  }
  return lots;
}

/**
 * Owner email addresses for the site at `address`, resolved via PropertyIQ.
 * Caches the matched building ID against the property row so subsequent
 * sends skip the address-matching pass. Returns { buildingId, emails } —
 * emails is deduplicated and always an array (possibly empty).
 */
async function getOwnerEmailsForProperty(property) {
  const cfg = await getConfig();
  if (!cfg) return { configured: false, buildingId: null, emails: [] };

  let buildingId = property.piq_building_id || null;
  if (!buildingId) {
    const building = await findBuildingByAddress(property.address);
    if (!building) return { configured: true, buildingId: null, emails: [] };
    buildingId = String(building.id);
  }

  const lots = await getBuildingLots(buildingId);
  const emails = new Set();
  for (const lot of lots) {
    const email = (lot.ownerContact && lot.ownerContact.email) || lot.email;
    if (email && email.includes('@')) emails.add(email.trim());
  }
  return { configured: true, buildingId, emails: [...emails] };
}

/** Verify credentials: fetch a token and list the first page of buildings. */
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, message: 'Not configured — fill in base URL, client ID and secret.' };
  try {
    const token = await getAccessToken(cfg);
    const resp = await apiGet(cfg, '/api/buildings?number=1&page=1', token);
    const count = resp.data ? resp.data.length : 0;
    return { ok: true, message: `Connected to ${cfg.piq_base_url} (${count ? 'buildings visible' : 'connected, no buildings returned'}).` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = {
  SETTING_KEYS, getConfig, findBuildingByAddress, getBuildingLots,
  getOwnerEmailsForProperty, testConnection,
};
