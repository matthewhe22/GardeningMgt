const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { logActivity } = require('../activity');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.' });
  }
  req.session.userId = user.id;
  logActivity(user.id, 'auth.login', 'user', user.id, `${user.name} signed in`);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  const id = req.session.userId;
  req.session.destroy(() => {
    if (id) logActivity(id, 'auth.logout', 'user', id, 'Signed out');
    res.redirect('/login');
  });
});

module.exports = router;
