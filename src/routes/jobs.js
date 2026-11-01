const express = require('express');
const { q, q1, withTransaction } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { contractEnd, occurrencesBetween, FREQUENCIES, isValidDate } = require('../recurrence');
const { today: businessToday } = require('../time');
const { asyncHandler } = require('../asyncHandler');
const { assertCsrf } = require('../csrf');
const { upload, savePhoto } = require('../upload');
const { MAX_SCOPES, loadJobScopes } = require('../scope');
const { applyTemplate } = require('../scopeTemplates');

// A site-level edit means the site no longer follows its template's updates.
const markCustomized = (jobId) => q('UPDATE jobs SET scope_customized = true WHERE id = $1', [jobId]);

const router = express.Router();

// How many future occurrences to materialize up front (the rest are created
// as visits complete / via the cron backfill). Keeps a 2-year weekly contract
// from inserting 100+ rows at once while still giving a real forward schedule.
const PREGENERATE = 12;

// Recurring site jobs: one contract per site. Gardeners see their own;
// staff see and manage all.
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const today = businessToday();
  const jobs = await q(`
    SELECT j.*, p.name AS property_name, p.address, p.lots, u.name AS gardener_name,
      (j.end_date < $1) AS expired,
      (SELECT MIN(v.scheduled_date) FROM visits v
        WHERE v.job_id = j.id AND v.status = 'scheduled') AS next_visit_date,
      (SELECT v.id FROM visits v
        WHERE v.job_id = j.id AND v.status = 'scheduled'
        ORDER BY v.scheduled_date LIMIT 1) AS next_visit_id,
      (SELECT COUNT(*) FROM visits v WHERE v.job_id = j.id AND v.status = 'scheduled') AS upcoming_count,
      (SELECT COUNT(*) FROM job_scopes s WHERE s.job_id = j.id) AS scope_count,
      (SELECT t.name FROM scope_templates t WHERE t.id = j.template_id) AS template_name
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN users u ON u.id = j.gardener_id
    ${staff ? '' : 'WHERE j.gardener_id = $2'}
    ORDER BY j.active DESC, p.name`, staff ? [today] : [today, req.user.id]);
  const properties = await q('SELECT id, name FROM properties ORDER BY name');
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  res.render('jobs/index', {
    title: 'Sites', jobs, properties, gardeners, staff, frequencies: FREQUENCIES,
    flash: req.query.error || null,
  });
}));

// Create a recurring job and pre-generate its forward schedule (transactional).
router.post('/', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { property_id, gardener_id, frequency, contract_years, start_date, time_window } = req.body;
  if (!Number(property_id) || !isValidDate(start_date) || !FREQUENCIES.includes(frequency)) {
    return res.redirect('/jobs?error=invalid');
  }
  // The default gardener must actually be a gardener (or unassigned).
  let gardener = null;
  if (gardener_id) {
    const g = await q1("SELECT id FROM users WHERE id = $1 AND role = 'gardener' AND active", [Number(gardener_id)]);
    if (!g) return res.redirect('/jobs?error=gardener');
    gardener = g.id;
  }
  // One active contract per site.
  const dup = await q1('SELECT id FROM jobs WHERE property_id = $1 AND active', [Number(property_id)]);
  if (dup) return res.redirect('/jobs?error=duplicate');

  const years = Number(contract_years) === 2 ? 2 : 1;
  const endDate = contractEnd(start_date, years);
  const dates = occurrencesBetween(start_date, frequency, endDate).slice(0, PREGENERATE);

  await withTransaction(async (tx) => {
    const job = await tx.q1(`
      INSERT INTO jobs (property_id, gardener_id, frequency, contract_years, start_date, end_date, time_window, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [Number(property_id), gardener, frequency, years, start_date, endDate, time_window || null, req.user.id]);
    for (const d of dates) {
      await tx.q(`
        INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, time_window, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (job_id, scheduled_date) WHERE status = 'scheduled' AND job_id IS NOT NULL DO NOTHING`,
        [job.id, job.property_id, gardener, d, time_window || null, req.user.id]);
    }
    await tx.q(`INSERT INTO activity_log (user_id, action, entity_type, entity_id, details)
      VALUES ($1, 'job.create', 'job', $2, $3)`,
      [req.user.id, job.id,
        `Created ${frequency} job for site #${property_id} (${years}-yr from ${start_date}, ${dates.length} visits scheduled)`]);
  });
  res.redirect('/jobs');
}));

