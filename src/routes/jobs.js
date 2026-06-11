const express = require('express');
const { q, q1 } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { contractEnd, FREQUENCIES } = require('../recurrence');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

// Recurring site jobs: one contract per site. Gardeners see their own;
// staff see and manage all.
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const jobs = await q(`
    SELECT j.*, p.name AS property_name, p.address, p.lots, u.name AS gardener_name,
      (SELECT MIN(v.scheduled_date) FROM visits v
        WHERE v.job_id = j.id AND v.status = 'scheduled') AS next_visit_date,
      (SELECT v.id FROM visits v
        WHERE v.job_id = j.id AND v.status = 'scheduled'
        ORDER BY v.scheduled_date LIMIT 1) AS next_visit_id
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN users u ON u.id = j.gardener_id
    ${staff ? '' : 'WHERE j.gardener_id = $1'}
    ORDER BY j.active DESC, p.name`, staff ? [] : [req.user.id]);
  const properties = await q('SELECT id, name FROM properties ORDER BY name');
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  res.render('jobs/index', { title: 'Sites', jobs, properties, gardeners, staff, frequencies: FREQUENCIES });
}));

// Create a recurring job; schedules its first visit on the start date.
router.post('/', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { property_id, gardener_id, frequency, contract_years, start_date, time_window } = req.body;
  if (!property_id || !start_date || !FREQUENCIES.includes(frequency)) return res.redirect('/jobs');
  const years = Number(contract_years) === 2 ? 2 : 1;
  const job = await q1(`
    INSERT INTO jobs (property_id, gardener_id, frequency, contract_years, start_date, end_date, time_window, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [property_id, gardener_id || null, frequency, years, start_date,
      contractEnd(start_date, years), time_window || null, req.user.id]);
  await q(`
    INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, time_window, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.id, job.property_id, job.gardener_id, start_date, job.time_window, req.user.id]);
  await logActivity(req.user.id, 'job.create', 'job', job.id,
    `Created ${frequency} job for site #${property_id} (${years}-year contract from ${start_date})`);
  res.redirect('/jobs');
}));

// Update default gardener / frequency / window / active state.
router.post('/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.redirect('/jobs');
  const { gardener_id, frequency, time_window, active } = req.body;
  await q(`
    UPDATE jobs SET gardener_id = $1, frequency = $2, time_window = $3, active = $4 WHERE id = $5`,
    [gardener_id || null, FREQUENCIES.includes(frequency) ? frequency : job.frequency,
      time_window || null, active === 'on', job.id]);
  // Future scheduled visits follow the new default gardener unless they were
  // individually reassigned (a "replacement" differs from the old default).
  if ((gardener_id || null) !== job.gardener_id) {
    await q(`
      UPDATE visits SET gardener_id = $1
      WHERE job_id = $2 AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE
        AND (gardener_id IS NOT DISTINCT FROM $3)`,
      [gardener_id || null, job.id, job.gardener_id]);
  }
  await logActivity(req.user.id, 'job.update', 'job', job.id, `Updated site job #${job.id}`);
  res.redirect('/jobs');
}));

module.exports = router;
