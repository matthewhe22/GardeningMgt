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
// collapse whitespace. Building/site addresses are free-text on our side
// (properties.address) vs PIQ's structured streetNo/streetName/suburb fields,
// so an exact string match isn't realistic — matchAddress() below compares
// the structured pieces instead.
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Australian state abbreviations plus unit/secondary-address words that carry
// no street-identity signal — excluded when comparing street names so that
// "Park Avenue" and "Park Road" still differ on their meaningful token.
const NON_IDENTIFYING = new Set([
  'nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'act', 'nt', 'australia',
  'unit', 'units', 'apt', 'apartment', 'suite', 'level', 'floor', 'shop', 'villa', 'lot',
]);

// The identifying (non-numeric, non-boilerplate) tokens of a name/suburb.
function significantTokens(s) {
  return normalize(s).split(' ').filter((t) => t && !NON_IDENTIFYING.has(t) && !/^\d+$/.test(t));
}

/**
 * Extract the street number(s) from an address string as a Set of digit
 * strings. Handles a leading number ("12 Smith St"), a number that isn't
 * first ("Level 2, 40 King St" → 40, not the unit 2), a unit form
 * ("Unit 5/10 Smith St" → 10), and a range ("10-12" → {10, 12}). A trailing
 * 4-digit postcode is stripped first so it isn't mistaken for a street number.
 * Empty when there's no recognisable street number.
 */
function extractStreetNumbers(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/\b\d{4}\b(?!.*\d)/, ' '); // drop a trailing postcode
  const nums = new Set();
  // Unit/secondary "X/Y" — the street number is the part after the slash.
  const slash = s.match(/\b\d+[a-z]?\s*\/\s*(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)/);
  let streetPart;
  if (slash) {
    streetPart = slash[1];
  } else {
    // Strip a leading unit/level/shop token + its number so we don't grab the
    // secondary number as the street number.
    streetPart = s.replace(/\b(unit|apt|apartment|suite|level|floor|shop|villa|lot)\s*\.?\s*\d+[a-z]?\s*[,/]?\s*/g, ' ');
  }
  const m = streetPart.match(/\b(\d+)[a-z]?(?:\s*-\s*(\d+)[a-z]?)?/);
  if (m) {
    nums.add(m[1]);
    if (m[2]) nums.add(m[2]);
  }
  return nums;
}

/**
 * Score how well a PIQ building matches a free-text site address. Returns 0
 * (no match) unless ALL of these hard gates pass:
 *   1. street numbers agree (when both sides have one) — a range like "10-12"
 *      matches "10", "12" or "10-12";
 *   2. every identifying token of the building's streetName appears in the
 *      site address ("Park Road" needs both "park" and "road", so it can't
 *      match "Park Avenue");
 *   3. postcodes don't conflict.
 * Among candidates that pass, a higher score (shared street-name + suburb +
 * postcode tokens) is a better match. Pure function — unit-tested directly.
 */
function matchAddress(targetAddress, b) {
  const target = normalize(targetAddress);
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  const targetNums = extractStreetNumbers(targetAddress);
  const candNums = extractStreetNumbers(b.streetNo || '');

  // Gate 1: street number must agree. If the building has a number but the
  // site address has none, that's too weak to trust — reject.
  if (candNums.size) {
    if (!targetNums.size) return 0;
    let overlap = false;
    for (const n of candNums) if (targetNums.has(n)) overlap = true;
    if (!overlap) return 0;
  }

  // Gate 2: every identifying street-name token must be present in the target.
  const nameTokens = significantTokens(b.streetName);
  if (!nameTokens.length) return 0;
  for (const t of nameTokens) if (!targetTokens.has(t)) return 0;

  // Gate 3: reject on a postcode conflict.
  const targetPostcode = (target.match(/\b\d{4}\b/g) || []).pop();
  if (b.postcode && targetPostcode && normalize(b.postcode) !== targetPostcode) return 0;

  // Passed. Score by shared identifying tokens so the best of several valid
  // candidates wins (suburb / postcode agreement breaks ties).
  const candTokens = new Set([
    ...nameTokens,
    ...significantTokens(b.suburb),
    ...(b.postcode ? [normalize(b.postcode)] : []),
  ]);
  let score = 0;
  for (const t of candTokens) if (targetTokens.has(t)) score++;
  return score;
}

/**
 * Find the PIQ building whose address best matches the given site address.
 * Paginates through /api/buildings (no address search param on this API) and
 * scores each candidate with matchAddress(). Returns the raw PIQ Building
 * object, or null if nothing clears the matcher's hard gates.
 */
async function findBuildingByAddress(address) {
  const cfg = await getConfig();
  if (!cfg) return null;
  const token = await getAccessToken(cfg);

  let best = null;
  let bestScore = 0;
  // Bounded pagination so a misconfigured/huge PIQ instance can't hang a
  // report send indefinitely — 50 pages * 200/page covers 10,000 buildings.
  for (let page = 1; page <= 50; page++) {
    const resp = await apiGet(cfg, `/api/buildings?number=200&page=${page}`, token);
    const buildings = resp.data || [];
    if (!buildings.length) break;
    for (const b of buildings) {
      const score = matchAddress(address, b);
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (!resp.links || !resp.links.next) break;
  }
  return bestScore >= 1 ? best : null;
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
  // Exported for unit testing of the address-matching logic.
  extractStreetNumbers, matchAddress,
};
