const express = require('express');
const bcrypt = require('bcryptjs');
const { q1 } = require('../db');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null });
});

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await q1('SELECT * FROM users WHERE email = $1 AND active',
    [(email || '').trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.' });
  }
  req.session.userId = user.id;
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
