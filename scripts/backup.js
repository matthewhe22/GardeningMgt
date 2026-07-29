#!/usr/bin/env node
// Back up the database while keeping photo bytes out of the routine dump —
// pg_dump can't exclude a single column, and photos.data/thumb_data (up to
// 10MB+ per row) can make a plain pg_dump enormous compared to every other
// table combined. This produces two files:
//   1. backup-<timestamp>.sql              full pg_dump of the schema and
//      every table's data EXCEPT the photos table's row data.
//   2. backup-<timestamp>-photos-meta.sql   the photos table's own data,
//      with the data/thumb_data columns replaced by an empty bytea, so every
//      photo's filename/caption/visit-or-issue link/timestamp is still
//      backed up and restorable — only the actual image bytes are dropped.
//
// The image bytes themselves are recoverable from S3 (when S3_BUCKET is
// configured — see src/storage.js, which is the recommended way to keep
// large photo backups out of Postgres entirely) or need a real, deliberately
// less-frequent full pg_dump (no --exclude-table-data) when running without
// object storage.
//
// Usage: DATABASE_URL=postgres://... node scripts/backup.js [output-dir]

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const execFileAsync = promisify(execFile);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL is required.'); process.exit(1); }
  const outDir = process.argv[2] || '.';
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const sqlPath = path.join(outDir, `backup-${stamp}.sql`);
  console.log(`Dumping schema + all data (photos table data excluded) -> ${sqlPath}`);
  await execFileAsync('pg_dump', [dbUrl, '--exclude-table-data=photos', '-f', sqlPath]);

  const metaPath = path.join(outDir, `backup-${stamp}-photos-meta.sql`);
  console.log(`Dumping photo metadata only (no image bytes) -> ${metaPath}`);
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, filename, original_name, mime, caption, visit_id, issue_id,
             visit_comment_id, uploaded_by, shared, created_at
      FROM photos ORDER BY id`);
    // A bare `pg.Client` (unlike src/db.js's pool) uses node-postgres's
    // default type parsing, which returns TIMESTAMP columns as JS Date
    // objects — stringify explicitly to a valid Postgres timestamp literal
    // rather than Date's default toString() format.
    const esc = (v) => {
      if (v == null) return 'NULL';
      const s = v instanceof Date ? v.toISOString() : String(v);
      return `'${s.replace(/'/g, "''")}'`;
    };
    const lines = [
      '-- Photo metadata only (no image bytes) — see scripts/backup.js.',
      '-- Restore into a database that already has the photos table; data/thumb_data stay empty.',
      '',
    ];
    for (const r of rows) {
      lines.push(
        'INSERT INTO photos (id, filename, original_name, mime, data, caption, visit_id, issue_id, visit_comment_id, uploaded_by, shared, created_at) VALUES ' +
        `(${r.id}, ${esc(r.filename)}, ${esc(r.original_name)}, ${esc(r.mime)}, ''::bytea, ${esc(r.caption)}, ` +
        `${r.visit_id ?? 'NULL'}, ${r.issue_id ?? 'NULL'}, ${r.visit_comment_id ?? 'NULL'}, ${r.uploaded_by ?? 'NULL'}, ${r.shared}, ${esc(r.created_at)});`
      );
    }
    fs.writeFileSync(metaPath, lines.join('\n') + '\n');
    console.log(`Done. ${rows.length} photo row(s) recorded (metadata only, ${sqlPath} has everything else in full).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
