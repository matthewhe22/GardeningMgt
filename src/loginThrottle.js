/**
 * DB-backed login brute-force throttle, keyed by "ip|email". Backed by the
 * login_attempts table (not an in-process Map) so the limit actually holds
 * across the many concurrent serverless instances a deploy scales to.
 *
 * `q`/`q1` are always passed in explicitly (rather than imported from db.js
 * directly) so this logic — and the SQL it builds — can be unit tested with
 * a fake in-memory query function, no live Postgres needed.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
// Rows older than this are long past any throttle window and just dead
// weight (e.g. a scan through many throwaway emails from one IP) — purged
// opportunistically rather than on every request.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function throttleKey(req, email) {
  return `${req.ip}|${email}`;
}

/**
 * Atomically increment (or reset, if the previous window has expired) the
 * attempt count for `key` and return the post-increment count, in one
 * statement — so a burst of concurrent requests for the same key can't all
 * read a stale "not yet throttled" count before any of them commits. The
 * row lock on the UPSERT serializes concurrent callers, so each gets a
 * distinct, strictly increasing count; the Nth request truly sees N, not a
 * stale pre-burst value. All window-expiry math runs in Postgres via now(),
 * never a JS Date, so it can't drift with the app server's local timezone.
 *
 * @param {{q: Function, q1: Function}} db query helpers (from db.js)
 * @param {string} key
 * @returns {Promise<number>} the post-increment attempt count
 */
async function recordAttempt({ q, q1 }, key) {
  const { count } = await q1(`
    INSERT INTO login_attempts (key, count, first_at) VALUES ($1, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count    = CASE WHEN now() - login_attempts.first_at > interval '${WINDOW_MS} milliseconds'
                       THEN 1 ELSE login_attempts.count + 1 END,
      first_at = CASE WHEN now() - login_attempts.first_at > interval '${WINDOW_MS} milliseconds'
                       THEN now() ELSE login_attempts.first_at END
    RETURNING count
  `, [key]);
  if (Math.random() < 0.01) {
    q(`DELETE FROM login_attempts WHERE first_at < now() - interval '${STALE_AFTER_MS} milliseconds'`).catch(() => {});
  }
  return count;
}

async function clearAttempts({ q }, key) {
  await q('DELETE FROM login_attempts WHERE key = $1', [key]);
}

module.exports = { WINDOW_MS, MAX_FAILS, STALE_AFTER_MS, throttleKey, recordAttempt, clearAttempts };
