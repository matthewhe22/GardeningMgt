#!/usr/bin/env node
// Configure and verify the photo bucket (Supabase Storage, Cloudflare R2, AWS
// S3 or any S3-compatible store) for direct phone uploads, then run an
// end-to-end self-test of the exact calls the app makes.
//
//   npm run storage:setup -- https://your-app.example.com [more origins…]
//   npm run storage:setup -- --check-only https://your-app.example.com
//
// Origins default to APP_URL. Uses the same S3_* env vars as the app.
//
// 0. Creates the (private) bucket if it doesn't exist yet.
// 1. CORS: lets those origins PUT photos straight to the bucket.
// 2. Lifecycle: deletes unfinished uploads under <S3_PREFIX>pending/ after 1 day.
//    Supabase Storage has neither (it answers browser CORS itself, and the
//    app's daily job clears old pending/ uploads), so both are skipped there.
// 3. Self-test: presigned PUT (as a phone would, incl. the CORS preflight),
//    head, promote (copy + delete), read back, delete.
//
// Steps 1–2 change bucket settings, so they need a token allowed to (on R2:
// an "Admin Read & Write" token). The app itself only needs "Object Read &
// Write". If the token can't change settings, the script prints what to set
// in the dashboard instead and still runs the self-test.
// Existing CORS / lifecycle rules are kept; only this app's rules are replaced.

const storage = require('../src/storage');

const CORS_ID = 'gardeningmgt-direct-uploads';
const LIFECYCLE_ID = 'gardeningmgt-expire-pending';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const origins = args.filter((a) => !a.startsWith('--'))
  .concat(args.some((a) => !a.startsWith('--')) ? [] : [process.env.APP_URL].filter(Boolean))
  .map((o) => { try { return new URL(o).origin; } catch (_) { return null; } })
  .filter(Boolean);

let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const note = (msg) => console.log(`  – ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
// Supabase Storage doesn't implement bucket CORS / lifecycle rules.
const noBucketRules = /(^|\.)supabase\.co$/.test((() => { try { return new URL(process.env.S3_ENDPOINT || '').hostname; } catch (_) { return ''; } })());
const notImplemented = (e) => e && (e.name === 'NotImplemented' || e.$metadata?.httpStatusCode === 501);
const bad = (msg) => { failures++; console.log(`  ✘ ${msg}`); };
const denied = (e) => e && (e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403);
const missing = (e) => e && (/NoSuchCORSConfiguration|NoSuchLifecycleConfiguration|NotFound/.test(e.name || e.Code || '')
  || e.$metadata?.httpStatusCode === 404);

async function client() {
  // Reuse the app's configured client (same endpoint, region, checksum settings).
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
      : undefined,
  });
}

async function setupCors(s3, Bucket) {
  if (noBucketRules) return note('CORS: not configurable on Supabase Storage (it answers browser uploads itself) — checked below');
  const { GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
  const rule = { ID: CORS_ID, AllowedOrigins: origins, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 3600 };
  try {
    let rules = [];
    try { rules = (await s3.send(new GetBucketCorsCommand({ Bucket }))).CORSRules || []; } catch (e) { if (!missing(e)) throw e; }
    rules = rules.filter((r) => r.ID !== CORS_ID);
    await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [...rules, rule] } }));
    ok(`CORS: ${origins.join(', ')} may PUT photos`);
  } catch (e) {
    if (notImplemented(e)) return note('CORS: this provider has no bucket CORS settings — checked below');
    if (!denied(e)) return bad(`CORS: ${e.name || e.message}`);
    bad('CORS: this token may not change bucket settings. Set it in the dashboard instead');
    console.log('    (R2: bucket → Settings → CORS policy), with:');
    console.log(JSON.stringify([{ AllowedOrigins: origins, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 3600 }], null, 2)
      .replace(/^/gm, '      '));
  }
}

async function setupLifecycle(s3, Bucket) {
  if (noBucketRules) return note(`Lifecycle: not available on Supabase Storage — the app's daily job deletes unfinished uploads under ${storage.pendingKey('')}`);
  const { GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand } = require('@aws-sdk/client-s3');
  const Prefix = storage.pendingKey('');
  const rule = { ID: LIFECYCLE_ID, Status: 'Enabled', Filter: { Prefix }, Expiration: { Days: 1 } };
  try {
    let rules = [];
    try { rules = (await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules || []; } catch (e) { if (!missing(e)) throw e; }
    rules = rules.filter((r) => r.ID !== LIFECYCLE_ID);
    await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: [...rules, rule] } }));
    ok(`Lifecycle: unfinished uploads under ${Prefix} are deleted after 1 day`);
  } catch (e) {
    if (notImplemented(e)) return note(`Lifecycle: this provider has no lifecycle rules — the app's daily job deletes unfinished uploads under ${Prefix}`);
    if (!denied(e)) return bad(`Lifecycle: ${e.name || e.message}`);
    bad('Lifecycle: this token may not change bucket settings. In the dashboard');
    console.log(`    (R2: bucket → Settings → Object lifecycle rules) add: prefix "${Prefix}", delete after 1 day.`);
  }
}

