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
scope_library (global ≤20 items; standard photo = photos.library_scope_id)
scope_templates + scope_template_items (named subsets: Standard 1, 2 …)
jobs.template_id / jobs.scope_customized (site follows a template unless adjusted)
job_scopes (scope of duties per job, ≤20; library_id links to the library;
            site-specific photo = photos.job_scope_id, else the library photo)
visit_scope_checks (per-visit checklist: done, comment, title snapshot;
                    evidence photos = photos.scope_check_id)
visits.status adds 'approved' (+ approved_at/approved_by) = approved for payment
activity_log (append-only audit of every mutation)
```

## Key mechanisms

### Route optimization
`src/routeOptimizer.js`: per gardener per day, nearest-neighbour construction
then 2-opt improvement over haversine distances. O(n²) per pass — instant for
realistic daily stop counts (≤30). Needs no API key or network. Stops without
coordinates are appended to the end of the route. "Optimize all" loops every
gardener for a date.

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

### Scope of duties, review & payment approval
Staff define up to 20 scope items per recurring job (paste a list, reorder,
copy from another site) and attach one standard photo per item. When a visit
is opened its checklist is synced from the job's scope (titles snapshotted;
frozen once completed). The gardener ticks each item, adds photos and an
optional comment; completion requires every item ticked or explained by a
comment, plus ≥1 photo. On completion the report (scope results + all photos,
self-contained HTML attachment) is emailed to every active admin via Resend.
Admins review on the job page or **Jobs → Awaiting review** and click
**Approve for payment** (`completed → approved`); approved jobs can't be
restarted, and only an admin can withdraw the approval.

### Scope templates
Admins keep one global library (≤20 items with standard photos) on
**Scope standards**, save all or some items as named templates, and apply a
template to all active sites or chosen ones. Applying is a diff on job_scopes
(rows keep their ids), so in-progress checklists keep ticks/photos. Sites
that follow a template are re-synced automatically when the template's items
or the library (wording, order, deletion) change. Editing one site's items
sets `scope_customized`, which stops automatic re-sync until the template is
re-applied to that site.

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
