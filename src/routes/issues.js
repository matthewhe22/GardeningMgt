const express = require('express');
const { q, q1 } = require('../db');
const { isStaff, requireRole } = require('../auth');
const { assertCsrf } = require('../csrf');
const { logActivity } = require('../activity');
const { upload, savePhoto } = require('../upload');
const { asyncHandler } = require('../asyncHandler');
const { pageParam, paginate } = require('../pagination');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status || '';
  const search = (req.query.search || '').trim();
  const cond = [];
  const args = [];
  if (status) { args.push(status); cond.push(`i.status = $${args.length}`); }
  if (search) { args.push(`%${search}%`); cond.push(`(i.title ILIKE $${args.length} OR p.name ILIKE $${args.length})`); }
  const page = pageParam(req);
  const issuesSql = `
    SELECT i.*, p.name AS property_name, r.name AS reporter_name, a.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users r ON r.id = i.reported_by
    LEFT JOIN users a ON a.id = i.assigned_to
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY (i.status IN ('resolved','closed')),
      CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      i.created_at DESC`;
  const [issuesPage, properties, users] = await Promise.all([
    paginate(q, issuesSql, args, page),
    q('SELECT id, name FROM properties ORDER BY name'),
    q('SELECT id, name FROM users WHERE active ORDER BY name'),
  ]);
  const { rows: issues, total, totalPages } = issuesPage;
  // Carried over from a visit page's "Report an issue at this site" link, so
  // the property doesn't have to be re-picked from an alphabetical dropdown
  // with no context, and the new issue can still be traced back to the visit.
  const presetPropertyId = Number(req.query.property_id) || null;
  const presetVisitId = Number(req.query.visit_id) || null;
  res.render('issues/index', {
    title: 'Issues', issues, properties, users, status, search, staff: isStaff(req.user), page, total, totalPages,
    presetPropertyId, presetVisitId,
  });
}));

// Anyone can report an issue. Accepts an optional photo (same upload/multer
// setup src/routes/visits.js uses) so a gardener can attach evidence in the
// same request instead of navigating to the issue afterwards to add one.
router.post('/', upload.array('photos', 10), asyncHandler(async (req, res) => {
  assertCsrf(req);
  const { title, description, property_id, priority, assigned_to, visit_id } = req.body;
  if (!(title || '').trim()) return res.redirect('/issues');
  const visitId = Number(visit_id) || null;
  const { id } = await q1(`
    INSERT INTO issues (title, description, property_id, visit_id, priority, reported_by, assigned_to)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [title.trim(), description || null, property_id || null, visitId,
      ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium',
      req.user.id, assigned_to || null]);
  let badPhoto = false;
  for (const f of req.files || []) {
    const saved = await savePhoto(f, { issueId: id, userId: req.user.id });
    if (!saved) badPhoto = true;
  }
  await logActivity(req.user.id, 'issue.create', 'issue', id,
    `Reported issue "${title.trim()}"${(req.files || []).length ? ` with ${req.files.length} photo(s)` : ''}`);
  res.redirect(`/issues/${id}${badPhoto ? '?error=badphoto' : ''}`);
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
  const [comments, photos, users] = await Promise.all([
    q(`
    SELECT c.*, u.name AS author_name FROM issue_comments c
    LEFT JOIN users u ON u.id = c.user_id WHERE c.issue_id = $1 ORDER BY c.created_at`, [issue.id]),
    q(`
    SELECT ph.id, ph.filename, ph.caption, ph.original_name, ph.created_at, ph.uploaded_by, u.name AS uploader_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.issue_id = $1 ORDER BY ph.created_at DESC`, [issue.id]),
    q('SELECT id, name FROM users WHERE active ORDER BY name'),
  ]);
  res.render('issues/show', {
    title: `Issue #${issue.id}`, issue, comments, photos, users, staff: isStaff(req.user),
    flash: req.query.error || null,
  });
}));

// Only staff change an issue's status/priority/assignment.
router.post('/:id/update', requireRole('supervisor'), asyncHandler(async (req, res) => {
  const issue = await q1('SELECT * FROM issues WHERE id = $1', [req.params.id]);
  if (!issue) return res.redirect('/issues');
  const { status, priority, assigned_to } = req.body;
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status) ||
      !['low', 'medium', 'high', 'urgent'].includes(priority)) {
    return res.redirect(`/issues/${issue.id}?error=invalid`);
  }
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
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).render('error', { title: 'Not found', message: 'Issue not found.' });
  const issue = await q1('SELECT id FROM issues WHERE id = $1', [id]);
  if (!issue) return res.status(404).render('error', { title: 'Not found', message: 'Issue not found.' });
  const body = (req.body.body || '').trim();
  if (body) {
    await q('INSERT INTO issue_comments (issue_id, user_id, body) VALUES ($1, $2, $3)',
      [id, req.user.id, body]);
    await logActivity(req.user.id, 'issue.comment', 'issue', id, `Commented on issue #${id}`);
  }
  res.redirect(`/issues/${id}#comments`);
}));

router.post('/:id/photos', upload.array('photos', 10), asyncHandler(async (req, res) => {
  assertCsrf(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).render('error', { title: 'Not found', message: 'Issue not found.' });
  const issue = await q1('SELECT id FROM issues WHERE id = $1', [id]);
  if (!issue) return res.status(404).render('error', { title: 'Not found', message: 'Issue not found.' });
  let saved = 0;
  let badPhoto = false;
  for (const f of req.files || []) {
    const filename = await savePhoto(f, { caption: req.body.caption || null, issueId: id, userId: req.user.id });
    if (filename) saved++; else badPhoto = true;
  }
  if (saved) {
    await logActivity(req.user.id, 'photo.upload', 'issue', id,
      `Uploaded ${saved} photo(s) to issue #${id}`);
  }
  res.redirect(`/issues/${id}${badPhoto ? '?error=badphoto' : ''}#photos`);
}));

module.exports = router;
