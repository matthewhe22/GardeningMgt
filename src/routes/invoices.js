const express = require('express');
const { q, q1, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../activity');
const { asyncHandler } = require('../asyncHandler');
const { year: businessYear, today: businessToday } = require('../time');
const { pageParam, paginate } = require('../pagination');
const { getSetting, getSettings, INVOICE_SETTING_KEYS } = require('../settings');
const { renderInvoicePdf } = require('../report');

const router = express.Router();

// Add `days` calendar days to a 'YYYY-MM-DD' date string, without any
// timezone drift (plain UTC-midnight arithmetic on the calendar date).
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function nextInvoiceNumber() {
  // Per-year counter, atomically incremented-and-read in one statement — the
  // same INSERT ... ON CONFLICT ... RETURNING pattern already trusted
  // elsewhere in this codebase for race-safe counters (e.g. the unique
  // partial indexes on jobs/invoices), so concurrent creates never collide on
  // the UNIQUE number. Replaces the old single global invoice_seq sequence,
  // which never actually reset per year despite its comment claiming
  // otherwise — nextval() just kept counting across year boundaries.
  // invoice_seq itself is kept in the schema (unused for new numbers) so
  // already-issued numbers stay valid; see db.js.
  const year = businessYear();
  const { next_n } = await q1(
    `INSERT INTO invoice_number_counters (year) VALUES ($1)
     ON CONFLICT (year) DO UPDATE SET next_n = invoice_number_counters.next_n + 1
     RETURNING next_n`,
    [year]);
  return `INV-${year}-${String(next_n).padStart(4, '0')}`;
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
  const visit = await q1(
    `SELECT v.*, j.gardening_fee FROM visits v LEFT JOIN jobs j ON j.id = v.job_id WHERE v.id = $1`,
    [visitId]);
  if (!visit) return res.redirect('/invoices');
  // A job that hasn't happened yet has nothing to bill — block invoicing
  // until the visit is actually completed.
  if (visit.status !== 'completed') {
    return res.redirect('/invoices?error=notcompleted');
  }
  // Don't create a second live invoice for the same job (voided ones don't count).
  // This check-then-insert still has a race window, closed below by the
  // uq_invoices_visit_open unique index + a 23505 catch.
  const existing = await q1("SELECT id FROM invoices WHERE visit_id = $1 AND status <> 'void' LIMIT 1", [visitId]);
  if (existing) return res.redirect(`/invoices/${existing.id}`);
  const number = await nextInvoiceNumber();
  const termsDays = Number(await getSetting('invoice_payment_terms_days')) || 14;
  const dueAt = addDays(businessToday(), termsDays);
  let invoiceId;
  try {
    // Invoice + its fee line are one unit: a failure partway through must
    // not leave a live invoice with zero line items.
    invoiceId = await withTransaction(async (tx) => {
      const { id } = await tx.q1(
        'INSERT INTO invoices (visit_id, number, created_by, due_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [visitId, number, req.user.id, dueAt]);
      if (visit.gardening_fee != null) {
        await tx.q('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [id, 'Gardening fee', 1, visit.gardening_fee]);
      }
      return id;
    });
  } catch (e) {
    if (e.code === '23505') { // unique_violation: lost the race to a concurrent create
      const winner = await q1("SELECT id FROM invoices WHERE visit_id = $1 AND status <> 'void' LIMIT 1", [visitId]);
      if (winner) return res.redirect(`/invoices/${winner.id}`);
    }
    throw e;
  }
  await logActivity(req.user.id, 'invoice.create', 'invoice', invoiceId, `Created invoice ${number} for job #${visitId}`);
  res.redirect(`/invoices/${invoiceId}`);
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
