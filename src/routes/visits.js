const express = require('express');
const db = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { upload } = require('../upload');

const router = express.Router();

function getVisit(id) {
  return db.prepare(`
    SELECT v.*, p.name AS property_name, p.address, p.lat, p.lng, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.id = ?`).get(id);
}

function canSeeVisit(user, visit) {
  return isStaff(user) || visit.gardener_id === user.id;
}

// List (staff see all; gardeners see their own). Filter by date / gardener.
router.get('/', (req, res) => {
  const staff = isStaff(req.user);
  const date = req.query.date || '';
  const gardenerId = staff ? (req.query.gardener_id || '') : String(req.user.id);
  const where = [];
  const args = [];
  if (date) { where.push('v.scheduled_date = ?'); args.push(date); }
  if (gardenerId) { where.push('v.gardener_id = ?'); args.push(gardenerId); }
  const visits = db.prepare(`
    SELECT v.*, p.name AS property_name, p.address, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.scheduled_date DESC, COALESCE(v.route_order, 999)
    LIMIT 200`).all(...args);
  const gardeners = db.prepare("SELECT id, name FROM users WHERE role = 'gardener' AND active = 1").all();
  const properties = db.prepare('SELECT id, name FROM properties ORDER BY name').all();
  res.render('visits/index', { title: 'Visits / Jobs', visits, gardeners, properties, staff, date, gardenerId });
});

// Create (staff only)
router.post('/', requireRole('supervisor'), (req, res) => {
  const { property_id, gardener_id, scheduled_date, time_window, notes } = req.body;
  const info = db.prepare(`
    INSERT INTO visits (property_id, gardener_id, scheduled_date, time_window, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(property_id, gardener_id || null, scheduled_date, time_window || null, notes || null, req.user.id);
  logActivity(req.user.id, 'visit.create', 'visit', info.lastInsertRowid,
    `Scheduled visit #${info.lastInsertRowid} for ${scheduled_date}`);
  res.redirect(`/visits/${info.lastInsertRowid}`);
});

// Detail: tasks, photos, comments, invoice, timer
router.get('/:id', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit) return res.status(404).render('error', { title: 'Not found', message: 'Visit not found.' });
  if (!canSeeVisit(req.user, visit)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Not your visit.' });
  }
  const tasks = db.prepare('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.visit_id = ? ORDER BY t.id').all(visit.id);
  const photos = db.prepare('SELECT ph.*, u.name AS uploader_name FROM photos ph LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.visit_id = ? ORDER BY ph.created_at DESC').all(visit.id);
  const comments = db.prepare('SELECT c.*, u.name AS author_name, u.role AS author_role FROM visit_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.visit_id = ? ORDER BY c.created_at').all(visit.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(visit.id);
  const gardeners = db.prepare("SELECT id, name FROM users WHERE role = 'gardener' AND active = 1").all();
  const gpsPoints = db.prepare('SELECT * FROM gps_points WHERE visit_id = ? ORDER BY recorded_at').all(visit.id);
  res.render('visits/show', {
    title: `Job #${visit.id} — ${visit.property_name}`,
    visit, tasks, photos, comments, invoice, gardeners, gpsPoints, staff: isStaff(req.user),
  });
});

// Update core fields (staff)
router.post('/:id/update', requireRole('supervisor'), (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit) return res.redirect('/visits');
  const { gardener_id, scheduled_date, time_window, status, notes, duration_minutes } = req.body;
  db.prepare(`
    UPDATE visits SET gardener_id = ?, scheduled_date = ?, time_window = ?, status = ?, notes = ?,
      duration_minutes = ?
    WHERE id = ?`)
    .run(gardener_id || null, scheduled_date, time_window || null, status, notes || null,
      duration_minutes ? Number(duration_minutes) : visit.duration_minutes, visit.id);
  logActivity(req.user.id, 'visit.update', 'visit', visit.id,
    `Updated visit #${visit.id} (status: ${visit.status} -> ${status})`);
  res.redirect(`/visits/${visit.id}`);
});

// Status shortcut for gardeners (complete / skip)
router.post('/:id/status', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const status = req.body.status;
  if (!['scheduled', 'in_progress', 'completed', 'skipped'].includes(status)) return res.redirect(`/visits/${visit.id}`);
  db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(status, visit.id);
  logActivity(req.user.id, 'visit.status', 'visit', visit.id, `Visit #${visit.id}: ${visit.status} -> ${status}`);
  res.redirect(`/visits/${visit.id}`);
});

