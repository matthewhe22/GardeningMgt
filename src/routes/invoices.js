const express = require('express');
const { q, q1 } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const { pageParam, paginate } = require('../pagination');
const { getSettings, INVOICE_SETTING_KEYS } = require('../settings');
const { renderInvoicePdf } = require('../report');
const { createInvoiceForVisit, invoiceWithItems } = require('../invoicing');

const router = express.Router();

// Invoicing is staff-only.
router.use(requireRole('supervisor'));

router.get('/', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim();
  const args = [];
  let cond = '';
  if (search) { args.push(`%${search}%`); cond = `WHERE inv.number ILIKE $1 OR p.name ILIKE $1`; }
  const page = pageParam(req);
  const invoicesSql = `
    SELECT inv.*, p.name AS property_name, v.scheduled_date,
      (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_items WHERE invoice_id = inv.id) AS total
    FROM invoices inv
    JOIN visits v ON v.id = inv.visit_id
    JOIN properties p ON p.id = v.property_id
    ${cond}
    ORDER BY inv.created_at DESC`;
  const { rows: invoices, total, totalPages } = await paginate(q, invoicesSql, args, page);
  res.render('invoices/index', {
    title: 'Invoices', invoices, search, page, total, totalPages,
    error: req.query.error || null, deleted: req.query.deleted || null,
  });
}));

// Create an invoice for a job, pre-filled with a gardening-fee line when the
// site's job has one set (an admin-only figure — see jobs.js parseFee).
router.post('/', asyncHandler(async (req, res) => {
  const visitId = Number(req.body.visit_id);
  if (!Number.isInteger(visitId)) return res.redirect('/invoices');
  const result = await createInvoiceForVisit(visitId, { userId: req.user.id });
  if (result.status === 'not_found') return res.redirect('/invoices');
  if (result.status === 'not_completed') return res.redirect('/invoices?error=notcompleted');
  res.redirect(`/invoices/${result.invoiceId}`);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const invoice = await invoiceWithItems(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  res.render('invoices/show', { title: invoice.number, invoice, error: req.query.error || null });
}));

// PDF export — same gating as this whole router (staff-only), following the
// job-report PDF's approach (src/report.js, served from GET /visits/:id/report).
router.get('/:id/pdf', asyncHandler(async (req, res) => {
  const invoice = await invoiceWithItems(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  const business = await getSettings(INVOICE_SETTING_KEYS);
  const pdf = await renderInvoicePdf(invoice, business);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
  res.send(pdf);
}));

// Delete an empty draft — the one case where burning the invoice number
// with "void" is overkill (e.g. created by mistake, never had a line added).
router.post('/:id/delete', asyncHandler(async (req, res) => {
  const invoice = await q1('SELECT id, status FROM invoices WHERE id = $1', [req.params.id]);
  if (!invoice) return res.redirect('/invoices');
  if (invoice.status !== 'draft') return res.redirect(`/invoices/${req.params.id}?error=notdraft`);
  const { c } = await q1('SELECT COUNT(*)::int AS c FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
  if (c > 0) return res.redirect(`/invoices/${req.params.id}?error=hasitems`);
  await q('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  await logActivity(req.user.id, 'invoice.delete', 'invoice', Number(req.params.id),
    `Deleted empty draft invoice #${req.params.id}`);
  res.redirect('/invoices?deleted=1');
}));

router.post('/:id/items', asyncHandler(async (req, res) => {
  const { description, quantity, unit_price } = req.body;
  if ((description || '').trim()) {
    // Clamp to non-negative so a stray '-5' can't create negative money.
    const qty = Math.max(0, Number(quantity) || 1);
    const price = Math.max(0, Number(unit_price) || 0);
    await q('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
      [req.params.id, description.trim(), qty, price]);
    await logActivity(req.user.id, 'invoice.item.add', 'invoice', Number(req.params.id),
      `Added line "${description.trim()}" to invoice #${req.params.id}`);
  }
  res.redirect(`/invoices/${req.params.id}`);
}));

router.post('/:id/items/:itemId/delete', asyncHandler(async (req, res) => {
  await q('DELETE FROM invoice_items WHERE id = $1 AND invoice_id = $2', [req.params.itemId, req.params.id]);
  await logActivity(req.user.id, 'invoice.item.remove', 'invoice', Number(req.params.id),
    `Removed a line from invoice #${req.params.id}`);
  res.redirect(`/invoices/${req.params.id}`);
}));

router.post('/:id/status', asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'sent', 'paid', 'void'].includes(status)) return res.redirect(`/invoices/${req.params.id}`);
  try {
    await q(`
      UPDATE invoices SET status = $1,
        issued_at = CASE WHEN $1 = 'sent' AND issued_at IS NULL THEN now() ELSE issued_at END,
        paid_at   = CASE WHEN $1 = 'paid' THEN now() ELSE paid_at END
      WHERE id = $2`, [status, req.params.id]);
  } catch (e) {
    // Un-voiding this invoice while another live invoice already exists for
    // the same visit (uq_invoices_visit_open) — send back a friendly error
    // instead of a 500.
    if (e.code === '23505') return res.redirect(`/invoices/${req.params.id}?error=duplicate`);
    throw e;
  }
  await logActivity(req.user.id, 'invoice.status', 'invoice', Number(req.params.id),
    `Invoice #${req.params.id} marked ${status}`);
  res.redirect(`/invoices/${req.params.id}`);
}));

module.exports = router;
