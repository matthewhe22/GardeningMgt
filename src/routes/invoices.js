const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');

const router = express.Router();

function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const row = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE number LIKE ?").get(`INV-${year}-%`);
  return `INV-${year}-${String(row.c + 1).padStart(4, '0')}`;
}

function invoiceWithItems(id) {
  const invoice = db.prepare(`
    SELECT inv.*, v.scheduled_date, v.duration_minutes, p.name AS property_name, p.address,
           p.contact_name, u.name AS gardener_name
    FROM invoices inv
    JOIN visits v ON v.id = inv.visit_id
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE inv.id = ?`).get(id);
  if (!invoice) return null;
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(id);
  invoice.total = invoice.items.reduce((s, it) => s + it.quantity * it.unit_price, 0);
  return invoice;
}

// Invoicing is staff-only.
router.use(requireRole('supervisor'));

router.get('/', (req, res) => {
  const invoices = db.prepare(`
    SELECT inv.*, p.name AS property_name, v.scheduled_date,
      (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_items WHERE invoice_id = inv.id) AS total
    FROM invoices inv
    JOIN visits v ON v.id = inv.visit_id
    JOIN properties p ON p.id = v.property_id
    ORDER BY inv.created_at DESC LIMIT 200`).all();
  res.render('invoices/index', { title: 'Invoices', invoices });
});

// Create an invoice for a job, pre-filled with a labour line from the timer.
router.post('/', (req, res) => {
  const visitId = Number(req.body.visit_id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return res.redirect('/invoices');
  const number = nextInvoiceNumber();
  const info = db.prepare('INSERT INTO invoices (visit_id, number, created_by) VALUES (?, ?, ?)')
    .run(visitId, number, req.user.id);
  const invoiceId = info.lastInsertRowid;
  if (visit.duration_minutes) {
    const hourlyRate = Number(process.env.HOURLY_RATE || 50);
    db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES (?, ?, ?, ?)')
      .run(invoiceId, `Gardening labour (${visit.duration_minutes} min)`,
        Math.round((visit.duration_minutes / 60) * 100) / 100, hourlyRate);
  }
  logActivity(req.user.id, 'invoice.create', 'invoice', invoiceId, `Created invoice ${number} for job #${visitId}`);
  res.redirect(`/invoices/${invoiceId}`);
});

router.get('/:id', (req, res) => {
  const invoice = invoiceWithItems(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  res.render('invoices/show', { title: invoice.number, invoice });
});

router.post('/:id/items', (req, res) => {
  const { description, quantity, unit_price } = req.body;
  if ((description || '').trim()) {
    db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES (?, ?, ?, ?)')
      .run(req.params.id, description.trim(), Number(quantity) || 1, Number(unit_price) || 0);
    logActivity(req.user.id, 'invoice.item.add', 'invoice', Number(req.params.id),
      `Added line "${description.trim()}" to invoice #${req.params.id}`);
  }
  res.redirect(`/invoices/${req.params.id}`);
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  db.prepare('DELETE FROM invoice_items WHERE id = ? AND invoice_id = ?').run(req.params.itemId, req.params.id);
  logActivity(req.user.id, 'invoice.item.remove', 'invoice', Number(req.params.id),
    `Removed a line from invoice #${req.params.id}`);
  res.redirect(`/invoices/${req.params.id}`);
});

router.post('/:id/status', (req, res) => {
  const status = req.body.status;
  if (!['draft', 'sent', 'paid', 'void'].includes(status)) return res.redirect(`/invoices/${req.params.id}`);
  db.prepare(`
    UPDATE invoices SET status = ?,
      issued_at = CASE WHEN ? = 'sent' AND issued_at IS NULL THEN datetime('now') ELSE issued_at END,
      paid_at   = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END
    WHERE id = ?`).run(status, status, status, req.params.id);
  logActivity(req.user.id, 'invoice.status', 'invoice', Number(req.params.id),
    `Invoice #${req.params.id} marked ${status}`);
  res.redirect(`/invoices/${req.params.id}`);
});

module.exports = router;
