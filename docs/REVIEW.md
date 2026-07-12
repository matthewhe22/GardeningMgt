# GardeningMgt — Six-Perspective App Review

Consolidated from six independent reviews run against a live, seeded instance of the app:
**UI designer · UX designer · senior code engineer · full-stack engineer · Maria (administrator persona, desktop) · Gary (gardener persona, phone)**.
Code findings verified against `src/`; behavioral findings verified in a real browser (100+ screenshots) and via curl/psql. Findings that multiple reviewers hit independently are marked **[corroborated]**.

---

## What's solid (verified — don't touch)

- **Authorization is tight.** Live probing confirmed gardeners cannot view or modify other gardeners' visits, tasks, comments, photos, or reach staff/admin pages (403s everywhere they should be). SQL is fully parameterized; views escape output; CSRF double-submit is enforced; reminder double-send and invoice/visit races are closed with atomic claims and partial unique indexes; the login throttle is DB-backed.
- **The gardener happy path is genuinely good.** 0 taps to today's route-ordered job list, 2 taps to directions, 2 to start the timer, 2–3 for photos/comments/completion. Sticky full-width Start/Complete buttons, camera-direct photo capture, clear completion guards.
- **The app shell, pill system, stacked mobile tables, and login screen** are polished and consistent (44px+ touch targets, safe-area handling, AA contrast).
- **Admin flows that work well:** client onboarding (property → recurring job → auto-scheduled visits), complaint/issue lifecycle with photos and audit stamps, the reminders page, the OneDrive settings page with its excellent setup guide, and the activity log's answer to "who did what, when".

---

## P0 — Must fix before/immediately after go-live

### 1. Offline form submits lose the gardener's work **[corroborated: full-stack, UX, Gary — Gary's "day-one dealbreaker"]**
The service worker ignores POSTs (`public/sw.js:20`). Submitting a comment, photo, or job completion with no signal lands on a blank browser error page; everything typed is gone and nothing is retried on reconnect (verified: comment never arrived). `offline.html` even claims "your last viewed pages still work," which is false — no HTML is cached. In an app whose primary users work in dead spots, this sends gardeners back to texting the office.
**Fix:** persist form drafts to localStorage before submit; intercept failed POSTs with a "couldn't save — your text is kept, retry" page; longer term, queue POSTs with Background Sync. Correct the offline-page copy.

### 2. No password reset and no user editing **[Maria: blocking]**
There is no password reset anywhere — not admin-initiated, not self-service, no "forgot password" on the login page. A gardener who forgets their password is permanently locked out. User records also can't be edited at all after creation (email typo, new phone, role change).
**Fix:** admin "set new password" + edit form on /admin/users; later, self-service reset.