// Update default gardener / frequency / window / active state.
router.post('/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.redirect('/jobs');
  const { gardener_id, frequency, time_window, active } = req.body;
  let gardener = null;
  if (gardener_id) {
    const g = await q1("SELECT id FROM users WHERE id = $1 AND role = 'gardener' AND active", [Number(gardener_id)]);
    if (!g) return res.redirect('/jobs?error=gardener');
    gardener = g.id;
  }
  await q(`
    UPDATE jobs SET gardener_id = $1, frequency = $2, time_window = $3, active = $4 WHERE id = $5`,
    [gardener, FREQUENCIES.includes(frequency) ? frequency : job.frequency,
      time_window || null, active === 'on', job.id]);
  // Future scheduled visits follow the new default gardener unless they were
  // individually reassigned (a "replacement" differs from the old default).
  if (gardener !== job.gardener_id) {
    await q(`
      UPDATE visits SET gardener_id = $1
      WHERE job_id = $2 AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE
        AND (gardener_id IS NOT DISTINCT FROM $3)`,
      [gardener, job.id, job.gardener_id]);
  }
  await logActivity(req.user.id, 'job.update', 'job', job.id, `Updated site job #${job.id}`);
  res.redirect('/jobs');
}));

// Renew a contract for another term (extends end_date, regenerates schedule head).
router.post('/:id/renew', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.redirect('/jobs');
  const years = Number(req.body.contract_years) === 2 ? 2 : 1;
  const newEnd = contractEnd(job.end_date, years);
  await q('UPDATE jobs SET end_date = $1, active = true, renewal_acknowledged = true WHERE id = $2', [newEnd, job.id]);
  await logActivity(req.user.id, 'job.renew', 'job', job.id, `Renewed job #${job.id} to ${newEnd}`);
  res.redirect('/jobs');
}));

// Per-site history: every visit, plus rolled-up hours/photos/invoices.
router.get('/site/:propertyId', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const property = await q1('SELECT * FROM properties WHERE id = $1', [req.params.propertyId]);
  if (!property) return res.status(404).render('error', { title: 'Not found', message: 'Site not found.' });
  const visits = await q(`
    SELECT v.*, u.name AS gardener_name,
      (SELECT COUNT(*) FROM photos ph WHERE ph.visit_id = v.id) AS photo_count
    FROM visits v LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.property_id = $1 ORDER BY v.scheduled_date DESC LIMIT 300`, [req.params.propertyId]);
  const totals = await q1(`
    SELECT COUNT(*) FILTER (WHERE status IN ('completed','approved'))::int AS completed,
           COALESCE(SUM(duration_minutes), 0)::int AS minutes
    FROM visits WHERE property_id = $1`, [req.params.propertyId]);
  const invoices = await q(`
    SELECT inv.* FROM invoices inv JOIN visits v ON v.id = inv.visit_id
    WHERE v.property_id = $1 ORDER BY inv.created_at DESC`, [req.params.propertyId]);
  res.render('jobs/site', { title: property.name, property, visits, totals, invoices });
}));

// ---------------------------------------------------------------------------
// Scope of duties (max 20 items per job, each with an optional standard photo)
// ---------------------------------------------------------------------------

