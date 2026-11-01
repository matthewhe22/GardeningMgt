// Global scope-of-duties library and templates ("Standard 1", "Standard 2"...)
// that admins apply to all sites or selected sites.
const express = require('express');
const { q, q1, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const { assertCsrf } = require('../csrf');
const { upload, savePhoto } = require('../upload');
const { MAX_SCOPES } = require('../scope');
const { applyTemplate, resyncFollowers } = require('../scopeTemplates');

const router = express.Router();
router.use(requireRole('supervisor'));

const BASE = '/admin/scopes';
const back = (res, msg, anchor = '') => res.redirect(`${BASE}${msg ? `?msg=${msg}` : ''}${anchor}`);
/** Checkbox values arrive as a string (one) or an array (several). */
const idList = (v) => [...new Set([].concat(v || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const cleanLines = (text) => String(text || '').split(/\r?\n/)
  .map((l) => l.replace(/^[\s*•\-–]+/, '').replace(/[,;]\s*$/, '').trim())
  .filter(Boolean).map((l) => l.slice(0, 300));

router.get('/', asyncHandler(async (req, res) => {
  const library = await q(`
    SELECT l.*,
      (SELECT ph.filename FROM photos ph WHERE ph.library_scope_id = l.id ORDER BY ph.created_at DESC LIMIT 1) AS photo
    FROM scope_library l ORDER BY l.position, l.id`);
  const templates = await q(`
    SELECT t.*,
      COALESCE((SELECT array_agg(ti.library_id) FROM scope_template_items ti WHERE ti.template_id = t.id), '{}') AS item_ids,
      (SELECT COUNT(*) FROM jobs j WHERE j.template_id = t.id AND j.active)::int AS site_count
    FROM scope_templates t ORDER BY t.name`);
  const jobs = await q(`
    SELECT j.id, j.template_id, j.scope_customized, p.name AS property_name, p.address,
      (SELECT COUNT(*) FROM job_scopes s WHERE s.job_id = j.id)::int AS scope_count
    FROM jobs j JOIN properties p ON p.id = j.property_id
    WHERE j.active ORDER BY p.name`);
  const nextName = `Standard ${templates.length + 1}`;
  res.render('admin/scopes', {
    title: 'Scope standards', library, templates, jobs, max: MAX_SCOPES, nextName,
    msg: req.query.msg || null, applied: req.query.applied || null,
  });
}));

// ---- Library items -------------------------------------------------------

router.post('/library', asyncHandler(async (req, res) => {
  const lines = cleanLines(req.body.titles);
  let added = 0; let full = false;
  await withTransaction(async (tx) => {
    await tx.q('LOCK TABLE scope_library IN SHARE ROW EXCLUSIVE MODE');
    const { n, maxpos } = await tx.q1('SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0)::int AS maxpos FROM scope_library');
    full = lines.length > MAX_SCOPES - n;
    for (const [i, title] of lines.slice(0, Math.max(0, MAX_SCOPES - n)).entries()) {
      await tx.q('INSERT INTO scope_library (position, title) VALUES ($1, $2)', [maxpos + i + 1, title]);
      added++;
    }
  });
  if (added) await logActivity(req.user.id, 'scope.library.add', 'scope_library', null, `Added ${added} scope item(s) to the library`);
  back(res, full ? 'full' : null, '#library');
}));

router.post('/library/:id/update', asyncHandler(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 300);
  const row = title && await q1('UPDATE scope_library SET title = $1 WHERE id = $2 RETURNING id', [title, Number(req.params.id) || 0]);
  if (row) await resyncFollowers(); // sites following a template get the new wording
  back(res, null, '#library');
}));

router.post('/library/:id/move', asyncHandler(async (req, res) => {
  const id = Number(req.params.id) || 0;
  let moved = false;
  await withTransaction(async (tx) => {
    const all = await tx.q('SELECT id FROM scope_library ORDER BY position, id FOR UPDATE');
    const i = all.findIndex((r) => r.id === id);
    const j = req.body.dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    for (const [pos, r] of all.entries()) await tx.q('UPDATE scope_library SET position = $1 WHERE id = $2', [pos + 1, r.id]);
    moved = true;
  });
  if (moved) await resyncFollowers();
  back(res, null, '#library');
}));

router.post('/library/:id/delete', asyncHandler(async (req, res) => {
  const row = await q1('DELETE FROM scope_library WHERE id = $1 RETURNING title', [Number(req.params.id) || 0]);
  if (row) {
    await resyncFollowers(); // removed from every template and following site
    await logActivity(req.user.id, 'scope.library.delete', 'scope_library', null, `Deleted library scope item "${row.title}"`);
  }
  back(res, null, '#library');
}));

router.post('/library/:id/photo', upload.single('photo'), asyncHandler(async (req, res) => {
  assertCsrf(req);
  const item = await q1('SELECT * FROM scope_library WHERE id = $1', [Number(req.params.id) || 0]);
  if (!item || !req.file) return back(res, null, '#library');
  const saved = await savePhoto(req.file, { libraryScopeId: item.id, userId: req.user.id, shared: false, caption: 'Standard' });
  if (!saved) return back(res, 'badphoto', '#library');
  await q('DELETE FROM photos WHERE library_scope_id = $1 AND filename <> $2', [item.id, saved]);
  await logActivity(req.user.id, 'scope.library.photo', 'scope_library', item.id, `Set standard photo for "${item.title}"`);
  back(res, null, '#library');
}));

router.post('/library/:id/photo/delete', asyncHandler(async (req, res) => {
  await q('DELETE FROM photos WHERE library_scope_id = $1', [Number(req.params.id) || 0]);
  back(res, null, '#library');
}));

// ---- Templates -----------------------------------------------------------

async function setTemplateItems(tx, templateId, itemIds) {
  await tx.q('DELETE FROM scope_template_items WHERE template_id = $1', [templateId]);
  await tx.q(`INSERT INTO scope_template_items (template_id, library_id)
              SELECT $1, id FROM scope_library WHERE id = ANY($2::int[])`, [templateId, itemIds]);
}

// Save all / selected library items as a new template.
router.post('/templates', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const itemIds = idList(req.body.item_ids);
  if (!name || !itemIds.length) return back(res, 'noitems', '#library');
  try {
    const t = await withTransaction(async (tx) => {
      const row = await tx.q1('INSERT INTO scope_templates (name) VALUES ($1) RETURNING id', [name]);
      await setTemplateItems(tx, row.id, itemIds);
      return row;
    });
    await logActivity(req.user.id, 'scope.template.create', 'scope_template', t.id,
      `Saved template "${name}" with ${itemIds.length} item(s)`);
    back(res, 'created', `#tpl-${t.id}`);
  } catch (e) {
    if (e.code === '23505') return back(res, 'dupname', '#library');
    throw e;
  }
}));

