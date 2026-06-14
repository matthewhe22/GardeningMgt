const express = require('express');
const { q, pool } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { optimizeRouteRoad, haversineKm } = require('../routeOptimizer');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday } = require('../time');

const router = express.Router();

function loadDayVisits(gardenerId, date) {
  return q(`
    SELECT v.*, p.name AS property_name, p.address, p.lat, p.lng
    FROM visits v JOIN properties p ON p.id = v.property_id
    WHERE v.gardener_id = $1 AND v.scheduled_date = $2 AND v.status != 'cancelled'
    ORDER BY COALESCE(v.route_order, 999), v.id`, [gardenerId, date]);
}

async function applyOrder(orderedIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query('UPDATE visits SET route_order = $1 WHERE id = $2', [i + 1, orderedIds[i]]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Route planner: pick gardener + date, view ordered stops, optimize.
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const date = req.query.date || businessToday();
  const gardenerId = staff ? Number(req.query.gardener_id || 0) : req.user.id;
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  const visits = gardenerId ? await loadDayVisits(gardenerId, date) : [];

  let totalKm = 0;
  for (let i = 1; i < visits.length; i++) {
    const a = visits[i - 1];
    const b = visits[i];
    if (a.lat != null && b.lat != null) totalKm += haversineKm(a, b);
  }
  res.render('routes/index', {
    title: 'Route planner', staff, date, gardenerId, gardeners, visits, totalKm,
    optimized: req.query.optimized || null,
  });
}));

// Optimize a gardener's day (staff, or the gardener for their own day)
router.post('/optimize', asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardenerId = isStaff(req.user) ? Number(req.body.gardener_id) : req.user.id;
  if (!gardenerId || !date) return res.redirect('/routes');

  const visits = await loadDayVisits(gardenerId, date);
  const { orderedIds, lengthKm, mode } = await optimizeRouteRoad(
    visits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng }))
  );
  await applyOrder(orderedIds);
  await logActivity(req.user.id, 'route.optimize', 'visit', null,
    `Optimized route (${mode === 'road' ? 'road distance' : 'straight-line'}) for gardener #${gardenerId} on ${date}: ${orderedIds.length} stops, ~${lengthKm.toFixed(1)} km`);
  res.redirect(`/routes?date=${date}&gardener_id=${gardenerId}&optimized=${mode}`);
}));

// Optimize all gardeners for a date in one go (staff)
router.post('/optimize-all', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardeners = await q("SELECT id FROM users WHERE role = 'gardener' AND active");
  let total = 0;
  let mode = 'road';
  for (const g of gardeners) {
    const visits = await loadDayVisits(g.id, date);
    if (!visits.length) continue;
    const r = await optimizeRouteRoad(visits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    await applyOrder(r.orderedIds);
    if (r.mode === 'straight') mode = 'straight'; // any fallback downgrades the summary
    total += visits.length;
  }
  await logActivity(req.user.id, 'route.optimize_all', 'visit', null,
    `Optimized all routes (${mode === 'road' ? 'road distance' : 'straight-line'}) for ${date} (${total} visits)`);
  res.redirect(`/routes?date=${date}&optimized=${mode}`);
}));

module.exports = router;
