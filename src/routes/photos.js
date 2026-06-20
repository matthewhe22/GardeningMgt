const express = require('express');
const { q, q1 } = require('../db');
const { isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const storage = require('../storage');

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
router.get('/', asyncHandler(async (req, res) => {
  const staff = isStaff(req.user);
  const photos = await q(`
    SELECT ph.id, ph.filename, ph.caption, ph.original_name, ph.created_at,
           u.name AS uploader_name, v.id AS visit_ref, p.name AS property_name,
           ph.issue_id, i.title AS issue_title
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN visits v ON v.id = ph.visit_id
    LEFT JOIN properties p ON p.id = v.property_id
    LEFT JOIN issues i ON i.id = ph.issue_id
    ${staff ? '' : 'WHERE ph.shared OR ph.uploaded_by = $1'}
    ORDER BY ph.created_at DESC
    LIMIT 200`, staff ? [] : [req.user.id]);
  res.render('photos/index', { title: 'Photos', photos });
}));

module.exports = router;
