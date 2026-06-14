const express = require('express');
const { q, q1 } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

async function nextInvoiceNumber() {
  // A DB sequence is atomic, so concurrent creates never collide on the
  // UNIQUE number (the old COUNT(*) approach raced into 500s).
  const year = new Date().getFullYear();
  const { n } = await q1("SELECT nextval('invoice_seq')::int AS n");
  return `INV-${year}-${String(n).padStart(4, '0')}`;
}

async function invoiceWithItems(id) {
  // Header and line items are both keyed by the same id — fetch concurrently.
  const [invoice, items] = await Promise.all([
    q1(`
    SELECT inv.*, v.scheduled_date, v.duration_minutes, p.name AS property_name, p.address,
           p.contact_name, u.name AS gardener_name
    FROM invoices inv
    JOIN visits v ON v.id = inv.visit_id
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE inv.id = $1`, [id]),
    q('SELECT * FROM invoice_items WHERE invoice_id = $1', [id]),
  ]);
  if (!invoice) return null;
  invoice.items = items;
  invoice.total = invoice.items.reduce((s, it) => s + it.quantity * it.unit_price, 0);
  return invoice;
}

// Invoicing is staff-only.
router.use(requireRole('supervisor'));

router.get('/', asyncHandler(async (req, res) => {
  const invoices = await q(`
    SELECT inv.*, p.name AS property_name, v.scheduled_date,
      (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_items WHERE invoice_id = inv.id) AS total
    FROM invoices inv
    JOIN visits v ON v.id = inv.visit_id
    JOIN properties p ON p.id = v.property_id
    ORDER BY inv.created_at DESC LIMIT 200`);
  res.render('invoices/index', { title: 'Invoices', invoices });
}));

// Create an invoice for a job, pre-filled with a labour line from the timer.
router.post('/', asyncHandler(async (req, res) => {
  const visitId = Number(req.body.visit_id);
  const visit = await q1('SELECT * FROM visits WHERE id = $1', [visitId]);
  if (!visit) return res.redirect('/invoices');
  const number = await nextInvoiceNumber();
  const { id: invoiceId } = await q1(
    'INSERT INTO invoices (visit_id, number, created_by) VALUES ($1, $2, $3) RETURNING id',
    [visitId, number, req.user.id]);
  if (visit.duration_minutes) {
    const hourlyRate = Number(process.env.HOURLY_RATE || 50);
    await q('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
      [invoiceId, `Gardening labour (${visit.duration_minutes} min)`,
        Math.round((visit.duration_minutes / 60) * 100) / 100, hourlyRate]);
  }
  await logActivity(req.user.id, 'invoice.create', 'invoice', invoiceId, `Created invoice ${number} for job #${visitId}`);
  res.redirect(`/invoices/${invoiceId}`);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const invoice = await invoiceWithItems(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  res.render('invoices/show', { title: invoice.number, invoice });
}));

router.post('/:id/items', asyncHandler(async (req, res) => {
  const { description, quantity, unit_price } = req.body;
  if ((description || '').trim()) {
    await q('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
      [req.params.id, description.trim(), Number(quantity) || 1, Number(unit_price) || 0]);
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
  await q(`
    UPDATE invoices SET status = $1,
      issued_at = CASE WHEN $1 = 'sent' AND issued_at IS NULL THEN now() ELSE issued_at END,
      paid_at   = CASE WHEN $1 = 'paid' THEN now() ELSE paid_at END
    WHERE id = $2`, [status, req.params.id]);
  await logActivity(req.user.id, 'invoice.status', 'invoice', Number(req.params.id),
    `Invoice #${req.params.id} marked ${status}`);
  res.redirect(`/invoices/${req.params.id}`);
}));

module.exports = router;
