// Who can see what. Admins and supervisors see and manage everything; a
// gardener only sees their own work — visits assigned to them, sites they
// look after, and issues tied to those.
const { q1 } = require('./db');
const { isStaff } = require('./auth');

/**
 * SQL condition: issue `alias` is visible to the gardener bound at `$n`.
 * Visible when they reported it, it's assigned to them, it came from one of
 * their visits, or it's at a site where they are the contract gardener or
 * have a visit.
 */
function gardenerIssueCond(alias, n) {
  return `(${alias}.reported_by = $${n} OR ${alias}.assigned_to = $${n}
    OR EXISTS (SELECT 1 FROM visits gv WHERE gv.id = ${alias}.visit_id AND gv.gardener_id = $${n})
    OR EXISTS (SELECT 1 FROM jobs gj WHERE gj.property_id = ${alias}.property_id AND gj.gardener_id = $${n})
    OR EXISTS (SELECT 1 FROM visits gv WHERE gv.property_id = ${alias}.property_id AND gv.gardener_id = $${n}))`;
}

/** SQL condition: property `col` is one of the gardener's ($n) sites. */
function gardenerPropertyCond(col, n) {
  return `(EXISTS (SELECT 1 FROM jobs gj WHERE gj.property_id = ${col} AND gj.gardener_id = $${n})
    OR EXISTS (SELECT 1 FROM visits gv WHERE gv.property_id = ${col} AND gv.gardener_id = $${n}))`;
}

async function canSeeIssue(user, issueId) {
  if (isStaff(user)) return true;
  if (!issueId) return false;
  const r = await q1(`SELECT 1 AS ok FROM issues i WHERE i.id = $1 AND ${gardenerIssueCond('i', 2)}`,
    [Number(issueId) || 0, user.id]);
  return !!r;
}

module.exports = { gardenerIssueCond, gardenerPropertyCond, canSeeIssue };
