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
is set):

| Variable | Notes |
|---|---|
| `S3_BUCKET` | bucket name (enables object storage) |
| `S3_REGION` | region (default `us-east-1`; R2 uses `auto`) |
| `S3_ENDPOINT` | custom endpoint for R2/Supabase/MinIO (omit for AWS) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | credentials |
| `S3_PREFIX` | optional key prefix (default `photos/`) |

To move photos already in the database into the bucket, run once after
configuring the vars: `npm run migrate:photos`.

## Backups

`npm run backup [output-dir]` (requires `pg_dump` on PATH and `DATABASE_URL`
set) writes a full schema+data dump of every table *except* photo image bytes,
plus a second file with the photos table's own metadata (filename, caption,
visit/issue link, timestamps) — so a routine backup isn't multiple times
larger than the rest of the database just from `photos.data`/`thumb_data`.
The actual image bytes are recoverable from S3 if `S3_BUCKET` is configured
(see above); without S3, run an occasional full `pg_dump` (no
`--exclude-table-data`) alongside the routine backups if you need the photo
bytes themselves preserved too.

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
