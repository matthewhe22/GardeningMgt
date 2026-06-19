const express = require('express');
const { q, q1, pool, withTransaction } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { upload, savePhoto } = require('../upload');
const { nextOccurrenceAfter, isValidDate } = require('../recurrence');
const { loadReportData, renderReportHtml, renderReportPdf, archiveToOneDrive } = require('../report');
const { asyncHandler } = require('../asyncHandler');
const { assertCsrf } = require('../csrf');
const { optimizeRouteRoad } = require('../routeOptimizer');
const { today } = require('../time');

const router = express.Router();

const VISIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'skipped', 'cancelled'];

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

// List (staff see all; gardeners see their own). Three quick scopes:
//   • upcoming (default): today onward, nearest first
//   • today (upto=<today>): on or before today — includes delayed/overdue
//   • all: full history + future
// plus an exact-day picker. All views are ordered nearest → future.
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const todayStr = today();
  const date = req.query.date || '';     // exact day (date picker)
  const upto = req.query.upto || '';     // on/before this day (Today + overdue)
  const showAll = req.query.all === '1'; // entire history + future
  // Drill-down filters (used by the Reports "visits by status" links): an
  // exact status and/or a from–to date window.
  const status = VISIT_STATUSES.includes(req.query.status) ? req.query.status : '';
  const from = req.query.from || '';
  const to = req.query.to || '';
  const gardenerId = staff ? (req.query.gardener_id || '') : String(req.user.id);
  const where = [];
  const args = [];
  if (gardenerId) { args.push(Number(gardenerId)); where.push(`v.gardener_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`v.status = $${args.length}`); }
  if (from || to) {
    // A from–to window takes precedence over the quick scopes.
    if (from) { args.push(from); where.push(`v.scheduled_date >= $${args.length}`); }
    if (to) { args.push(to); where.push(`v.scheduled_date <= $${args.length}`); }
  } else if (date) {
    args.push(date); where.push(`v.scheduled_date = $${args.length}`);
  } else if (upto) {
    args.push(upto); where.push(`v.scheduled_date <= $${args.length}`);
  } else if (!showAll) {
    args.push(todayStr); where.push(`v.scheduled_date >= $${args.length}`);
  }
  // Every view reads nearest → future (ascending by date), then by visiting
  // order within the day. The visit list and the filter dropdowns are
  // independent, so fetch them in parallel to cut page latency.
  const [visits, gardeners, properties] = await Promise.all([
    q(`
    SELECT v.*, p.name AS property_name, p.address, p.lat, p.lng, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.scheduled_date ASC, COALESCE(v.route_order, 999), v.id
    LIMIT 200`, args),
    q("SELECT id, name FROM users WHERE role = 'gardener' AND active"),
    q('SELECT id, name FROM properties ORDER BY name'),
  ]);
  // Group consecutive visits by day so the list reads as a per-day route in
  // visiting sequence (route_order). Reordering / optimizing is offered per day
  // only when the list is scoped to a single gardener (one route to order).
  const groups = [];
  for (const v of visits) {
    let g = groups[groups.length - 1];
    if (!g || g.date !== v.scheduled_date) { g = { date: v.scheduled_date, items: [] }; groups.push(g); }
    g.items.push(v);
  }
  // Reordering only makes sense for a single gardener's plain day view, not a
  // status / date-range drill-down that can span many days.
  const filtered = !!(status || from || to);
  res.render('visits/index', {
    title: 'Visits / Jobs', visits, groups, gardeners, properties, staff,
    date, upto, showAll, status, from, to, gardenerId, today: todayStr,
    canReorder: !!gardenerId && !filtered,
  });
}));

// --- Per-day route ordering, available right on the Jobs page ---------------
// Scoped to one gardener + one day (a single route). Staff can order any
// gardener's day; a gardener can order their own.

function loadDayOrder(gardenerId, date) {
  return q(`
    SELECT v.id, p.lat, p.lng
    FROM visits v JOIN properties p ON p.id = v.property_id
    WHERE v.gardener_id = $1 AND v.scheduled_date = $2 AND v.status <> 'cancelled'
    ORDER BY COALESCE(v.route_order, 999), v.id`, [gardenerId, date]);
}

async function applyRouteOrder(orderedIds) {
  await withTransaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.q('UPDATE visits SET route_order = $1 WHERE id = $2', [i + 1, orderedIds[i]]);
    }
  });
}

function backToList(date, gardenerId) {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (gardenerId) qs.set('gardener_id', String(gardenerId));
  return `/visits${qs.toString() ? '?' + qs.toString() : ''}`;
}

// Optimize one gardener's day with the routing function (nearest-neighbour + 2-opt).
router.post('/optimize', asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardenerId = isStaff(req.user) ? Number(req.body.gardener_id) : req.user.id;
  if (!gardenerId || !isValidDate(date)) return res.redirect('/visits');
  const day = await loadDayOrder(gardenerId, date);
  if (day.length) {
    const { orderedIds, lengthKm, mode } = await optimizeRouteRoad(day.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    await applyRouteOrder(orderedIds);
    await logActivity(req.user.id, 'route.optimize', 'visit', null,
      `Optimized route (${mode === 'road' ? 'road distance' : 'straight-line'}) for gardener #${gardenerId} on ${date}: ${orderedIds.length} stops, ~${lengthKm.toFixed(1)} km`);
  }
  res.redirect(backToList(date, gardenerId));
}));

