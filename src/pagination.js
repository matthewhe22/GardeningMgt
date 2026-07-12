/** Shared LIMIT/OFFSET pagination for list views (visits, tasks, issues, etc). */

const PAGE_SIZE = 50;

function pageParam(req) {
  const p = parseInt(req.query.page, 10);
  return Number.isInteger(p) && p > 0 ? p : 1;
}

/**
 * Page a full SELECT (no LIMIT/OFFSET/trailing semicolon) via `q`. The page
 * of rows and the matching total count come back from a single query — a
 * `COUNT(*) OVER()` window function riding along on the same LIMIT/OFFSET
 * pass — instead of running the whole query twice, so callers don't have to
 * hand-maintain a second near-duplicate WHERE clause just to know how many
 * pages there are. The window function doesn't reorder rows (no PARTITION/
 * ORDER BY on the OVER() clause), so the inner SQL's own ORDER BY still
 * determines the page's row order.
 *
 * @param {Function} q query-all-rows helper (from db.js)
 * @param {string} sql a full SELECT ... ORDER BY ..., no LIMIT/OFFSET
 * @param {Array} args positional params referenced by `sql`
 * @param {number} page 1-indexed
 * @returns {{rows: Array, page: number, pageSize: number, total: number, totalPages: number}}
 */
async function paginate(q, sql, args, page, pageSize = PAGE_SIZE) {
  const offset = (page - 1) * pageSize;
  const rows = await q(
    `SELECT paginate_t.*, COUNT(*) OVER()::int AS __paginate_total
     FROM (${sql}) paginate_t
     LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, pageSize, offset]
  );
  let total;
  if (rows.length) {
    total = rows[0].__paginate_total;
    for (const r of rows) delete r.__paginate_total;
  } else {
    // LIMIT/OFFSET produced no rows on this page (typically a stale/
    // out-of-range ?page= past the last one) — COUNT(*) OVER() has nothing
    // to ride along on in that case, so fall back to a plain count query
    // just for this rare edge case.
    const countRows = await q(`SELECT COUNT(*)::int AS c FROM (${sql}) paginate_count`, args);
    total = countRows[0].c;
  }
  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

module.exports = { PAGE_SIZE, pageParam, paginate };
