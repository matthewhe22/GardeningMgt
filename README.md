# GardeningMgt 🌱

A gardening job management platform for teams of admins, supervisors and gardeners.
Runs on Vercel (serverless) with a PostgreSQL database (e.g. Supabase), or on any
normal Node.js server.

## Features

| Feature | Where |
|---|---|
| Daily tasks & job schedule | Dashboard, **Jobs**, **Tasks** |
| Issue tracking (priority, status, comments, photos) | **Issues** |
| Photo upload & team sharing, with timestamps on every photo | Job/issue pages, **Photos** gallery |
| Route optimization per gardener per day (nearest-neighbour + 2-opt; road distance via OSRM with a straight-line fallback) | **Routes** |
| Automatic visit reminders (daily 06:00 cron → in-app notifications) | 🔔 Notifications |
| Bulk visit reminders for any date | **Reminders** (staff) |
| Activity log of every change | **Activity** (staff) |
| Job timer with GPS capture on start/finish | Job page (mobile-friendly) |
| Job completion summary sent to supervisors & admins | 🔔 Notifications |
| Per-job comments (supervisor ↔ gardener) | Job page |
| Invoicing per job (pre-filled from the site's gardening fee), with per-site billing name/address/email and a GST-inclusive breakdown | **Invoices** (staff), **Properties** |
| Automatic invoice creation + emailing (PDF attached) to the site's billing address when a job completes | Job page, **Properties**, **Settings** (email/SMTP) |
| Reporting (visits, hours per gardener, issues, invoice totals) | **Reports** (staff) |
| Global scope library (≤20 items + standard photos) → templates (Standard 1, 2…) → apply to all / selected sites | **Scope standards** |
| Per-site scope adjustment (optional; marks the site “adjusted”) | **Sites** → 📋 scope chip |
| Gardener checklist: tick / photo / comment per scope item, “View scope standards” | Job page |
| Live job photos: camera only, only while the job runs, rejected if older than `PHOTO_MAX_AGE_HOURS` (EXIF capture time); every scope item needs a photo before the job can be completed; compressed in the browser to 2560px and uploaded one photo per request (straight to the bucket when object storage is set up); every ad-hoc job task needs a photo too | Job page |
| Job report emailed to every active admin on completion (photos attached) | Email (needs Resend) |
| Admin review → **Approve for payment** (status `approved`) | Job page, **Jobs** → Awaiting review |
| Custom logo (sidebar/top bar) and browser tab favicon, uploaded as an image and re-encoded server-side | **Settings** (admin) |

## Roles

- **Admin** — everything, plus user management.
- **Supervisor** — schedule jobs, manage properties/tasks/issues, optimize routes, send bulk reminders, invoicing, reports, activity log, comment on jobs.
- **Gardener** — sees own jobs/tasks/routes, runs the job timer (with GPS), uploads photos, reports issues, comments.

## Deploy to Vercel (with Supabase Postgres)

1. **Database**: create a [Supabase](https://supabase.com) project (free tier works) and
   copy the **connection-pooler** string (Supabase → Database → Connection pooling,
   port `6543`). Serverless functions spin up many concurrent instances, so a
   pooler is strongly recommended — a direct (`5432`) connection can exhaust
   Postgres' connection slots under load (the app logs a warning if it detects this
   on Vercel). If the password contains special characters (`@`, `#`, …) they must be
   URL-encoded (`@` → `%40`).
2. **Import the repo** at [vercel.com/new](https://vercel.com/new) (framework preset:
   *Other*; no build command needed).
3. **Environment variables** (Project → Settings → Environment Variables):
   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | pooler URL, e.g. `postgresql://postgres.xxxx:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?pgbouncer=true` |
   | `DB_SKIP_INIT` | `1` once the schema exists, so cold starts skip the schema/migration check |
   | `SESSION_SECRET` | a long random string |
   | `CRON_SECRET` | a long random string (protects the reminder cron endpoint) |
4. **Deploy.** On the first request the app creates all tables and a bootstrap
   admin: **admin@example.com / admin1234** — sign in and change it immediately
   (or set `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` before deploying).
5. Daily reminders run automatically via the Vercel Cron entry in `vercel.json`
   (20:00 UTC → `/cron/reminders`, ≈ 06:00 Melbourne / 07:00 during daylight saving;
   Vercel cron is UTC-only so the local time drifts ±1h across DST).

Photos are stored in PostgreSQL (`bytea`) by default, so no blob storage setup
is needed to get started.

### Optional: store photos in object storage (recommended at scale)

Keeping image bytes in Postgres bloats the database and meters egress on every
view. To offload them to any S3-compatible bucket (Cloudflare R2, AWS S3,
Supabase Storage, MinIO), set these env vars — when `S3_BUCKET` is present the
app stores new uploads in the bucket automatically (nothing changes until it
is set). To move the database itself to Sydney, see
[docs/DB-MOVE-SYDNEY.md](docs/DB-MOVE-SYDNEY.md).

| Variable | Notes |
|---|---|
| `S3_BUCKET` | bucket name (enables object storage) |
| `S3_REGION` | region (default `us-east-1`; R2 uses `auto`) |
| `S3_ENDPOINT` | custom endpoint for R2/Supabase/MinIO (omit for AWS) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | credentials |
| `S3_PREFIX` | optional key prefix (default `photos/`) |
| `S3_DIRECT_UPLOADS` | set to `0` to keep job photos going through the app instead of straight to the bucket |
| `S3_UPLOAD_ORIGIN` | override the bucket origin(s) allowed in the page's CSP `connect-src` (comma-separated); normally worked out from the vars above |

To move photos already in the database into the bucket, run once after
configuring the vars: `npm run migrate:photos`. Each photo is checked in the
bucket before its database copy is cleared; afterwards run `VACUUM FULL photos;`
(Supabase SQL editor, quiet time) so the database actually shrinks.

#### Supabase Storage setup (recommended if your database is on Supabase)

Supabase Storage speaks the S3 protocol, so it needs no new account and sits in
the same region as your database. On a **Pro** plan it includes 100 GB of
storage and 250 GB of downloads.

1. Supabase → your project → **Storage → Settings → S3 Connection**: note the
   **Endpoint** (`https://<project-ref>.storage.supabase.co/storage/v1/s3`) and
   **Region**, then **New access key** and copy the Access Key ID and Secret.
   These keys bypass row-level security: keep them server-side only (Vercel
   env vars + your own terminal), never in the browser or the repo.
2. Vercel → Project → Settings → Environment Variables, then redeploy:
   `S3_BUCKET=photos`, `S3_ENDPOINT=<the endpoint above>`,
   `S3_REGION=<the region above, e.g. ap-southeast-2>`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`.
3. Create the bucket and self-test the real upload path from your machine
   (same variables exported; the bucket is created **private** if missing):
   ```bash
   npm run storage:setup -- https://<your-app-domain>
   ```
   Supabase has no bucket CORS or lifecycle settings, so the script skips those.
   Browser uploads rely on Supabase answering CORS itself; if the preflight line
   shows ⚠, phones simply upload through the app instead (slower, still works).
   Unfinished uploads under `photos/pending/` are deleted by the app's daily job.
4. `npm run migrate:photos`, then `VACUUM FULL photos;` — see above.

#### Cloudflare R2 setup (alternative)

1. Cloudflare dashboard → **R2** → *Create bucket*, e.g. `gardeningmgt-photos`.
   Set **Location → Specify jurisdiction/hint → Oceania (OC)** — it can't be
   changed later. Keep public access **off**.
2. R2 → *Manage API tokens* → create an **Object Read & Write** token limited to
   that bucket. Note the Access Key ID, Secret Access Key and your account ID.
3. Vercel → Project → Settings → Environment Variables:
   `S3_BUCKET=gardeningmgt-photos`,
   `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Redeploy.
4. Configure CORS + the pending-upload cleanup rule and self-test, from your
   machine (bucket settings need an **Admin Read & Write** token for this one
   run — create one temporarily, or use the dashboard settings it prints):
   ```bash
   S3_BUCKET=… S3_ENDPOINT=… S3_REGION=auto S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
     npm run storage:setup -- https://<your-app-domain>
   ```
   Re-run with `--check-only` any time to verify uploads work end to end.
5. `npm run migrate:photos` (same variables plus `DATABASE_URL`), then
   `VACUUM FULL photos;`.

#### Direct uploads from the phone

With a bucket configured, job photos go **straight from the phone to the
bucket** using short-lived presigned URLs: the app hands out a URL for a
`pending/` key, the phone uploads to it, and the app then checks the stored
file (size, real image, EXIF capture time), makes the thumbnail and moves it to
its final key. Photo bytes no longer pass through the app's request, so the
host's ~4.5 MB request limit doesn't apply. Two one-time bucket settings:

`npm run storage:setup` applies both of these for you (see above). By hand:

1. **CORS** — allow your app's origin to `PUT` with a `Content-Type` header, e.g.
   ```json
   [{ "AllowedOrigins": ["https://your-app.example.com"], "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 3000 }]
   ```
2. **Lifecycle rule** — expire objects under `photos/pending/` (your
   `S3_PREFIX` + `pending/`) after 1 day, to sweep up uploads that were never
   finished (dropped connection mid-upload).

If CORS isn't set up yet, the phone notices the bucket refusing it and
automatically falls back to uploading through the app, so nothing breaks in
the meantime.

## Backups

Three things hold your data; each needs its own backup.

**1. The database.** Supabase backs up Postgres daily on paid plans (and can
restore to a point in time with the PITR add-on) — check what your plan
includes under Database → Backups. For your own copy, run:

```bash
DATABASE_URL="<session pooler URL>" npm run backup -- ./backups
```

This writes one `pg_dump` custom-format file with every table and column.
`scripts/backup.js` shows how to restore it. It needs `pg_dump` with the
server's major version or newer.

**2. Photo originals (object storage).** Supabase's database backups do not
include Storage. When a second bucket is configured, the daily job copies
each new photo there (time-boxed, so a big backlog catches up over a few
days), and records it in `photos.backed_up_at`. Nothing is ever deleted from
the backup. Use a different provider than the primary, e.g. a Cloudflare R2
bucket:

| Variable | Notes |
|---|---|
| `BACKUP_S3_BUCKET` | backup bucket name (enables photo backups) |
| `BACKUP_S3_ENDPOINT` | e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_REGION` | `auto` for R2 |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | an **Object Read & Write** token for that bucket only |

To copy the existing backlog in one go (from your machine, with the same
`S3_*`, `BACKUP_S3_*` and `DATABASE_URL` values exported):

```bash
npm run backup:photos
```

It's safe to stop and re-run.

**3. Thumbnails** live in the database, so backup 1 covers them.

## Housekeeping (daily job)

`/cron/reminders` runs once a day (see `vercel.json`). Each step runs on its
own, so one failing doesn't skip the rest; a failure is recorded in the
activity log as `system.cron_failed`. It sends reminders, books the next
contract visits, prunes old notifications and activity, geocodes new sites,
and then does three photo jobs:
- deletes unfinished uploads older than a day;
- deletes bucket photos that no database row refers to any more, if they're
  older than 7 days (at most 500 per run, and never when the photos table is
  empty);
- copies new photos to the backup bucket.

## Job photo rules

Job photos (checklist items, tasks, general job photos) must:
- come from the camera, while the job is running;
- have been taken during the job: no more than `PHOTO_MAX_AGE_HOURS`
  (default 12) old, and not more than `PHOTO_START_GRACE_MINUTES` (default 30)
  before the job was started.

The capture time is read from the photo itself (EXIF). When the file carries
none, the phone's clock is used instead, and staff see the photo marked
**time from phone**. HEIC files are refused with a request to set the camera
to "Most Compatible" (JPG); iPhone Safari converts automatically.

## Run locally / on a normal server

The app refuses to start without `SESSION_SECRET` set (it signs the session
cookie; a known secret lets anyone forge a signed admin login). For local dev
only, set `ALLOW_INSECURE_SECRET=1` instead of generating a real secret — never
set it on a deployment reachable over the network. `npm start` on a bare
server is a supported deployment (see `startReminderScheduler` in
`src/reminders.js`), so this applies there too, not just to `npm run dev`.

```bash
npm install
export DATABASE_URL=postgresql://user:pass@host:5432/dbname
export ALLOW_INSECURE_SECRET=1   # or: export SESSION_SECRET=<a long random string>
npm run seed     # demo users + data (skips if data exists)
npm start        # http://localhost:3000
npm test         # unit tests
```

Demo accounts (after seeding):

| Role | Email | Password |
|---|---|---|
| Admin | admin@example.com | admin1234 |
| Supervisor | supervisor@example.com | super1234 |
| Gardener | gary@example.com | garden1234 |
| Gardener | gina@example.com | garden1234 |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local dev value | PostgreSQL connection string (required in production). On Vercel, this should be your provider's **pooler** connection string (Supabase port 6543, Neon's "-pooler" host) — a direct connection means every serverless instance opens its own independent pool, which can exhaust Postgres' connection slots under real traffic and take the whole app down at once. A direct URL on Vercel logs a warning and shows on `GET /health` and the admin Settings page until switched |
| `REQUIRE_DB_POOLER` | unset | Set to `1` once `DATABASE_URL` is confirmed to be a pooler URL, to turn the above from a warning into a hard boot-time failure — catches a future misconfiguration (e.g. an env var accidentally reverted) instead of silently reintroducing the risk |
| `SESSION_SECRET` | none | Signs the session cookie. **Required** — the app refuses to start without it (or without `ALLOW_INSECURE_SECRET=1`), since a known secret lets anyone forge a signed admin session cookie |
| `ALLOW_INSECURE_SECRET` | unset | Set to `1` to let the app boot with the built-in insecure default secret/key when `SESSION_SECRET`/`SETTINGS_KEY` aren't set. **Local dev only** — never set this in any deployment reachable over the network |
| `CRON_SECRET` | unset | If set, `/cron/reminders` requires `Authorization: Bearer <secret>` |
| `BOOTSTRAP_ADMIN_EMAIL/_PASSWORD` | admin@example.com / admin1234 | First admin on an empty database |
| `APP_URL` | request origin | Public URL used in email links (job report "Review & approve" button), e.g. `https://gardeningmgt.vercel.app` |
| `RESEND_API_KEY` / `RESEND_FROM` | unset | Fallback email provider for job reports when SMTP isn't configured in **Settings** |
| `PHOTO_MAX_AGE_HOURS` | 12 | Oldest capture time (from the photo's EXIF) accepted for a job photo |
| `PHOTO_START_GRACE_MINUTES` | 30 | How long before a job's start time a job photo may have been taken |
| `BACKUP_S3_*` | unset | Off-site copy of photo originals — see Backups |
| `BUSINESS_TZ` | Australia/Melbourne | Timezone for the business calendar, reminder scheduling and every timestamp shown to users |
| `OSRM_URL` | public demo server | Road-distance routing endpoint (OSRM). Falls back to straight-line if unreachable; self-host for production volume — see [docs/OSRM.md](docs/OSRM.md) |
| `GEOCODER_URL` / `GEOCODER_EMAIL` | Nominatim | Address→coordinates geocoder (used by Sites) |
| `PORT` | 3000 | HTTP port (non-Vercel) |

## Mobile use

The web app is responsive and installable (PWA manifest); gardeners can use it
from a phone browser to start/stop the job timer (GPS position is captured),
take and upload photos with the camera, and receive reminders. See
[docs/DESIGN.md](docs/DESIGN.md) for the native mobile app roadmap.

## Architecture

Node.js + Express 5 (exported as a single Vercel serverless function via
`api/index.js`), server-rendered EJS views, PostgreSQL via `pg`, signed cookie
sessions (no server-side store), photos in `bytea`, and a built-in
nearest-neighbour + 2-opt route optimizer. Full design notes and data model:
[docs/DESIGN.md](docs/DESIGN.md).
