const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parseSiteUpload } = require('../siteImport');
const { q, q1, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { sendRemindersForDate } = require('../reminders');
const { asyncHandler } = require('../asyncHandler');
const { assertCsrf } = require('../csrf');
const { geocodeAddress, sleep } = require('../geocode');

// Per-click cap on the backfill so the request stays under the serverless
// time limit (Nominatim wants ~1 req/sec). Click again to continue.
const GEOCODE_BATCH = Number(process.env.GEOCODE_BATCH || 5);

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

// --- Properties / sites: supervisors and admins ---

router.get('/properties', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const properties = await q('SELECT * FROM properties ORDER BY name');
  const missingCoords = properties.filter((p) => p.lat == null || p.lng == null).length;
  res.render('admin/properties', {
    title: 'Properties', properties, missingCoords,
    imported: req.query.imported, importErrors: req.query.errors,
    geocoded: req.query.geocoded, geoFailed: req.query.failed, remaining: req.query.remaining,
  });
}));

router.post('/properties', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { name, address, contact_name, contact_phone, lat, lng, lots, notes } = req.body;
  if (!(name || '').trim() || !(address || '').trim()) return res.redirect('/admin/properties');
  // Coordinates power route optimization. If they weren't entered, derive them
  // from the address automatically (best-effort — a save never fails on this).
  let latN = lat ? Number(lat) : null;
  let lngN = lng ? Number(lng) : null;
  if ((latN == null || lngN == null)) {
    try {
      const geo = await geocodeAddress(address.trim());
      if (geo) { latN = geo.lat; lngN = geo.lng; }
    } catch (e) { console.error('[geocode] create lookup failed:', e.message); }
  }
  const { id } = await q1(`
    INSERT INTO properties (name, address, contact_name, contact_phone, lat, lng, lots, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [name.trim(), address.trim(), contact_name || null, contact_phone || null,
      latN, lngN, lots ? Math.round(Number(lots)) : null, notes || null]);
  await logActivity(req.user.id, 'property.create', 'property', id, `Added site "${name.trim()}"`);
  res.redirect('/admin/properties');
}));

// Backfill coordinates for sites that don't have them yet, from their address.
// Processes a small batch per click (Nominatim ~1 req/sec) and reports how many
// still remain so the button can be clicked again until it's done.
router.post('/properties/geocode', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const missing = await q(
    `SELECT id, name, address FROM properties
     WHERE (lat IS NULL OR lng IS NULL) AND COALESCE(TRIM(address), '') <> ''
     ORDER BY id LIMIT $1`, [GEOCODE_BATCH]);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < missing.length; i++) {
    const p = missing[i];
    try {
      const geo = await geocodeAddress(p.address);
      if (geo) {
        await q('UPDATE properties SET lat = $1, lng = $2 WHERE id = $3', [geo.lat, geo.lng, p.id]);
        done++;
      } else { failed++; }
    } catch (e) {
      console.error(`[geocode] site #${p.id} failed:`, e.message);
      failed++;
    }
    if (i < missing.length - 1) await sleep(1100); // stay under ~1 req/sec
  }
  const { c: remaining } = await q1(
    `SELECT COUNT(*)::int AS c FROM properties WHERE lat IS NULL OR lng IS NULL`);
  if (done) {
    await logActivity(req.user.id, 'property.geocode', 'property', null,
      `Geocoded ${done} site(s) from address`);
  }
  const params = new URLSearchParams({ geocoded: String(done), failed: String(failed), remaining: String(remaining) });
  res.redirect(`/admin/properties?${params}`);
}));

// Bulk import sites from an Excel (.xlsx) or CSV upload.
// Expected columns (flexible spelling): Site Name, Address, # of Lots,
// Lat, Lng, Contact, Phone, Notes.
const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, /\.(xlsx|csv)$/i.test(file.originalname || '')),
});

