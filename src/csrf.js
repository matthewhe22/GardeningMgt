const crypto = require('crypto');

/**
 * Stateless double-submit CSRF protection for cookie-session.
 * A random token is stored in the (signed, httpOnly) session and must be
 * echoed back in a hidden `_csrf` form field (or X-CSRF-Token header) on
 * every state-changing request. res.locals.csrfToken is exposed to views.
 */
function csrfProtection(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrf;

  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (safe) return next();
  // Background JSON GPS pings carry no form and are same-user low-risk; the
  // cron endpoint is authenticated by its bearer secret instead.
  if (/\/gps$/.test(req.path) || req.path.startsWith('/cron/')) return next();
  // Multipart bodies aren't parsed yet here — those routes call assertCsrf()
  // after multer has populated req.body._csrf.
  if ((req.get('content-type') || '').startsWith('multipart/form-data')) return next();

  try { assertCsrf(req); return next(); }
  catch (err) { return next(err); }
}

/** Throw EBADCSRFTOKEN unless req carries a valid token (body/header). */
function assertCsrf(req) {
  const sent = req.body?._csrf || req.get('X-CSRF-Token');
  if (sent && typeof sent === 'string' && req.session?.csrf && safeEqual(sent, req.session.csrf)) return;
  const err = new Error('Invalid CSRF token');
  err.code = 'EBADCSRFTOKEN';
  err.status = 403;
  throw err;
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { csrfProtection, assertCsrf };
