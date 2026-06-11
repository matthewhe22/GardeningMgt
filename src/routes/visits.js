const express = require('express');
const { q, q1, pool } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { upload, savePhoto } = require('../upload');
const { nextDate } = require('../recurrence');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

function getVisit(id) {
  return q1(`
    SELECT v.*, p.name AS property_name, p.address, p.lat, p.lng, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.id = $1`, [id]);
}

function canSeeVisit(user, visit) {
  return isStaff(user) || visit.gardener_id === user.id;
}

// List (staff see all; gardeners see their own). Filter by date / gardener.
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const date = req.query.date || '';
  const gardenerId = staff ? (req.query.gardener_id || '') : String(req.user.id);
  const where = [];
  const args = [];
  if (date) { args.push(date); where.push(`v.scheduled_date = $${args.length}`); }
  if (gardenerId) { args.push(Number(gardenerId)); where.push(`v.gardener_id = $${args.length}`); }
  const visits = await q(`
    SELECT v.*, p.name AS property_name, p.address, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.scheduled_date DESC, COALESCE(v.route_order, 999)
    LIMIT 200`, args);
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  const properties = await q('SELECT id, name FROM properties ORDER BY name');
  res.render('visits/index', { title: 'Visits / Jobs', visits, gardeners, properties, staff, date, gardenerId });
}));

// Create (staff only)
router.post('/', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { property_id, gardener_id, scheduled_date, time_window, notes } = req.body;
  const { id } = await q1(`
    INSERT INTO visits (property_id, gardener_id, scheduled_date, time_window, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [property_id, gardener_id || null, scheduled_date, time_window || null, notes || null, req.user.id]);
  await logActivity(req.user.id, 'visit.create', 'visit', id, `Scheduled visit #${id} for ${scheduled_date}`);
  res.redirect(`/visits/${id}`);
}));

// Detail: tasks, photos, comments, invoice, timer, GPS
router.get('/:id', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit) return res.status(404).render('error', { title: 'Not found', message: 'Visit not found.' });
  if (!canSeeVisit(req.user, visit)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Not your visit.' });
  }
  const tasks = await q('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.visit_id = $1 ORDER BY t.id', [visit.id]);
  const photos = await q('SELECT ph.id, ph.filename, ph.caption, ph.original_name, ph.created_at, u.name AS uploader_name FROM photos ph LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.visit_id = $1 AND ph.visit_comment_id IS NULL ORDER BY ph.created_at DESC', [visit.id]);
  const comments = await q('SELECT c.*, u.name AS author_name, u.role AS author_role FROM visit_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.visit_id = $1 ORDER BY c.created_at', [visit.id]);
  const commentPhotos = await q('SELECT ph.visit_comment_id, ph.filename, ph.created_at FROM photos ph WHERE ph.visit_id = $1 AND ph.visit_comment_id IS NOT NULL ORDER BY ph.created_at', [visit.id]);
  const photosByComment = {};
  for (const ph of commentPhotos) (photosByComment[ph.visit_comment_id] ||= []).push(ph);
  const invoice = await q1('SELECT * FROM invoices WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]);
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  const gpsPoints = await q('SELECT * FROM gps_points WHERE visit_id = $1 ORDER BY recorded_at', [visit.id]);
  const job = visit.job_id
    ? await q1('SELECT j.*, u.name AS default_gardener_name FROM jobs j LEFT JOIN users u ON u.id = j.gardener_id WHERE j.id = $1', [visit.job_id])
    : null;
  res.render('visits/show', {
    title: `Job #${visit.id} — ${visit.property_name}`,
    visit, tasks, photos, comments, photosByComment, invoice, gardeners, gpsPoints, job,
    staff: isStaff(req.user),
  });
}));

