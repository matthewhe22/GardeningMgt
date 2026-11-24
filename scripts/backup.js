#!/usr/bin/env node
// Back up the whole database to one file you can restore with pg_restore.
//
//   DATABASE_URL=postgres://... node scripts/backup.js [output-dir]
//
// Every table and column is included (photo links, capture times, thumbnails
// and all), with timestamps exactly as stored. With object storage on (S3_BUCKET),
// photo originals are not in the database — they live in the bucket and are
// copied to the off-site backup bucket by the daily job (BACKUP_S3_*; see
// src/photoBackup.js and `npm run backup:photos`), so this file stays small.
// Without object storage the originals are inside the database and the file
// can be large.
//
// Restore into an empty database (which already has a public schema, so skip
// re-creating it):
//   pg_restore --list backup-<stamp>.dump | grep -vE ' SCHEMA - public | COMMENT - SCHEMA public ' > restore.list
//   pg_restore --no-owner --no-privileges --exit-on-error --use-list restore.list -d "$TARGET_URL" backup-<stamp>.dump
//
// Needs pg_dump with the same or a newer major version than the server.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL is required.'); process.exit(1); }
  const outDir = process.argv[2] || '.';
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `backup-${stamp}.dump`);
  console.log(`Dumping the public schema (all tables, all data) -> ${file}`);
  await execFileAsync('pg_dump', [dbUrl, '--schema=public', '--no-owner', '--no-privileges', '--format=custom', '--file', file],
    { maxBuffer: 64 * 1024 * 1024 });
  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`Done: ${file} (${mb} MB). Keep it private — it contains customer data.`);
}

main().catch((e) => { console.error(e.stderr || e.message || e); process.exit(1); });
