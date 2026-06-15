const express = require('express');
const { q, pool, withTransaction } = require('../db');
const { requireRole, isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { optimizeRoute, haversineKm, segmentByLocation } = require('../routeOptimizer');
const { today: businessToday } = require('../time');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Monday on/before the given 'YYYY-MM-DD' date. */
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
  return addDays(dateStr, -((dow + 6) % 7));
}

/** Clamp the requested number of service days to a sane 1–7. */
function serviceDays(raw) {
  return Math.min(7, Math.max(1, Number(raw) || 5));
}

/** Every site under an active contract — the portfolio to route. */
function loadPortfolioSites() {
  return q(`
    SELECT p.id, p.name, p.address, p.lat, p.lng, j.gardener_id, u.name AS gardener_name
    FROM properties p
    JOIN jobs j ON j.property_id = p.id AND j.active
    LEFT JOIN users u ON u.id = j.gardener_id
    ORDER BY p.name`);
}

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
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const gardenerId = staff ? Number(req.query.gardener_id || 0) : req.user.id;
  const gardeners = await q("SELECT id, name FROM users WHERE role = 'gardener' AND active");
  const visits = gardenerId ? await loadDayVisits(gardenerId, date) : [];

  let totalKm = 0;
  for (let i = 1; i < visits.length; i++) {
    const a = visits[i - 1];
    const b = visits[i];
    if (a.lat != null && b.lat != null) totalKm += haversineKm(a, b);
  }
  res.render('routes/index', { title: 'Route planner', staff, date, gardenerId, gardeners, visits, totalKm });
}));

// Optimize a gardener's day (staff, or the gardener for their own day)
router.post('/optimize', asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardenerId = isStaff(req.user) ? Number(req.body.gardener_id) : req.user.id;
  if (!gardenerId || !date) return res.redirect('/routes');

  const visits = await loadDayVisits(gardenerId, date);
  const { orderedIds, lengthKm } = optimizeRoute(
    visits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng }))
  );
  await applyOrder(orderedIds);
  await logActivity(req.user.id, 'route.optimize', 'visit', null,
    `Optimized route for gardener #${gardenerId} on ${date}: ${orderedIds.length} stops, ~${lengthKm.toFixed(1)} km`);
  res.redirect(`/routes?date=${date}&gardener_id=${gardenerId}`);
}));

// Optimize all gardeners for a date in one go (staff)
router.post('/optimize-all', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.body.date;
  const gardeners = await q("SELECT id FROM users WHERE role = 'gardener' AND active");
  let total = 0;
  for (const g of gardeners) {
    const visits = await loadDayVisits(g.id, date);
    if (!visits.length) continue;
    const { orderedIds } = optimizeRoute(visits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    await applyOrder(orderedIds);
    total += visits.length;
  }
  await logActivity(req.user.id, 'route.optimize_all', 'visit', null,
    `Optimized all routes for ${date} (${total} visits)`);
  res.redirect(`/routes?date=${date}`);
}));

// Portfolio routing: segment every site by location into one group per service
// day, so geographically close sites are serviced together. Preview only — the
// allocation is applied to a week's visits via /portfolio/apply.
router.get('/portfolio', asyncHandler(async (req, res) => {
  if (!isStaff(req.user)) return res.redirect('/routes');
  const monday = mondayOf(req.query.week || businessToday());
  const dayCount = serviceDays(req.query.days);
  const sites = await loadPortfolioSites();
  const { segments, unlocated } = segmentByLocation(
    sites.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })), dayCount
  );
  const byId = new Map(sites.map((s) => [s.id, s]));

  const days = segments.map((seg, idx) => {
    const { orderedIds, lengthKm } = optimizeRoute(seg.sites);
    return {
      label: WEEKDAYS[idx % 7],
      date: addDays(monday, idx % 7),
      lengthKm,
      sites: orderedIds.map((id) => byId.get(id)),
    };
  });
  res.render('routes/portfolio', {
    title: 'Portfolio routing',
    week: monday, dayCount, days,
    unlocated: unlocated.map((s) => byId.get(s.id)),
    totalSites: sites.length,
    applied: req.query.applied ? Number(req.query.applied) : null,
  });
}));

// Apply the location segmentation to one week: move each scheduled visit to the
// weekday assigned to its site, then re-optimize the order within every
// affected gardener's day.
router.post('/portfolio/apply', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const monday = mondayOf(req.body.week || businessToday());
  const sunday = addDays(monday, 6);
  const dayCount = serviceDays(req.body.days);

  const sites = await loadPortfolioSites();
  const { segments } = segmentByLocation(
    sites.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })), dayCount
  );
  const dayOffsetOf = new Map(); // property_id -> weekday offset from Monday
  segments.forEach((seg, idx) => seg.sites.forEach((s) => dayOffsetOf.set(s.id, idx % 7)));

  const visits = await q(`
    SELECT id, property_id, gardener_id, scheduled_date FROM visits
    WHERE status = 'scheduled' AND scheduled_date BETWEEN $1 AND $2`, [monday, sunday]);

  let moved = 0;
  const affected = new Map(); // "gardenerId|date" -> { gardenerId, date }
  await withTransaction(async (tx) => {
    for (const v of visits) {
      if (!dayOffsetOf.has(v.property_id)) continue; // unlocated site: leave as-is
      const target = addDays(monday, dayOffsetOf.get(v.property_id));
      if (target !== v.scheduled_date) {
        await tx.q('UPDATE visits SET scheduled_date = $1 WHERE id = $2', [target, v.id]);
        moved += 1;
      }
      if (v.gardener_id) affected.set(`${v.gardener_id}|${target}`, { gardenerId: v.gardener_id, date: target });
    }
  });

  // Re-optimize route order for each gardener/day that now holds visits.
  for (const { gardenerId, date } of affected.values()) {
    const dayVisits = await loadDayVisits(gardenerId, date);
    if (!dayVisits.length) continue;
    const { orderedIds } = optimizeRoute(dayVisits.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng })));
    await applyOrder(orderedIds);
  }

  await logActivity(req.user.id, 'route.portfolio', 'visit', null,
    `Segmented portfolio into ${dayCount} day(s) for week of ${monday}: ${moved} visit(s) re-allocated by location`);
  res.redirect(`/routes/portfolio?week=${monday}&days=${dayCount}&applied=${moved}`);
}));

module.exports = router;
