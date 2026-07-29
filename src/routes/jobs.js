const express = require('express');
const { q, q1, withTransaction } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { contractEnd, occurrencesBetween, FREQUENCIES, isValidDate, isValidTimeWindow } = require('../recurrence');
const { today: businessToday } = require('../time');
const { asyncHandler } = require('../asyncHandler');
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
      (SELECT COUNT(*) FROM visits v WHERE v.job_id = j.id AND v.status = 'scheduled') AS upcoming_count
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
  const dates = occurrencesBetween(start_date, frequency, endDate).slice(0, PREGENERATE);

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
    const g = await q1("SELECT id FROM users WHERE id = $1 AND role = 'gardener' AND active", [Number(gardener_id)]);
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
  await logActivity(req.user.id, 'job.update', 'job', job.id, `Updated site contract #${job.id}`);
  res.redirect('/jobs');
}));

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
    SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
           COALESCE(SUM(duration_minutes), 0)::int AS minutes
    FROM visits WHERE property_id = $1`, [req.params.propertyId]),
    q(`
    SELECT inv.* FROM invoices inv JOIN visits v ON v.id = inv.visit_id
    WHERE v.property_id = $1 ORDER BY inv.created_at DESC`, [req.params.propertyId]),
  ]);
  const { rows: visits, total, totalPages } = visitsPage;
  res.render('jobs/site', { title: property.name, property, visits, totals, invoices, page, total, totalPages });
}));

module.exports = router;