### 3. Invoices cannot actually be sent to a client **[corroborated: Maria (blocking), UX]**
No PDF, print view, or email for invoices (job *reports* have PDFs; invoices don't). The page lacks business name, client billing details, GST, due date, payment details. Invoicing is strictly one-per-visit (no monthly consolidated invoice — how most contracts bill); invoices can be created for visits that haven't happened, and an accidental empty draft can't be deleted.
**Fix:** invoice PDF using the existing report.js infrastructure + business-details settings; guard the create button on incomplete visits; allow deleting empty drafts. Consider multi-visit invoices.
**Mostly addressed:** the hardcoded, invisible `HOURLY_RATE`/$50 default has been removed. Each site's recurring job now has an admin-only **gardening fee** (`jobs.gardening_fee`, set/edited only when `req.user.role === 'admin'` — see `src/routes/jobs.js`, `views/jobs/index.ejs`); creating an invoice pulls that fee into a "Gardening fee" line item instead of computing labour × a fixed rate (`src/routes/invoices.js`). Supervisors can still create and manage invoices but never see or set the fee itself. A real invoice **PDF** now exists (`GET /invoices/:id/pdf`, `renderInvoicePdf` in `src/report.js`) carrying business name/address/ABN-GST, client contact/email, due date, and line items/total — this note previously said PDF and business/client/GST details were still open; they aren't, as of this session. Still genuinely open: no email-send action (PDF is download-only, no automated delivery to the client), and invoicing is still strictly one-per-visit (no monthly/consolidated multi-visit invoice).

### 4. CSRF tokens are injected only by client-side JS — without JS nobody can even log in **[full-stack: critical]**
Zero `_csrf` hidden inputs are rendered server-side; `public/js/app.js` injects them after load. If that one script fails (flaky signal, mid-deploy, script error), every POST including login returns 403 "Session expired" (verified via curl).
**Fix:** render the hidden `_csrf` input server-side in every form (shared partial); keep JS injection only for dynamic/multipart cases.

### 5. `DB_SKIP_INIT=1` silently disables all future migrations **[corroborated: full-stack, code engineer]**
The recommended production setting short-circuits `ready()` before the `schema_version` check and migration block (`src/db.js:351-355`), so the next shipped schema change never runs → runtime 500s on the new column. Rollbacks also ping-pong the version and replay ~50 DDL statements per cold start.
**Fix:** run migrations as an explicit deploy step, or make the skip flag still perform the cheap version check and run migrations once on mismatch; use forward-only comparison (`>=`).

### 6. Self-hosted deploys can fall back to the publicly-known session secret **[code engineer: high]**
The fail-closed guard only triggers when `VERCEL` or `NODE_ENV=production` is set. `npm start` on a VPS without `NODE_ENV` runs with `secret: 'dev-only-insecure-secret'` (in the public repo) — anyone can forge an admin cookie; cookies also ride plain HTTP in that path.
**Fix:** fail closed whenever `SESSION_SECRET` is unset unless an explicit `ALLOW_INSECURE_SECRET=1` dev flag is present.

---

## P1 — High

7. **Visit page (the core work screen) overflows the phone viewport** once tasks exist — tasks table pushes body width to ~441px; taps on "Complete job"/tab bar drift and mis-hit; the task-status `<select>` renders clipped ("penc…") at ~48px wide. **[corroborated: UX, Gary]** Fix: stack task rows on small screens; wrap visit-page tables in the existing `.table-wrap`.
8. **Photo pipeline won't scale:** up to 10MB originals served 50-per-page through the serverless function with no thumbnails; whole photos buffered in memory per request; the OneDrive job-completion archive triple-buffers all visit photos (~250MB+ possible in one invocation). **[full-stack]** Fix: generate thumbnails at upload (sharp); stream/loop archive uploads; move originals to the existing S3 mode.
   **Fixed:** every upload now generates a small 480px-wide JPEG thumbnail (`makeThumbnail()`, `src/upload.js`, via `sharp` — best-effort, falls back to no thumbnail on undecodable input); gallery/list views (`/photos`, visit photos, comment photos, issue photos) now point their `<img>` at a new `GET /uploads/:filename/thumb` route, which falls back to the full original when no thumbnail exists (old photos, or a format sharp couldn't decode); the `<a href>` around each thumbnail still opens the full original. The OneDrive archive (`archiveToOneDrive`, `src/report.js`) now inlines the small thumbnail (not the full original) in the self-contained report HTML, and uploads original files one at a time (a fresh per-photo query) instead of bulk-fetching every photo's bytes into memory at once — cutting peak memory from ~O(N × photo size) to ~O(1). Object-storage (S3) mode originals are now correctly fetched from the bucket for the OneDrive relay (previously would have uploaded empty placeholder bytes). Moving originals to S3 by default remains an opt-in deployment choice (`S3_BUCKET` + credentials), unchanged from before.
   Verified end-to-end against a real Postgres instance and a live HTTP server: a synthetic 4.8MB/3000×2250 JPEG uploaded through `POST /visits/:id/photos` produced a 9.4KB/480×360 thumbnail served correctly (with auth) from `/uploads/:filename/thumb`, while `/uploads/:filename` still serves the full original; the fresh-DB and v8→v9 upgrade migration paths were both exercised directly. Added `test/thumbnail.test.js` (8 sub-tests) covering resize, re-encode, no-upscale, and graceful-null-on-bad-input behavior.
   **Verified live:** confirmed on the production Vercel deployment (gardeningmgt.vercel.app) — an uploaded photo renders its thumbnail correctly, so `sharp`'s native binary loads fine in the serverless runtime.
9. **Static asset caching is accidentally disabled:** a global `Cache-Control: no-cache` set before `express.static` wins over the intended 7-day cache, making the whole `?v=assetVersion` design dead code — every page load revalidates CSS/JS/icons. **[full-stack]** Fix: scope `no-cache` to HTML; add immutable headers for static paths in vercel.json.
10. **Reminder cron can permanently lose sends:** rows are marked sent *before* delivery; a timeout mid-send means those reminders never go out. Backfill runs in the same invocation with no `maxDuration` configured. **[full-stack]** Fix: claim→deliver→confirm pattern; split backfill into its own cron; set `maxDuration`.
11. **Malformed date query params 500 across the app** (`/visits?from=notadate`, `/reports?from=bad`, CSV export — all verified). Any logged-in user, or a hand-edited link, triggers it. **[code engineer]** Fix: validate with the existing `isValidDate()` like `status` already is.
12. **Overdue visits are invisible on the dashboard** — yesterday's unfinished job only appears via Jobs → "Today & overdue". Both the admin monitoring the crew and the gardener planning their day miss slipped work. **[corroborated: Maria, UX]** Fix: include overdue visits (or a red "N overdue" banner) on Home.
13. **Issue reporting is backwards for field use:** no photo field on the report form (photo must be attached afterwards), no "report issue" entry point from the visit you're standing at, no link from issue back to visit. **[corroborated: Gary, UX]** Fix: file input on the create form; pre-filled "Report issue at this site" link on the visit page.
14. **Hours/payroll data is fiction when the timer is skipped:** manually-completed visits record 0 minutes; a forgotten timer runs 4h without a nudge; recorded time can't be corrected. Reports (and invoice labour lines) inherit the bad numbers. **[corroborated: Maria, Gary]** Fix: manual time entry/correction (staff-approved), long-running-timer nudge, flag 0-minute completed visits in reports.
15. **Money is stored as floating-point `REAL`** (invoice items, totals summed in both SQL and JS) — cent-level drift and "123.4500000001" renders. **[code engineer]** Fix: `NUMERIC(10,2)`.

---

## P2 — Medium

16. **No way for a gardener to skip an impossible job** — the server allows it; no UI exposes it. Locked gate = phone the office. **[UX]**
   **Fixed:** confirm-gated "Skip job" button on the visit page, posting to the existing status-skip gate (`views/visits/show.ejs`, `src/routes/visits.js`).
17. **"Optimize all routes" gives zero feedback** and silently reorders every gardener's day (including already-completed stops, which the per-day optimizer also reorders). **[UX]**
   **Fixed:** the redirect now always carries a count/mode summary (rendered regardless of `gardenerId`); reordering is pinned to only `scheduled` visits, leaving completed/in-progress stops' `route_order` untouched (`src/routes/routeplan.js`, `views/routes/index.ejs`).
18. **No calendar/bulk rescheduling** — a sick day means editing each visit individually; reassignment is buried in a collapsed "Manage job" panel. **[Maria]**
   **Scoped-down fix:** a multi-select bulk reassign/reschedule action on the existing Visits list (`POST /visits/bulk`, staff-only), not a calendar UI — per explicit scoping decision this round.
19. **Offline banner covers the sticky primary button** (~25px overlap over Start/Complete). **[corroborated: UX, Gary]**
   **Fixed:** the banner now measures `.mobile-sticky-cta`'s live bounding-box height and positions itself above it (`public/js/app.js`).
20. **Terminology tangle:** "Jobs" tab opens /visits, a visit is titled "Job #3", recurring contracts are "jobs" on a page called "Sites" at URL /jobs. **[UX]**
   **Fixed:** the Sites page (`views/jobs/index.ejs`) consistently calls the recurring booking a "contract"; the bottom-nav/sidebar "Jobs" label now reads "Visits" (`views/partials/header.ejs`); the per-visit browser-tab title, activity-log messages, notification text, and the invoice/photo-gallery cross-links that said "job #N" now consistently say "visit #N" (`src/routes/visits.js`, `src/report.js`, `src/routes/invoices.js`, `views/invoices/show.ejs`, `views/photos/index.ejs`) — this also fixed a pre-existing inconsistency where some of these messages already said "visit #N" and others said "job #N" for the exact same entity. Left as-is: colloquial phrasing like "Complete job"/"Start job"/"Manage job" buttons, which read naturally and aren't the identity collision being described here.
21. **Activity log has no search/filter** and drowns in sign-in noise; `notifications`/`activity_log` grow unbounded (the unread COUNT runs on every request). **[corroborated: Maria, full-stack]**
   **Fixed:** search/user/category filters on `views/admin/activity.ejs` (category derived via `split_part` on the action prefix); a scheduled `pruneOldRecords()` trims `activity_log` older than 1 year and read notifications older than 90 days (safety-net cap at 1 year regardless of read state) — `src/reminders.js`.
22. **PWA install is broken on iOS:** SVG-only icon (iOS needs PNG), non-conformant `purpose: "any maskable"`, no screenshots — the installed home-screen icon is blank. **[full-stack]**
   **Fixed:** real rasterized `icon-192.png`/`icon-512.png`/`icon-512-maskable.png`/`apple-touch-icon.png`, `manifest.json` now has separate `any`/`maskable` entries, `views/partials/header.ejs` points its apple-touch-icon link at the new PNG. (Screenshots still not added.)
23. **Photos failing magic-byte sniffing are silently discarded** — gardener believes the upload succeeded (may even be the photo gating completion). **[code engineer]**
   **Fixed:** failed sniffs now surface a `?error=badphoto` alert on the visit/issue photo and comment forms instead of failing silently (`src/routes/visits.js`, `src/routes/issues.js`).
24. **Naive TIMESTAMP columns assume a UTC DB session** — a non-UTC Postgres setting silently shifts every displayed time. **[code engineer]**
   **Fixed:** every pooled connection now runs `SET TIME ZONE 'UTC'` on connect (`src/db.js`), independent of the server's Postgres default.
25. **Pool exhaustion risk with direct DATABASE_URL** on serverless (max 3/instance × many instances vs ~100 connections). **[code engineer]**
   **Mitigated:** pool `max` tuned down further for the no-pooler Vercel case (3→2); the underlying architectural risk (many serverless instances × direct connections) remains — moving to a real connection pooler is still the complete fix.
26. **Observability is near-zero:** errors logged without method/URL/user/request-ID, no access logs, no health endpoint. **[full-stack]**
   **Fixed:** `GET /health` (pool `SELECT 1`), a `req.id`/`X-Request-Id` middleware, and error-handler logs now include method/URL/request-ID/user id (`src/server.js`).
27. **Env failure modes fail late:** missing DATABASE_URL falls back to localhost:5433 and 500s on first request; non-local DB without `DB_SSL_CA` runs unverified TLS silently. **[code engineer, full-stack]**
   **Fixed:** DATABASE_URL now fails closed at boot (mirroring the existing SESSION_SECRET guard); a warning is logged when `DB_SSL_CA` is absent on a non-local connection (`src/db.js`).
28. **GPS captured at page load, not at submit** — start position can be from wherever the page was opened; the dedicated ping endpoint has no client caller (route tracks are two-point lines). **[UX, full-stack]**
   **Fixed:** page-load GPS capture removed; a `refreshGpsForSubmit()` (3.5s timeout) runs at actual submit time, plus a periodic GPS ping wired to the existing ping endpoint while a visit is open (`public/js/app.js`).
29. **Dashboard order can disagree with the optimized route order**, and unrouted visits show a "–" in the stop badge. **[Gary, UI]**
   **Fixed:** unrouted visits now render a hollow `.route-no.unrouted` badge instead of "–" (`views/dashboard.ejs`, `public/css/style.css`); the dashboard's existing `ORDER BY COALESCE(route_order, 999), ...` was already consistent with the route page, so no query change was needed there.
30. **No client/billing record** — issues and invoices reference a property, not a person with email/billing address. **[Maria]**
   **Scoped-down fix:** a `contact_email` column on Properties (schema v8), surfaced on invoices/reports with `mailto:` links — not a new Clients entity, per explicit scoping decision this round.
31. **List pages execute their query twice (thrice on /visits)** via the COUNT pattern with correlated subqueries; fine today, linear cost growth. **[full-stack]**
   **Fixed:** `paginate()` (`src/pagination.js`) now rides a `COUNT(*) OVER()` window function on the same LIMIT/OFFSET query instead of running the whole query a second time just for the count — one round trip in the common case, falling back to a second query only when the requested page comes back empty (e.g. a stale `?page=` past the last page). `/visits` goes from three queries to two (the DISTINCT-date paginate call is now one query; the separate visit-row-count summary query is semantically different and still needed). Verified the row order and totals are unchanged against a real multi-page, multi-hundred-row dataset (both a plain ordered SELECT and the DISTINCT-date shape `/visits` uses), including the empty-page edge case; `test/pagination.test.js` rewritten for the new query shape.
32. **Spreadsheet import geocodes inline with sleeps** — can exceed the serverless time limit by design. **[full-stack]**
   **Fixed:** the batch-geocode logic was extracted into a shared `geocodeMissingBatch()` (`src/geocode.js`) and moved out of the synchronous import-request path; imports no longer geocode inline, and `POST /properties/geocode` is now the explicit, separately-invoked batch action.

---

## P3 — Low / polish

- **UI:** polished `.empty` component is dead code (bare "No invoices yet." paragraphs on ~8 pages); whole-row hover underlines through status pills on the dashboard; "Today & overdue" chip wraps into a tall oval at 390px; emoji used as icons (⚡✅📷⚙) against the SVG icon system; conflicting mobile H1 rules (1.9rem wins over intended 1.35rem); duplicated CSS "review fixes" layer redefining tokens/components; three different responsive-table breakpoints (640/700/767); ISO dates and lowercase select values leaking into UI; tiny "view job"/"Mark read" links and a small, confirm-less, green (not red) photo Delete. **[UI, Gary]**
   **Mostly fixed:** `.empty`/`.empty-icon` is now used across ~15 view files; the dashboard row-hover-underline bug is fixed; the mobile H1 conflict and the duplicated "review fixes" CSS layer are both cleaned up; table breakpoints consolidated to a single 767px; "view job"/"Mark read" are now proper `.btn.btn-sm` tap targets and the photo Delete link is now red (`.link-btn-danger`, confirm-gated).
   **Now fully fixed:** every remaining functional-icon emoji across all views and `public/js/app.js` (warning triangles, checkmarks, calendar/compass/pin/megaphone/download/refresh glyphs, etc.) converted to inline SVG matching the header's icon style — verified with a repo-wide scan that turned up zero remaining pictographic-emoji icons, leaving only the 🌱 brand mark (intentional branding, not a functional icon) and one glyph in the standalone/print job-completion report (`views/visits/report.ejs`, a separate self-contained document outside the interactive icon system). The "Today & overdue" chip's wrap-into-oval bug is fixed: removed the `flex:1`/equal-width split that squeezed its text onto two lines inside a 999px-radius pill at ≤600px, and added `white-space: nowrap` so chips now wrap onto a second *row* instead of wrapping *text* inside a pill. Audited every raw `<%= %>` output across all views for unformatted ISO dates/lowercase-with-underscore enum values — found one genuine bug (`invoice.due_at` rendered raw while its siblings `issued_at`/`paid_at` on the same line correctly used `fmtDate`/`fmtDateTime`) and fixed it; everywhere else already handled this correctly (`.replace('_',' ')` on status enums, `fmtDateTime`/`fmtDate` on timestamps) so there was nothing further to change.
- **Nav duplication:** More-sheet "My profile"/"Notifications" duplicate tab-bar "Me"/"Alerts" under different names. **[UX]**
   **Fixed:** both entries removed from the More sheet.
- **No "next stop" handoff** after completing a job. **[UX, Gary]**
   **Fixed:** a next-stop handoff card now renders on the visit page after completion.
- **Free-text time windows** accept any typo; one-off visit date doesn't default to today. **[UX]**
   **Fixed:** `pattern`/`title` HH:MM-HH:MM validation added to time-window inputs; one-off visit scheduling now defaults its date field to today.
- **Straight-line km** shown to gardeners ("7.1 km (straight-line)") isn't drive distance. **[Gary]**
   **Fixed:** reworded to "~X km straight-line (actual driving distance will be longer)".
- **Invoice numbers are globally sequential**, not per-year as the code comment claims. **[code engineer]**
   **Fixed:** a real per-year counter table (`invoice_number_counters`), atomically incremented via `INSERT ... ON CONFLICT ... RETURNING`; the old global sequence is kept only so already-issued numbers stay valid.
- **Sync bcrypt** blocks the event loop on self-hosted deploys. **[code engineer]**
   **Fixed:** `bcrypt.hashSync`/`compareSync` replaced with the async `bcrypt.hash`/`compare` throughout auth and admin user creation.
- **Reflected-referer redirect** in task status; `/gps` endpoint exempt from CSRF; visit `gardener_id` not role-validated (staff can assign visits to admins/inactive users). **[code engineer]**
   **Fixed:** task-status redirect now goes through a same-origin `safeRedirectBack()` allowlist; the `/gps` CSRF exemption was removed; visit create/update now validates `gardener_id` against active gardener-role users, mirroring `jobs.js`'s existing check.
- **Backup/export story:** visits-CSV only; no invoice/issue/photo export; pg_dump bloated by BYTEA photos. **[full-stack]**
   **Fixed:** added `GET /reports/export-invoices.csv` and `GET /reports/export-issues.csv` (same date-range/staff-only pattern as the existing visits CSV), with buttons on the Reports page. Added `npm run backup [output-dir]` (`scripts/backup.js`): a `pg_dump --exclude-table-data=photos` for the full schema and every table's data except photo bytes, plus a second file with the photos table's own metadata (filename/caption/visit-or-issue link/timestamps, with the image bytes replaced by an empty bytea) — so a routine backup isn't dominated by `photos.data`/`thumb_data`. Verified end-to-end: seeded a real photo, ran the backup, and fully restored both files into a fresh database with zero errors, confirming every non-photo table round-trips in full and the photo's metadata (not its bytes) comes back correctly. Documented in `README.md`; the actual image bytes still need either S3 storage mode (already supported) or an occasional full, uncensored `pg_dump` if you're not using S3.
- **Test-suite gaps:** the verified-good authz/IDOR gates, CSRF, and upload sniffing have zero CI coverage — correct today, unguarded against regression. **[code engineer]**
   **Fixed:** `test/integration/authz.test.js` (13 sub-tests against real Postgres, IDOR gates for visits/tasks/photos/staff-only pages), `test/integration/csrf.test.js` (4 sub-tests), `test/upload.test.js` (13 sub-tests on `sniffOk()` magic-byte checks).

---

## Suggested fix order

1. **Field-trust bundle (P0-1, 13, 14, 19):** offline draft protection + issue-form photo + timer corrections — this is what makes gardeners adopt the app.
2. **Office bundle (P0-2, P0-3, 18, 21, 30):** password reset/user editing + sendable invoices — what Maria needs to go live.
3. **Platform hardening (P0-4/5/6, 8–11, 15):** CSRF server-side rendering, migration strategy, session secret, photo thumbnails, static caching, cron delivery, date validation, NUMERIC money.
4. **Polish sweep (P2/P3 UI+UX items):** mostly small template/CSS diffs; the UI reviewer's H1–H3 and Gary's touch-target list give the exact files and lines.

Screenshot evidence: `scratchpad/ui-review/`, `ux-review/`, `admin-review/`, `gardener-review/`.
