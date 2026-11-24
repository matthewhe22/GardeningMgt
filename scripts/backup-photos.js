#!/usr/bin/env node
// Copy every photo original not yet backed up from the primary bucket to the
// off-site backup bucket (the daily job does this in small batches; run this
// once to clear the backlog, or any time to catch up).
//
// The backup bucket and its switch are set in the app: Settings → Off-site
// photo backup. This needs the database and the photo bucket settings, plus
// the same SETTINGS_KEY / SESSION_SECRET as the app (to read the saved secret):
//
//   DATABASE_URL=... SESSION_SECRET=... S3_BUCKET=... S3_ENDPOINT=... S3_REGION=... \
//   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npm run backup:photos
//
// Safe to stop and re-run: each photo is marked once copied.

const { q, pool } = require('../src/db');
const photoBackup = require('../src/photoBackup');

async function main() {
  if (!(await photoBackup.enabled())) {
    console.error('Off-site photo backup is switched off or incomplete (Settings → Off-site photo backup), '
      + 'or S3_* (the photo bucket) is not set here.');
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
