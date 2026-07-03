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
function throttleKey(req, email) {
  return `${req.ip}|${email}`;
}
async function tooMany(key) {
  const rec = await q1('SELECT count, first_at FROM login_attempts WHERE key = $1', [key]);
  if (!rec) return false;
  if (Date.now() - new Date(rec.first_at).getTime() > WINDOW_MS) return false;
  return rec.count >= MAX_FAILS;
}
async function recordFail(key) {
  await q(`
    INSERT INTO login_attempts (key, count, first_at) VALUES ($1, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count    = CASE WHEN now() - login_attempts.first_at > interval '${WINDOW_MS} milliseconds'
                       THEN 1 ELSE login_attempts.count + 1 END,
      first_at = CASE WHEN now() - login_attempts.first_at > interval '${WINDOW_MS} milliseconds'
                       THEN now() ELSE login_attempts.first_at END
  `, [key]);
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
  if (await tooMany(key)) {
    return res.status(429).render('login',
      { title: 'Sign in', error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const user = await q1('SELECT * FROM users WHERE email = $1 AND active', [normEmail]);
  const passwordOk = bcrypt.compareSync(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    await recordFail(key);
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
