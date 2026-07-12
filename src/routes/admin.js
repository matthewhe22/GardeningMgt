const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parseSiteUpload } = require('../siteImport');
const { q, q1, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { sendRemindersForDate } = require('../reminders');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday } = require('../time');
const { assertCsrf } = require('../csrf');
const { geocodeAddress, geocodeMissingBatch } = require('../geocode');
const { pageParam, paginate } = require('../pagination');

// Per-click cap on the backfill so the request stays under the serverless
// time limit (Nominatim wants ~1 req/sec). Click again to continue.
const GEOCODE_BATCH = Number(process.env.GEOCODE_BATCH || 5);

const router = express.Router();

// --- Activity log & bulk reminders: supervisors and admins ---

// Every action logged so far is "<category>.<verb>" (e.g. 'auth.login',
// 'visit.timer.stop') — group the filter dropdown by that category prefix
// rather than hardcoding the full list, so it stays in sync with whatever
// logActivity() calls actually exist across the codebase.
const ACTIVITY_CATEGORY_LABELS = {
  auth: 'Login/logout', visit: 'Visits', job: 'Contracts', invoice: 'Invoicing',
  issue: 'Issues', property: 'Sites', task: 'Tasks', user: 'Users',
  route: 'Routing', settings: 'Settings', photo: 'Photos', report: 'Reports',
};

router.get('/activity', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const page = pageParam(req);
  const search = (req.query.search || '').trim();
  const actingUserId = Number(req.query.user_id) || '';
  const category = (req.query.category || '').trim();
  const where = [];
  const args = [];
  if (search) { args.push(`%${search}%`); where.push(`a.details ILIKE $${args.length}`); }
  if (actingUserId) { args.push(actingUserId); where.push(`a.user_id = $${args.length}`); }
  if (category) { args.push(`${category}.%`); where.push(`a.action LIKE $${args.length}`); }
  const baseWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const activitySql = `
    SELECT a.*, u.name AS user_name FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${baseWhere}
    ORDER BY a.created_at DESC, a.id DESC`;
  const [{ rows: entries, total, totalPages }, users, categoryRows] = await Promise.all([
    paginate(q, activitySql, args, page),
    q('SELECT id, name FROM users ORDER BY name'),
    q(`SELECT DISTINCT split_part(action, '.', 1) AS cat FROM activity_log ORDER BY cat`),
  ]);
  const categories = categoryRows.map((r) => ({ value: r.cat, label: ACTIVITY_CATEGORY_LABELS[r.cat] || r.cat }));
  res.render('admin/activity', {
    title: 'Activity log', entries, page, total, totalPages,
    search, actingUserId, category, users, categories,
  });
}));

router.post('/reminders/bulk', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.body.date || businessToday();
  const sent = await sendRemindersForDate(date, { actorId: req.user.id, force: req.body.force === 'on' });
  res.redirect(`/admin/reminders?date=${date}&sent=${sent}`);
}));

