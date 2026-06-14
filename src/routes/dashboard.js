const express = require('express');
const { q } = require('../db');
const { isStaff } = require('../auth');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday } = require('../time');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const today = businessToday();
  const me = req.user;
  const staff = isStaff(me);

  // These three are independent — run them concurrently rather than waiting
  // for each round-trip in turn.
  const [todayVisits, myTasks, openIssues] = await Promise.all([
    q(`
    SELECT v.*, p.name AS property_name, p.address, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date = $1 ${staff ? '' : 'AND v.gardener_id = $2'}
    ORDER BY COALESCE(v.route_order, 999), v.time_window`,
      staff ? [today] : [today, me.id]),
    q(`
    SELECT t.*, v.scheduled_date, p.name AS property_name
    FROM tasks t
    LEFT JOIN visits v ON v.id = t.visit_id
    LEFT JOIN properties p ON p.id = v.property_id
    WHERE t.status IN ('pending','in_progress')
      ${staff ? '' : 'AND (t.assignee_id = $1 OR v.gardener_id = $1)'}
    ORDER BY COALESCE(t.due_date, v.scheduled_date, '9999-12-31')
    LIMIT 15`,
      staff ? [] : [me.id]),
    q(`
    SELECT i.*, p.name AS property_name, u.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users u ON u.id = i.assigned_to
    WHERE i.status IN ('open','in_progress')
      ${staff ? '' : 'AND (i.assigned_to = $1 OR i.reported_by = $1)'}
    ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 10`,
      staff ? [] : [me.id]),
  ]);

  res.render('dashboard', { title: 'Dashboard', today, todayVisits, myTasks, openIssues, staff });
}));

module.exports = router;
