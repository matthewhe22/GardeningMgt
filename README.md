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
| Route optimization per gardener per day (nearest-neighbour + 2-opt, no external API) | **Routes** |
| Automatic visit reminders (daily 06:00 cron → in-app notifications) | 🔔 Notifications |
| Bulk visit reminders for any date | **Reminders** (staff) |
| Activity log of every change | **Activity** (staff) |
| Job timer with GPS capture on start/finish | Job page (mobile-friendly) |
| Job completion summary sent to supervisors & admins | 🔔 Notifications |
| Per-job comments (supervisor ↔ gardener) | Job page |
| Invoicing per job (labour pre-filled from the timer) | **Invoices** (staff) |
| Reporting (visits, hours per gardener, issues, invoice totals) | **Reports** (staff) |

## Roles

- **Admin** — everything, plus user management.
- **Supervisor** — schedule jobs, manage properties/tasks/issues, optimize routes, send bulk reminders, invoicing, reports, activity log, comment on jobs.
- **Gardener** — sees own jobs/tasks/routes, runs the job timer (with GPS), uploads photos, reports issues, comments.

## Deploy to Vercel (with Supabase Postgres)

1. **Database**: create a [Supabase](https://supabase.com) project (free tier works) and
   copy the *direct connection string*. If the password contains special characters
   (`@`, `#`, …) they must be URL-encoded (`@` → `%40`).
2. **Import the repo** at [vercel.com/new](https://vercel.com/new) (framework preset:
   *Other*; no build command needed).
3. **Environment variables** (Project → Settings → Environment Variables):
   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres` |
   | `SESSION_SECRET` | a long random string |
   | `CRON_SECRET` | a long random string (protects the reminder cron endpoint) |
4. **Deploy.** On the first request the app creates all tables and a bootstrap
   admin: **admin@example.com / admin1234** — sign in and change it immediately
   (or set `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` before deploying).
5. Daily reminders run automatically via the Vercel Cron entry in `vercel.json`
   (06:00 UTC → `/cron/reminders`).

Photos are stored in PostgreSQL (`bytea`), so no blob storage setup is needed.

## Run locally / on a normal server

```bash
npm install
export DATABASE_URL=postgresql://user:pass@host:5432/dbname
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
| `DATABASE_URL` | local dev value | PostgreSQL connection string (required in production) |
| `SESSION_SECRET` | dev value | **Set in production** — signs the session cookie |
| `CRON_SECRET` | unset | If set, `/cron/reminders` requires `Authorization: Bearer <secret>` |
| `BOOTSTRAP_ADMIN_EMAIL/_PASSWORD` | admin@example.com / admin1234 | First admin on an empty database |
| `HOURLY_RATE` | 50 | Default labour rate for invoices |
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
