const { pool, q, q1 } = require('./db');
const { logActivity } = require('./activity');
const { today: businessToday } = require('./time');
const { sendSms, sendEmail } = require('./notify');

/**
 * Create in-app reminder notifications for every assigned, scheduled visit on
 * `date` (YYYY-MM-DD). Idempotent under concurrency: a single statement claims
 * unreminded visits (RETURNING) so a cron retry overlapping the supervisor's
 * "bulk reminders" click can't double-notify. Optionally also sends SMS/email
 * if a provider is configured (see notify.js). Returns count sent.
 *
 * @param {string} date
 * @param {{actorId?: number|null, force?: boolean}} opts force re-sends even if already reminded
 */
async function sendRemindersForDate(date, opts = {}) {
  const { actorId = null, force = false } = opts;
  const claimed = await q(
    `UPDATE visits v SET reminder_sent_at = now()
     FROM properties p
     WHERE v.property_id = p.id
       AND v.scheduled_date = $1 AND v.status = 'scheduled' AND v.gardener_id IS NOT NULL
       AND ($2 OR v.reminder_sent_at IS NULL)
     RETURNING v.id, v.gardener_id, v.time_window, p.name AS property_name, p.address`,
    [date, force]
  );
  if (!claimed.length) return 0;

  const insert = `INSERT INTO notifications (user_id, visit_id, type, message) VALUES ($1, $2, 'reminder', $3)`;
  for (const v of claimed) {
    const when = v.time_window ? ` (${v.time_window})` : '';
    const msg = `Reminder: visit ${v.property_name}, ${v.address} on ${date}${when}`;
    await pool.query(insert, [v.gardener_id, v.id, msg]);
    // Best-effort external delivery; no-ops unless a provider is configured.
    const u = await q1('SELECT phone, email FROM users WHERE id = $1', [v.gardener_id]);
    if (u) { await sendSms(u.phone, msg); await sendEmail(u.email, 'Visit reminder', msg); }
  }
  await logActivity(actorId, actorId ? 'reminder.bulk' : 'reminder.auto', 'visit', null,
    `Sent ${claimed.length} visit reminder(s) for ${date}`);
  return claimed.length;
}

/**
 * Safety net for recurring contracts: ensure every active, in-term job has a
 * future scheduled visit. Catches jobs whose only visit was skipped/cancelled
 * outside the normal advance path, or created before forward-scheduling.
 * Returns the number of visits created.
 */
async function backfillSchedules() {
  const { occurrence, nextOccurrenceAfter } = require('./recurrence');
  const today = businessToday();
  const jobs = await q(`
    SELECT j.* FROM jobs j
    WHERE j.active AND j.end_date >= $1
      AND NOT EXISTS (
        SELECT 1 FROM visits v
        WHERE v.job_id = j.id AND v.status = 'scheduled' AND v.scheduled_date >= $1)`,
    [today]);
  let created = 0;
  for (const job of jobs) {
    // Next occurrence on/after today, anchored to the contract start.
    let next = job.start_date >= today ? job.start_date : nextOccurrenceAfter(job.start_date, job.frequency, today);
    if (next < today) next = occurrence(job.start_date, job.frequency, 0);
    if (next > job.end_date) continue;
    const ins = await q1(`
      INSERT INTO visits (job_id, property_id, gardener_id, scheduled_date, time_window, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (job_id, scheduled_date) WHERE status = 'scheduled' AND job_id IS NOT NULL
      DO NOTHING RETURNING id`,
      [job.id, job.property_id, job.gardener_id, next, job.time_window, job.created_by]);
    if (ins) created++;
  }
  if (created) await logActivity(null, 'job.backfill', 'job', null, `Backfilled ${created} scheduled visit(s)`);
  return created;
}

/**
 * Daily at 06:00 in the business timezone (BUSINESS_TZ, default
 * Australia/Melbourne) — used by `npm start` on a normal server.
 * On Vercel, the schedule in vercel.json calls /cron/reminders instead.
 */
function startReminderScheduler() {
  const cron = require('node-cron');
  const { TZ } = require('./time');
  return cron.schedule('0 6 * * *', async () => {
    const today = businessToday();
    const sent = await sendRemindersForDate(today);
    await backfillSchedules();
    if (sent) console.log(`[reminders] auto-sent ${sent} reminder(s) for ${today}`);
  }, { timezone: TZ });
}

module.exports = { sendRemindersForDate, backfillSchedules, startReminderScheduler };
