const express = require('express');
const { q, q1 } = require('../db');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const notifications = await q(`
    SELECT n.*, v.scheduled_date FROM notifications n
    LEFT JOIN visits v ON v.id = n.visit_id
    WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [req.user.id]);
  res.render('notifications/index', { title: 'Notifications', notifications });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.redirect('/notifications');
}));

// Mark a single notification read (stays on the list).
router.post('/:id/read', asyncHandler(async (req, res) => {
  await q('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [Number(req.params.id), req.user.id]);
  res.redirect('/notifications');
}));

// Open the linked job: mark this notification read, then go to the visit.
router.get('/:id/open', asyncHandler(async (req, res) => {
  const n = await q1('SELECT visit_id FROM notifications WHERE id = $1 AND user_id = $2',
    [Number(req.params.id), req.user.id]);
  if (!n) return res.redirect('/notifications');
  await q('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [Number(req.params.id), req.user.id]);
  res.redirect(n.visit_id ? `/visits/${n.visit_id}` : '/notifications');
}));

module.exports = router;
