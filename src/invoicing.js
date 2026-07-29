/**
 * Shared invoice-creation logic, used by both the manual "Create invoice"
 * button (src/routes/invoices.js) and the auto-invoice-on-completion hook
 * (src/routes/visits.js).
 */
const { q, q1, withTransaction } = require('./db');
const { year: businessYear, today: businessToday, fmtDate } = require('./time');
const { getSetting, getSettings, INVOICE_SETTING_KEYS } = require('./settings');
const { logActivity } = require('./activity');

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
  // the UNIQUE number. invoice_seq itself is kept in the schema (unused for
  // new numbers) so already-issued numbers stay valid; see db.js.
  const year = businessYear();
  const { next_n } = await q1(
    `INSERT INTO invoice_number_counters (year) VALUES ($1)
     ON CONFLICT (year) DO UPDATE SET next_n = invoice_number_counters.next_n + 1
     RETURNING next_n`,
    [year]);
  return `INV-${year}-${String(next_n).padStart(4, '0')}`;
}

/**
 * Create an invoice for a completed visit, pre-filled with a gardening-fee
 * line item when the site's job has one set (an admin-only figure — see
 * jobs.js parseFee).
 *
 * @param {number} visitId
 * @param {{userId?: number|null}} opts  the creating staff member, or null
 *   for a system/automatic create (e.g. on job completion) — mirrors
 *   logActivity's own userId:null convention for cron/system actions.
 * @returns {Promise<
 *   {status: 'created', invoiceId: number, number: string} |
 *   {status: 'exists', invoiceId: number} |
 *   {status: 'not_completed'} |
 *   {status: 'not_found'}
 * >}
 */
async function createInvoiceForVisit(visitId, { userId = null } = {}) {
  const visit = await q1(
    `SELECT v.*, j.gardening_fee FROM visits v LEFT JOIN jobs j ON j.id = v.job_id WHERE v.id = $1`,
    [visitId]);
  if (!visit) return { status: 'not_found' };
  // A job that hasn't happened yet has nothing to bill — block invoicing
  // until the visit is actually completed.
  if (visit.status !== 'completed') return { status: 'not_completed' };
  // Don't create a second live invoice for the same job (voided ones don't
  // count). This check-then-insert still has a race window, closed below by
  // the uq_invoices_visit_open unique index + a 23505 catch.
  const existing = await q1("SELECT id FROM invoices WHERE visit_id = $1 AND status <> 'void' LIMIT 1", [visitId]);
  if (existing) return { status: 'exists', invoiceId: existing.id };

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
        [visitId, number, userId, dueAt]);
      if (visit.gardening_fee != null) {
        await tx.q('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [id, 'Gardening fee', 1, visit.gardening_fee]);
      }
      return id;
    });
  } catch (e) {
    if (e.code === '23505') { // unique_violation: lost the race to a concurrent create
      const winner = await q1("SELECT id FROM invoices WHERE visit_id = $1 AND status <> 'void' LIMIT 1", [visitId]);
      if (winner) return { status: 'exists', invoiceId: winner.id };
    }
    throw e;
  }
  await logActivity(userId, 'invoice.create', 'invoice', invoiceId,
    `Created invoice ${number} for visit #${visitId}${userId ? '' : ' (auto, on job completion)'}`);
  return { status: 'created', invoiceId, number };
}

/** Full invoice header + line items + total, keyed by invoice id. */
async function invoiceWithItems(id) {
  // Header and line items are both keyed by the same id — fetch concurrently.
  const [invoice, items] = await Promise.all([
    q1(`
    SELECT inv.*, v.scheduled_date, v.duration_minutes, p.name AS property_name, p.address,
           p.contact_name, p.contact_email, p.billing_name, p.billing_address, p.billing_email,
           p.gst_applicable, u.name AS gardener_name
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

/**
 * Best-effort: create (if not already existing) and email the invoice for a
 * just-completed visit, using the site's gardening_fee and billing_email.
 * Called from the visit-complete flow in the background (see
 * src/background.js's runInBackground) — never blocks or fails the
 * gardener's "complete job" tap; any problem is logged to the activity log
 * rather than surfaced, mirroring archiveToOneDrive's own error handling.
 */
async function autoInvoiceAndEmail(visitId) {
  try {
    const { renderInvoicePdf } = require('./report'); // lazy: avoids a require cycle at module-load time
    const { sendMail } = require('./email');

    const result = await createInvoiceForVisit(visitId, { userId: null });
    if (result.status === 'not_found' || result.status === 'not_completed') return; // nothing to invoice
    const invoice = await invoiceWithItems(result.invoiceId);
    // Only a still-draft invoice needs sending — if it's already sent/paid/
    // void (e.g. staff acted on it manually before this background task ran),
    // leave it alone.
    if (!invoice || invoice.status !== 'draft') return;
    if (!invoice.billing_email) {
      await logActivity(null, 'invoice.email_skipped', 'invoice', invoice.id,
        `Invoice ${invoice.number} created but not emailed — no billing email set for ${invoice.property_name}`);
      return;
    }

    const business = await getSettings(INVOICE_SETTING_KEYS);
    const businessName = business.invoice_business_name || 'GardeningMgt';
    const billTo = invoice.billing_name || invoice.property_name;
    const dueText = invoice.due_at ? fmtDate(invoice.due_at) : 'on receipt';
    const pdf = await renderInvoicePdf(invoice, business);

    const send = await sendMail({
      to: invoice.billing_email,
      subject: `Invoice ${invoice.number} from ${businessName}`,
      text: `Hi ${billTo},\n\n` +
        `Please find attached invoice ${invoice.number} for the gardening service completed at ` +
        `${invoice.property_name} on ${invoice.scheduled_date}.\n\n` +
        `Total: $${invoice.total.toFixed(2)}\nDue: ${dueText}\n\n` +
        `Thank you,\n${businessName}`,
      attachments: [{ filename: `${invoice.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });

    if (send.ok) {
      await q("UPDATE invoices SET status = 'sent', issued_at = COALESCE(issued_at, now()) WHERE id = $1", [invoice.id]);
      await logActivity(null, 'invoice.email_sent', 'invoice', invoice.id,
        `Invoice ${invoice.number} emailed to ${invoice.billing_email}`);
    } else {
      await logActivity(null, 'invoice.email_skipped', 'invoice', invoice.id,
        `Invoice ${invoice.number} not emailed — ${send.reason || 'SMTP not configured'}`);
    }
  } catch (e) {
    // Detail goes to server logs only, matching archiveToOneDrive's own
    // convention — SMTP error bodies can echo credentials/recipient details.
    console.error(`[invoicing] auto-invoice/email for visit #${visitId} failed:`, e.message);
    await logActivity(null, 'invoice.email_failed', 'invoice', null,
      `Auto-invoice/email failed for visit #${visitId} (see server logs)`).catch(() => {});
  }
}

module.exports = { nextInvoiceNumber, createInvoiceForVisit, invoiceWithItems, autoInvoiceAndEmail };