router.post('/properties/import', requireRole('supervisor'),
  spreadsheetUpload.single('file'), asyncHandler(async (req, res) => {
    assertCsrf(req);
    if (!req.file) {
      return res.redirect('/admin/properties?errors=' +
        encodeURIComponent('No file received — upload a .xlsx or .csv file'));
    }
    const { sites, errors } = await parseSiteUpload(req.file);
    // One transaction; skip rows that duplicate an existing (name, address)
    // so re-uploading the same sheet doesn't create duplicates.
    let imported = 0;
    let skipped = 0;
    await withTransaction(async (tx) => {
      for (const s of sites) {
        const exists = await tx.q1(
          'SELECT 1 FROM properties WHERE lower(name) = lower($1) AND lower(address) = lower($2)',
          [s.name, s.address]);
        if (exists) { skipped++; continue; }
        await tx.q(`
          INSERT INTO properties (name, address, contact_name, contact_phone, lat, lng, lots, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [s.name, s.address, s.contact_name, s.contact_phone, s.lat, s.lng, s.lots, s.notes]);
        imported++;
      }
    });
    if (skipped) errors.push(`${skipped} row(s) skipped as duplicates`);
    if (imported) {
      await logActivity(req.user.id, 'property.import', 'property', null,
        `Imported ${imported} site(s) from ${req.file.originalname}`);
    }
    const params = new URLSearchParams({ imported: String(imported) });
    if (errors.length) params.set('errors', errors.slice(0, 10).join(' · '));
    res.redirect(`/admin/properties?${params}`);
  }));

// --- User management: admin only ---

router.get('/users', requireRole(), asyncHandler(async (req, res) => {
  const users = await q('SELECT id, name, email, role, phone, active, created_at FROM users ORDER BY role, name');
  res.render('admin/users', { title: 'Users', users });
}));

router.post('/users', requireRole(), asyncHandler(async (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!(name || '').trim() || !(email || '').trim() || !password || !['admin', 'supervisor', 'gardener'].includes(role)) {
    return res.redirect('/admin/users?error=invalid');
  }
  if (String(password).length < 8) return res.redirect('/admin/users?error=weak');
  try {
    const { id } = await q1(`
      INSERT INTO users (name, email, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), role, phone || null]);
    await logActivity(req.user.id, 'user.create', 'user', id, `Created ${role} account for ${name.trim()}`);
  } catch (e) {
    if (e.code === '23505') return res.redirect('/admin/users?error=dupemail'); // unique_violation
    throw e; // anything else is a real error
  }
  res.redirect('/admin/users?created=1');
}));

router.post('/users/:id/toggle', requireRole(), asyncHandler(async (req, res) => {
  if (Number(req.params.id) !== req.user.id) {
    await q('UPDATE users SET active = NOT active WHERE id = $1', [req.params.id]);
    await logActivity(req.user.id, 'user.toggle', 'user', Number(req.params.id), `Toggled active state of user #${req.params.id}`);
  }
  res.redirect('/admin/users');
}));

// --- App settings (OneDrive archiving): admin only ---

const { getSettings, setSetting } = require('../settings');
const { testConnection, SETTING_KEYS } = require('../onedrive');

router.get('/settings', requireRole(), asyncHandler(async (req, res) => {
  const settings = await getSettings(SETTING_KEYS);
  res.render('admin/settings', {
    title: 'Settings', settings,
    saved: req.query.saved, test: null,
  });
}));

router.post('/settings', requireRole(), asyncHandler(async (req, res) => {
  for (const key of SETTING_KEYS) {
    const value = (req.body[key] || '').trim();
    // Leave the stored secret untouched when the masked placeholder comes back.
    if (key === 'onedrive_client_secret' && value === '********') continue;
    await setSetting(key, value || null);
  }
  await logActivity(req.user.id, 'settings.update', 'settings', null, 'Updated OneDrive settings');
  res.redirect('/admin/settings?saved=1');
}));

router.post('/settings/test', requireRole(), asyncHandler(async (req, res) => {
  const settings = await getSettings(SETTING_KEYS);
  const test = await testConnection();
  // Log only pass/fail — the message can contain Graph error detail.
  await logActivity(req.user.id, 'settings.test', 'settings', null,
    `OneDrive connection test: ${test.ok ? 'OK' : 'failed'}`);
  res.render('admin/settings', { title: 'Settings', settings, saved: null, test });
}));

module.exports = router;
