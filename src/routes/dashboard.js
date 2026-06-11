const express = require('express');
const db = require('../db');
const { isStaff } = require('../auth');

const router = express.Router();

router.get('/', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const me = req.user;
  const staff = isStaff(me);

  const visitFilter = staff ? '' : 'AND v.gardener_id = ?';
  const visitArgs = staff ? [today] : [today, me.id];
  const todayVisits = db.prepare(`
    SELECT v.*, p.name AS property_name, p.address, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date = ? ${visitFilter}
    ORDER BY COALESCE(v.route_order, 999), v.time_window
  `).all(...visitArgs);

  const myTasks = db.prepare(`
    SELECT t.*, v.scheduled_date, p.name AS property_name
    FROM tasks t
    LEFT JOIN visits v ON v.id = t.visit_id
    LEFT JOIN properties p ON p.id = v.property_id
    WHERE t.status IN ('pending','in_progress')
      ${staff ? '' : 'AND (t.assignee_id = ? OR v.gardener_id = ?)'}
    ORDER BY COALESCE(t.due_date, v.scheduled_date, '9999')
    LIMIT 15
  `).all(...(staff ? [] : [me.id, me.id]));

  const openIssues = db.prepare(`
    SELECT i.*, p.name AS property_name, u.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users u ON u.id = i.assigned_to
    WHERE i.status IN ('open','in_progress')
      ${staff ? '' : 'AND (i.assigned_to = ? OR i.reported_by = ?)'}
    ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 10
  `).all(...(staff ? [] : [me.id, me.id]));

  res.render('dashboard', { title: 'Dashboard', today, todayVisits, myTasks, openIssues, staff });
});

module.exports = router;
