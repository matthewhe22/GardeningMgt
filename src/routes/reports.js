const express = require('express');
const { q, q1 } = require('../db');
const { requireRole } = require('../auth');
const { asyncHandler } = require('../asyncHandler');
const { today: businessToday } = require('../time');

const router = express.Router();
router.use(requireRole('supervisor'));

// Operational report for a date range: jobs, hours, issues, invoicing.
router.get('/', asyncHandler(async (req, res) => {
  // Window anchored to the business calendar (Melbourne), last 30 days.
  const todayStr = businessToday();
  const [y, m, d] = todayStr.split('-').map(Number);
  const defaultFrom = new Date(Date.UTC(y, m - 1, d - 29)).toISOString().slice(0, 10);
  const from = req.query.from || defaultFrom;
  const to = req.query.to || todayStr;

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

module.exports = router;
