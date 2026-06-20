#!/usr/bin/env node
// Move existing in-database photo bytes into the configured S3-compatible
// bucket. Idempotent and safe to re-run: each photo is uploaded under its
// filename, then its `data` column is emptied (the marker the app uses to serve
// from object storage). Run once after configuring S3_* env vars:
//
//   node scripts/migrate-photos-to-s3.js
//
// Requires S3_BUCKET (+ credentials) to be set, and DATABASE_URL.

const { pool } = require('../src/db');
const storage = require('../src/storage');

async function main() {
  if (!storage.enabled()) {
    console.error('S3 is not configured (set S3_BUCKET + credentials). Aborting.');
    process.exit(1);
  }
  const BATCH = 25;
  let moved = 0;
  for (;;) {
    // Only rows that still hold inline bytes (length > 0).
    const { rows } = await pool.query(
      'SELECT id, filename, mime, data FROM photos WHERE octet_length(data) > 0 ORDER BY id LIMIT $1', [BATCH]);
    if (!rows.length) break;
    for (const r of rows) {
      await storage.putObject(r.filename, r.data, r.mime || 'application/octet-stream');
      await pool.query("UPDATE photos SET data = ''::bytea WHERE id = $1", [r.id]);
      moved++;
      if (moved % 25 === 0) console.log(`  …moved ${moved}`);
    }
  }
  console.log(`Done. Moved ${moved} photo(s) to object storage.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