router.get('/reminders', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const date = req.query.date || businessToday();
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
  const { name, address, contact_name, contact_phone, contact_email, lat, lng, lots, notes,
    billing_name, billing_address, billing_email } = req.body;
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
  // gst_applicable defaults true (the common case); unchecked checkboxes
  // aren't sent by the browser at all, so its absence means "off".
  const gstApplicable = req.body.gst_applicable === 'on';
  const { id } = await q1(`
    INSERT INTO properties (name, address, contact_name, contact_phone, contact_email, lat, lng, lots, notes,
      billing_name, billing_address, billing_email, gst_applicable)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [name.trim(), address.trim(), contact_name || null, contact_phone || null, contact_email || null,
      latN, lngN, lots ? Math.round(Number(lots)) : null, notes || null,
      billing_name || null, billing_address || null, billing_email || null, gstApplicable]);
  await logActivity(req.user.id, 'property.create', 'property', id, `Added site "${name.trim()}"`);
  res.redirect('/admin/properties');
}));

// Backfill coordinates for sites that don't have them yet, from their address.
// Processes a small batch per click (Nominatim ~1 req/sec) and reports how many
// still remain so the button can be clicked again until it's done.
// geocodeMissingBatch itself lives in ../geocode.js — shared by this button,
// the daily cron pass (server.js's /cron/reminders), and (previously) the
// spreadsheet import below, which no longer calls it inline.
router.post('/properties/geocode', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const { done, failed, remaining } = await geocodeMissingBatch(GEOCODE_BATCH);
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
    // Imported rows with no Lat/Lng are left with NULL coordinates (the
    // properties list already flags "missing coordinates" sites) rather than
    // geocoding them inline here: geocoding is rate-limited to ~1 req/sec and
    // each lookup can take up to 8s, so doing it inside this request/response
    // cycle risked a serverless timeout on anything but a tiny sheet. The
    // daily cron pass (server.js's /cron/reminders) and the "Find missing
    // coordinates" button both pick up any property still missing coordinates.
    res.redirect(`/admin/properties?${params}`);
  }));

// Edit a site. Re-detects coordinates from the address when "Re-detect" is
// ticked, or whenever latitude/longitude are left blank.
router.post('/properties/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await q1('SELECT id FROM properties WHERE id = $1', [id]);
  if (!existing) return res.redirect('/admin/properties');
  const { name, address, contact_name, contact_phone, contact_email, lat, lng, lots, notes,
    billing_name, billing_address, billing_email } = req.body;
  if (!(name || '').trim() || !(address || '').trim()) return res.redirect('/admin/properties');
  const redetect = req.body.regeocode === 'on';
  let latN = (!redetect && lat) ? Number(lat) : null;
  let lngN = (!redetect && lng) ? Number(lng) : null;
  if (redetect || latN == null || lngN == null) {
    try {
      const g = await geocodeAddress(address.trim());
      if (g) { latN = g.lat; lngN = g.lng; }
    } catch (e) { console.error('[geocode] update lookup failed:', e.message); }
  }
  const gstApplicable = req.body.gst_applicable === 'on';
  await q(`
    UPDATE properties SET name = $1, address = $2, contact_name = $3, contact_phone = $4,
      contact_email = $5, lat = $6, lng = $7, lots = $8, notes = $9,
      billing_name = $10, billing_address = $11, billing_email = $12, gst_applicable = $13
    WHERE id = $14`,
    [name.trim(), address.trim(), contact_name || null, contact_phone || null, contact_email || null,
      latN, lngN, lots ? Math.round(Number(lots)) : null, notes || null,
      billing_name || null, billing_address || null, billing_email || null, gstApplicable, id]);
  await logActivity(req.user.id, 'property.update', 'property', id, `Updated site "${name.trim()}"`);
  res.redirect('/admin/properties');
}));

// --- User management: admin only ---

router.get('/users', requireRole(), asyncHandler(async (req, res) => {
  const users = await q('SELECT id, name, email, role, phone, active, created_at FROM users ORDER BY role, name');
  res.render('admin/users', {
    title: 'Users', users,
    error: req.query.error || null,
    created: req.query.created || null, updated: req.query.updated || null, reset: req.query.reset || null,
  });
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
      [name.trim(), email.trim().toLowerCase(), await bcrypt.hash(password, 10), role, phone || null]);
    await logActivity(req.user.id, 'user.create', 'user', id, `Created ${role} account for ${name.trim()}`);
  } catch (e) {
    if (e.code === '23505') return res.redirect('/admin/users?error=dupemail'); // unique_violation
    throw e; // anything else is a real error
  }
  res.redirect('/admin/users?created=1');
}));

// How many *other* active admins exist besides `id` — used to stop a
// role-change or deactivation from leaving the business with zero admins.
async function activeAdminCountExcluding(id) {
  const { c } = await q1(
    "SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND active AND id <> $1", [id]);
  return c;
}

// Edit an existing user's name/email/phone/role. Mirrors the create route's
// validation and duplicate-email handling (unique index + 23505 catch, same
// pattern as uq_jobs_property_active elsewhere in this codebase).
router.post('/users/:id/update', requireRole(), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await q1('SELECT id, role, active FROM users WHERE id = $1', [id]);
  if (!existing) return res.redirect('/admin/users');
  const { name, email, role, phone } = req.body;
  if (!(name || '').trim() || !(email || '').trim() || !['admin', 'supervisor', 'gardener'].includes(role)) {
    return res.redirect('/admin/users?error=invalid');
  }
  if (existing.role === 'admin' && existing.active && role !== 'admin' && await activeAdminCountExcluding(id) === 0) {
    return res.redirect('/admin/users?error=lastadmin');
  }
  try {
    await q(`UPDATE users SET name = $1, email = $2, role = $3, phone = $4 WHERE id = $5`,
      [name.trim(), email.trim().toLowerCase(), role, phone || null, id]);
  } catch (e) {
    if (e.code === '23505') return res.redirect('/admin/users?error=dupemail'); // unique_violation
    throw e;
  }
  await logActivity(req.user.id, 'user.update', 'user', id, `Updated details for ${name.trim()}`);
  res.redirect('/admin/users?updated=1');
}));

// Admin-initiated password reset — no email flow, just sets the new hash
// directly (same bcrypt convention as the login route in routes/auth.js).
// The log entry records who reset whose password, never the password itself.
router.post('/users/:id/password', requireRole(), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const target = await q1('SELECT id, name FROM users WHERE id = $1', [id]);
  if (!target) return res.redirect('/admin/users');
  const { password } = req.body;
  if (!password || String(password).length < 8) return res.redirect('/admin/users?error=weak');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, 10), id]);
  await logActivity(req.user.id, 'user.password_reset', 'user', id, `Reset password for ${target.name}`);
  res.redirect('/admin/users?reset=1');
}));

router.post('/users/:id/toggle', requireRole(), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id !== req.user.id) {
    const existing = await q1('SELECT role, active FROM users WHERE id = $1', [id]);
    // Disabling the last active admin would lock the whole business out of
    // admin-only functions (user management, settings, ...) — block it.
    if (existing && existing.role === 'admin' && existing.active && await activeAdminCountExcluding(id) === 0) {
      return res.redirect('/admin/users?error=lastadmin');
    }
    await q('UPDATE users SET active = NOT active WHERE id = $1', [id]);
    await logActivity(req.user.id, 'user.toggle', 'user', id, `Toggled active state of user #${id}`);
  }
  res.redirect('/admin/users');
}));

