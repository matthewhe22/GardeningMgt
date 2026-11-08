const express = require('express');
const crypto = require('crypto');
const path = require('path');
const storage = require('../storage');
const { q, q1, withTransaction } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { contractEnd, occurrencesBetween, FREQUENCIES, isValidDate, isValidTimeWindow } = require('../recurrence');
const { today: businessToday } = require('../time');
const { asyncHandler } = require('../asyncHandler');
const { assertCsrf } = require('../csrf');
const { upload, savePhoto } = require('../upload');
const { MAX_SCOPES, loadJobScopes } = require('../scope');
const { applyTemplate } = require('../scopeTemplates');

// A site-level edit means the site no longer follows its template's updates.
const markCustomized = (jobId) => q('UPDATE jobs SET scope_customized = true WHERE id = $1', [jobId]);
const { pageParam, paginate } = require('../pagination');

const router = express.Router();

// How many future occurrences to materialize up front (the rest are created
// as visits complete / via the cron backfill). Keeps a 2-year weekly contract
// from inserting 100+ rows at once while still giving a real forward schedule.
const PREGENERATE = 12;

// The gardening fee is an admin-only figure — parse to a clean non-negative
// amount (or null to clear it), and only ever call this for an admin caller.
function parseFee(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// Recurring site jobs: one contract per site. Gardeners see their own;
// staff see and manage all.
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const today = businessToday();
  const search = (req.query.search || '').trim();
  const cond = [];
  const args = [today];
  if (!staff) { args.push(req.user.id); cond.push(`j.gardener_id = $${args.length}`); }
  if (search) { args.push(`%${search}%`); cond.push(`(p.name ILIKE $${args.length} OR p.address ILIKE $${args.length})`); }
  const page = pageParam(req);
  const jobsSql = `
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
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY j.active DESC, p.name`;
  const [jobsPage, properties, gardeners] = await Promise.all([
    paginate(q, jobsSql, args, page),
    q('SELECT id, name FROM properties ORDER BY name'),
    q("SELECT id, name FROM users WHERE role = 'gardener' AND active"),
  ]);
  const { rows: jobs, total, totalPages } = jobsPage;
  res.render('jobs/index', {
    title: 'Sites', jobs, properties, gardeners, staff, search, frequencies: FREQUENCIES,
    flash: req.query.error || null, page, total, totalPages,
  });
}));

