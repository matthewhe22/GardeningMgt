const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { sendRemindersForDate } = require('../reminders');

const router = express.Router();

// --- Activity log & bulk reminders: supervisors and admins ---

router.get('/activity', requireRole('supervisor'), (req, res) => {
  const entries = db.prepare(`
    SELECT a.*, u.name AS user_name FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 300`).all();
  res.render('admin/activity', { title: 'Activity log', entries });
});

router.post('/reminders/bulk', requireRole('supervisor'), (req, res) => {
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const sent = sendRemindersForDate(date, { actorId: req.user.id, force: req.body.force === 'on' });
  res.redirect(`/admin/reminders?date=${date}&sent=${sent}`);
});

router.get('/reminders', requireRole('supervisor'), (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const pending = db.prepare(`
    SELECT v.*, p.name AS property_name, u.name AS gardener_name
    FROM visits v JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date = ? AND v.status = 'scheduled'
    ORDER BY u.name, COALESCE(v.route_order, 999)`).all(date);
  res.render('admin/reminders', { title: 'Visit reminders', date, pending, sent: req.query.sent });
});

// --- Properties: supervisors and admins ---

router.get('/properties', requireRole('supervisor'), (req, res) => {
  const properties = db.prepare('SELECT * FROM properties ORDER BY name').all();
  res.render('admin/properties', { title: 'Properties', properties });
});

router.post('/properties', requireRole('supervisor'), (req, res) => {
  const { name, address, contact_name, contact_phone, lat, lng, notes } = req.body;
  if (!(name || '').trim() || !(address || '').trim()) return res.redirect('/admin/properties');
  const info = db.prepare(`
    INSERT INTO properties (name, address, contact_name, contact_phone, lat, lng, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(name.trim(), address.trim(), contact_name || null, contact_phone || null,
      lat ? Number(lat) : null, lng ? Number(lng) : null, notes || null);
  logActivity(req.user.id, 'property.create', 'property', info.lastInsertRowid, `Added property "${name.trim()}"`);
  res.redirect('/admin/properties');
});

// --- User management: admin only ---

router.get('/users', requireRole(), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, phone, active, created_at FROM users ORDER BY role, name').all();
  res.render('admin/users', { title: 'Users', users });
});

router.post('/users', requireRole(), (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!(name || '').trim() || !(email || '').trim() || !password || !['admin', 'supervisor', 'gardener'].includes(role)) {
    return res.redirect('/admin/users');
  }
  try {
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)`)
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), role, phone || null);
    logActivity(req.user.id, 'user.create', 'user', info.lastInsertRowid, `Created ${role} account for ${name.trim()}`);
  } catch (e) {
    // duplicate email — fall through to the list
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle', requireRole(), (req, res) => {
  if (Number(req.params.id) !== req.user.id) {
    db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(req.params.id);
    logActivity(req.user.id, 'user.toggle', 'user', Number(req.params.id), `Toggled active state of user #${req.params.id}`);
  }
  res.redirect('/admin/users');
});

module.exports = router;