// Rename and/or change which library items a template contains.
router.post('/templates/:id/update', asyncHandler(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const name = String(req.body.name || '').trim().slice(0, 80);
  const itemIds = idList(req.body.item_ids);
  if (!name || !itemIds.length) return back(res, 'noitems', `#tpl-${id}`);
  try {
    await withTransaction(async (tx) => {
      await tx.q('UPDATE scope_templates SET name = $1 WHERE id = $2', [name, id]);
      await setTemplateItems(tx, id, itemIds);
    });
  } catch (e) {
    if (e.code === '23505') return back(res, 'dupname', `#tpl-${id}`);
    throw e;
  }
  const n = await resyncFollowers(id);
  await logActivity(req.user.id, 'scope.template.update', 'scope_template', id,
    `Updated template "${name}" (${itemIds.length} items); re-synced ${n} site(s)`);
  back(res, 'saved', `#tpl-${id}`);
}));

router.post('/templates/:id/delete', asyncHandler(async (req, res) => {
  const row = await q1('DELETE FROM scope_templates WHERE id = $1 RETURNING name', [Number(req.params.id) || 0]);
  // Sites keep their current scope items; they just stop following the template.
  if (row) await logActivity(req.user.id, 'scope.template.delete', 'scope_template', null, `Deleted template "${row.name}"`);
  back(res, null, '#templates');
}));

// Apply a template to all active sites, or to the selected ones.
router.post('/templates/:id/apply', asyncHandler(async (req, res) => {
  const t = await q1('SELECT * FROM scope_templates WHERE id = $1', [Number(req.params.id) || 0]);
  if (!t) return back(res);
  const jobIds = req.body.target === 'all'
    ? (await q('SELECT id FROM jobs WHERE active')).map((j) => j.id)
    : (await q('SELECT id FROM jobs WHERE active AND id = ANY($1::int[])', [idList(req.body.job_ids)])).map((j) => j.id);
  if (!jobIds.length) return back(res, 'nosites', `#tpl-${t.id}`);
  const n = await applyTemplate(t.id, jobIds);
  await logActivity(req.user.id, 'scope.template.apply', 'scope_template', t.id,
    `Applied "${t.name}" to ${n} site(s)`);
  res.redirect(`${BASE}?msg=applied&applied=${n}#tpl-${t.id}`);
}));

module.exports = router;