// Manually nudge a visit up/down within its day's visiting sequence.
router.post('/:id/move', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit) || !visit.gardener_id) return res.redirect('/visits');
  const day = await loadDayOrder(visit.gardener_id, visit.scheduled_date);
  const ids = day.map((d) => d.id);
  const idx = ids.indexOf(visit.id);
  const swap = idx + (req.body.dir === 'up' ? -1 : 1);
  if (idx >= 0 && swap >= 0 && swap < ids.length) {
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    await applyRouteOrder(ids);
    await logActivity(req.user.id, 'route.reorder', 'visit', visit.id,
      `Moved job #${visit.id} ${req.body.dir === 'up' ? 'earlier' : 'later'} in the ${visit.scheduled_date} route`);
  }
  res.redirect(backToList(visit.scheduled_date, visit.gardener_id) + `#v${visit.id}`);
}));

// Create (staff only)
router.post('/', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { property_id, gardener_id, scheduled_date, time_window, notes } = req.body;
  if (!Number(property_id) || !isValidDate(scheduled_date)) {
    return res.redirect('/visits?error=invalid');
  }
  const { id } = await q1(`
    INSERT INTO visits (property_id, gardener_id, scheduled_date, time_window, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [Number(property_id), gardener_id || null, scheduled_date, time_window || null, notes || null, req.user.id]);
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
  // All of these are independent of one another — fetch them concurrently so
  // the page costs one round-trip's worth of latency instead of eight.
  const [tasks, photos, comments, commentPhotos, invoice, gardeners, gpsPoints, job] = await Promise.all([
    q('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.visit_id = $1 ORDER BY t.id', [visit.id]),
    q('SELECT ph.id, ph.filename, ph.caption, ph.original_name, ph.created_at, u.name AS uploader_name FROM photos ph LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.visit_id = $1 AND ph.visit_comment_id IS NULL ORDER BY ph.created_at DESC', [visit.id]),
    q('SELECT c.*, u.name AS author_name, u.role AS author_role FROM visit_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.visit_id = $1 ORDER BY c.created_at', [visit.id]),
    q('SELECT ph.visit_comment_id, ph.filename, ph.created_at FROM photos ph WHERE ph.visit_id = $1 AND ph.visit_comment_id IS NOT NULL ORDER BY ph.created_at', [visit.id]),
    q1('SELECT * FROM invoices WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visit.id]),
    q("SELECT id, name FROM users WHERE role = 'gardener' AND active"),
    q('SELECT * FROM gps_points WHERE visit_id = $1 ORDER BY recorded_at', [visit.id]),
    visit.job_id
      ? q1('SELECT j.*, u.name AS default_gardener_name FROM jobs j LEFT JOIN users u ON u.id = j.gardener_id WHERE j.id = $1', [visit.job_id])
      : Promise.resolve(null),
  ]);
  const photosByComment = {};
  for (const ph of commentPhotos) (photosByComment[ph.visit_comment_id] ||= []).push(ph);
  res.render('visits/show', {
    title: `Job #${visit.id} — ${visit.property_name}`,
    visit, tasks, photos, comments, photosByComment, invoice, gardeners, gpsPoints, job,
    staff: isStaff(req.user), flash: req.query.error || null,
  });
}));

