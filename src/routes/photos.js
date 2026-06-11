const express = require('express');
const { q } = require('../db');
const { isStaff } = require('../auth');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

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
