const { q1 } = require('./db');

/** A session is valid for this long after sign-in, however often it's used. */
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The session cookie contents for a fresh sign-in. */
function newSession(user, now = Date.now()) {
  return { userId: user.id, sv: user.session_version || 0, iat: now };
}

async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  const s = req.session;
  // Signed cookies can't be deleted from the server, so a session also carries
  // when it was issued (absolute expiry) and the user's session version
  // (bumped to revoke every session of that user).
  const now = Date.now();
  if (s.iat != null && !(Number(s.iat) > now - SESSION_MAX_AGE_MS && Number(s.iat) <= now + 60000)) {
    req.session = null;
    return null;
  }
  // Fold the unread-notification count into the user lookup so every request
  // resolves the session in a single round-trip instead of two.
  const user = await q1(
    `SELECT id, name, email, role, phone, session_version,
       (SELECT COUNT(*)::int FROM notifications n WHERE n.user_id = u.id AND n.read_at IS NULL) AS unread_count
     FROM users u WHERE id = $1 AND active`,
    [s.userId]
  );
  if (!user || Number(s.sv || 0) !== Number(user.session_version || 0)) {
    req.session = null;
    return null;
  }
  // Sessions from before issue times were recorded: start their clock now.
  if (s.iat == null) req.session.iat = now;
  return user;
}

/** Sign a user out on every device (their existing session cookies stop working). */
async function revokeSessions(userId) {
  await q1('UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version', [userId]);
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

module.exports = { currentUser, newSession, revokeSessions, SESSION_MAX_AGE_MS, requireLogin, requireRole, isStaff };
