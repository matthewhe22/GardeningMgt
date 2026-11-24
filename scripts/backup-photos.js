#!/usr/bin/env node
// Copy every photo original not yet backed up from the primary bucket to the
// off-site backup bucket (the daily job does this in small batches; run this
// once to clear the backlog, or any time to catch up).
//
//   DATABASE_URL=... S3_BUCKET=... S3_ENDPOINT=... S3_REGION=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//   BACKUP_S3_BUCKET=... BACKUP_S3_ENDPOINT=... BACKUP_S3_REGION=auto \
//   BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... npm run backup:photos
//
// Safe to stop and re-run: each photo is marked once copied.

const { q, pool } = require('../src/db');
const photoBackup = require('../src/photoBackup');

async function main() {
  if (!photoBackup.enabled()) {
    console.error('Set S3_* (the photo bucket) and BACKUP_S3_* (the backup bucket) first.');
    process.exit(1);
  }
  let total = 0;
  let failedTotal = 0;
  for (;;) {
    const { copied, failed, remaining } = await photoBackup.backupPhotos(q, { maxMs: 60000, limit: 100 });
    total += copied;
    failedTotal += failed;
    console.log(`  copied ${total} so far, ${remaining} to go${failedTotal ? `, ${failedTotal} failed` : ''}`);
    if (!remaining || (!copied && failed)) break; // done, or stuck on failures
  }
  console.log(failedTotal ? `Finished with ${failedTotal} failure(s) — see the messages above, then re-run.` : 'All photos are backed up.');
  await pool.end();
  process.exit(failedTotal ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