// Create a recurring job and pre-generate its forward schedule (transactional).
router.post('/', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { property_id, gardener_id, frequency, contract_years, start_date, time_window, gardening_fee } = req.body;
  if (!Number(property_id) || !isValidDate(start_date) || !FREQUENCIES.includes(frequency) ||
    (time_window && !isValidTimeWindow(time_window))) {
    return res.redirect('/jobs?error=invalid');
  }
  // Only an admin can set the fee — a supervisor posting this field (or
  // tampering with the request) is silently ignored, not an error.
  const fee = req.user.role === 'admin' ? parseFee(gardening_fee) : null;
  // The default gardener must actually be a gardener (or unassigned).
  let gardener = null;
  if (gardener_id) {
    const g = await q1("SELECT id FROM users WHERE id = $1 AND role = 'gardener' AND active", [Number(gardener_id)]);
    if (!g) return res.redirect('/jobs?error=gardener');
    gardener = g.id;
  }
  // One active contract per site. This check-then-insert still has a race
  // window, closed below by the uq_jobs_property_active unique index + a
  // 23505 catch.
  const dup = await q1('SELECT id FROM jobs WHERE property_id = $1 AND active', [Number(property_id)]);
  if (dup) return res.redirect('/jobs?error=duplicate');

  const years = Number(contract_years) === 2 ? 2 : 1;
  const endDate = contractEnd(start_date, years);
  // A contract that started in the past only books visits from today on.
  const fromDay = businessToday();
  const dates = occurrencesBetween(start_date, frequency, endDate).filter((d) => d >= fromDay).slice(0, PREGENERATE);

  try {
    await withTransaction(async (tx) => {
      const job = await tx.q1(`
        INSERT INTO jobs (property_id, gardener_id, frequency, contract_years, start_date, end_date, time_window, gardening_fee, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [Number(property_id), gardener, frequency, years, start_date, endDate, time_window || null, fee, req.user.id]);
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
  } catch (e) {
    if (e.code === '23505') return res.redirect('/jobs?error=duplicate'); // lost the race to a concurrent create
    throw e;
  }
  res.redirect('/jobs');
}));

// Update default gardener / frequency / window / active state.
router.post('/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.redirect('/jobs');
  const { gardener_id, frequency, time_window, active, gardening_fee } = req.body;
  if (time_window && !isValidTimeWindow(time_window)) return res.redirect('/jobs?error=invalid');
  let gardener = null;
  if (gardener_id) {
    // The current default gardener stays valid even if since disabled.
    const g = Number(gardener_id) === job.gardener_id
      ? { id: job.gardener_id }
      : await q1("SELECT id FROM users WHERE id = $1 AND role = 'gardener' AND active", [Number(gardener_id)]);
    if (!g) return res.redirect('/jobs?error=gardener');
    gardener = g.id;
  }
  // Only an admin can change the fee — a supervisor submitting this form
  // (the field isn't even rendered for them) leaves it untouched.
  const fee = req.user.role === 'admin' ? parseFee(gardening_fee) : job.gardening_fee;
  try {
    await q(`
      UPDATE jobs SET gardener_id = $1, frequency = $2, time_window = $3, active = $4, gardening_fee = $5 WHERE id = $6`,
      [gardener, FREQUENCIES.includes(frequency) ? frequency : job.frequency,
        time_window || null, active === 'on', fee, job.id]);
  } catch (e) {
    // Reactivating this job while another active job already exists for the
    // same property (uq_jobs_property_active) — same conflict as creating a
    // duplicate, so use the same friendly redirect instead of a 500.
    if (e.code === '23505') return res.redirect('/jobs?error=duplicate');
    throw e;
  }
  // Future scheduled visits follow the new default gardener unless they were
  // individually reassigned (a "replacement" differs from the old default).
  if (gardener !== job.gardener_id) {
    await q(`
      UPDATE visits SET gardener_id = $1
      WHERE job_id = $2 AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE
        AND (gardener_id IS NOT DISTINCT FROM $3)`,
      [gardener, job.id, job.gardener_id]);
  }
  const newFreq = FREQUENCIES.includes(frequency) ? frequency : job.frequency;
  const nowActive = active === 'on';
  if (newFreq !== job.frequency || nowActive !== job.active) {
    const n = await rebuildSchedule(job.id);
    await logActivity(req.user.id, 'job.reschedule', 'job', job.id,
      nowActive ? `Rebuilt schedule for contract #${job.id} (${newFreq}): ${n} upcoming visit(s)`
        : `Contract #${job.id} deactivated: future scheduled visits removed`);
  }
  await logActivity(req.user.id, 'job.update', 'job', job.id, `Updated site contract #${job.id}`);
  res.redirect('/jobs');
}));

/**
 * Replace a contract's future scheduled visits after its frequency or active
 * state changes: drop untouched future visits, then (if active) book the next
 * PREGENERATE occurrences from today on the contract's anchor dates.
 * Returns how many visits are now booked.
 */
async function rebuildSchedule(jobId) {
  return withTransaction(async (tx) => {
    const job = await tx.q1('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    const fromDay = businessToday();
    // Only untouched occurrences are replaced: anything someone has worked
    // on or annotated (started, photos, comments, invoice, a task, a linked
    // issue, notes) is kept rather than silently destroyed.
    await tx.q(`DELETE FROM visits v WHERE v.job_id = $1 AND v.status = 'scheduled' AND v.scheduled_date >= $2
      AND v.started_at IS NULL AND v.notes IS NULL
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.visit_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.visit_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM photos ph WHERE ph.visit_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM visit_comments c WHERE c.visit_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.visit_id = v.id)`, [jobId, fromDay]);
    if (!job.active) return 0;
    const dates = occurrencesBetween(job.start_date, job.frequency, job.end_date)
      .filter((d) => d >= fromDay).slice(0, PREGENERATE);
    let n = 0;
    for (const d of dates) {
      const r = await tx.q1(`
        INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, time_window, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (job_id, scheduled_date) WHERE status = 'scheduled' AND job_id IS NOT NULL DO NOTHING
        RETURNING id`, [job.id, job.property_id, job.gardener_id, d, job.time_window, job.created_by]);
      if (r) n++;
    }
    return n;
  });
}

// Renew a contract for another term (extends end_date, regenerates schedule head).
router.post('/:id/renew', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.redirect('/jobs');
  const years = Number(req.body.contract_years) === 2 ? 2 : 1;
  const newEnd = contractEnd(job.end_date, years);
  await q('UPDATE jobs SET end_date = $1, active = true, renewal_acknowledged = true WHERE id = $2', [newEnd, job.id]);
  await logActivity(req.user.id, 'job.renew', 'job', job.id, `Renewed contract #${job.id} to ${newEnd}`);
  res.redirect('/jobs');
}));

