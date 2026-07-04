const express = require('express');
const bcrypt = require('bcryptjs');
const { q, q1 } = require('../db');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

// Login throttle: max 8 failures per IP+email per 15 min window, backed by
// the login_attempts table (not an in-process Map) so the limit actually
// holds across the many concurrent serverless instances a deploy scales to.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
// Rows older than this are long past any throttle window and just dead
// weight (e.g. a scan through many throwaway emails from one IP) — purged
// opportunistically rather than on every request.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function throttleKey(req, email) {
  return `${req.ip}|${email}`;
}

/**
 * Atomically increment (or reset, if the previous window has expired) the
 * attempt count for `key` and return the post-increment count, in one
 * statement — so a burst of concurrent requests for the same key can't all
 * read a stale "not yet throttled" count before any of them commits. The
 * row lock on the UPSERT serializes concurrent callers, so each gets a
 * distinct, strictly increasing count; the Nth request truly sees N, not a
 * stale pre-burst value. All window-expiry math runs in Postgres via now(),
 * never a JS Date, so it can't drift with the app server's local timezone.
 */
async function recordAttempt(key) {
  const { count } = await q1(`
    INSERT INTO login_attempts (key, count, first_at) VALUES ($1, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count    = CASE WHEN now() - login_attempts.first_at > interval '${WINDOW_MS} milliseconds'
                       THEN 1 ELSE login_attempts.count + 1 END,
      first_at = CASE WHEN now() - login_attempts.first_at > interval '${WINDOW_MS} milliseconds'
                       THEN now() ELSE login_attempts.first_at END
    RETURNING count
  `, [key]);
  if (Math.random() < 0.01) {
    q(`DELETE FROM login_attempts WHERE first_at < now() - interval '${STALE_AFTER_MS} milliseconds'`).catch(() => {});
  }
  return count;
}
async function clearAttempts(key) {
  await q('DELETE FROM login_attempts WHERE key = $1', [key]);
}

// A bcrypt hash of no real password, compared against on every login attempt
// for an email that doesn't exist — so failed logins cost the same either
// way and response timing can't be used to enumerate registered emails.
const DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null });
});

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normEmail = (email || '').trim().toLowerCase();
  const key = throttleKey(req, normEmail);
  const attemptCount = await recordAttempt(key);
  if (attemptCount > MAX_FAILS) {
    return res.status(429).render('login',
      { title: 'Sign in', error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const user = await q1('SELECT * FROM users WHERE email = $1 AND active', [normEmail]);
  const passwordOk = bcrypt.compareSync(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.' });
  }
  await clearAttempts(key);
  // Rotate session on login to prevent fixation.
  req.session = { userId: user.id };
  await logActivity(user.id, 'auth.login', 'user', user.id, `${user.name} signed in`);
  res.redirect('/');
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const id = req.session.userId;
  req.session = null;
  if (id) await logActivity(id, 'auth.logout', 'user', id, 'Signed out');
  res.redirect('/login');
}));

module.exports = router;
