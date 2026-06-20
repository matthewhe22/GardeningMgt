// Run best-effort work that should not block the HTTP response.
//
// On Vercel, fire-and-forget promises can be frozen/killed once the response is
// sent, so we hand the promise to `waitUntil` (from @vercel/functions) which
// keeps the serverless invocation alive until it settles. Off Vercel (local
// `npm start`) the promise simply runs on the event loop. Errors are always
// swallowed and logged — callers use this only for non-critical side effects.

let waitUntil = null;
try { ({ waitUntil } = require('@vercel/functions')); } catch (_) { /* not installed / not on Vercel */ }

function runInBackground(task, label = 'task') {
  const p = Promise.resolve()
    .then(() => (typeof task === 'function' ? task() : task))
    .catch((e) => console.error(`[background] ${label} failed:`, e && e.message));
  if (waitUntil) {
    try { waitUntil(p); } catch (_) { /* outside a request context — let it run on the loop */ }
  }
  return p;
}

module.exports = { runInBackground };
