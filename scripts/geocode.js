// One-shot backfill: fill in latitude/longitude for every property that's
// missing them, looked up from the address. Unlike the in-app button this has
// no serverless time limit, so it can process the whole table in one run.
//
//   DATABASE_URL=postgres://... node scripts/geocode.js
//
// Respects Nominatim's ~1 request/second policy. Set GEOCODER_URL /
// GEOCODER_EMAIL / GEOCODER_USER_AGENT to tune the geocoder (see src/geocode.js).
const { q, pool } = require('../src/db');
const { geocodeAddress, sleep } = require('../src/geocode');

(async () => {
  const rows = await q(
    `SELECT id, name, address FROM properties
     WHERE (lat IS NULL OR lng IS NULL) AND COALESCE(TRIM(address), '') <> ''
     ORDER BY id`);
  console.log(`${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} missing coordinates.`);

  let done = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    try {
      const geo = await geocodeAddress(p.address);
      if (geo) {
        await q('UPDATE properties SET lat = $1, lng = $2 WHERE id = $3', [geo.lat, geo.lng, p.id]);
        done++;
        console.log(`✓ #${p.id} ${p.name} → ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`);
      } else {
        failed++;
        console.log(`✗ #${p.id} ${p.name} — no match for "${p.address}"`);
      }
    } catch (e) {
      failed++;
      console.log(`✗ #${p.id} ${p.name} — ${e.message}`);
    }
    if (i < rows.length - 1) await sleep(1100); // ~1 req/sec
  }

  console.log(`\nDone: ${done} geocoded, ${failed} unresolved.`);
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
