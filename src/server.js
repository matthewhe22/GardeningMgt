const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { q1, pool, ready } = require('./db');
const { currentUser, requireLogin, isStaff } = require('./auth');
const { sendRemindersForDate, pruneOldRecords } = require('./reminders');
const { asyncHandler } = require('./asyncHandler');
const { csrfProtection } = require('./csrf');
const storage = require('./storage');
const { today: businessToday, fmtDateTime, fmtDate } = require('./time');

const app = express();
const PORT = process.env.PORT || 3000;

// A per-deploy version string used to cache-bust the static asset URLs
// (/css/style.css?v=…). It lets us cache those files aggressively in the
// browser while still picking up CSS/JS changes immediately after a deploy.
// Changes on every Vercel deploy (commit SHA) and on every local restart.
const ASSET_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);
app.locals.assetVersion = ASSET_VERSION;

// Fail closed: never run with the placeholder session secret. The old check
// only fired when VERCEL or NODE_ENV=production was set, so `npm start` on a
// plain VPS/server (a supported deployment per reminders.js's doc comment)
// silently fell through to a literal string sitting in the public repo —
// anyone can forge a signed `gmgt` session cookie for the bootstrap admin
// with it. Require an explicit opt-in (ALLOW_INSECURE_SECRET=1) for local dev
// instead of trying to infer "is this production" from the environment.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.ALLOW_INSECURE_SECRET !== '1') {
  throw new Error(
    'SESSION_SECRET must be set — refusing to start with the default insecure secret. ' +
    'Set SESSION_SECRET to a long random string, or set ALLOW_INSECURE_SECRET=1 for local dev only.'
  );
}
// Any production deploy serves HTTPS-only, not just Vercel's — used to lock
// the session cookie and HSTS to HTTPS regardless of host.
const isProdHttps = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view cache', true); // compile each template once, not on every render
app.set('trust proxy', 1);
app.disable('x-powered-by');

// A short random ID per request, attached as early as possible and echoed
// back in a response header, so a user's bug report ("it broke around 3pm")
// can be correlated to the exact log line the error handler below writes.
app.use((req, res, next) => {
  req.id = crypto.randomBytes(4).toString('hex');
  res.set('X-Request-Id', req.id);
  next();
});

// Unauthenticated liveness/readiness probe: confirms the process can actually
// reach the database, not just that Express is listening — a plain "server
// up" check would miss a database outage entirely. No auth needed: nothing
// here is sensitive, and a load balancer/uptime checker won't carry a session
// cookie. Mounted before the session/CSRF/auth-requiring routes below.
app.get('/health', asyncHandler(async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    console.error(`[health] db check failed (request ${req.id}):`, e.message);
    res.status(503).json({ ok: false });
  }
}));

// Baseline security headers. The only external origin is the OpenStreetMap
// tile server, used for the job-location map snapshot (img-src only).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; " +
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  if (isProdHttps) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Cache static assets in the browser for a week. CSS/JS are cache-busted by
// the ?v=<assetVersion> query string, so a long lifetime never serves stale
// files after a deploy; icons/manifest change rarely.
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

// Rendered HTML pages must always be revalidated so a deploy shows up
// immediately instead of being served stale from the browser cache. This must
// come AFTER express.static: serve-static only sets its own Cache-Control
// header when the response doesn't already have one, so setting `no-cache`
// any earlier (e.g. in the security-headers middleware above) silently wins
// over static's `maxAge: '7d'` for every static asset too, defeating the
// ?v=<assetVersion> cache-busting design entirely. Static hits short-circuit
// the request and never reach middleware mounted after them, so this only
// ever fires for dynamic routes — /uploads overrides it with its own
// long-lived caching.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});

// Signed cookie sessions: no server-side store, so login survives
// serverless cold starts and multiple instances.
app.use(cookieSession({
  name: 'gmgt',
  secret: SESSION_SECRET || 'dev-only-insecure-secret',
  httpOnly: true,
  sameSite: 'lax',
  secure: isProdHttps,
  maxAge: 14 * 24 * 60 * 60 * 1000,
}));

// Ensure schema exists (no-op after first call), then resolve the user and
// unread notification count for every request. Both lookups key off the
// session's userId, so run them in parallel — one DB round trip of latency
// instead of two on every page.
app.use(asyncHandler(async (req, res, next) => {
  await ready();
  const user = await currentUser(req);
  res.locals.user = user;
  res.locals.unreadCount = user ? user.unread_count : 0;
  res.locals.currentPath = req.path;
  // Timestamp formatters for views (render every time in the business timezone).
  res.locals.fmtDateTime = fmtDateTime;
  res.locals.fmtDate = fmtDate;
  // Build a link to another page of the current list, keeping every other
  // filter/search query param as-is — used by the shared pagination partial.
  // req.path is relative to the mounting router (e.g. "/" for GET /visits),
  // so use originalUrl's pathname to get the real route path.
  res.locals.pageUrl = (page) => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(page));
    return `${req.originalUrl.split('?')[0]}?${params.toString()}`;
  };
  next();
}));

