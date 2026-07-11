/**
 * Map snapshot of a job's location, drawn from the GPS points captured by the
 * timer (start / pings / finish) over a real OpenStreetMap street background.
 *
 * The snapshot is an inline <svg>: OSM raster tiles sit in <image> elements
 * behind the GPS track and start/finish markers. Two modes:
 *   - inline:false (live pages) — tiles referenced by URL, loaded by the
 *     browser. The app's CSP allows tile.openstreetmap.org for this.
 *   - inline:true (completion report) — tiles are fetched server-side and
 *     embedded as data: URIs, so the report stays self-contained and renders
 *     offline / from the OneDrive archive.
 *
 * Tile fetches are best-effort: any tile that can't be loaded is simply
 * dropped (the styled background shows through) so the track/markers always
 * render. Falls back to the site's stored coordinates when no GPS exists.
 */

const TILE_SIZE = 256;
const TILE_HOST = 'https://tile.openstreetmap.org';
// Identify the app to OSM's tile servers (their usage policy requires a UA).
const TILE_UA = 'GardeningMgt/0.1 (+https://github.com/matthewhe22/GardeningMgt; job location report)';

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Web Mercator pixel projection (256px tiles) ---
function lngToWorldX(lng, z) {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** z;
}
function latToWorldY(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * TILE_SIZE * 2 ** z;
}
// Ground resolution (metres per pixel) at a latitude / zoom.
function metresPerPixel(lat, z) {
  return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/**
 * Collect the plottable points, chronological, with a property-coordinate
 * fallback when no GPS was captured. Returns { pts, source } where source is
 * 'gps' | 'property' | 'none'.
 */
function collectPoints(gpsPoints, property) {
  const pts = (gpsPoints || [])
    .map((g) => ({ lat: Number(g.lat), lng: Number(g.lng), kind: g.kind }))
    .filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lng) && (g.lat !== 0 || g.lng !== 0));
  if (pts.length) return { pts, source: 'gps' };
  if (property && property.lat != null && property.lng != null) {
    const lat = Number(property.lat), lng = Number(property.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { pts: [{ lat, lng, kind: 'site' }], source: 'property' };
    }
  }
  return { pts: [], source: 'none' };
}

/** The single coordinate that best represents the job: finish > start > last > property. */
function representativePoint(gpsPoints, property) {
  const { pts } = collectPoints(gpsPoints, property);
  if (!pts.length) return null;
  return pts.find((p) => p.kind === 'finish')
    || pts.find((p) => p.kind === 'start')
    || pts[pts.length - 1];
}

