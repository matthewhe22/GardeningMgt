const { q1 } = require('./db');

async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return q1(
    'SELECT id, name, email, role, phone FROM users WHERE id = $1 AND active',
    [req.session.userId]
  );
}

function requireLogin(req, res, next) {
  // res.locals.user is set for every request in server.js
  if (!res.locals.user) return res.redirect('/login');
  req.user = res.locals.user;
  next();
}

/** requireRole('supervisor') — admin always passes; no args = admin only. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to do that.' });
  };
}

const isStaff = (user) => user.role === 'admin' || user.role === 'supervisor';

module.exports = { currentUser, requireLogin, requireRole, isStaff };
