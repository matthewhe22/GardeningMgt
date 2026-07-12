const express = require('express');
const { q, pool } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { optimizeRouteRoad, haversineKm } = require('../routeOptimizer');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday } = require('../time');
const { mapWithConcurrency } = require('../concurrency');

const router = express.Router();

function loadDayVisits(gardenerId, date) {
  return q(`
    SELECT v.*, p.name AS property_name, p.address, p.lat, p.lng
    FROM visits v JOIN properties p ON p.id = v.property_id
    WHERE v.gardener_id = $1 AND v.scheduled_date = $2 AND v.status != 'cancelled'
    ORDER BY COALESCE(v.route_order, 999), v.id`, [gardenerId, date]);
}

async function applyOrder(orderedIds, startAt = 1) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query('UPDATE visits SET route_order = $1 WHERE id = $2', [startAt + i, orderedIds[i]]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Stops that already reflect real-world progress (in progress, completed, or
// otherwise no longer plain "scheduled") shouldn't be reshuffled by a later
// re-optimize — e.g. re-running this after lunch would otherwise renumber a
// gardener's already-completed stops alongside the remaining ones, producing
// an order on the dashboard/Jobs list that doesn't match what actually
// happened. Only the still-scheduled remainder of the day is up for
// reordering; pinned stops keep their existing route_order untouched, and the
// reorderable stops are numbered to continue on after them.
function splitForReorder(visits) {
  const pinned = visits.filter((v) => v.status !== 'scheduled');
  const reorderable = visits.filter((v) => v.status === 'scheduled');
  const startAt = pinned.reduce((m, v) => (v.route_order != null ? Math.max(m, v.route_order) : m), 0) + 1;
  return { pinned, reorderable, startAt };
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
    allCount: req.query.all_count != null ? Number(req.query.all_count) : null,
    allVisits: req.query.all_visits != null ? Number(req.query.all_visits) : null,
  });
}));

// Optimize a gardener's day (staff, or the gardener for their own day)
router.post('/optimize', asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardenerId = isStaff(req.user) ? Number(req.body.gardener_id) : req.user.id;
  if (!gardenerId || !date) return res.redirect('/routes');

  const visits = await loadDayVisits(gardenerId, date);
  const { pinned, reorderable, startAt } = splitForReorder(visits);
  let mode = 'road';
  if (reorderable.length) {
    const r = await optimizeRouteRoad(reorderable.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    await applyOrder(r.orderedIds, startAt);
    mode = r.mode;
    await logActivity(req.user.id, 'route.optimize', 'visit', null,
      `Optimized route (${mode === 'road' ? 'road distance' : 'straight-line'}) for gardener #${gardenerId} on ${date}: ` +
      `${r.orderedIds.length} stops, ~${r.lengthKm.toFixed(1)} km` +
      (pinned.length ? ` (${pinned.length} already in-progress/completed stop(s) left in place)` : ''));
  }
  res.redirect(`/routes?date=${date}&gardener_id=${gardenerId}&optimized=${mode}`);
}));

// Optimize all gardeners for a date in one go (staff). Bounded to 3 at a
// time — being impolite to the shared public OSRM demo server every
// gardener's request hits by default is the concern, not raw throughput.
router.post('/optimize-all', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardeners = await q("SELECT id FROM users WHERE role = 'gardener' AND active");
  const perGardener = await mapWithConcurrency(gardeners, 3, async (g) => {
    const visits = await loadDayVisits(g.id, date);
    const { reorderable, startAt } = splitForReorder(visits);
    if (!reorderable.length) return null;
    const r = await optimizeRouteRoad(reorderable.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    await applyOrder(r.orderedIds, startAt);
    return { count: reorderable.length, mode: r.mode };
  });
  let total = 0;
  let mode = 'road';
  for (const r of perGardener) {
    if (!r) continue;
    total += r.count;
    if (r.mode === 'straight') mode = 'straight'; // any fallback downgrades the summary
  }
  await logActivity(req.user.id, 'route.optimize_all', 'visit', null,
    `Optimized all routes (${mode === 'road' ? 'road distance' : 'straight-line'}) for ${date} (${total} visits)`);
  // No single gardener is selected on this action, so /routes would otherwise
  // render nothing but "pick a gardener and date" with zero confirmation that
  // every gardener's route was just silently rewritten — pass a summary
  // through the redirect so the view can show it regardless of gardenerId.
  const gardenerCount = perGardener.filter(Boolean).length;
  res.redirect(`/routes?date=${date}&optimized=${mode}&all_count=${gardenerCount}&all_visits=${total}`);
}));

module.exports = router;
