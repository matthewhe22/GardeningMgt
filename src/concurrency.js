/** Generic bounded-concurrency helper shared by route handlers that fan out
 * async work (e.g. calling an external API once per item). */

/**
 * Run async `fn` over `items` with at most `limit` in flight at once —
 * avoids both a fully-serial loop (slow, risks a serverless timeout with
 * many items) and unbounded Promise.all (impolite to a shared external
 * service, and unbounded concurrency in general).
 * @returns {Promise<Array>} results in the same order as `items`.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapWithConcurrency };
