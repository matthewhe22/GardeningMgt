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
  // The cron endpoint is authenticated by its bearer secret instead, not a
  // session/CSRF token. GPS pings used to be exempted here too ("no form,
  // same-user low-risk"), but there's no real reason a JSON POST from an
  // authenticated session shouldn't carry the same token as every other
  // state-changing request — window.CSRF_TOKEN is already exposed in
  // app.js for exactly this kind of fetch()-based caller.
  if (req.path.startsWith('/cron/')) return next();
  // Multipart bodies aren't parsed yet here, so the token rides in the query
  // string (app.js appends ?_csrf=… to multipart form actions). Validating it
  // now rejects forged cross-site uploads BEFORE multer buffers megabytes of
  // files into memory.
  // (Routes still call assertCsrf() after multer as defence in depth.)
  try { assertCsrf(req); return next(); }
  catch (err) { return next(err); }
}

/** Throw EBADCSRFTOKEN unless req carries a valid token (body/query/header). */
function assertCsrf(req) {
  const sent = req.body?._csrf || req.query?._csrf || req.get('X-CSRF-Token');
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
