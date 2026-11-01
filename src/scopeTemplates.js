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
  // Serialize concurrent applies/resyncs of the same job.
  await tx.q('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
  const items = await templateItems(tx, templateId);
  const ids = items.map((i) => i.id);
  // Drop items not in the template (library-linked or site-specific).
  await tx.q(`DELETE FROM job_scopes WHERE job_id = $1
              AND (library_id IS NULL OR NOT (library_id = ANY($2::int[])))`, [jobId, ids]);
  for (const it of items) {
    await tx.q(`
      INSERT INTO job_scopes (job_id, library_id, title, position) VALUES ($1, $2, $3, $4)
      ON CONFLICT (job_id, library_id) WHERE library_id IS NOT NULL
      DO UPDATE SET title = EXCLUDED.title, position = EXCLUDED.position`,
      [jobId, it.id, it.title, it.position]);
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
async function resyncFollowers(templateId = null, { libraryId = null } = {}) {
  return withTransaction(async (tx) => {
    // Limit to one template, or to templates containing one library item, or
    // (libraryId deleted → its template rows are gone) jobs still holding it.
    const jobs = await tx.q(`SELECT j.id, j.template_id FROM jobs j
      WHERE j.template_id IS NOT NULL AND NOT j.scope_customized
        AND ($1::int IS NULL OR j.template_id = $1)
        AND ($2::int IS NULL
             OR EXISTS (SELECT 1 FROM scope_template_items ti WHERE ti.template_id = j.template_id AND ti.library_id = $2)
             OR EXISTS (SELECT 1 FROM job_scopes s WHERE s.job_id = j.id AND (s.library_id = $2 OR s.library_id IS NULL)))`,
      [templateId, libraryId]);
    for (const j of jobs) await applyToJob(tx, j.template_id, j.id);
    return jobs.length;
  });
}

module.exports = { applyToJob, applyTemplate, resyncFollowers };
