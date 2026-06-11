const express = require('express');
const db = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { optimizeRoute, haversineKm } = require('../routeOptimizer');

const router = express.Router();

function loadDayVisits(gardenerId, date) {
  return db.prepare(`
    SELECT v.*, p.name AS property_name, p.address, p.lat, p.lng
    FROM visits v JOIN properties p ON p.id = v.property_id
    WHERE v.gardener_id = ? AND v.scheduled_date = ? AND v.status != 'cancelled'
    ORDER BY COALESCE(v.route_order, 999), v.id`).all(gardenerId, date);
}

// Route planner: pick gardener + date, view ordered stops, optimize.
router.get('/', (req, res) => {
  const staff = isStaff(req.user);
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const gardenerId = staff ? Number(req.query.gardener_id || 0) : req.user.id;
  const gardeners = db.prepare("SELECT id, name FROM users WHERE role = 'gardener' AND active = 1").all();
  const visits = gardenerId ? loadDayVisits(gardenerId, date) : [];

  let totalKm = 0;
  for (let i = 1; i < visits.length; i++) {
    const a = visits[i - 1];
    const b = visits[i];
    if (a.lat != null && b.lat != null) totalKm += haversineKm(a, b);
  }
  res.render('routes/index', { title: 'Route planner', staff, date, gardenerId, gardeners, visits, totalKm });
});

// Optimize a gardener's day (staff, or the gardener for their own day)
router.post('/optimize', (req, res) => {
  const date = req.body.date;
  const gardenerId = isStaff(req.user) ? Number(req.body.gardener_id) : req.user.id;
  if (!gardenerId || !date) return res.redirect('/routes');

  const visits = loadDayVisits(gardenerId, date);
  const { orderedIds, lengthKm } = optimizeRoute(
    visits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng }))
  );
  const setOrder = db.prepare('UPDATE visits SET route_order = ? WHERE id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, idx) => setOrder.run(idx + 1, id));
  })();
  logActivity(req.user.id, 'route.optimize', 'visit', null,
    `Optimized route for gardener #${gardenerId} on ${date}: ${orderedIds.length} stops, ~${lengthKm.toFixed(1)} km`);
  res.redirect(`/routes?date=${date}&gardener_id=${gardenerId}`);
});

// Optimize all gardeners for a date in one go (staff)
router.post('/optimize-all', requireRole('supervisor'), (req, res) => {
  const date = req.body.date;
  const gardeners = db.prepare("SELECT id FROM users WHERE role = 'gardener' AND active = 1").all();
  let total = 0;
  for (const g of gardeners) {
    const visits = loadDayVisits(g.id, date);
    if (!visits.length) continue;
    const { orderedIds } = optimizeRoute(visits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    const setOrder = db.prepare('UPDATE visits SET route_order = ? WHERE id = ?');
    db.transaction(() => orderedIds.forEach((id, idx) => setOrder.run(idx + 1, id)))();
    total += visits.length;
  }
  logActivity(req.user.id, 'route.optimize_all', 'visit', null,
    `Optimized all routes for ${date} (${total} visits)`);
  res.redirect(`/routes?date=${date}`);
});

module.exports = router;