// Update core fields (staff)
router.post('/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit) return res.redirect('/visits');
  const { gardener_id, scheduled_date, time_window, status, notes, duration_minutes } = req.body;
  if (!VISIT_STATUSES.includes(status) || !isValidDate(scheduled_date)) {
    return res.redirect(`/visits/${visit.id}?error=invalid`);
  }
  // When staff mark a visit completed here, fill timing if missing so the
  // record (and report) is consistent with the timer path.
  const completing = status === 'completed' && visit.status !== 'completed';
  await q(`
    UPDATE visits SET gardener_id = $1, scheduled_date = $2, time_window = $3, status = $4, notes = $5,
      duration_minutes = $6,
      finished_at = CASE WHEN $4 = 'completed' AND finished_at IS NULL THEN now() ELSE finished_at END
    WHERE id = $7`,
    [gardener_id || null, scheduled_date, time_window || null, status, notes || null,
      duration_minutes ? Number(duration_minutes) : visit.duration_minutes, visit.id]);
  await logActivity(req.user.id, 'visit.update', 'visit', visit.id,
    `Updated visit #${visit.id} (status: ${visit.status} -> ${status})`);
  // Advance the recurring contract when this occurrence reaches a terminal state.
  if (['completed', 'skipped', 'cancelled'].includes(status) && status !== visit.status) {
    await advanceRecurringJob(visit, req.user.id, status === 'completed');
  }
  res.redirect(`/visits/${visit.id}`);
}));

// Reschedule: the assigned gardener (or staff) can set the date of a visit.
router.post('/:id/reschedule', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const date = req.body.scheduled_date;
  if (isValidDate(date)) {
    await q('UPDATE visits SET scheduled_date = $1, route_order = NULL WHERE id = $2', [date, visit.id]);
    await logActivity(req.user.id, 'visit.reschedule', 'visit', visit.id,
      `Moved job #${visit.id} from ${visit.scheduled_date} to ${date}`);
  }
  res.redirect(`/visits/${visit.id}`);
}));

// Status shortcut (gardeners: skip; staff: any). Advances the contract on a
// terminal status so a skipped/cancelled occurrence still schedules the next one.
router.post('/:id/status', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  const status = req.body.status;
  if (!['scheduled', 'in_progress', 'skipped', 'cancelled'].includes(status)) {
    return res.redirect(`/visits/${visit.id}`);
  }
  if (status === visit.status) return res.redirect(`/visits/${visit.id}`);
  await q('UPDATE visits SET status = $1 WHERE id = $2', [status, visit.id]);
  await logActivity(req.user.id, 'visit.status', 'visit', visit.id, `Visit #${visit.id}: ${visit.status} -> ${status}`);
  if (['skipped', 'cancelled'].includes(status)) await advanceRecurringJob(visit, req.user.id, false);
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

// Job complete (timer stop): requires confirming all photos are uploaded AND
// at least one photo on file, then records completion date/time, notifies
// staff, advances the recurring contract and archives to OneDrive.
// Idempotent: an atomic status gate prevents a double-tap from re-running it.
router.post('/:id/timer/stop', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) return res.redirect('/visits');
  if (!visit.started_at) return res.redirect(`/visits/${visit.id}`);
  if (req.body.confirm_photos !== 'on') {
    return res.redirect(`/visits/${visit.id}?error=confirm`);
  }
  // Enforce the photo requirement server-side (not just the honor checkbox).
  const { pc } = await q1('SELECT COUNT(*)::int AS pc FROM photos WHERE visit_id = $1', [visit.id]);
  if (pc === 0) return res.redirect(`/visits/${visit.id}?error=photos`);

  // Atomic gate: only the first request that flips status off 'completed' wins.
  const gate = await q1(`
    UPDATE visits SET finished_at = now(),
      duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - started_at)) / 60))::int,
      status = 'completed'
    WHERE id = $1 AND status <> 'completed'
    RETURNING id, duration_minutes`, [visit.id]);
  if (!gate) return res.redirect(`/visits/${visit.id}`); // already completed — no double side effects

  await recordGps(visit.id, req.user.id, req.body, 'finish');
  await logActivity(req.user.id, 'visit.timer.stop', 'visit', visit.id,
    `Finished job #${visit.id} in ${gate.duration_minutes} min`);

  const { dc } = await q1("SELECT COUNT(*)::int AS dc FROM tasks WHERE visit_id = $1 AND status = 'done'", [visit.id]);
  const { tc } = await q1('SELECT COUNT(*)::int AS tc FROM tasks WHERE visit_id = $1', [visit.id]);
  const summary = `Job #${visit.id} completed by ${req.user.name} at ${visit.property_name}: ` +
    `${gate.duration_minutes} min, tasks ${dc}/${tc} done, ${pc} photo(s).`;
  await pool.query(`
    INSERT INTO notifications (user_id, visit_id, type, message)
    SELECT id, $1, 'job_summary', $2 FROM users WHERE role IN ('admin','supervisor') AND active`,
    [visit.id, summary]);

  await advanceRecurringJob(visit, req.user.id, true);
  // Archive report + photos to OneDrive (best-effort; never blocks completion).
  await archiveToOneDrive(visit.id);
  res.redirect(`/visits/${visit.id}`);
}));

