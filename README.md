# GardeningMgt 🌱

A gardening job management platform for teams of admins, supervisors and gardeners.

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

## Quick start

```bash
npm install
npm run seed     # demo users + data (safe: skips if users exist)
npm start        # http://localhost:3000
```

Demo accounts (after seeding):

| Role | Email | Password |
|---|---|---|
| Admin | admin@example.com | admin1234 |
| Supervisor | supervisor@example.com | super1234 |
| Gardener | gary@example.com | garden1234 |
| Gardener | gina@example.com | garden1234 |

```bash
npm test         # unit tests
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `SESSION_SECRET` | dev value | **Set in production** |
| `DATA_DIR` | `./data` | SQLite DB + uploads location |
| `HOURLY_RATE` | 50 | Default labour rate for invoices |

## Mobile use

The web app is responsive and installable (PWA manifest); gardeners can use it
from a phone browser to start/stop the job timer (GPS position is captured),
take and upload photos with the camera, and receive reminders. See
[docs/DESIGN.md](docs/DESIGN.md) for the native mobile app roadmap.

## Architecture

Node.js + Express 5, server-rendered EJS views, SQLite (better-sqlite3),
sessions + bcrypt auth, multer uploads, node-cron scheduler. Route optimization
is a built-in nearest-neighbour + 2-opt heuristic over haversine distances.
Full design notes and data model: [docs/DESIGN.md](docs/DESIGN.md).
