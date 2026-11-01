/**
 * Email the job completion report to every active admin.
 *
 * Each email has an HTML summary (scope of duties with tick / comment / photo
 * count, plus a link to the online report) and the full self-contained report
 * (all photos embedded) attached as an .html file. Best-effort: failures are
 * logged and never block job completion. Requires RESEND_API_KEY + RESEND_FROM.
 */
const { q } = require('./db');
const { loadReportData, renderReportHtml } = require('./report');
const { sendEmail, emailConfigured } = require('./notify');
const { logActivity } = require('./activity');

// Keep well under the provider's 40 MB message cap (base64 adds ~33%).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Public base URL for links in emails: APP_URL env, else the request's origin. */
function baseUrlFrom(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  return req ? `${req.protocol}://${req.get('host')}` : '';
}

function summaryHtml(d, link, attached) {
  const v = d.visit;
  const rows = d.checks.map((c, i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#707b72">${i + 1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(c.title)}
        ${c.comment ? `<br><span style="color:#555;font-size:13px">💬 ${esc(c.comment)}</span>` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap">${c.done
        ? '<b style="color:#15803d">✔ Done</b>' : '<b style="color:#b45309">✘ Not done</b>'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#707b72">📷 ${c.photos.length}</td>
    </tr>`).join('');
  const done = d.checks.filter((c) => c.done).length;
  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#1d2620;max-width:720px">
  <h2 style="color:#14532d;margin:0 0 4px">Job report #${v.id} — ${esc(v.property_name)}</h2>
  <p style="color:#707b72;margin:0 0 16px">${esc(v.address)} · ${esc(v.scheduled_date)}</p>
  <table style="font-size:14px;margin-bottom:16px">
    <tr><td style="color:#707b72;padding:2px 12px 2px 0">Gardener</td><td>${esc(v.gardener_name || '—')}</td></tr>
    <tr><td style="color:#707b72;padding:2px 12px 2px 0">Completed</td><td>${esc(v.finished_at || '—')} UTC</td></tr>
    <tr><td style="color:#707b72;padding:2px 12px 2px 0">Time on site</td><td>${v.duration_minutes ?? '—'} min</td></tr>
    <tr><td style="color:#707b72;padding:2px 12px 2px 0">Photos</td><td>${d.photos.length}</td></tr>
  </table>
  ${d.checks.length ? `<h3 style="color:#14532d;margin:16px 0 6px">Scope of duties (${done}/${d.checks.length} done)</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>` : ''}
  <p style="margin:20px 0">
    <a href="${esc(link)}" style="background:#14532d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Review &amp; approve job</a>
  </p>
  <p style="color:#707b72;font-size:13px">${attached
    ? 'The full report with every photo is attached (open the .html file in a browser).'
    : 'Open the link above to see the full report with every photo.'}</p>
</div>`;
}

async function emailJobReport(visitId, baseUrl = '') {
  try {
    if (!emailConfigured()) return 0;
    const admins = await q("SELECT email FROM users WHERE role = 'admin' AND active ORDER BY id");
    if (!admins.length) return 0;
    const d = await loadReportData(visitId);
    if (!d) return 0;
    const v = d.visit;
    const link = `${baseUrl}/visits/${v.id}`;
    const fullHtml = await renderReportHtml(d, { inlinePhotos: true });
    const attach = Buffer.byteLength(fullHtml) <= MAX_ATTACHMENT_BYTES;
    const html = summaryHtml(d, link, attach);
    const done = d.checks.filter((c) => c.done).length;
    const text = `Job #${v.id} at ${v.property_name} (${v.scheduled_date}) was completed by ` +
      `${v.gardener_name || 'the gardener'}: ${v.duration_minutes ?? '?'} min, ` +
      `${d.checks.length ? `scope ${done}/${d.checks.length} done, ` : ''}${d.photos.length} photo(s).\n` +
      `Review and approve: ${link}`;
    const subject = `Job report: ${v.property_name} — ${v.scheduled_date} (#${v.id})`;
    const attachments = attach
      ? [{ filename: `job-${v.id}-${v.scheduled_date}-report.html`, content: fullHtml }] : [];
    let sent = 0;
    for (const a of admins) {
      if (await sendEmail(a.email, subject, text, { html, attachments })) sent++;
    }
    await logActivity(null, 'report.email', 'visit', v.id,
      `Emailed job #${v.id} report to ${sent}/${admins.length} admin(s)`);
    return sent;
  } catch (e) {
    console.error(`[email] job #${visitId} report failed:`, e.message);
    await logActivity(null, 'report.email_failed', 'visit', visitId,
      `Emailing job #${visitId} report failed (see server logs)`).catch(() => {});
    return 0;
  }
}

module.exports = { emailJobReport, baseUrlFrom, summaryHtml };