// Vercel Cron (or any scheduler) hits this daily; Vercel sends
// "Authorization: Bearer $CRON_SECRET" automatically when the env var is set.
// Fail closed: without a configured secret the endpoint is disabled.
// Scheduled at 20:00 UTC (vercel.json) ≈ 06:00 Melbourne (AEST) / 07:00 (AEDT);
// Vercel cron is UTC-only, so the exact local time drifts ±1h across DST.
app.get('/cron/reminders', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false });
  }
  const today = businessToday();
  const [sent, rolled] = [await sendRemindersForDate(today), await require('./reminders').backfillSchedules()];
  const pruned = await pruneOldRecords();
  // Geocode a bounded batch of properties still missing coordinates (e.g.
  // from a spreadsheet import that intentionally skipped geocoding inline —
  // see routes/admin.js). Rate-limited the same as the manual "Find missing
  // coordinates" button; running daily via cron means a large import fills in
  // over a few days without ever risking a request timeout.
  const { geocodeMissingBatch } = require('./geocode');
  const geocoded = await geocodeMissingBatch(Number(process.env.GEOCODE_BATCH || 5));
  res.json({ ok: true, date: today, sent, rolled, pruned, geocoded });
}));

// CSRF protection on all state-changing requests (after session is set up).
app.use(csrfProtection);

// Photos are stored in the database; stream them out by filename key.
// Access mirrors the gallery's visibility rules so a gardener can't read
// another gardener's private visit photos by guessing the filename: staff see
// everything; everyone else sees shared photos, their own uploads, photos on a
// visit assigned to them, and any issue photo (issues are team-wide).
function photoAllowed(u, photo) {
  return isStaff(u) || photo.shared || photo.uploaded_by === u.id
    || photo.gardener_id === u.id || photo.issue_id != null;
}

app.get('/uploads/:filename', requireLogin, asyncHandler(async (req, res) => {
  const photo = await q1(`
    SELECT ph.mime, ph.data, ph.shared, ph.uploaded_by, ph.issue_id, v.gardener_id
    FROM photos ph LEFT JOIN visits v ON v.id = ph.visit_id
    WHERE ph.filename = $1`, [req.params.filename]);
  if (!photo) return res.status(404).end();
  if (!photoAllowed(res.locals.user, photo)) return res.status(404).end();
  res.set('Content-Type', photo.mime);
  // Filenames are unique, immutable content keys, so the browser can keep them
  // for a long time and never re-fetch — repeat photo views become instant.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  // Photos stored in object storage keep an empty `data` buffer — stream those
  // from the bucket (through the function, so the auth check above still gates
  // access); inline bytes are sent directly.
  if (storage.enabled() && photo.data && photo.data.length === 0) {
    try {
      const body = await storage.getObjectStream(req.params.filename);
      body.on('error', () => { if (!res.headersSent) res.status(502).end(); });
      return body.pipe(res);
    } catch (e) {
      return res.status(404).end();
    }
  }
  res.send(photo.data);
}));

// Small JPEG generated at upload (src/upload.js) for gallery/list views, so
// those pages stop serving up-to-10MB originals as thumbnails. Falls back to
// the full original for photos uploaded before this existed, or where sharp
// couldn't decode the source format — callers can always point an <img> at
// this URL and get the best available image.
app.get('/uploads/:filename/thumb', requireLogin, asyncHandler(async (req, res) => {
  const photo = await q1(`
    SELECT ph.thumb_data, ph.shared, ph.uploaded_by, ph.issue_id, v.gardener_id
    FROM photos ph LEFT JOIN visits v ON v.id = ph.visit_id
    WHERE ph.filename = $1`, [req.params.filename]);
  if (!photo) return res.status(404).end();
  if (!photoAllowed(res.locals.user, photo)) return res.status(404).end();
  if (!photo.thumb_data || photo.thumb_data.length === 0) {
    return res.redirect(`/uploads/${encodeURIComponent(req.params.filename)}`);
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(photo.thumb_data);
}));

app.use('/', require('./routes/auth'));
app.use('/', requireLogin, require('./routes/dashboard'));
app.use('/profile', requireLogin, require('./routes/profile'));
app.use('/visits', requireLogin, require('./routes/visits'));
app.use('/jobs', requireLogin, require('./routes/jobs'));
app.use('/tasks', requireLogin, require('./routes/tasks'));
app.use('/issues', requireLogin, require('./routes/issues'));
app.use('/photos', requireLogin, require('./routes/photos'));
app.use('/routes', requireLogin, require('./routes/routeplan'));
app.use('/invoices', requireLogin, require('./routes/invoices'));
app.use('/reports', requireLogin, require('./routes/reports'));
app.use('/notifications', requireLogin, require('./routes/notifications'));
app.use('/admin', requireLogin, require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});
app.use((err, req, res, next) => {
  const who = req.user && req.user.id;
  console.error(`[error] ${req.method} ${req.originalUrl} reqId=${req.id || '-'} user=${who != null ? who : '-'}:`, err);
  // Friendly message for oversized/invalid uploads (multer) instead of a blank 500.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).render('error', { title: 'File too large', message: 'Each photo must be under 10 MB.' });
  }
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', { title: 'Session expired', message: 'Please go back and try again.' });
  }
  const status = err.status || 500;
  res.status(status).render('error', { title: 'Error', message: 'Something went wrong. Please try again.' },
    (renderErr, html) => {
      if (renderErr) return res.type('text/plain').send('Something went wrong.');
      res.send(html);
    });
});

if (require.main === module) {
  const { startReminderScheduler } = require('./reminders');
  startReminderScheduler();
  app.listen(PORT, () => console.log(`GardeningMgt running on http://localhost:${PORT}`));
}

module.exports = app;
