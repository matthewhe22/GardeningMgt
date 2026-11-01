const express = require('express');
const { q, q1 } = require('../db');
const { isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const storage = require('../storage');
const { pageParam, paginate } = require('../pagination');
const { isValidDate } = require('../recurrence');

const router = express.Router();

// Delete a photo (the uploader or any staff member). Redirects back to the
// visit/issue it belonged to so the field flow isn't interrupted.
router.post('/:id/delete', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.redirect('/photos');
  const photo = await q1('SELECT id, filename, uploaded_by, visit_id, issue_id, octet_length(data) AS dlen FROM photos WHERE id = $1', [id]);
  if (!photo) return res.redirect('/photos');
  if (!isStaff(req.user) && photo.uploaded_by !== req.user.id) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'You can only delete your own photos.' });
  }
  await q('DELETE FROM photos WHERE id = $1', [id]);
  // Best-effort: drop the bucket object too when this photo lived in storage.
  if (storage.enabled() && photo.dlen === 0) {
    try { await storage.deleteObject(photo.filename); } catch (_) { /* best-effort */ }
  }
  await logActivity(req.user.id, 'photo.delete', photo.visit_id ? 'visit' : 'issue',
    photo.visit_id || photo.issue_id || null, `Deleted photo #${id}`);
  if (photo.visit_id) return res.redirect(`/visits/${photo.visit_id}#photos`);
  if (photo.issue_id) return res.redirect(`/issues/${photo.issue_id}#photos`);
  res.redirect('/photos');
}));

// Team photo gallery. Shared photos are visible to everyone; private ones
// only to the uploader and staff. Each photo shows its upload timestamp.
// Staff can filter by date range, site, and gardener (uploader).
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const page = pageParam(req);
  const where = [];
  const args = [];
  // Non-staff only ever see shared photos or their own uploads.
  if (!staff) { args.push(req.user.id); where.push(`(ph.shared OR ph.uploaded_by = $${args.length})`); }

  // Filters (validated; blanks are ignored). A site can be attached to a photo
  // via its visit or its issue, so match either.
  const from = isValidDate(req.query.from) ? req.query.from : '';
  const to = isValidDate(req.query.to) ? req.query.to : '';
  const propertyId = /^\d+$/.test(req.query.property_id || '') ? req.query.property_id : '';
  const gardenerId = /^\d+$/.test(req.query.gardener_id || '') ? req.query.gardener_id : '';
  if (from) { args.push(from); where.push(`ph.created_at::date >= $${args.length}`); }
  if (to) { args.push(to); where.push(`ph.created_at::date <= $${args.length}`); }
  if (propertyId) { args.push(Number(propertyId)); where.push(`(v.property_id = $${args.length} OR i.property_id = $${args.length})`); }
  if (gardenerId) { args.push(Number(gardenerId)); where.push(`ph.uploaded_by = $${args.length}`); }

  const photosSql = `
    SELECT ph.id, ph.filename, ph.caption, ph.original_name, ph.created_at,
           u.name AS uploader_name, v.id AS visit_ref, p.name AS property_name,
           ph.issue_id, i.title AS issue_title
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN visits v ON v.id = ph.visit_id
    LEFT JOIN properties p ON p.id = v.property_id
    LEFT JOIN issues i ON i.id = ph.issue_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ph.created_at DESC`;
  const { rows: photos, total, totalPages } = await paginate(q, photosSql, args, page);

  // Filter dropdown data (staff only).
  let properties = [];
  let gardeners = [];
  if (staff) {
    [properties, gardeners] = await Promise.all([
      q('SELECT id, name FROM properties ORDER BY name'),
      q("SELECT id, name FROM users WHERE role = 'gardener' AND active ORDER BY name"),
    ]);
  }

  res.render('photos/index', {
    title: 'Photos', photos, page, total, totalPages,
    staff, properties, gardeners, from, to, propertyId, gardenerId,
  });
}));

module.exports = router;
