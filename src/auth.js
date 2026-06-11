const db = require('./db');

function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return db.prepare('SELECT id, name, email, role, phone FROM users WHERE id = ? AND active = 1')
    .get(req.session.userId) || null;
}

function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  res.locals.user = user;
  next();
}

/** requireRole('admin','supervisor') — admin always passes. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to do that.' });
  };
}

const isStaff = (user) => user.role === 'admin' || user.role === 'supervisor';

module.exports = { currentUser, requireLogin, requireRole, isStaff };
