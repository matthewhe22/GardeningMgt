const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { q1 } = db;
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const { MAX_FAILS, throttleKey, recordAttempt, clearAttempts } = require('../loginThrottle');

const router = express.Router();

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
  const attemptCount = await recordAttempt(db, key);
  if (attemptCount > MAX_FAILS) {
    return res.status(429).render('login',
      { title: 'Sign in', error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const user = await q1('SELECT * FROM users WHERE email = $1 AND active', [normEmail]);
  // Async compare: bcrypt is deliberately slow, and the sync variant blocks
  // the single Node event loop for that whole duration on every login attempt.
  const passwordOk = await bcrypt.compare(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.' });
  }
  await clearAttempts(db, key);
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
