# GardeningMgt — Design

## Goals

A job management platform for gardening businesses with three roles
(admin, supervisor, gardener) covering scheduling, field work capture
(timer, GPS, photos), issue tracking, invoicing and reporting.

## Stack

- **Backend**: Node.js + Express 5, server-rendered EJS. Deployed as a single
  Vercel serverless function (`api/index.js`) or run as a normal Node process.
- **Database**: PostgreSQL via `pg` (e.g. Supabase). Schema is created
  idempotently on first request; an empty database also gets a bootstrap admin.
- **Auth**: signed cookie sessions (`cookie-session`, no server-side store —
  survives serverless cold starts) + bcrypt password hashes. Role checks in
  middleware (`requireRole`), admin implicitly passes all checks.
- **Files**: photos stored in PostgreSQL (`bytea`) and streamed out behind
  login — serverless filesystems are read-only/ephemeral, so no disk is used.
- **Scheduler**: Vercel Cron hits `/cron/reminders` daily (protected by
  `CRON_SECRET`); `npm start` on a normal server uses in-process node-cron.

## Data model

```
users (role: admin|supervisor|gardener)
properties (client sites; lat/lng enables route optimization)
visits (the "job": property + gardener + date, status, route_order,
        started_at/finished_at/duration_minutes  ← job timer)
tasks (per-visit or standalone, assignee, status)
issues + issue_comments (priority, status workflow, assignee)
photos (visit or issue attachment, uploaded_by, shared flag, created_at ← timestamp)
visit_comments (supervisor/gardener discussion per job)
gps_points (visit_id, lat/lng, kind: start|ping|finish ← GPS tracking)
invoices + invoice_items (per job; labour line pre-filled from timer)
notifications (in-app: reminders, job completion summaries)
activity_log (append-only audit of every mutation)
```

## Key mechanisms

### Route optimization
`src/routeOptimizer.js`: per gardener per day, nearest-neighbour construction
then 2-opt improvement over haversine distances. O(n²) per pass — instant for
realistic daily stop counts (≤30). Needs no API key or network. Stops without
coordinates are appended to the end of the route. "Optimize all" loops every
gardener for a date.

**Portfolio routing by location** (`segmentByLocation` / `clusterByLocation`):
across the whole portfolio, every site under an active contract is grouped by
location with deterministic k-means over haversine distance (farthest-first
seeding so day allocations are stable and testable), producing one
geographically tight segment per service day. The preview at
`/routes/portfolio` shows the day-by-day allocation; applying it moves a chosen
week's scheduled visits onto the weekday assigned to their site and re-optimizes
each affected gardener's day. Sites without coordinates are listed but not
allocated.

### Reminders
`src/reminders.js`: a single `sendRemindersForDate(date, {force})` function used by
1) a cron job at 06:00 daily (automatic reminders for today's visits) and
2) the staff **Bulk reminders** screen (any date, optional force re-send).
Reminders are in-app notifications; `visits.reminder_sent_at` prevents duplicates.
Email/SMS delivery would plug in at the same point.

### Job timer + GPS
Start/stop buttons on the job page set `started_at`/`finished_at` and compute
`duration_minutes` in SQL. The browser fills hidden lat/lng fields from the
Geolocation API, stored as `gps_points` (`start`/`finish`, plus a `/gps` ping
endpoint for periodic tracking). On finish, a **job summary notification**
(duration, tasks done, photo count) goes to every supervisor and admin.

### Activity log
`logActivity(userId, action, entityType, entityId, details)` is called from every
mutating route and the cron job (userId = null → "System"). Staff view at
`/admin/activity`.

### Photos
Multer memory storage → PostgreSQL `bytea`, 10 MB limit, image extensions only,
random filename keys served from `/uploads/:filename`.
Every photo records uploader and `created_at`; the UI overlays the timestamp
on the image. Photos attach to a job or an issue and appear in the shared
team gallery (`shared` flag lets a gardener keep one private to staff+self).

## Mobile

Phase 1 (this repo): responsive, installable web app (PWA manifest). Gardeners
use the phone browser for: today's route, job timer with GPS capture, camera
photo upload (`capture="environment"`), reminders and summaries via in-app
notifications.

Phase 2 (roadmap): native app (React Native/Expo) talking to the same backend
exposed as JSON; needs an `/api` token-auth layer (the route handlers already
separate data access cleanly), background GPS pings to `POST /visits/:id/gps`,
push notifications (FCM/APNs) replacing in-app-only delivery, and offline
queueing of photos/timer events.

## Security notes

- All pages and uploads require login; role middleware guards staff routes;
  gardeners can only open their own jobs.
- Passwords bcrypt-hashed; sessions httpOnly + SameSite=Lax.
- Set `SESSION_SECRET` in production; serve behind HTTPS.
- Known MVP gaps to address next: CSRF tokens on forms, rate limiting on login,
  image content-type sniffing (currently extension allowlist).
