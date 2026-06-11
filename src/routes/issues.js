const express = require('express');
const { q, q1 } = require('../db');
const { isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { upload, savePhoto } = require('../upload');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status || '';
  const issues = await q(`
    SELECT i.*, p.name AS property_name, r.name AS reporter_name, a.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users r ON r.id = i.reported_by
    LEFT JOIN users a ON a.id = i.assigned_to
    ${status ? 'WHERE i.status = $1' : ''}
    ORDER BY (i.status IN ('resolved','closed')),
      CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      i.created_at DESC
    LIMIT 300`, status ? [status] : []);
  const properties = await q('SELECT id, name FROM properties ORDER BY name');
  const users = await q('SELECT id, name FROM users WHERE active ORDER BY name');
  res.render('issues/index', { title: 'Issues', issues, properties, users, status, staff: isStaff(req.user) });
}));

// Anyone can report an issue
router.post('/', asyncHandler(async (req, res) => {
  const { title, description, property_id, priority, assigned_to } = req.body;
  if (!(title || '').trim()) return res.redirect('/issues');
  const { id } = await q1(`
    INSERT INTO issues (title, description, property_id, priority, reported_by, assigned_to)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [title.trim(), description || null, property_id || null,
      ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium',
      req.user.id, assigned_to || null]);
  await logActivity(req.user.id, 'issue.create', 'issue', id, `Reported issue "${title.trim()}"`);
  res.redirect(`/issues/${id}`);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const issue = await q1(`
    SELECT i.*, p.name AS property_name, r.name AS reporter_name, a.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users r ON r.id = i.reported_by
    LEFT JOIN users a ON a.id = i.assigned_to
    WHERE i.id = $1`, [req.params.id]);
  if (!issue) return res.status(404).render('error', { title: 'Not found', message: 'Issue not found.' });
  const comments = await q(`
    SELECT c.*, u.name AS author_name FROM issue_comments c
    LEFT JOIN users u ON u.id = c.user_id WHERE c.issue_id = $1 ORDER BY c.created_at`, [issue.id]);
  const photos = await q(`
    SELECT ph.id, ph.filename, ph.caption, ph.original_name, ph.created_at, u.name AS uploader_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.issue_id = $1 ORDER BY ph.created_at DESC`, [issue.id]);
  const users = await q('SELECT id, name FROM users WHERE active ORDER BY name');
  res.render('issues/show', { title: `Issue #${issue.id}`, issue, comments, photos, users, staff: isStaff(req.user) });
}));

router.post('/:id/update', asyncHandler(async (req, res) => {
  const issue = await q1('SELECT * FROM issues WHERE id = $1', [req.params.id]);
  if (!issue) return res.redirect('/issues');
  const { status, priority, assigned_to } = req.body;
  await q(`
    UPDATE issues SET status = $1, priority = $2, assigned_to = $3,
      resolved_at = CASE WHEN $1 IN ('resolved','closed') AND resolved_at IS NULL THEN now()
                         WHEN $1 NOT IN ('resolved','closed') THEN NULL ELSE resolved_at END
    WHERE id = $4`,
    [status, priority, assigned_to || null, issue.id]);
  await logActivity(req.user.id, 'issue.update', 'issue', issue.id,
    `Issue #${issue.id}: status ${issue.status} -> ${status}, priority ${priority}`);
  res.redirect(`/issues/${issue.id}`);
}));

router.post('/:id/comments', asyncHandler(async (req, res) => {
  const body = (req.body.body || '').trim();
  if (body) {
    await q('INSERT INTO issue_comments (issue_id, user_id, body) VALUES ($1, $2, $3)',
      [req.params.id, req.user.id, body]);
    await logActivity(req.user.id, 'issue.comment', 'issue', Number(req.params.id), `Commented on issue #${req.params.id}`);
  }
  res.redirect(`/issues/${req.params.id}#comments`);
}));

router.post('/:id/photos', upload.array('photos', 10), asyncHandler(async (req, res) => {
  for (const f of req.files || []) {
    await savePhoto(f, { caption: req.body.caption || null, issueId: Number(req.params.id), userId: req.user.id });
  }
  if ((req.files || []).length) {
    await logActivity(req.user.id, 'photo.upload', 'issue', Number(req.params.id),
      `Uploaded ${req.files.length} photo(s) to issue #${req.params.id}`);
  }
  res.redirect(`/issues/${req.params.id}#photos`);
}));

module.exports = router;
