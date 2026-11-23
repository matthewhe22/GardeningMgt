/**
 * Stateless, signed "upload tickets" for direct-to-bucket photo uploads.
 *
 * The presign step hands the browser a ticket naming exactly which object it
 * may finalize, for which job, user and checklist item/task, until when. The
 * finalize step only trusts what the ticket says (HMAC-checked), so the
 * browser can't finalize someone else's object or re-target a photo — and no
 * pending-upload table is needed (serverless friendly).
 */
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret';
const TTL_MS = 30 * 60 * 1000; // presigned PUT is 10 min; leave room to finalize a slow upload

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => b64(crypto.createHmac('sha256', SECRET).update(`upload-ticket:${payload}`).digest());

function issue(fields, now = Date.now()) {
  const payload = b64(JSON.stringify({ ...fields, exp: now + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/** The ticket's fields, or null if it's malformed, tampered with or expired. */
function verify(ticket, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 2000) return null;
  const [payload, sig] = ticket.split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!data || typeof data.exp !== 'number' || data.exp < now) return null;
  return data;
}

module.exports = { issue, verify, TTL_MS };
