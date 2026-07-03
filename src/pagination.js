/** Shared LIMIT/OFFSET pagination for list views (visits, tasks, issues, etc). */

const PAGE_SIZE = 50;

function pageParam(req) {
  const p = parseInt(req.query.page, 10);
  return Number.isInteger(p) && p > 0 ? p : 1;
}

/**
 * Page a full SELECT (no LIMIT/OFFSET/trailing semicolon) via `q`. The same
 * query is wrapped as a subquery to compute a matching total count, so
 * callers don't have to hand-maintain a second near-duplicate WHERE clause
 * just to know how many pages there are.
 *
 * @param {Function} q query-all-rows helper (from db.js)
 * @param {string} sql a full SELECT ... ORDER BY ..., no LIMIT/OFFSET
 * @param {Array} args positional params referenced by `sql`
 * @param {number} page 1-indexed
 * @returns {{rows: Array, page: number, pageSize: number, total: number, totalPages: number}}
 */
async function paginate(q, sql, args, page, pageSize = PAGE_SIZE) {
  const offset = (page - 1) * pageSize;
  const [rows, countRows] = await Promise.all([
    q(`${sql} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, offset]),
    q(`SELECT COUNT(*)::int AS c FROM (${sql}) paginate_count`, args),
  ]);
  const total = countRows[0].c;
  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

module.exports = { PAGE_SIZE, pageParam, paginate };