async function getJob(id) {
  return q1(`
    SELECT j.*, p.name AS property_name, p.address, t.name AS template_name FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN scope_templates t ON t.id = j.template_id WHERE j.id = $1`, [Number(id) || 0]);
}
async function getScope(job, sid) {
  return q1('SELECT * FROM job_scopes WHERE id = $1 AND job_id = $2', [Number(sid) || 0, job.id]);
}
const scopeUrl = (job, msg) => `/jobs/${job.id}/scope${msg ? `?msg=${msg}` : ''}`;

router.get('/:id/scope', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).render('error', { title: 'Not found', message: 'Job not found.' });
  const scopes = await loadJobScopes(job.id);
  // Other sites that already have a scope, to copy from.
  const sources = await q(`
    SELECT j.id, p.name, COUNT(s.id)::int AS n FROM jobs j
    JOIN properties p ON p.id = j.property_id JOIN job_scopes s ON s.job_id = j.id
    WHERE j.id <> $1 GROUP BY j.id, p.name ORDER BY p.name`, [job.id]);
  const templates = await q(`SELECT t.id, t.name,
    (SELECT COUNT(*) FROM scope_template_items ti WHERE ti.template_id = t.id)::int AS n
    FROM scope_templates t ORDER BY t.name`);
  res.render('jobs/scope', {
    title: `Scope of duties — ${job.property_name}`, job, scopes, sources, templates,
    max: MAX_SCOPES, msg: req.query.msg || null,
  });
}));

// Add items: one per line (paste the list from the contract), capped at 20 total.
router.post('/:id/scope', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.redirect('/jobs');
  const lines = String(req.body.titles || '').split(/\r?\n/)
    .map((l) => l.replace(/^[\s*•\-–]+/, '').replace(/[,;]\s*$/, '').trim())
    .filter(Boolean).map((l) => l.slice(0, 300));
  let added = 0;
  let full = false;
  await withTransaction(async (tx) => {
    // Lock the job row so two concurrent adds can't exceed the cap.
    await tx.q('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [job.id]);
    const { n, maxpos } = await tx.q1(
      'SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0)::int AS maxpos FROM job_scopes WHERE job_id = $1', [job.id]);
    const room = MAX_SCOPES - n;
    full = lines.length > room;
    for (const [i, title] of lines.slice(0, Math.max(0, room)).entries()) {
      await tx.q('INSERT INTO job_scopes (job_id, position, title) VALUES ($1, $2, $3)', [job.id, maxpos + i + 1, title]);
      added++;
    }
  });
  if (added) {
    await markCustomized(job.id);
    await logActivity(req.user.id, 'scope.add', 'job', job.id, `Added ${added} scope item(s) to job #${job.id}`);
  }
  res.redirect(scopeUrl(job, full ? 'full' : null));
}));

// Copy another job's scope items (titles + standard photos) into this one.
router.post('/:id/scope/copy', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.redirect('/jobs');
  const from = Number(req.body.from_job_id) || 0;
  let copied = 0;
  let full = false;
  await withTransaction(async (tx) => {
    await tx.q('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [job.id]);
    const { n, maxpos } = await tx.q1(
      'SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0)::int AS maxpos FROM job_scopes WHERE job_id = $1', [job.id]);
    const src = await tx.q('SELECT * FROM job_scopes WHERE job_id = $1 ORDER BY position, id', [from]);
    full = src.length > MAX_SCOPES - n;
    for (const [i, s] of src.slice(0, Math.max(0, MAX_SCOPES - n)).entries()) {
      const row = await tx.q1('INSERT INTO job_scopes (job_id, position, title) VALUES ($1, $2, $3) RETURNING id',
        [job.id, maxpos + i + 1, s.title]);
      // Duplicate the standard photo bytes under a new unique filename.
      await tx.q(`
        INSERT INTO photos (filename, original_name, mime, data, caption, job_scope_id, uploaded_by, shared)
        SELECT 'std-' || $1::int || '-' || md5(random()::text) || substring(filename from '\\.[^.]+$'),
               original_name, mime, data, caption, $1::int, $3, false
        FROM photos WHERE job_scope_id = $2 ORDER BY created_at DESC LIMIT 1`, [row.id, s.id, req.user.id]);
      copied++;
    }
  });
  if (copied) await markCustomized(job.id);
  if (copied) await logActivity(req.user.id, 'scope.copy', 'job', job.id, `Copied ${copied} scope item(s) from job #${from}`);
  res.redirect(scopeUrl(job, full ? 'full' : null));
}));

