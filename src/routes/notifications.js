const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const notifications = db.prepare(`
    SELECT n.*, v.scheduled_date FROM notifications n
    LEFT JOIN visits v ON v.id = n.visit_id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`).all(req.user.id);
  res.render('notifications/index', { title: 'Notifications', notifications });
});

router.post('/read-all', (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .run(req.user.id);
  res.redirect('/notifications');
});

module.exports = router;
