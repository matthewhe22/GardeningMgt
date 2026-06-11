const express = require('express');
const db = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');

const router = express.Router();

router.get('/', (req, res) => {
  const staff = isStaff(req.user);
  const status = req.query.status || '';
  const where = [];
  const args = [];
  if (status) { where.push('t.status = ?'); args.push(status); }
  if (!staff) { where.push('(t.assignee_id = ? OR v.gardener_id = ?)'); args.push(req.user.id, req.user.id); }
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name, v.scheduled_date, p.name AS property_name, v.id AS visit_ref
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN visits v ON v.id = t.visit_id
    LEFT JOIN properties p ON p.id = v.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.status = 'done', COALESCE(t.due_date, v.scheduled_date, '9999')
    LIMIT 300`).all(...args);
  const gardeners = db.prepare("SELECT id, name FROM users WHERE role = 'gardener' AND active = 1").all();
  res.render('tasks/index', { title: 'Tasks', tasks, gardeners, staff, status });
});

// Standalone task (not tied to a visit)
router.post('/', requireRole('supervisor'), (req, res) => {
  const { title, description, assignee_id, due_date } = req.body;
  if ((title || '').trim()) {
    const info = db.prepare(`
      INSERT INTO tasks (title, description, assignee_id, due_date, created_by)
      VALUES (?, ?, ?, ?, ?)`)
      .run(title.trim(), description || null, assignee_id || null, due_date || null, req.user.id);
    logActivity(req.user.id, 'task.create', 'task', info.lastInsertRowid, `Created task "${title.trim()}"`);
  }
  res.redirect('/tasks');
});

router.post('/:id/status', (req, res) => {
  const task = db.prepare(`
    SELECT t.*, v.gardener_id FROM tasks t LEFT JOIN visits v ON v.id = t.visit_id WHERE t.id = ?`)
    .get(req.params.id);
  if (!task) return res.redirect('/tasks');
  const mine = task.assignee_id === req.user.id || task.gardener_id === req.user.id;
  if (!isStaff(req.user) && !mine) return res.redirect('/tasks');
  const status = req.body.status;
  if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) return res.redirect('back');
  db.prepare(`UPDATE tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END WHERE id = ?`)
    .run(status, status, task.id);
  logActivity(req.user.id, 'task.status', 'task', task.id, `Task "${task.title}": ${task.status} -> ${status}`);
  res.redirect(req.get('referer') || '/tasks');
});

module.exports = router;