function recordGps(visitId, userId, body, kind) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    db.prepare('INSERT INTO gps_points (visit_id, user_id, lat, lng, kind) VALUES (?, ?, ?, ?, ?)')
      .run(visitId, userId, lat, lng, kind);
    return true;
  }
  return false;
}

// Job timer: start (captures the gardener's GPS position if provided)
router.post('/:id/timer/start', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  db.prepare(`UPDATE visits SET started_at = datetime('now'), finished_at = NULL, status = 'in_progress' WHERE id = ?`).run(visit.id);
  const gps = recordGps(visit.id, req.user.id, req.body, 'start');
  logActivity(req.user.id, 'visit.timer.start', 'visit', visit.id,
    `Started job timer on visit #${visit.id}${gps ? ' (GPS recorded)' : ''}`);
  res.redirect(`/visits/${visit.id}`);
});

// GPS ping while working (called periodically by the mobile UI)
router.post('/:id/gps', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.status(403).json({ ok: false });
  recordGps(visit.id, req.user.id, req.body, 'ping');
  res.json({ ok: true });
});

// Job timer: stop (computes duration, marks completed, notifies supervisors/admins)
router.post('/:id/timer/stop', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  if (visit.started_at) {
    db.prepare(`
      UPDATE visits SET finished_at = datetime('now'),
        duration_minutes = CAST(ROUND((julianday('now') - julianday(started_at)) * 24 * 60) AS INTEGER),
        status = 'completed'
      WHERE id = ?`).run(visit.id);
    recordGps(visit.id, req.user.id, req.body, 'finish');
    const updated = getVisit(visit.id);
    logActivity(req.user.id, 'visit.timer.stop', 'visit', visit.id,
      `Finished job #${visit.id} in ${updated.duration_minutes} min`);

    // Job summary -> every supervisor and admin, in-app.
    const doneTasks = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE visit_id = ? AND status = 'done'").get(visit.id).c;
    const totalTasks = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE visit_id = ?').get(visit.id).c;
    const photoCount = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE visit_id = ?').get(visit.id).c;
    const summary = `Job #${visit.id} completed by ${req.user.name} at ${updated.property_name}: ` +
      `${updated.duration_minutes} min, tasks ${doneTasks}/${totalTasks} done, ${photoCount} photo(s).`;
    const staffUsers = db.prepare("SELECT id FROM users WHERE role IN ('admin','supervisor') AND active = 1").all();
    const insert = db.prepare("INSERT INTO notifications (user_id, visit_id, type, message) VALUES (?, ?, 'job_summary', ?)");
    db.transaction(() => staffUsers.forEach((u) => insert.run(u.id, visit.id, summary)))();
  }
  res.redirect(`/visits/${visit.id}`);
});

// Comments on a job (supervisors, admins and the assigned gardener)
router.post('/:id/comments', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const body = (req.body.body || '').trim();
  if (body) {
    db.prepare('INSERT INTO visit_comments (visit_id, user_id, body) VALUES (?, ?, ?)')
      .run(visit.id, req.user.id, body);
    logActivity(req.user.id, 'visit.comment', 'visit', visit.id, `Commented on job #${visit.id}`);
  }
  res.redirect(`/visits/${visit.id}#comments`);
});

// Photo upload for a job
router.post('/:id/photos', upload.array('photos', 10), (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const insert = db.prepare(`
    INSERT INTO photos (filename, original_name, caption, visit_id, uploaded_by, shared)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const shared = req.body.shared === 'on' || req.body.shared === '1' ? 1 : 0;
  for (const f of req.files || []) {
    insert.run(f.filename, f.originalname, req.body.caption || null, visit.id, req.user.id, shared);
  }
  if ((req.files || []).length) {
    logActivity(req.user.id, 'photo.upload', 'visit', visit.id,
      `Uploaded ${req.files.length} photo(s) to job #${visit.id}`);
  }
  res.redirect(`/visits/${visit.id}#photos`);
});

// Add a task to a visit
router.post('/:id/tasks', (req, res) => {
  const visit = getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const title = (req.body.title || '').trim();
  if (title) {
    const info = db.prepare(`
      INSERT INTO tasks (visit_id, assignee_id, title, description, created_by)
      VALUES (?, ?, ?, ?, ?)`)
      .run(visit.id, visit.gardener_id, title, req.body.description || null, req.user.id);
    logActivity(req.user.id, 'task.create', 'task', info.lastInsertRowid, `Added task "${title}" to job #${visit.id}`);
  }
  res.redirect(`/visits/${visit.id}#tasks`);
});

module.exports = router;
