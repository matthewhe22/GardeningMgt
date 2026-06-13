const path = require('path');
const ejs = require('ejs');
const { q, q1 } = require('./db');
const { uploadFile } = require('./onedrive');
const { logActivity } = require('./activity');
const { renderMapSnapshot, externalMapUrl } = require('./mapSnapshot');
const { fmtDateTime } = require('./time');

/** Everything needed to render a job completion report. */
async function loadReportData(visitId) {
  const visit = await q1(`
    SELECT v.*, p.name AS property_name, p.address, p.lots, p.contact_name,
           p.lat, p.lng, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.id = $1`, [visitId]);
  if (!visit) return null;
  const job = visit.job_id
    ? await q1('SELECT j.*, u.name AS default_gardener_name FROM jobs j LEFT JOIN users u ON u.id = j.gardener_id WHERE j.id = $1', [visit.job_id])
    : null;
  const tasks = await q('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.visit_id = $1 ORDER BY t.id', [visitId]);
  const comments = await q('SELECT c.*, u.name AS author_name, u.role AS author_role FROM visit_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.visit_id = $1 ORDER BY c.created_at', [visitId]);
  const photos = await q('SELECT ph.id, ph.filename, ph.mime, ph.caption, ph.created_at, u.name AS uploader_name FROM photos ph LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.visit_id = $1 ORDER BY ph.created_at', [visitId]);
  const gpsPoints = await q('SELECT * FROM gps_points WHERE visit_id = $1 ORDER BY recorded_at', [visitId]);
  return { visit, job, tasks, comments, photos, gpsPoints };
}

/**
 * Render the report HTML. With inlinePhotos, image bytes are embedded as
 * data URIs so the file is self-contained (for the OneDrive archive copy).
 */
async function renderReportHtml(data, { inlinePhotos = false } = {}) {
  let photoSrc = (ph) => `/uploads/${ph.filename}`;
  if (inlinePhotos && data.photos.length) {
    // One query for all photo bytes (was N+1).
    const ids = data.photos.map((p) => p.id);
    const rows = await q('SELECT id, data, mime FROM photos WHERE id = ANY($1)', [ids]);
    const srcs = {};
    for (const r of rows) srcs[r.id] = `data:${r.mime};base64,${r.data.toString('base64')}`;
    photoSrc = (ph) => srcs[ph.id] || '';
  }
  // Self-contained location snapshot from the captured GPS: OSM tiles are
  // embedded as data URIs so the report still renders offline / from the
  // OneDrive archive.
  const mapSvg = await renderMapSnapshot(data.gpsPoints, data.visit, { inline: true });
  const mapLink = externalMapUrl(data.gpsPoints, data.visit);
  return ejs.renderFile(
    path.join(__dirname, '..', 'views', 'visits', 'report.ejs'),
    { ...data, photoSrc, mapSvg, mapLink, fmtDateTime,
      generatedAt: fmtDateTime(new Date()) }
  );
}

/**
 * Archive a completed job to OneDrive: self-contained HTML report plus the
 * original photo files, under <folder>/job-<id>-<date>/. Best-effort — any
 * failure is logged and never blocks job completion.
 */
async function archiveToOneDrive(visitId) {
  try {
    const data = await loadReportData(visitId);
    if (!data) return;
    const dir = `job-${visitId}-${data.visit.scheduled_date}`;
    const html = await renderReportHtml(data, { inlinePhotos: true });
    const result = await uploadFile(`${dir}/report.html`, html, 'text/html');
    if (result.skipped) return; // OneDrive not configured
    const ids = data.photos.map((p) => p.id);
    const rows = ids.length
      ? await q('SELECT id, filename, data, mime FROM photos WHERE id = ANY($1)', [ids]) : [];
    for (const row of rows) {
      await uploadFile(`${dir}/${row.filename}`, row.data, row.mime);
    }
    await logActivity(null, 'report.archive', 'visit', visitId,
      `Archived job #${visitId} report and ${data.photos.length} photo(s) to OneDrive`);
  } catch (e) {
    // Detail goes to server logs only; the activity log gets a generic note so
    // Graph error bodies (which can echo tokens/ids) never persist in the DB.
    console.error(`[onedrive] archive of job #${visitId} failed:`, e.message);
    await logActivity(null, 'report.archive_failed', 'visit', visitId,
      `OneDrive archive failed for job #${visitId} (see server logs)`).catch(() => {});
  }
}

module.exports = { loadReportData, renderReportHtml, archiveToOneDrive };