// Per-site history: every visit, plus rolled-up hours/photos/invoices.
router.get('/site/:propertyId', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const property = await q1('SELECT * FROM properties WHERE id = $1', [req.params.propertyId]);
  if (!property) return res.status(404).render('error', { title: 'Not found', message: 'Site not found.' });
  const page = pageParam(req);
  const visitsSql = `
    SELECT v.*, u.name AS gardener_name,
      (SELECT COUNT(*) FROM photos ph WHERE ph.visit_id = v.id) AS photo_count
    FROM visits v LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.property_id = $1 ORDER BY v.scheduled_date DESC`;
  const [visitsPage, totals, invoices] = await Promise.all([
    paginate(q, visitsSql, [req.params.propertyId], page),
    q1(`
    SELECT COUNT(*) FILTER (WHERE status IN ('completed','approved'))::int AS completed,
           COALESCE(SUM(duration_minutes), 0)::int AS minutes
    FROM visits WHERE property_id = $1`, [req.params.propertyId]),
    q(`
    SELECT inv.* FROM invoices inv JOIN visits v ON v.id = inv.visit_id
    WHERE v.property_id = $1 ORDER BY inv.created_at DESC`, [req.params.propertyId]),
  ]);
  const { rows: visits, total, totalPages } = visitsPage;
  res.render('jobs/site', { title: property.name, property, visits, totals, invoices, page, total, totalPages });
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
  const photoCopies = []; // [newScopeId, sourcePhotoRow] — bytes copied after the transaction
  await withTransaction(async (tx) => {
    await tx.q('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [job.id]);
    const { n, maxpos } = await tx.q1(
      'SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0)::int AS maxpos FROM job_scopes WHERE job_id = $1', [job.id]);
    // Skip items this site already has (same library item or same wording).
    const src = await tx.q(`
      SELECT s.* FROM job_scopes s WHERE s.job_id = $1
        AND NOT EXISTS (SELECT 1 FROM job_scopes t WHERE t.job_id = $2
          AND ((s.library_id IS NOT NULL AND t.library_id = s.library_id) OR lower(t.title) = lower(s.title)))
      ORDER BY s.position, s.id`, [from, job.id]);
    full = src.length > MAX_SCOPES - n;
    for (const [i, s] of src.slice(0, Math.max(0, MAX_SCOPES - n)).entries()) {
      // Keep the library link so the library's standard photo still applies.
      const row = await tx.q1(`
        INSERT INTO job_scopes (job_id, library_id, position, title) VALUES ($1, $2, $3, $4)
        ON CONFLICT (job_id, library_id) WHERE library_id IS NOT NULL DO NOTHING RETURNING id`,
        [job.id, s.library_id, maxpos + i + 1, s.title]);
      if (!row) continue;
      const ph = await tx.q1('SELECT * FROM photos WHERE job_scope_id = $1 ORDER BY created_at DESC LIMIT 1', [s.id]);
      if (ph) photoCopies.push([row.id, ph]);
      copied++;
    }
    if (copied) await tx.q('UPDATE jobs SET scope_customized = true WHERE id = $1', [job.id]);
  });
  // Site-specific photos are copied under a new filename (from object storage when used).
  for (const [scopeId, ph] of photoCopies) {
    let data = ph.data;
    const filename = `std-${scopeId}-${crypto.randomBytes(6).toString('hex')}${path.extname(ph.filename)}`;
    if (storage.enabled() && data && data.length === 0) {
      const buf = await storage.getObjectBuffer(ph.filename).catch(() => null);
      if (!buf) continue;
      await storage.putObject(filename, buf, ph.mime);
    }
    await q(`INSERT INTO photos (filename, original_name, mime, data, thumb_data, caption, job_scope_id, uploaded_by, shared)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
      [filename, ph.original_name, ph.mime, data, ph.thumb_data, ph.caption, scopeId, req.user.id]);
  }
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