// A 1×1 JPEG — the app's sniff check wants real JPEG magic bytes.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function selfTest() {
  const name = `selftest-${Date.now()}.jpg`;
  const url = await storage.presignPendingPut(name, 'image/jpeg', 120);
  const origin = origins[0];
  if (origin) {
    // The browser's CORS preflight for the phone's PUT. A rule just saved can
    // take up to a minute to start applying on R2, so retry before failing.
    const attempts = checkOnly ? 1 : 7;
    let pre; let allow; let detail = '';
    for (let i = 0; i < attempts; i++) {
      pre = await fetch(url, { method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
      allow = pre.headers.get('access-control-allow-origin');
      if (pre.ok && (allow === origin || allow === '*')) break;
      detail = (await pre.text()).replace(/\s+/g, ' ').slice(0, 300);
      if (i === 0 && attempts > 1) console.log('  … preflight not accepted yet; waiting for the CORS rule to take effect (up to ~1 min)');
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 10000));
    }
    if (pre.ok && (allow === origin || allow === '*')) ok(`CORS preflight from ${origin} accepted`);
    else {
      warn(`CORS preflight from ${origin} refused (HTTP ${pre.status}) — phones will fall back to uploading through the app (slower, but works)`);
      console.log(`    response body: ${detail || '(empty)'}`);
      console.log(`    access-control-allow-origin: ${allow || '(none)'}`);
      try {
        const { GetBucketCorsCommand } = require('@aws-sdk/client-s3');
        const rules = (await (await client()).send(new GetBucketCorsCommand({ Bucket: process.env.S3_BUCKET }))).CORSRules;
        console.log(`    CORS rules stored on the bucket: ${JSON.stringify(rules)}`);
      } catch (e) { console.log(`    could not read the bucket's CORS rules back: ${e.name || e.message}`); }
    }
  }
  const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', ...(origin ? { Origin: origin } : {}) }, body: TINY_JPEG });
  if (!put.ok) {
    bad(`Presigned upload failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
    return;
  }
  ok('Presigned upload (phone → bucket)');
  const head = await storage.headPending(name);
  if (head && head.size === TINY_JPEG.length) ok('Head of the pending upload'); else bad(`Head returned ${JSON.stringify(head)}`);
  await storage.promotePending(name);
  if (await storage.headPending(name)) bad('Pending copy still there after promote'); else ok('Promote (copy to final key, delete pending)');
  const back = await storage.getObjectBuffer(name);
  if (back.equals(TINY_JPEG)) ok('Read back the stored photo'); else bad('Read back different bytes');
  await storage.deleteObject(name);
  ok('Delete');
}

async function main() {
  if (!storage.enabled()) {
    console.error('S3_BUCKET is not set — configure S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  const Bucket = process.env.S3_BUCKET;
  console.log(`Bucket "${Bucket}" at ${process.env.S3_ENDPOINT || 'AWS S3'} (region ${process.env.S3_REGION || 'us-east-1'})`);
  if (!origins.length) console.log('  ! No app origin given (pass it, or set APP_URL) — skipping CORS setup and the preflight check.');
  const s3 = await client();
  if (!checkOnly) {
    try {
      if (await storage.ensureBucket()) ok(`Created private bucket "${Bucket}"`); else ok(`Bucket "${Bucket}" exists`);
    } catch (e) {
      bad(`Bucket: ${e.name || e.message}${denied(e) ? ' (this key may not create buckets — create it in the dashboard)' : ''}`);
    }
    if (origins.length) await setupCors(s3, Bucket);
    await setupLifecycle(s3, Bucket);
  }
  try { await selfTest(); } catch (e) { bad(`Self-test: ${e.name || ''} ${e.message}`); }
  console.log(failures ? `\n${failures} problem(s) — see above.` : '\nAll good: the bucket works for photo uploads.');
  process.exit(failures ? 1 : 0);
}

main();