// Update core fields (staff)
router.post('/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit) return res.redirect('/visits');
  const { gardener_id, scheduled_date, time_window, status, notes, duration_minutes } = req.body;
  await q(`
    UPDATE visits SET gardener_id = $1, scheduled_date = $2, time_window = $3, status = $4, notes = $5,
      duration_minutes = $6
    WHERE id = $7`,
    [gardener_id || null, scheduled_date, time_window || null, status, notes || null,
      duration_minutes ? Number(duration_minutes) : visit.duration_minutes, visit.id]);
  await logActivity(req.user.id, 'visit.update', 'visit', visit.id,
    `Updated visit #${visit.id} (status: ${visit.status} -> ${status})`);
  if (status === 'completed' && visit.status !== 'completed') await rollRecurringJob(visit, req.user.id);
  res.redirect(`/visits/${visit.id}`);
}));

// Reschedule: the assigned gardener (or staff) can set the date of a visit.
router.post('/:id/reschedule', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const date = req.body.scheduled_date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    await q('UPDATE visits SET scheduled_date = $1, route_order = NULL WHERE id = $2', [date, visit.id]);
    await logActivity(req.user.id, 'visit.reschedule', 'visit', visit.id,
      `Moved job #${visit.id} from ${visit.scheduled_date} to ${date}`);
  }
  res.redirect(`/visits/${visit.id}`);
}));

// Status shortcut for gardeners (complete / skip)
router.post('/:id/status', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const status = req.body.status;
  if (!['scheduled', 'in_progress', 'completed', 'skipped'].includes(status)) return res.redirect(`/visits/${visit.id}`);
  await q('UPDATE visits SET status = $1 WHERE id = $2', [status, visit.id]);
  await logActivity(req.user.id, 'visit.status', 'visit', visit.id, `Visit #${visit.id}: ${visit.status} -> ${status}`);
  if (status === 'completed' && visit.status !== 'completed') await rollRecurringJob(visit, req.user.id);
  res.redirect(`/visits/${visit.id}`);
}));

async function recordGps(visitId, userId, body, kind) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    await q('INSERT INTO gps_points (visit_id, user_id, lat, lng, kind) VALUES ($1, $2, $3, $4, $5)',
      [visitId, userId, lat, lng, kind]);
    return true;
  }
  return false;
}

// Job timer: start (captures the gardener's GPS position if provided)
router.post('/:id/timer/start', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  await q(`UPDATE visits SET started_at = now(), finished_at = NULL, status = 'in_progress' WHERE id = $1`, [visit.id]);
  const gps = await recordGps(visit.id, req.user.id, req.body, 'start');
  await logActivity(req.user.id, 'visit.timer.start', 'visit', visit.id,
    `Started job timer on visit #${visit.id}${gps ? ' (GPS recorded)' : ''}`);
  res.redirect(`/visits/${visit.id}`);
}));

// GPS ping while working (called periodically by the mobile UI)
router.post('/:id/gps', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.status(403).json({ ok: false });
  await recordGps(visit.id, req.user.id, req.body, 'ping');
  res.json({ ok: true });
}));

// Job timer: stop (computes duration, marks completed, notifies supervisors/admins)
router.post('/:id/timer/stop', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  if (visit.started_at) {
    await q(`
      UPDATE visits SET finished_at = now(),
        duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - started_at)) / 60))::int,
        status = 'completed'
      WHERE id = $1`, [visit.id]);
    await recordGps(visit.id, req.user.id, req.body, 'finish');
    const updated = await getVisit(visit.id);
    await logActivity(req.user.id, 'visit.timer.stop', 'visit', visit.id,
      `Finished job #${visit.id} in ${updated.duration_minutes} min`);

    // Job summary -> every supervisor and admin, in-app.
    const { dc } = await q1("SELECT COUNT(*)::int AS dc FROM tasks WHERE visit_id = $1 AND status = 'done'", [visit.id]);
    const { tc } = await q1('SELECT COUNT(*)::int AS tc FROM tasks WHERE visit_id = $1', [visit.id]);
    const { pc } = await q1('SELECT COUNT(*)::int AS pc FROM photos WHERE visit_id = $1', [visit.id]);
    const summary = `Job #${visit.id} completed by ${req.user.name} at ${updated.property_name}: ` +
      `${updated.duration_minutes} min, tasks ${dc}/${tc} done, ${pc} photo(s).`;
    await pool.query(`
      INSERT INTO notifications (user_id, visit_id, type, message)
      SELECT id, $1, 'job_summary', $2 FROM users WHERE role IN ('admin','supervisor') AND active`,
      [visit.id, summary]);

    await rollRecurringJob(visit, req.user.id);
  }
  res.redirect(`/visits/${visit.id}`);
}));

