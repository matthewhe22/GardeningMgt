const path = require('path');
const ejs = require('ejs');
const { q, q1 } = require('./db');
const { uploadFile, getConfig, getAccessToken } = require('./onedrive');
const { logActivity } = require('./activity');
const storage = require('./storage');
const { renderMapSnapshot, externalMapUrl } = require('./mapSnapshot');
const { fmtDateTime, fmtDate } = require('./time');

/** Everything needed to render a job completion report. */
async function loadReportData(visitId) {
  const visit = await q1(`
    SELECT v.*, p.name AS property_name, p.address, p.lots, p.contact_name, p.contact_email,
           p.lat, p.lng, u.name AS gardener_name
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.id = $1`, [visitId]);
  if (!visit) return null;
  const [job, tasks, comments, photos, gpsPoints] = await Promise.all([
    visit.job_id
      ? q1('SELECT j.*, u.name AS default_gardener_name FROM jobs j LEFT JOIN users u ON u.id = j.gardener_id WHERE j.id = $1', [visit.job_id])
      : Promise.resolve(null),
    q('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.visit_id = $1 ORDER BY t.id', [visitId]),
    q('SELECT c.*, u.name AS author_name, u.role AS author_role FROM visit_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.visit_id = $1 ORDER BY c.created_at', [visitId]),
    q('SELECT ph.id, ph.filename, ph.mime, ph.caption, ph.created_at, u.name AS uploader_name FROM photos ph LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.visit_id = $1 ORDER BY ph.created_at', [visitId]),
    q('SELECT * FROM gps_points WHERE visit_id = $1 ORDER BY recorded_at', [visitId]),
  ]);
  return { visit, job, tasks, comments, photos, gpsPoints };
}

/**
 * Render the report HTML. With inlinePhotos, image bytes are embedded as
 * data URIs so the file is self-contained (for the OneDrive archive copy).
 * Embeds the small upload-time thumbnail rather than the (up to 10MB) full
 * original — this is a preview copy alongside the full-resolution files
 * archiveToOneDrive uploads separately, so there's no need to hold every
 * original's bytes in memory just to inline them here too.
 */
