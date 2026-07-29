const express = require('express');
const { q, q1 } = require('../db');
const { requireRole } = require('../auth');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday } = require('../time');
const { isValidDate } = require('../recurrence');

const router = express.Router();
router.use(requireRole('supervisor'));

function reportRange(req) {
  // Window anchored to the business calendar (Melbourne), last 30 days.
  const todayStr = businessToday();
  const [y, m, d] = todayStr.split('-').map(Number);
  const defaultFrom = new Date(Date.UTC(y, m - 1, d - 29)).toISOString().slice(0, 10);
  return {
    from: isValidDate(req.query.from) ? req.query.from : defaultFrom,
    to: isValidDate(req.query.to) ? req.query.to : todayStr,
  };
}

// Shared minimal RFC-4180 CSV writer: wrap every field, double internal quotes.
function toCsv(header, rows) {
  const esc = (val) => `"${String(val == null ? '' : val).replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return lines.join('\r\n');
}

function sendCsv(res, filename, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// Operational report for a date range: jobs, hours, issues, invoicing.
router.get('/', asyncHandler(async (req, res) => {
  const { from, to } = reportRange(req);

  // Five independent aggregates — run them concurrently.
  const [visitStats, perGardener, issueStats, invoiceStats, photoRow] = await Promise.all([
    q(`
    SELECT status, COUNT(*)::int AS count FROM visits
    WHERE scheduled_date BETWEEN $1 AND $2 GROUP BY status`, [from, to]),
    q(`
    SELECT u.name,
      COUNT(*)::int AS visits,
      COUNT(*) FILTER (WHERE v.status = 'completed')::int AS completed,
      COALESCE(SUM(v.duration_minutes), 0)::int AS minutes
    FROM visits v JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date BETWEEN $1 AND $2
    GROUP BY u.id, u.name ORDER BY completed DESC`, [from, to]),
    q(`
    SELECT status, COUNT(*)::int AS count FROM issues
    WHERE created_at::date BETWEEN $1 AND $2 GROUP BY status`, [from, to]),
    q(`
    SELECT inv.status, COUNT(*)::int AS count,
      COALESCE(SUM((SELECT SUM(quantity * unit_price) FROM invoice_items WHERE invoice_id = inv.id)), 0) AS total
    FROM invoices inv JOIN visits v ON v.id = inv.visit_id
    WHERE v.scheduled_date BETWEEN $1 AND $2
    GROUP BY inv.status`, [from, to]),
    q1('SELECT COUNT(*)::int AS c FROM photos WHERE created_at::date BETWEEN $1 AND $2', [from, to]),
  ]);
  const photoCount = photoRow.c;

  res.render('reports/index', {
    title: 'Reports', from, to, visitStats, perGardener, issueStats, invoiceStats, photoCount,
  });
}));

// CSV export of the visits in the selected range (one row per visit).
router.get('/export.csv', asyncHandler(async (req, res) => {
  const { from, to } = reportRange(req);
  const rows = await q(`
    SELECT v.scheduled_date, p.name AS property, p.address, u.name AS gardener,
           v.status, v.duration_minutes, v.time_window
    FROM visits v
    JOIN properties p ON p.id = v.property_id
    LEFT JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date BETWEEN $1 AND $2
    ORDER BY v.scheduled_date, p.name`, [from, to]);
  const csv = toCsv(
    ['Date', 'Property', 'Address', 'Gardener', 'Status', 'Minutes', 'Time window'],
    rows.map((r) => [r.scheduled_date, r.property, r.address, r.gardener || 'Unassigned',
      r.status, r.duration_minutes == null ? '' : r.duration_minutes, r.time_window || ''])
  );
  sendCsv(res, `visits-${from}_to_${to}.csv`, csv);
}));

// CSV export of invoices in the selected range (one row per invoice, joined
// to its visit so the sheet is useful for reconciliation without the app).
router.get('/export-invoices.csv', asyncHandler(async (req, res) => {
  const { from, to } = reportRange(req);
  const rows = await q(`
    SELECT inv.number, inv.status, v.scheduled_date, p.name AS property,
      inv.issued_at, inv.due_at, inv.paid_at,
      COALESCE((SELECT SUM(quantity * unit_price) FROM invoice_items WHERE invoice_id = inv.id), 0) AS total
    FROM invoices inv
    JOIN visits v ON v.id = inv.visit_id
    JOIN properties p ON p.id = v.property_id
    WHERE v.scheduled_date BETWEEN $1 AND $2
    ORDER BY v.scheduled_date, inv.number`, [from, to]);
  const csv = toCsv(
    ['Number', 'Status', 'Visit date', 'Property', 'Issued', 'Due', 'Paid', 'Total'],
    rows.map((r) => [r.number, r.status, r.scheduled_date, r.property, r.issued_at || '', r.due_at || '', r.paid_at || '', r.total.toFixed(2)])
  );
  sendCsv(res, `invoices-${from}_to_${to}.csv`, csv);
}));

// CSV export of issues in the selected range.
router.get('/export-issues.csv', asyncHandler(async (req, res) => {
  const { from, to } = reportRange(req);
  const rows = await q(`
    SELECT i.created_at, i.title, i.status, i.priority, p.name AS property, u.name AS reporter_name
    FROM issues i
    JOIN properties p ON p.id = i.property_id
    LEFT JOIN users u ON u.id = i.reported_by
    WHERE i.created_at::date BETWEEN $1 AND $2
    ORDER BY i.created_at`, [from, to]);
  const csv = toCsv(
    ['Reported', 'Title', 'Status', 'Priority', 'Property', 'Reporter'],
    rows.map((r) => [r.created_at, r.title, r.status, r.priority, r.property, r.reporter_name || ''])
  );
  sendCsv(res, `issues-${from}_to_${to}.csv`, csv);
}));

module.exports = router;