/** A deep link that opens the exact location (with a pin) in a full map app. */
function externalMapUrl(gpsPoints, property) {
  const p = representativePoint(gpsPoints, property);
  if (!p) return null;
  const lat = p.lat.toFixed(6), lng = p.lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

const NICE_DISTANCES = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
function niceScaleMeters(target) {
  let bar = NICE_DISTANCES[0];
  for (const n of NICE_DISTANCES) if (n <= target) bar = n;
  return bar;
}
function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000) % 1 === 0 ? m / 1000 : (m / 1000).toFixed(1)} km` : `${m} m`;
}

// Highest zoom (<= max) at which all points fit inside width×height with padding.
function fitZoom(pts, width, height, pad) {
  const MIN_Z = 2, MAX_Z = 18;
  if (pts.length === 1) return 17;
  for (let z = MAX_Z; z >= MIN_Z; z--) {
    const xs = pts.map((p) => lngToWorldX(p.lng, z));
    const ys = pts.map((p) => latToWorldY(p.lat, z));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= width - 2 * pad && spanY <= height - 2 * pad) return z;
  }
  return MIN_Z;
}

function tileUrl(z, x, y) {
  return `${TILE_HOST}/${z}/${x}/${y}.png`;
}

async function fetchTileDataUri(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': TILE_UA }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null; // network/policy/timeout — background shows through
  }
}

/**
 * Render the job-location snapshot as an inline SVG string, or null when there
 * is no location to show. With { inline: true } the OSM tiles are embedded as
 * data: URIs (self-contained); otherwise they are referenced by URL.
 */
async function renderMapSnapshot(gpsPoints, property, opts = {}) {
  const width = opts.width || 600;
  const height = opts.height || 340;
  const pad = 44;
  const inline = !!opts.inline;
  const { pts, source } = collectPoints(gpsPoints, property);
  if (!pts.length) return null;

  const z = fitZoom(pts, width, height, pad);
  const world = pts.map((p) => ({ ...p, wx: lngToWorldX(p.lng, z), wy: latToWorldY(p.lat, z) }));
  const minX = Math.min(...world.map((p) => p.wx)), maxX = Math.max(...world.map((p) => p.wx));
  const minY = Math.min(...world.map((p) => p.wy)), maxY = Math.max(...world.map((p) => p.wy));
  const topLeftX = (minX + maxX) / 2 - width / 2;
  const topLeftY = (minY + maxY) / 2 - height / 2;
  const toScreen = (p) => ({ X: p.wx - topLeftX, Y: p.wy - topLeftY });
  const screen = world.map((p) => ({ ...p, ...toScreen(p) }));

  // Tiles covering the viewport.
  const n = 2 ** z;
  const x0 = Math.floor(topLeftX / TILE_SIZE), x1 = Math.floor((topLeftX + width) / TILE_SIZE);
  const y0 = Math.floor(topLeftY / TILE_SIZE), y1 = Math.floor((topLeftY + height) / TILE_SIZE);
  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= n) continue; // no vertical wrap
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n; // wrap horizontally
      tiles.push({
        sx: tx * TILE_SIZE - topLeftX,
        sy: ty * TILE_SIZE - topLeftY,
        url: tileUrl(z, wx, ty),
      });
    }
  }
  if (inline) {
    const uris = await Promise.all(tiles.map((t) => fetchTileDataUri(t.url)));
    tiles.forEach((t, i) => { t.href = uris[i]; });
  } else {
    tiles.forEach((t) => { t.href = t.url; });
  }
  const tilesSvg = tiles.filter((t) => t.href).map((t) =>
    `<image x="${t.sx.toFixed(1)}" y="${t.sy.toFixed(1)}" width="${TILE_SIZE}" height="${TILE_SIZE}" ` +
    `href="${t.href}" preserveAspectRatio="none"/>`).join('');

  const start = screen.find((p) => p.kind === 'start') || screen[0];
  const finish = screen.find((p) => p.kind === 'finish')
    || (screen.length > 1 ? screen[screen.length - 1] : null);
  const rep = screen.find((p) => p.kind === 'finish')
    || screen.find((p) => p.kind === 'start') || screen[screen.length - 1];

  const track = screen.length > 1
    ? `<polyline points="${screen.map((p) => `${p.X.toFixed(1)},${p.Y.toFixed(1)}`).join(' ')}" ` +
      `fill="none" stroke="#1d4ed8" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" ` +
      `opacity="0.9" paint-order="stroke"/>`
    : '';

  // Scale bar from true ground resolution.
  const res = metresPerPixel(rep.lat, z);
  const barMeters = niceScaleMeters((width / 4) * res);
  const barPx = barMeters / res;

  const marker = (p, fill, label) => p ? `
    <circle cx="${p.X.toFixed(1)}" cy="${p.Y.toFixed(1)}" r="10" fill="${fill}" stroke="#fff" stroke-width="3"/>
    <text x="${p.X.toFixed(1)}" y="${(p.Y + 3.5).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${label}</text>` : '';

  const singlePoint = source !== 'property' && screen.length === 1;
  const markersSvg = (source === 'property' || singlePoint)
    ? marker(rep, '#15803d', '●')
    : `${marker(start, '#15803d', 'S')}${marker(finish, '#b91c1c', 'F')}`;

  const repLabel = source === 'property'
    ? 'Site location (no GPS captured this visit)'
    : `${rep.lat.toFixed(5)}, ${rep.lng.toFixed(5)}`;
  const showLegend = source === 'gps' && (finish || screen.length > 1);

  const chip = (x, y, w, h) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#ffffff" opacity="0.82"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="Job location map snapshot" xmlns="http://www.w3.org/2000/svg" ` +
    `style="display:block;background:#dfe8df;border:1px solid #d7e0d7;border-radius:10px;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
  ${tilesSvg}
  ${track}
  ${markersSvg}
  <!-- north arrow -->
  <g transform="translate(${width - 26}, 28)">
    ${chip(-13, -16, 26, 40)}
    <path d="M0 -12 L5 6 L0 2 L-5 6 Z" fill="#14532d"/>
    <text x="0" y="20" text-anchor="middle" font-size="10" font-weight="700" fill="#14532d">N</text>
  </g>
  <!-- scale bar -->
  <g transform="translate(14, ${height - 16})">
    ${chip(-6, -22, barPx + 12, 28)}
    <line x1="0" y1="0" x2="${barPx.toFixed(1)}" y2="0" stroke="#14532d" stroke-width="3"/>
    <line x1="0" y1="-4" x2="0" y2="4" stroke="#14532d" stroke-width="3"/>
    <line x1="${barPx.toFixed(1)}" y1="-4" x2="${barPx.toFixed(1)}" y2="4" stroke="#14532d" stroke-width="3"/>
    <text x="${(barPx / 2).toFixed(1)}" y="-7" text-anchor="middle" font-size="10" fill="#14532d" font-weight="600">${formatDistance(barMeters)}</text>
  </g>
  <!-- coordinate caption -->
  <g transform="translate(10, 10)">
    ${chip(0, 0, Math.min(width - 64, 22 + repLabel.length * 6.2), 22)}
    <text x="8" y="15" font-size="11" fill="#14532d" font-weight="600">📍 ${escapeXml(repLabel)}</text>
  </g>
  ${showLegend ? `
  <g transform="translate(10, ${height - 50})" font-size="10" fill="#23311f">
    ${chip(0, -13, 108, 20)}
    <circle cx="12" cy="-3" r="5" fill="#15803d"/><text x="22" y="0">Start</text>
    <circle cx="62" cy="-3" r="5" fill="#b91c1c"/><text x="72" y="0">Finish</text>
  </g>` : ''}
  <!-- attribution (required by the OpenStreetMap tile usage policy) -->
  <g transform="translate(${width}, ${height})">
    <text x="-4" y="-5" text-anchor="end" font-size="9" fill="#3a463c" style="paint-order:stroke;stroke:#ffffff;stroke-width:2.5px">© OpenStreetMap contributors</text>
  </g>
</svg>`;
}

module.exports = { renderMapSnapshot, representativePoint, externalMapUrl, collectPoints };
