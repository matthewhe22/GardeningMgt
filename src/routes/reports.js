const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();
router.use(requireRole('supervisor'));

// Operational report for a date range: jobs, hours, issues, invoicing.
router.get('/', (req, res) => {
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const from = req.query.from || defaultFrom;
  const to = req.query.to || today.toISOString().slice(0, 10);

  const visitStats = db.prepare(`
    SELECT status, COUNT(*) AS count FROM visits
    WHERE scheduled_date BETWEEN ? AND ? GROUP BY status`).all(from, to);

  const perGardener = db.prepare(`
    SELECT u.name,
      COUNT(*) AS visits,
      SUM(v.status = 'completed') AS completed,
      COALESCE(SUM(v.duration_minutes), 0) AS minutes
    FROM visits v JOIN users u ON u.id = v.gardener_id
    WHERE v.scheduled_date BETWEEN ? AND ?
    GROUP BY u.id ORDER BY completed DESC`).all(from, to);

  const issueStats = db.prepare(`
    SELECT status, COUNT(*) AS count FROM issues
    WHERE date(created_at) BETWEEN ? AND ? GROUP BY status`).all(from, to);

  const invoiceStats = db.prepare(`
    SELECT inv.status, COUNT(*) AS count,
      COALESCE(SUM((SELECT SUM(quantity * unit_price) FROM invoice_items WHERE invoice_id = inv.id)), 0) AS total
    FROM invoices inv JOIN visits v ON v.id = inv.visit_id
    WHERE v.scheduled_date BETWEEN ? AND ?
    GROUP BY inv.status`).all(from, to);

  const photoCount = db.prepare(
    'SELECT COUNT(*) AS c FROM photos WHERE date(created_at) BETWEEN ? AND ?').get(from, to).c;

  res.render('reports/index', {
    title: 'Reports', from, to, visitStats, perGardener, issueStats, invoiceStats, photoCount,
  });
});

module.exports = router;
