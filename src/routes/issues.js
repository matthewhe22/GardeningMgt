const express = require('express');
const db = require('../db');
const { isStaff } = require('../auth');
const { logActivity } = require('../activity');
const { upload } = require('../upload');

const router = express.Router();

router.get('/', (req, res) => {
  const status = req.query.status || '';
  const where = status ? 'WHERE i.status = ?' : '';
  const issues = db.prepare(`
    SELECT i.*, p.name AS property_name, r.name AS reporter_name, a.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users r ON r.id = i.reported_by
    LEFT JOIN users a ON a.id = i.assigned_to
    ${where}
    ORDER BY i.status IN ('resolved','closed'),
      CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      i.created_at DESC
    LIMIT 300`).all(...(status ? [status] : []));
  const properties = db.prepare('SELECT id, name FROM properties ORDER BY name').all();
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
  res.render('issues/index', { title: 'Issues', issues, properties, users, status, staff: isStaff(req.user) });
});

// Anyone can report an issue
router.post('/', (req, res) => {
  const { title, description, property_id, priority, assigned_to } = req.body;
  if (!(title || '').trim()) return res.redirect('/issues');
  const info = db.prepare(`
    INSERT INTO issues (title, description, property_id, priority, reported_by, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(title.trim(), description || null, property_id || null,
      ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium',
      req.user.id, assigned_to || null);
  logActivity(req.user.id, 'issue.create', 'issue', info.lastInsertRowid, `Reported issue "${title.trim()}"`);
  res.redirect(`/issues/${info.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const issue = db.prepare(`
    SELECT i.*, p.name AS property_name, r.name AS reporter_name, a.name AS assignee_name
    FROM issues i
    LEFT JOIN properties p ON p.id = i.property_id
    LEFT JOIN users r ON r.id = i.reported_by
    LEFT JOIN users a ON a.id = i.assigned_to
    WHERE i.id = ?`).get(req.params.id);
  if (!issue) return res.status(404).render('error', { title: 'Not found', message: 'Issue not found.' });
  const comments = db.prepare(`
    SELECT c.*, u.name AS author_name FROM issue_comments c
    LEFT JOIN users u ON u.id = c.user_id WHERE c.issue_id = ? ORDER BY c.created_at`).all(issue.id);
  const photos = db.prepare(`
    SELECT ph.*, u.name AS uploader_name FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.issue_id = ? ORDER BY ph.created_at DESC`).all(issue.id);
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
  res.render('issues/show', { title: `Issue #${issue.id}`, issue, comments, photos, users, staff: isStaff(req.user) });
});

router.post('/:id/update', (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.redirect('/issues');
  const { status, priority, assigned_to } = req.body;
  db.prepare(`
    UPDATE issues SET status = ?, priority = ?, assigned_to = ?,
      resolved_at = CASE WHEN ? IN ('resolved','closed') AND resolved_at IS NULL THEN datetime('now')
                         WHEN ? NOT IN ('resolved','closed') THEN NULL ELSE resolved_at END
    WHERE id = ?`)
    .run(status, priority, assigned_to || null, status, status, issue.id);
  logActivity(req.user.id, 'issue.update', 'issue', issue.id,
    `Issue #${issue.id}: status ${issue.status} -> ${status}, priority ${priority}`);
  res.redirect(`/issues/${issue.id}`);
});

router.post('/:id/comments', (req, res) => {
  const body = (req.body.body || '').trim();
  if (body) {
    db.prepare('INSERT INTO issue_comments (issue_id, user_id, body) VALUES (?, ?, ?)')
      .run(req.params.id, req.user.id, body);
    logActivity(req.user.id, 'issue.comment', 'issue', Number(req.params.id), `Commented on issue #${req.params.id}`);
  }
  res.redirect(`/issues/${req.params.id}#comments`);
});

router.post('/:id/photos', upload.array('photos', 10), (req, res) => {
  const insert = db.prepare(`
    INSERT INTO photos (filename, original_name, caption, issue_id, uploaded_by, shared)
    VALUES (?, ?, ?, ?, ?, 1)`);
  for (const f of req.files || []) {
    insert.run(f.filename, f.originalname, req.body.caption || null, req.params.id, req.user.id);
  }
  if ((req.files || []).length) {
    logActivity(req.user.id, 'photo.upload', 'issue', Number(req.params.id),
      `Uploaded ${req.files.length} photo(s) to issue #${req.params.id}`);
  }
  res.redirect(`/issues/${req.params.id}#photos`);
});

module.exports = router;
