const express = require('express');
const { q } = require('../db');
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

module.exports = router;
