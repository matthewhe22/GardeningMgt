/**
 * Global scope library + templates ("Standard 1", "Standard 2", ...).
 *
 * A template is a chosen subset of the library (max 20 items). Applying it
 * to a site's job makes the job's scope exactly the template's items, linked
 * to the library (job_scopes.library_id), and records jobs.template_id. Jobs
 * that follow a template (not individually customized) are re-synced
 * whenever the template or the library changes, so the admin maintains the
 * standard in one place. Standard photos come from the library item unless a
 * site-specific photo was uploaded for that job.
 *
 * Applying is a diff, not delete+insert: existing job_scopes rows keep their
 * ids, so a gardener's in-progress checklist (keyed by scope id) keeps its
 * ticks, photos and comments.
 */
const { withTransaction } = require('./db');

/** Template items in library order. */
const templateItems = (tx, templateId) => tx.q(`
  SELECT l.id, l.title, l.position FROM scope_template_items ti
  JOIN scope_library l ON l.id = ti.library_id
  WHERE ti.template_id = $1 ORDER BY l.position, l.id`, [templateId]);

/** Make one job's scope match a template (inside a transaction). */
async function applyToJob(tx, templateId, jobId) {
  const items = await templateItems(tx, templateId);
  const ids = items.map((i) => i.id);
  // Drop items not in the template (library-linked or site-specific).
  await tx.q(`DELETE FROM job_scopes WHERE job_id = $1
              AND (library_id IS NULL OR NOT (library_id = ANY($2::int[])))`, [jobId, ids]);
  for (const it of items) {
    const upd = await tx.q1(`UPDATE job_scopes SET title = $3, position = $4
                             WHERE job_id = $1 AND library_id = $2 RETURNING id`, [jobId, it.id, it.title, it.position]);
    if (!upd) {
      await tx.q('INSERT INTO job_scopes (job_id, library_id, title, position) VALUES ($1, $2, $3, $4)',
        [jobId, it.id, it.title, it.position]);
    }
  }
  await tx.q('UPDATE jobs SET template_id = $1, scope_customized = false WHERE id = $2', [templateId, jobId]);
  return items.length;
}

/** Apply a template to many jobs; returns how many jobs were updated. */
async function applyTemplate(templateId, jobIds) {
  return withTransaction(async (tx) => {
    let n = 0;
    for (const jobId of jobIds) { await applyToJob(tx, templateId, jobId); n++; }
    return n;
  });
}

/**
 * Re-sync every job that follows a template and hasn't been customized.
 * Pass a templateId to limit it to one template.
 */
async function resyncFollowers(templateId = null) {
  return withTransaction(async (tx) => {
    const jobs = await tx.q(`SELECT id, template_id FROM jobs
      WHERE template_id IS NOT NULL AND NOT scope_customized
        AND ($1::int IS NULL OR template_id = $1)`, [templateId]);
    for (const j of jobs) await applyToJob(tx, j.template_id, j.id);
    return jobs.length;
  });
}

module.exports = { applyToJob, applyTemplate, resyncFollowers };