// --- App settings (OneDrive archiving, invoice letterhead): admin only ---

const { getSettings, setSetting, INVOICE_SETTING_KEYS } = require('../settings');
const { testConnection: testOneDrive, SETTING_KEYS: ONEDRIVE_SETTING_KEYS } = require('../onedrive');
const { testConnection: testEmail, SETTING_KEYS: EMAIL_SETTING_KEYS } = require('../email');

// Settings whose masked placeholder ('********') means "leave as-is, don't
// overwrite the stored secret" — mirrors the onedrive_client_secret pattern.
const MASKED_SETTING_KEYS = new Set(['onedrive_client_secret', 'invoice_payment_details', 'smtp_password']);
const ALL_SETTING_KEYS = [...ONEDRIVE_SETTING_KEYS, ...INVOICE_SETTING_KEYS, ...EMAIL_SETTING_KEYS];

router.get('/settings', requireRole(), asyncHandler(async (req, res) => {
  const settings = await getSettings(ALL_SETTING_KEYS);
  res.render('admin/settings', {
    title: 'Settings', settings,
    saved: req.query.saved, test: null, emailTest: null,
  });
}));

router.post('/settings', requireRole(), asyncHandler(async (req, res) => {
  for (const key of ALL_SETTING_KEYS) {
    const value = (req.body[key] || '').trim();
    // Leave the stored secret untouched when the masked placeholder comes back.
    if (MASKED_SETTING_KEYS.has(key) && value === '********') continue;
    await setSetting(key, value || null);
  }
  await logActivity(req.user.id, 'settings.update', 'settings', null, 'Updated settings');
  res.redirect('/admin/settings?saved=1');
}));

router.post('/settings/test', requireRole(), asyncHandler(async (req, res) => {
  const settings = await getSettings(ALL_SETTING_KEYS);
  const test = await testOneDrive();
  // Log only pass/fail — the message can contain Graph error detail.
  await logActivity(req.user.id, 'settings.test', 'settings', null,
    `OneDrive connection test: ${test.ok ? 'OK' : 'failed'}`);
  res.render('admin/settings', { title: 'Settings', settings, saved: null, test, emailTest: null });
}));

router.post('/settings/test-email', requireRole(), asyncHandler(async (req, res) => {
  const settings = await getSettings(ALL_SETTING_KEYS);
  const emailTest = await testEmail();
  await logActivity(req.user.id, 'settings.test', 'settings', null,
    `Email (SMTP) connection test: ${emailTest.ok ? 'OK' : 'failed'}`);
  res.render('admin/settings', { title: 'Settings', settings, saved: null, test: null, emailTest });
}));

module.exports = router;