// Apply a template to just this site ("" = stop following any template).
router.post('/:id/scope/template', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.redirect('/jobs');
  const t = await q1('SELECT id, name FROM scope_templates WHERE id = $1', [Number(req.body.template_id) || 0]);
  if (t) {
    await applyTemplate(t.id, [job.id]);
    await logActivity(req.user.id, 'scope.template.apply', 'job', job.id, `Applied "${t.name}" to job #${job.id}`);
  } else {
    await q('UPDATE jobs SET template_id = NULL, scope_customized = false WHERE id = $1', [job.id]);
  }
  res.redirect(scopeUrl(job));
}));

router.post('/:id/scope/:sid/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  const scope = job && await getScope(job, req.params.sid);
  if (!scope) return res.redirect('/jobs');
  const title = String(req.body.title || '').trim().slice(0, 300);
  if (title && title !== scope.title) {
    await q('UPDATE job_scopes SET title = $1 WHERE id = $2', [title, scope.id]);
    await markCustomized(job.id);
  }
  res.redirect(scopeUrl(job));
}));

// Move an item up or down (swap with its neighbour).
router.post('/:id/scope/:sid/move', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  const scope = job && await getScope(job, req.params.sid);
  if (!scope) return res.redirect('/jobs');
  await withTransaction(async (tx) => {
    const all = await tx.q('SELECT id FROM job_scopes WHERE job_id = $1 ORDER BY position, id FOR UPDATE', [job.id]);
    const i = all.findIndex((r) => r.id === scope.id);
    const j = req.body.dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    for (const [pos, r] of all.entries()) {
      await tx.q('UPDATE job_scopes SET position = $1 WHERE id = $2', [pos + 1, r.id]);
    }
    await tx.q('UPDATE jobs SET scope_customized = true WHERE id = $1', [job.id]);
  });
  res.redirect(scopeUrl(job));
}));

router.post('/:id/scope/:sid/delete', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  const scope = job && await getScope(job, req.params.sid);
  if (!scope) return res.redirect('/jobs');
  await q('DELETE FROM job_scopes WHERE id = $1', [scope.id]); // standard photo cascades
  await markCustomized(job.id);
  await logActivity(req.user.id, 'scope.delete', 'job', job.id, `Removed scope item "${scope.title}" from job #${job.id}`);
  res.redirect(scopeUrl(job));
}));

// Upload / replace the standard (reference) photo for one scope item.
router.post('/:id/scope/:sid/photo', requireRole('supervisor'), upload.single('photo'), asyncHandler(async (req, res) => {
  assertCsrf(req);
  const job = await getJob(req.params.id);
  const scope = job && await getScope(job, req.params.sid);
  if (!scope) return res.redirect('/jobs');
  if (!req.file) return res.redirect(scopeUrl(job));
  const saved = await savePhoto(req.file, { jobScopeId: scope.id, userId: req.user.id, shared: false, caption: 'Standard' });
  if (!saved) return res.redirect(scopeUrl(job, 'badphoto'));
  await q('DELETE FROM photos WHERE job_scope_id = $1 AND filename <> $2', [scope.id, saved]);
  await logActivity(req.user.id, 'scope.photo', 'job', job.id, `Set standard photo for "${scope.title}"`);
  res.redirect(scopeUrl(job));
}));

router.post('/:id/scope/:sid/photo/delete', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  const scope = job && await getScope(job, req.params.sid);
  if (!scope) return res.redirect('/jobs');
  await q('DELETE FROM photos WHERE job_scope_id = $1', [scope.id]);
  res.redirect(scopeUrl(job));
}));

module.exports = router;
