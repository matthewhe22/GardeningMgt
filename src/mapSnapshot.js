/**
 * Self-contained map snapshot of a job's location, drawn server-side as an
 * inline SVG from the GPS points captured by the timer (start / pings / finish).
 *
 * Why a generated SVG instead of map tiles: the app ships a strict CSP
 * (img-src 'self' data: blob:) and deliberately uses no external CDNs/APIs, and
 * completion reports are archived to OneDrive as a single self-contained file.
 * An inline SVG honours all three — it needs no network when viewed, so the
 * snapshot still renders inside an offline/archived report. For street-level
 * context we also expose a deep link to open the exact coordinates in a full
 * map app (see externalMapUrl), which is a navigation action, not an embed.
 */

// Metres per degree of latitude (good enough for a single job site).
const M_PER_DEG_LAT = 111320;

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
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

/**
 * Render the job-location snapshot as an inline SVG string, or null when there
 * is no location to show. Plots the on-site GPS track with start/finish markers,
 * a north arrow and a scale bar, all in a self-contained <svg>.
 */
function renderMapSnapshot(gpsPoints, property, opts = {}) {
  const width = opts.width || 600;
  const height = opts.height || 300;
  const pad = 30;
  const { pts, source } = collectPoints(gpsPoints, property);
  if (!pts.length) return null;

  // Local equirectangular projection (metres) around the centroid.
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lng0 = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  const mPerLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const proj = pts.map((p) => ({
    ...p,
    x: (p.lng - lng0) * mPerLng,
    y: (p.lat - lat0) * M_PER_DEG_LAT,
  }));

  const xs = proj.map((p) => p.x), ys = proj.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  // Fit the largest span (min 80 m so a single point isn't absurdly zoomed),
  // with headroom so markers near the edge aren't clipped. Isotropic scale.
  const MIN_SPAN = 80;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), MIN_SPAN) * 1.3;
  const scale = Math.min(width - 2 * pad, height - 2 * pad) / span; // px per metre
  const toSvg = (p) => ({
    X: width / 2 + (p.x - cx) * scale,
    Y: height / 2 - (p.y - cy) * scale, // invert Y for north-up
  });
  const svgPts = proj.map((p) => ({ ...p, ...toSvg(p) }));

  const start = svgPts.find((p) => p.kind === 'start') || svgPts[0];
  const finish = svgPts.find((p) => p.kind === 'finish')
    || (svgPts.length > 1 ? svgPts[svgPts.length - 1] : null);
  const rep = svgPts.find((p) => p.kind === 'finish')
    || svgPts.find((p) => p.kind === 'start') || svgPts[svgPts.length - 1];

  // Track path through every point in chronological order.
  const track = svgPts.length > 1
    ? `<polyline points="${svgPts.map((p) => `${p.X.toFixed(1)},${p.Y.toFixed(1)}`).join(' ')}" ` +
      `fill="none" stroke="#15803d" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="1 5"/>`
    : '';

  // Scale bar (~ a quarter of the width, snapped to a round distance).
  const barMeters = niceScaleMeters((width / 4) / scale);
  const barPx = barMeters * scale;

  const marker = (p, fill, label) => p ? `
    <circle cx="${p.X.toFixed(1)}" cy="${p.Y.toFixed(1)}" r="9" fill="${fill}" stroke="#fff" stroke-width="2.5"/>
    <text x="${p.X.toFixed(1)}" y="${(p.Y + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">${label}</text>` : '';

  const repLabel = source === 'property'
    ? 'Site location (no GPS captured this visit)'
    : `${rep.lat.toFixed(5)}, ${rep.lng.toFixed(5)}`;

  // Single point (just started, or property fallback): one neutral pin.
  const singlePoint = source !== 'property' && svgPts.length === 1;
  const markersSvg = (source === 'property' || singlePoint)
    ? marker(rep, '#15803d', '●')
    : `${marker(start, '#15803d', 'S')}${marker(finish, '#b91c1c', 'F')}`;

  const showLegend = source === 'gps' && (finish || svgPts.length > 1);

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="Job location map snapshot" xmlns="http://www.w3.org/2000/svg" ` +
    `style="display:block;background:#eef4ee;border:1px solid #d7e0d7;border-radius:10px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
  <defs>
    <pattern id="msgrid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#dde7dd" stroke-width="1"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#msgrid)"/>
  ${track}
  ${markersSvg}
  <!-- north arrow -->
  <g transform="translate(${width - 26}, 26)">
    <path d="M0 -12 L5 6 L0 2 L-5 6 Z" fill="#14532d"/>
    <text x="0" y="20" text-anchor="middle" font-size="10" font-weight="700" fill="#14532d">N</text>
  </g>
  <!-- scale bar -->
  <g transform="translate(16, ${height - 16})">
    <line x1="0" y1="0" x2="${barPx.toFixed(1)}" y2="0" stroke="#14532d" stroke-width="3"/>
    <line x1="0" y1="-4" x2="0" y2="4" stroke="#14532d" stroke-width="3"/>
    <line x1="${barPx.toFixed(1)}" y1="-4" x2="${barPx.toFixed(1)}" y2="4" stroke="#14532d" stroke-width="3"/>
    <text x="${(barPx / 2).toFixed(1)}" y="-7" text-anchor="middle" font-size="10" fill="#14532d" font-weight="600">${formatDistance(barMeters)}</text>
  </g>
  <!-- coordinate caption -->
  <text x="16" y="22" font-size="11" fill="#14532d" font-weight="600">📍 ${escapeXml(repLabel)}</text>
  ${showLegend ? `
  <g transform="translate(16, ${height - 42})" font-size="10" fill="#3a463c">
    <circle cx="6" cy="-3" r="5" fill="#15803d"/><text x="16" y="0">Start</text>
    <circle cx="56" cy="-3" r="5" fill="#b91c1c"/><text x="66" y="0">Finish</text>
  </g>` : ''}
</svg>`;
}

module.exports = { renderMapSnapshot, representativePoint, externalMapUrl, collectPoints };
