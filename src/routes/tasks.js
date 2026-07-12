const express = require('express');
const { q, q1 } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const { pageParam, paginate } = require('../pagination');

const router = express.Router();

// Redirect back to wherever the user came from (the tasks list or a visit's
// detail page both link to this action), but never to an attacker-controlled
// referer: only follow it if it actually parses as same-origin as this
// request, otherwise fall back. Same-site session cookies already mitigate
// the real-world risk, but there's no reason to trust the raw header either.
function safeRedirectBack(req, res, fallback) {
  const ref = req.get('referer');
  if (ref) {
    try {
      const refUrl = new URL(ref);
      if (`${refUrl.protocol}//${refUrl.host}` === `${req.protocol}://${req.get('host')}`) {
        return res.redirect(ref);
      }
    } catch (e) { /* unparseable referer: fall through to fallback */ }
  }
  res.redirect(fallback);
}

router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const status = req.query.status || '';
  const where = [];
  const args = [];
  if (status) { args.push(status); where.push(`t.status = $${args.length}`); }
  if (!staff) { args.push(req.user.id); where.push(`(t.assignee_id = $${args.length} OR v.gardener_id = $${args.length})`); }
  const page = pageParam(req);
  const tasksSql = `
    SELECT t.*, u.name AS assignee_name, v.scheduled_date, p.name AS property_name, v.id AS visit_ref
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN visits v ON v.id = t.visit_id
    LEFT JOIN properties p ON p.id = v.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (t.status = 'done'), COALESCE(t.due_date, v.scheduled_date, '9999-12-31')`;
  const { rows: tasks, total, totalPages } = await paginate(q, tasksSql, args, page);
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  res.render('tasks/index', { title: 'Tasks', tasks, gardeners, staff, status, page, total, totalPages });
}));

// Standalone task (not tied to a visit)
router.post('/', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { title, description, assignee_id, due_date } = req.body;
  if ((title || '').trim()) {
    const { id } = await q1(`
      INSERT INTO tasks (title, description, assignee_id, due_date, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title.trim(), description || null, assignee_id || null, due_date || null, req.user.id]);
    await logActivity(req.user.id, 'task.create', 'task', id, `Created task "${title.trim()}"`);
  }
  res.redirect('/tasks');
}));

router.post('/:id/status', asyncHandler(async (req, res) => {
  const task = await q1(`
    SELECT t.*, v.gardener_id FROM tasks t LEFT JOIN visits v ON v.id = t.visit_id WHERE t.id = $1`,
    [req.params.id]);
  if (!task) return res.redirect('/tasks');
  const mine = task.assignee_id === req.user.id || task.gardener_id === req.user.id;
  if (!isStaff(req.user) && !mine) return res.redirect('/tasks');
  const status = req.body.status;
  if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) return res.redirect('/tasks');
  await q(`UPDATE tasks SET status = $1, completed_at = CASE WHEN $1 = 'done' THEN now() ELSE NULL END WHERE id = $2`,
    [status, task.id]);
  await logActivity(req.user.id, 'task.status', 'task', task.id, `Task "${task.title}": ${task.status} -> ${status}`);
  safeRedirectBack(req, res, '/tasks');
}));

module.exports = router;
