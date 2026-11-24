// Admin clean-up of old work that was never closed:
//   • overdue visits — still "scheduled" though their date has passed;
//   • stuck jobs — started ("in progress") but never completed.
// Both are marked skipped (missed) or cancelled in bulk. Nothing is deleted:
// photos, checklists and tasks stay on each visit, and the activity log keeps
// the ids of every visit changed. The daily job books the next visit for any
// contract that is left with none.
const express = require('express');
const { q, q1 } = require('../db');
const { requireRole } = require('../auth');
const { assertCsrf } = require('../csrf');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday, fmtDateTime } = require('../time');
const { isValidDate } = require('../recurrence');

/** 'YYYY-MM-DD' plus n days. */
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const router = express.Router();
router.use(requireRole());

/** A job counts as stuck once it has been in progress for this long. */
const STUCK_HOURS = 12;
const STUCK_SQL = `v.status = 'in_progress' AND (v.started_at < now() - interval '${STUCK_HOURS} hours' OR v.scheduled_date < $1)`;

/** Overdue visits are those dated before `before` (never later than yesterday). */
function cutoff(req) {
  const today = businessToday();
  const raw = req.query.before || (req.body && req.body.before);
  const def = addDays(today, -7);
  const before = isValidDate(raw) ? raw : def;
  return before > today ? today : before;
}

router.get('/', asyncHandler(async (req, res) => {
  const today = businessToday();
  const before = cutoff(req);
  const [byMonth, stuck, newestOverdue] = await Promise.all([
    q(`SELECT to_char(date_trunc('month', scheduled_date), 'YYYY-MM') AS month, COUNT(*)::int AS n
       FROM visits WHERE status = 'scheduled' AND scheduled_date < $1 GROUP BY 1 ORDER BY 1`, [before]),
    q(`SELECT v.id, v.scheduled_date, v.started_at, p.name AS property_name, u.name AS gardener_name,
         (SELECT COUNT(*)::int FROM photos ph WHERE ph.visit_id = v.id) AS photos,
         (SELECT COUNT(*)::int FROM visit_scope_checks c WHERE c.visit_id = v.id) AS checks,
         (SELECT COUNT(*)::int FROM visit_scope_checks c WHERE c.visit_id = v.id AND c.done) AS checks_done
       FROM visits v
       LEFT JOIN properties p ON p.id = v.property_id
       LEFT JOIN users u ON u.id = v.gardener_id
       WHERE ${STUCK_SQL} ORDER BY v.started_at`, [today]),
    q1(`SELECT COUNT(*)::int AS n FROM visits WHERE status = 'scheduled' AND scheduled_date < $1 AND scheduled_date >= $2`,
      [today, before]),
  ]);
  const overdueTotal = byMonth.reduce((s, r) => s + r.n, 0);
  res.render('admin/cleanup', {
    title: 'Clean up old jobs', today, before, byMonth, overdueTotal, stuck, keptRecent: newestOverdue.n,
    stuckHours: STUCK_HOURS, fmtDateTime,
    done: req.query.done || null, n: Number(req.query.n) || 0, flash: req.query.error || null,
  });
}));

const ACTIONS = { skipped: 'skipped (missed)', cancelled: 'cancelled' };

// Overdue visits dated before the cutoff → skipped / cancelled.
router.post('/overdue', asyncHandler(async (req, res) => {
  assertCsrf(req);
  const before = cutoff(req);
  const status = req.body.action;
  if (!ACTIONS[status]) return res.redirect(`/admin/cleanup?before=${before}`);
  if (req.body.confirm !== 'on') return res.redirect(`/admin/cleanup?before=${before}&error=confirm`);
  const rows = await q(`
    UPDATE visits SET status = $2, advanced_at = COALESCE(advanced_at, now())
    WHERE status = 'scheduled' AND scheduled_date < $1
    RETURNING id`, [before, status]);
  const ids = rows.map((r) => r.id).sort((a, b) => a - b);
  if (ids.length) {
    await logActivity(req.user.id, 'visit.bulk_cleanup', 'visit', null,
      `Marked ${ids.length} overdue visit(s) dated before ${before} as ${ACTIONS[status]}: #${ids.join(', #')}`);
  }
  res.redirect(`/admin/cleanup?before=${before}&done=overdue&n=${ids.length}`);
}));

// Selected stuck jobs → skipped / cancelled.
router.post('/stuck', asyncHandler(async (req, res) => {
  assertCsrf(req);
  const status = req.body.action;
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ACTIONS[status]) return res.redirect('/admin/cleanup');
  if (!ids.length) return res.redirect('/admin/cleanup?error=none');
  // Only jobs that are still stuck: one completed in the meantime is left alone.
  const rows = await q(`
    UPDATE visits v SET status = $3, advanced_at = COALESCE(v.advanced_at, now())
    WHERE v.id = ANY($2::int[]) AND ${STUCK_SQL}
    RETURNING v.id`, [businessToday(), ids, status]);
  const changed = rows.map((r) => r.id).sort((a, b) => a - b);
  if (changed.length) {
    await logActivity(req.user.id, 'visit.bulk_cleanup', 'visit', null,
      `Marked ${changed.length} stuck in-progress job(s) as ${ACTIONS[status]}: #${changed.join(', #')}`);
  }
  res.redirect(`/admin/cleanup?done=stuck&n=${changed.length}`);
}));

module.exports = router;