/**
 * After an occurrence of a recurring site job completes: record the
 * completion time on the job and schedule the next visit per the job's
 * frequency (assigned to the job's default gardener), while the contract
 * is active and within its term.
 */
async function rollRecurringJob(visit, actorId) {
  if (!visit.job_id) return;
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [visit.job_id]);
  if (!job) return;
  await q('UPDATE jobs SET last_completed_at = now() WHERE id = $1', [job.id]);
  if (!job.active) return;
  const next = nextDate(visit.scheduled_date, job.frequency);
  if (next > job.end_date) return; // contract term over
  const exists = await q1(
    `SELECT id FROM visits WHERE job_id = $1 AND scheduled_date >= $2 AND status = 'scheduled' LIMIT 1`,
    [job.id, next]);
  if (exists) return; // next occurrence already on the books
  await q(`
    INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, time_window, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.id, job.property_id, job.gardener_id, next, job.time_window, actorId]);
  await logActivity(null, 'job.roll', 'job', job.id,
    `Scheduled next ${job.frequency} visit for job #${job.id} on ${next}`);
}

// Comments on a job (supervisors, admins and the assigned gardener).
// Photos can be attached, and the other party is notified: commenting staff
// notify the assigned gardener; a commenting gardener notifies staff.
router.post('/:id/comments', upload.array('photos', 10), asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const body = (req.body.body || '').trim();
  const files = req.files || [];
  if (body || files.length) {
    const comment = await q1(
      'INSERT INTO visit_comments (visit_id, user_id, body) VALUES ($1, $2, $3) RETURNING id',
      [visit.id, req.user.id, body || '(photo)']);
    for (const f of files) {
      await savePhoto(f, { visitId: visit.id, commentId: comment.id, userId: req.user.id });
    }
    await logActivity(req.user.id, 'visit.comment', 'visit', visit.id,
      `Commented on job #${visit.id}${files.length ? ` with ${files.length} photo(s)` : ''}`);

    const message = `${req.user.name} commented on job #${visit.id} (${visit.property_name}): ` +
      `${body.slice(0, 120)}${files.length ? ` [${files.length} photo(s)]` : ''}`;
    if (req.user.id === visit.gardener_id) {
      await pool.query(`
        INSERT INTO notifications (user_id, visit_id, type, message)
        SELECT id, $1, 'comment', $2 FROM users WHERE role IN ('admin','supervisor') AND active`,
        [visit.id, message]);
    } else if (visit.gardener_id) {
      await q('INSERT INTO notifications (user_id, visit_id, type, message) VALUES ($1, $2, $3, $4)',
        [visit.gardener_id, visit.id, 'comment', message]);
    }
  }
  res.redirect(`/visits/${visit.id}#comments`);
}));

// Photo upload for a job
router.post('/:id/photos', upload.array('photos', 10), asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const shared = req.body.shared === 'on' || req.body.shared === '1';
  for (const f of req.files || []) {
    await savePhoto(f, { caption: req.body.caption || null, visitId: visit.id, userId: req.user.id, shared });
  }
  if ((req.files || []).length) {
    await logActivity(req.user.id, 'photo.upload', 'visit', visit.id,
      `Uploaded ${req.files.length} photo(s) to job #${visit.id}`);
  }
  res.redirect(`/visits/${visit.id}#photos`);
}));

// Add a task to a visit
router.post('/:id/tasks', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const title = (req.body.title || '').trim();
  if (title) {
    const { id } = await q1(`
      INSERT INTO tasks (visit_id, assignee_id, title, description, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [visit.id, visit.gardener_id, title, req.body.description || null, req.user.id]);
    await logActivity(req.user.id, 'task.create', 'task', id, `Added task "${title}" to job #${visit.id}`);
  }
  res.redirect(`/visits/${visit.id}#tasks`);
}));

module.exports = router;