// Printable completion report for a job (also archived to OneDrive on completion).
router.get('/:id/report', asyncHandler(async (req, res) => {
  const visit = await getVisit(req.params.id);
  if (!visit || !canSeeVisit(req.user, visit)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Report not found.' });
  }
  const data = await loadReportData(visit.id);
  const slug = String(visit.property_name || 'job')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'job';
  // ?download=1 returns a PDF file; otherwise the report opens as HTML in the tab.
  if (req.query.download === '1') {
    const pdf = await renderReportPdf(data);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition',
      `attachment; filename="completion-report-${slug}-${visit.scheduled_date}.pdf"`);
    return res.send(pdf);
  }
  res.type('html').send(await renderReportHtml(data));
}));

/**
 * When an occurrence of a recurring site job reaches a terminal state
 * (completed / skipped / cancelled), schedule the next occurrence so the
 * contract never silently stops. The next date is anchored to the contract
 * start (no monthly drift) and inserted with ON CONFLICT DO NOTHING against
 * the partial unique index, so concurrent calls/double-taps can't double-book.
 * Only `completed` stamps last_completed_at.
 */
async function advanceRecurringJob(visit, actorId, completed) {
  if (!visit.job_id) return;
  const job = await q1('SELECT * FROM jobs WHERE id = $1', [visit.job_id]);
  if (!job) return;
  if (completed) await q('UPDATE jobs SET last_completed_at = now() WHERE id = $1', [job.id]);
  if (!job.active) return;
  const next = nextOccurrenceAfter(job.start_date, job.frequency, visit.scheduled_date);
  if (next > job.end_date) {
    // Contract term reached — flag for renewal rather than silently stopping.
    await q('UPDATE jobs SET renewal_acknowledged = false WHERE id = $1', [job.id]);
    return;
  }
  const inserted = await q1(`
    INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, time_window, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (job_id, scheduled_date) WHERE status = 'scheduled' AND job_id IS NOT NULL
    DO NOTHING RETURNING id`,
    [job.id, job.property_id, job.gardener_id, next, job.time_window, actorId]);
  if (inserted) {
    await logActivity(null, 'job.roll', 'job', job.id,
      `Scheduled next ${job.frequency} visit for job #${job.id} on ${next}`);
  }
}

// Comments on a job (supervisors, admins and the assigned gardener).
// Photos can be attached, and the other party is notified: commenting staff
// notify the assigned gardener; a commenting gardener notifies staff.
router.post('/:id/comments', upload.array('photos', 10), asyncHandler(async (req, res) => {
  assertCsrf(req);
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
  assertCsrf(req);
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
