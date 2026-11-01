/**
 * Scope of duties: the standard checklist an admin defines per recurring job
 * (max 20 items, each with an optional reference "standard" photo), and the
 * per-visit checklist a gardener fills in (tick, photos, comment).
 */
const { q, q1 } = require('./db');

const MAX_SCOPES = 20;

/** Visit statuses after which the checklist is frozen. */
const LOCKED = ['completed', 'approved'];

/** Job scope items with their standard photo (if any), in order. */
function loadJobScopes(jobId) {
  return q(`
    SELECT s.*,
      (SELECT ph.filename FROM photos ph WHERE ph.job_scope_id = s.id
        ORDER BY ph.created_at DESC LIMIT 1) AS standard_photo
    FROM job_scopes s WHERE s.job_id = $1 ORDER BY s.position, s.id`, [jobId]);
}

/**
 * Bring a visit's checklist in line with its job's current scope:
 * add rows for new items, refresh titles/order, and drop untouched rows whose
 * scope item was deleted. No-op once the visit is completed/approved, so the
 * submitted record is never rewritten.
 */
async function syncChecks(visit) {
  if (!visit.job_id || LOCKED.includes(visit.status)) return;
  await q(`
    INSERT INTO visit_scope_checks (visit_id, scope_id, position, title)
    SELECT $1, s.id, s.position, s.title FROM job_scopes s WHERE s.job_id = $2
    ON CONFLICT (visit_id, scope_id) DO UPDATE
      SET title = EXCLUDED.title, position = EXCLUDED.position`, [visit.id, visit.job_id]);
  await q(`
    DELETE FROM visit_scope_checks c
    WHERE c.visit_id = $1 AND c.scope_id IS NULL AND NOT c.done
      AND c.comment IS NULL
      AND NOT EXISTS (SELECT 1 FROM photos ph WHERE ph.scope_check_id = c.id)`, [visit.id]);
}

/** A visit's checklist rows, each with .photos and the standard photo. */
async function loadChecks(visitId) {
  const checks = await q(`
    SELECT c.*, u.name AS checked_by_name,
      (SELECT ph.filename FROM photos ph WHERE ph.job_scope_id = c.scope_id
        ORDER BY ph.created_at DESC LIMIT 1) AS standard_photo
    FROM visit_scope_checks c LEFT JOIN users u ON u.id = c.checked_by
    WHERE c.visit_id = $1 ORDER BY c.position, c.id`, [visitId]);
  if (!checks.length) return checks;
  const photos = await q(`
    SELECT id, filename, mime, created_at, scope_check_id FROM photos
    WHERE scope_check_id = ANY($1) ORDER BY created_at`, [checks.map((c) => c.id)]);
  const by = {};
  for (const ph of photos) (by[ph.scope_check_id] ||= []).push(ph);
  for (const c of checks) c.photos = by[c.id] || [];
  return checks;
}

/**
 * An item is "resolved" when ticked done, or left unticked with a comment
 * explaining why (e.g. "time clock didn't need adjusting").
 */
const isResolved = (c) => c.done || !!(c.comment && c.comment.trim());

module.exports = { MAX_SCOPES, LOCKED, loadJobScopes, syncChecks, loadChecks, isResolved };
