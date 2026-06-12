const express = require('express');
const bcrypt = require('bcryptjs');
const { q1 } = require('../db');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

// In-memory login throttle: max 8 failures per IP+email per 15 min window.
// Good enough for a single-region deploy; swap for a store-backed limiter at scale.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
function throttleKey(req, email) {
  return `${req.ip}|${email}`;
}
function tooMany(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_FAILS;
}
function recordFail(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else rec.count += 1;
}

router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null });
});

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normEmail = (email || '').trim().toLowerCase();
  const key = throttleKey(req, normEmail);
  if (tooMany(key)) {
    return res.status(429).render('login',
      { title: 'Sign in', error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const user = await q1('SELECT * FROM users WHERE email = $1 AND active', [normEmail]);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    recordFail(key);
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.' });
  }
  attempts.delete(key);
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
