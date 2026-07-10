const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { q1, ready } = require('./db');
const { currentUser, requireLogin } = require('./auth');
const { sendRemindersForDate } = require('./reminders');
const { asyncHandler } = require('./asyncHandler');
const { csrfProtection } = require('./csrf');
const { today: businessToday } = require('./time');

const app = express();
const PORT = process.env.PORT || 3000;

// Fail closed: never run with the placeholder session secret outside local dev.
// A known secret lets anyone forge a signed admin cookie.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && (process.env.VERCEL || process.env.NODE_ENV === 'production')) {
  throw new Error('SESSION_SECRET must be set in production — refusing to start with a default secret.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Baseline security headers (no external CDNs, so a strict CSP is safe).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  if (process.env.VERCEL) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Signed cookie sessions: no server-side store, so login survives
// serverless cold starts and multiple instances.
app.use(cookieSession({
  name: 'gmgt',
  secret: SESSION_SECRET || 'dev-only-insecure-secret',
  httpOnly: true,
  sameSite: 'lax',
  secure: !!process.env.VERCEL,
  maxAge: 14 * 24 * 60 * 60 * 1000,
}));

// Ensure schema exists (no-op after first call), then resolve the user and
// unread notification count for every request. Both lookups key off the
// session's userId, so run them in parallel — one DB round trip of latency
// instead of two on every page.
app.use(asyncHandler(async (req, res, next) => {
  await ready();
  const userId = req.session && req.session.userId;
  const [user, unread] = userId
    ? await Promise.all([
        currentUser(req),
        q1('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]),
      ])
    : [null, null];
  res.locals.user = user;
  res.locals.unreadCount = user ? unread.c : 0;
  res.locals.currentPath = req.path;
  next();
}));

// Vercel Cron (or any scheduler) hits this daily; Vercel sends
// "Authorization: Bearer $CRON_SECRET" automatically when the env var is set.
// Fail closed: without a configured secret the endpoint is disabled.
app.get('/cron/reminders', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false });
  }
  const today = businessToday();
  const [sent, rolled] = [await sendRemindersForDate(today), await require('./reminders').backfillSchedules()];
  res.json({ ok: true, date: today, sent, rolled });
}));

// CSRF protection on all state-changing requests (after session is set up).
app.use(csrfProtection);

// Photos are stored in the database; stream them out by filename key.
app.get('/uploads/:filename', requireLogin, asyncHandler(async (req, res) => {
  const photo = await q1('SELECT mime, data FROM photos WHERE filename = $1', [req.params.filename]);
  if (!photo) return res.status(404).end();
  res.set('Content-Type', photo.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(photo.data);
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
  console.error(err);
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