async function renderReportHtml(data, { inlinePhotos = false } = {}) {
  let photoSrc = (ph) => `/uploads/${ph.filename}`;
  if (inlinePhotos && data.photos.length) {
    // One query for all photo bytes (was N+1) — thumbnails only, so this
    // stays small even for a job with many photos.
    const ids = data.photos.map((p) => p.id);
    const rows = await q('SELECT id, thumb_data, data, mime FROM photos WHERE id = ANY($1)', [ids]);
    const srcs = {};
    for (const r of rows) {
      const bytes = (r.thumb_data && r.thumb_data.length) ? r.thumb_data : r.data;
      const mime = (r.thumb_data && r.thumb_data.length) ? 'image/jpeg' : r.mime;
      srcs[r.id] = `data:${mime};base64,${bytes.toString('base64')}`;
    }
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
    // Cheap check first: if OneDrive isn't configured, skip immediately rather
    // than loading the full report and base64-encoding every photo (which the
    // user would otherwise wait on when completing a job).
    const cfg = await getConfig();
    if (!cfg) return;
    const data = await loadReportData(visitId);
    if (!data) return;
    const dir = `job-${visitId}-${data.visit.scheduled_date}`;
    const html = await renderReportHtml(data, { inlinePhotos: true });
    // Fetch the OAuth token once and reuse it for every file in this archive
    // batch instead of once per file (was 1 + N Graph token requests).
    const token = await getAccessToken(cfg);
    const ctx = { cfg, token };
    const result = await uploadFile(`${dir}/report.html`, html, 'text/html', ctx);
    if (result.skipped) return; // OneDrive not configured
    // One photo's bytes in memory at a time, not all of them — a job with
    // many multi-MB photos no longer needs to hold every original at once
    // just to relay it to OneDrive.
    for (const p of data.photos) {
      const row = await q1('SELECT filename, data, mime FROM photos WHERE id = $1', [p.id]);
      if (!row) continue;
      // Object-storage mode empties `data` in Postgres — fetch the actual
      // bytes from the bucket instead of uploading an empty file.
      const bytes = (storage.enabled() && row.data && row.data.length === 0)
        ? await storage.getObjectBuffer(row.filename)
        : row.data;
      await uploadFile(`${dir}/${row.filename}`, bytes, row.mime, ctx);
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

/**
 * Render the job completion report as a real PDF (Buffer). Uses pdfkit — pure
 * JS, no headless browser — so it stays light on serverless cold starts
 * (pdfkit is required lazily, only when a PDF is actually generated). Photos
 * are embedded; the SVG map is summarised as GPS coordinates plus a map link.
 */
async function renderReportPdf(data) {
  const PDFDocument = require('pdfkit');
  const { visit, job, tasks, comments, gpsPoints, photos } = data;

  // pdfkit's built-in fonts are Latin-1 only: strip emoji / exotic glyphs so
  // user-entered text never renders as boxes or breaks encoding.
  const clean = (s) => String(s == null ? '' : s).replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '').trim();

  // Photo bytes (only JPEG/PNG can be embedded by pdfkit) in one query.
  const photoBytes = {};
  if (photos.length) {
    const rows = await q('SELECT id, data, mime FROM photos WHERE id = ANY($1)', [photos.map((p) => p.id)]);
    for (const r of rows) photoBytes[r.id] = r;
  }
  const mapLink = externalMapUrl(gpsPoints, visit);

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 48,
      info: { Title: `Job completion report #${visit.id} - ${clean(visit.property_name)}`, Author: 'GardeningMgt' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GREEN = '#14532d', MUTED = '#707b72', INK = '#1d2620';
    const left = doc.page.margins.left;
    const cw = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

    const heading = (t) => {
      ensure(46);
      doc.moveDown(0.8);
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(13).text(clean(t));
      doc.moveTo(left, doc.y + 2).lineTo(left + cw, doc.y + 2).lineWidth(1).strokeColor('#e6e4dc').stroke();
      doc.moveDown(0.4).fillColor(INK).font('Helvetica').fontSize(10);
    };
    const row = (label, value) => {
      const v = clean(value);
      if (v === '') return;
      const labelW = 150;
      ensure(20);
      const y = doc.y;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text(clean(label), left, y, { width: labelW });
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(v, left + labelW, y, { width: cw - labelW });
      doc.y = Math.max(doc.y, y) ; doc.moveDown(0.2);
    };

    // Header
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(18).text(`Job completion report  #${visit.id}`);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10)
      .text(`${clean(visit.property_name)}, ${clean(visit.address)}  -  ${visit.scheduled_date}`);
    doc.moveTo(left, doc.y + 4).lineTo(left + cw, doc.y + 4).lineWidth(2).strokeColor(GREEN).stroke();
    doc.lineWidth(1).moveDown(0.6);

    // Job details
    heading('Job details');
    row('Site', `${clean(visit.property_name)} - ${clean(visit.address)}${visit.lots != null ? ` (${visit.lots} lots)` : ''}`);
    if (visit.contact_name) row('Site contact', visit.contact_name);
    if (visit.contact_email) row('Contact email', visit.contact_email);
    row('Gardener', visit.gardener_name || 'Unassigned');
    row('Status', visit.status.replace('_', ' '));
    row('Scheduled date', `${visit.scheduled_date}${visit.time_window ? ` - ${visit.time_window}` : ''}`);
    if (visit.started_at) row('Started', fmtDateTime(visit.started_at));
    if (visit.finished_at) row('Completed', fmtDateTime(visit.finished_at));
    if (visit.duration_minutes != null) row('Time on site', `${visit.duration_minutes} minutes`);
    if (visit.notes) row('Notes', visit.notes);
    if (job) row('Recurring schedule', `${job.frequency} - ${job.contract_years}-year contract (${job.start_date} to ${job.end_date}) - default gardener: ${job.default_gardener_name || '-'}`);

    // Tasks
    if (tasks.length) {
      heading(`Tasks (${tasks.filter((t) => t.status === 'done').length}/${tasks.length} done)`);
      tasks.forEach((t) => row(t.title, `${t.status.replace('_', ' ')}${t.description ? ` - ${t.description}` : ''}`));
    }

    // GPS + map link
    if (gpsPoints.length) {
      heading('GPS log');
      gpsPoints.forEach((g) => row(g.kind, `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}  -  ${fmtDateTime(g.recorded_at)}`));
      if (mapLink) {
        ensure(16);
        doc.fillColor(GREEN).font('Helvetica').fontSize(9).text('View job location on map', { link: mapLink, underline: true });
        doc.fillColor(INK);
      }
    }

    // Comments
    if (comments.length) {
      heading('Comments');
      comments.forEach((c) => {
        ensure(34);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(clean(c.author_name), { continued: true })
          .font('Helvetica').fillColor(MUTED).fontSize(9).text(`  (${clean(c.author_role)}) - ${fmtDateTime(c.created_at)}`);
        doc.fillColor(INK).font('Helvetica').fontSize(10).text(clean(c.body));
        doc.moveDown(0.3);
      });
    }

    // Photos
    heading(`Photos (${photos.length})`);
    if (!photos.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('No photos were uploaded for this job.');
    } else {
      photos.forEach((ph) => {
        const rec = photoBytes[ph.id];
        const caption = `${fmtDateTime(ph.created_at)}${ph.caption ? ` - ${clean(ph.caption)}` : ''} - by ${clean(ph.uploader_name) || 'unknown'}`;
        if (rec && /jpe?g|png/i.test(rec.mime)) {
          ensure(250);
          try {
            doc.image(rec.data, left, doc.y, { fit: [Math.min(340, cw), 230] });
            doc.y += 236;
          } catch (e) {
            ensure(16);
            doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`[Could not render image ${clean(ph.filename)}]`);
          }
        } else {
          ensure(16);
          doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`[Photo ${clean(ph.filename)}${rec ? ` - ${rec.mime}` : ''} - not embeddable]`);
        }
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(caption, { width: cw });
        doc.moveDown(0.5);
      });
    }

    doc.moveDown(1);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Generated by GardeningMgt on ${fmtDateTime(new Date())}.`);
    doc.end();
  });
}

/**
 * Render a single invoice as a real PDF (Buffer), for the "Download PDF"
 * action on the invoice detail page. Same pdfkit approach as
 * renderReportPdf above — no headless browser, lazily required.
 * @param {object} invoice  from invoiceWithItems() in routes/invoices.js —
 *   header fields plus .items[] and .total
 * @param {object} business  invoice-related settings (see
 *   INVOICE_SETTING_KEYS in settings.js): business name/address/ABN, payment
 *   details, and default payment-terms days. Any/all may be unset.
 */
async function renderInvoicePdf(invoice, business = {}) {
  const PDFDocument = require('pdfkit');

  // pdfkit's built-in fonts are Latin-1 only: strip emoji / exotic glyphs so
  // user-entered text never renders as boxes or breaks encoding.
  const clean = (s) => String(s == null ? '' : s).replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '').trim();
  const businessName = clean(business.invoice_business_name) || 'GardeningMgt';

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 48,
      info: { Title: `Invoice ${invoice.number}`, Author: businessName },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GREEN = '#14532d', MUTED = '#707b72', INK = '#1d2620';
    const left = doc.page.margins.left;
    const cw = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const row = (label, value) => {
      const v = clean(value);
      if (v === '') return;
      const labelW = 130;
      ensure(20);
      const y = doc.y;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text(clean(label), left, y, { width: labelW });
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(v, left + labelW, y, { width: cw - labelW });
      doc.y = Math.max(doc.y, y); doc.moveDown(0.2);
    };

    // Header: business identity (letterhead) + document title.
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20).text(businessName);
    doc.fillColor(MUTED).font('Helvetica').fontSize(9);
    if (business.invoice_business_address) doc.text(clean(business.invoice_business_address));
    if (business.invoice_business_abn) doc.text(`ABN/GST: ${clean(business.invoice_business_abn)}`);
    doc.moveDown(0.6);
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text(`TAX INVOICE  ${clean(invoice.number)}`);
    doc.moveTo(left, doc.y + 4).lineTo(left + cw, doc.y + 4).lineWidth(2).strokeColor(GREEN).stroke();
    doc.lineWidth(1).moveDown(0.6);

    // Invoice meta
    doc.fillColor(INK).font('Helvetica').fontSize(10);
    row('Invoice number', invoice.number);
    row('Issued', invoice.issued_at ? fmtDate(invoice.issued_at) : 'not yet issued');
    row('Due date', invoice.due_at ? fmtDate(invoice.due_at) : '-');
    row('Status', invoice.status);

    // Bill to
    doc.moveDown(0.4);
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(12).text('Bill to');
    doc.moveDown(0.2);
    row('Property', invoice.property_name);
    row('Address', invoice.address);
    if (invoice.contact_name) row('Contact', invoice.contact_name);
    if (invoice.contact_email) row('Contact email', invoice.contact_email);
    row('Job date', invoice.scheduled_date);

    // Line items table
    doc.moveDown(0.6);
    ensure(30);
    const amtW = 75, priceW = 75, qtyW = 50;
    const descW = cw - amtW - priceW - qtyW;
    const colDesc = left, colQty = colDesc + descW, colPrice = colQty + qtyW, colAmt = colPrice + priceW;
    const tableTop = doc.y;
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9);
    doc.text('Description', colDesc, tableTop, { width: descW });
    doc.text('Qty', colQty, tableTop, { width: qtyW, align: 'right' });
    doc.text('Unit price', colPrice, tableTop, { width: priceW, align: 'right' });
    doc.text('Amount', colAmt, tableTop, { width: amtW, align: 'right' });
    doc.moveTo(left, tableTop + 14).lineTo(left + cw, tableTop + 14).lineWidth(1).strokeColor('#e6e4dc').stroke();
    doc.y = tableTop + 20;

    doc.font('Helvetica').fillColor(INK).fontSize(10);
    invoice.items.forEach((it) => {
      const desc = clean(it.description);
      const h = Math.max(doc.heightOfString(desc, { width: descW }), 14);
      ensure(h + 6);
      const y = doc.y;
      doc.text(desc, colDesc, y, { width: descW });
      doc.text(String(it.quantity), colQty, y, { width: qtyW, align: 'right' });
      doc.text(`$${it.unit_price.toFixed(2)}`, colPrice, y, { width: priceW, align: 'right' });
      doc.text(`$${(it.quantity * it.unit_price).toFixed(2)}`, colAmt, y, { width: amtW, align: 'right' });
      doc.y = y + h + 6;
    });
    if (!invoice.items.length) {
      ensure(16);
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('No line items.', colDesc, doc.y);
      doc.moveDown(0.4);
    }

    ensure(30);
    doc.moveTo(left, doc.y + 2).lineTo(left + cw, doc.y + 2).lineWidth(1).strokeColor('#e6e4dc').stroke();
    doc.moveDown(0.4);
    const totalY = doc.y;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    doc.text('Total', colPrice, totalY, { width: priceW, align: 'right' });
    doc.text(`$${invoice.total.toFixed(2)}`, colAmt, totalY, { width: amtW, align: 'right' });
    doc.y = totalY + 24;

    // Payment details / terms
    if (business.invoice_payment_terms_days || business.invoice_payment_details) {
      ensure(60);
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(11).text('Payment details');
      doc.moveDown(0.2);
      doc.fillColor(INK).font('Helvetica').fontSize(9);
      if (business.invoice_payment_terms_days) {
        doc.text(`Payment due within ${clean(business.invoice_payment_terms_days)} days of issue.`);
      }
      if (business.invoice_payment_details) {
        doc.text(clean(business.invoice_payment_details), { width: cw });
      }
    }

    doc.moveDown(1);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Generated by ${businessName} on ${fmtDateTime(new Date())}.`);
    doc.end();
  });
}

module.exports = { loadReportData, renderReportHtml, renderReportPdf, renderInvoicePdf, archiveToOneDrive };
