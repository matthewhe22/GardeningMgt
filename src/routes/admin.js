const express = require('express');
const bcrypt = require('bcryptjs');
const { q, q1 } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { sendRemindersForDate } = require('../reminders');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

// --- Activity log & bulk reminders: supervisors and admins ---

router.get('/activity', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const entries = await q(`
    SELECT a.*, u.name AS user_name FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 300`);
  res.render('admin/activity', { title: 'Activity log', entries });
}));

router.post('/reminders/bulk', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const sent = await sendRemindersForDate(date, { actorId: req.user.id, force: req.body.force === 'on' });
  res.redirect(`/admin/reminders?date=${date}&sent=${sent}`);
}));

router.get('/reminders', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const pending = await q(`
    SELECT v.*, p.name AS property_name, u.name AS gardener_name
    FROM visits v JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date = $1 AND v.status = 'scheduled'
    ORDER BY u.name, COALESCE(v.route_order, 999)`, [date]);
  res.render('admin/reminders', { title: 'Visit reminders', date, pending, sent: req.query.sent });
}));

// --- Properties: supervisors and admins ---

router.get('/properties', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const properties = await q('SELECT * FROM properties ORDER BY name');
  res.render('admin/properties', { title: 'Properties', properties });
}));

router.post('/properties', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { name, address, contact_name, contact_phone, lat, lng, notes } = req.body;
  if (!(name || '').trim() || !(address || '').trim()) return res.redirect('/admin/properties');
  const { id } = await q1(`
    INSERT INTO properties (name, address, contact_name, contact_phone, lat, lng, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [name.trim(), address.trim(), contact_name || null, contact_phone || null,
      lat ? Number(lat) : null, lng ? Number(lng) : null, notes || null]);
  await logActivity(req.user.id, 'property.create', 'property', id, `Added property "${name.trim()}"`);
  res.redirect('/admin/properties');
}));

// --- User management: admin only ---

router.get('/users', requireRole(), asyncHandler(async (req, res) => {
  const users = await q('SELECT id, name, email, role, phone, active, created_at FROM users ORDER BY role, name');
  res.render('admin/users', { title: 'Users', users });
}));

router.post('/users', requireRole(), asyncHandler(async (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!(name || '').trim() || !(email || '').trim() || !password || !['admin', 'supervisor', 'gardener'].includes(role)) {
    return res.redirect('/admin/users');
  }
  try {
    const { id } = await q1(`
      INSERT INTO users (name, email, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), role, phone || null]);
    await logActivity(req.user.id, 'user.create', 'user', id, `Created ${role} account for ${name.trim()}`);
  } catch (e) {
    // duplicate email — fall through to the list
  }
  res.redirect('/admin/users');
}));

router.post('/users/:id/toggle', requireRole(), asyncHandler(async (req, res) => {
  if (Number(req.params.id) !== req.user.id) {
    await q('UPDATE users SET active = NOT active WHERE id = $1', [req.params.id]);
    await logActivity(req.user.id, 'user.toggle', 'user', Number(req.params.id), `Toggled active state of user #${req.params.id}`);
  }
  res.redirect('/admin/users');
}));

module.exports = router;
