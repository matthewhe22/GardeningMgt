const { withTransaction, q, q1, pool } = require('./db');
const { logActivity } = require('./activity');
const { today: businessToday } = require('./time');
const { sendSms, sendEmail } = require('./notify');

/**
 * Core implementation of sendRemindersForDate with every I/O dependency
 * passed in explicitly, so the concurrent-send behavior and the query shapes
 * built here can be unit tested with fakes — no live DB or SMS/email
 * provider needed (see test/reminders.test.js). sendRemindersForDate() below
 * is a thin wrapper binding the real db/notify/activity modules.
 *
 * Claim, notification insert, and the final reminder_sent_at update all run
 * inside one DB transaction (see withTransaction in db.js) that only commits
 * after the notification insert and the external SMS/email sends have been
 * attempted. reminder_sent_at is intentionally NOT set by the claim query —
 * it's the last thing written, right before commit. That means:
 *   - Concurrency (cron racing a supervisor's manual "bulk send" click) is
 *     still safe: the claim uses SELECT ... FOR UPDATE SKIP LOCKED, so a
 *     concurrent transaction skips any row this one is already holding a lock
 *     on instead of double-claiming it or blocking.
 *   - If the process crashes/times out anywhere between the claim and the
 *     commit, the transaction is never committed, so reminder_sent_at stays
 *     NULL and the next run's claim picks those visits up again — instead of
 *     the old behavior (mark reminder_sent_at as part of the claim, before
 *     delivery) which could mark a visit "sent" and then crash before
 *     anything was actually delivered, silently losing it forever (the claim
 *     query filters on reminder_sent_at IS NULL, so a lost visit was never
 *     retried). The tradeoff: if the crash happens *after* an external
 *     send actually went out but *before* commit, a retry can re-send that
 *     same SMS/email/in-app notification — a duplicate is far better than a
 *     silent loss.
 *
 * @param {{withTransaction: Function, sendSms: Function, sendEmail: Function, logActivity: Function}} deps
 * @param {string} date
 * @param {{actorId?: number|null, force?: boolean}} opts force re-sends even if already reminded
 */
async function sendRemindersForDateWith(deps, date, opts = {}) {
  const { withTransaction: withTx, sendSms, sendEmail, logActivity: log } = deps;
  const { actorId = null, force = false } = opts;

  return withTx(async (tx) => {
    // Join the gardener's contact details into the claim so there's no
    // per-visit user lookup (was an N+1) when sending SMS/email. FOR UPDATE
    // OF v ... SKIP LOCKED claims exclusively without setting
    // reminder_sent_at yet (see the function doc comment above for why).
    const claimed = await tx.q(
      `SELECT v.id, v.gardener_id, v.time_window, p.name AS property_name, p.address,
         u.phone AS gardener_phone, u.email AS gardener_email
       FROM visits v
       JOIN properties p ON p.id = v.property_id
       JOIN users u ON u.id = v.gardener_id
       WHERE v.scheduled_date = $1 AND v.status = 'scheduled' AND v.gardener_id IS NOT NULL
         AND ($2 OR v.reminder_sent_at IS NULL)
       FOR UPDATE OF v SKIP LOCKED`,
      [date, force]
    );
    if (!claimed.length) return 0;

    const msgFor = (v) =>
      `Reminder: visit ${v.property_name}, ${v.address} on ${date}${v.time_window ? ` (${v.time_window})` : ''}`;

    // One multi-row insert for all in-app notifications instead of N inserts.
    const values = claimed.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, 'reminder', $${i * 3 + 3})`).join(', ');
    const params = claimed.flatMap((v) => [v.gardener_id, v.id, msgFor(v)]);
    await tx.q(`INSERT INTO notifications (user_id, visit_id, type, message) VALUES ${values}`, params);

    // Best-effort external delivery; no-ops unless a provider is configured.
    // Every send is independent (and each already swallows its own errors), so
    // fire them all concurrently instead of one gardener at a time — a busy
    // day's worth of visits was otherwise slow enough to risk a serverless
    // request timeout partway through.
    await Promise.all(claimed.flatMap((v) => {
      const msg = msgFor(v);
      return [sendSms(v.gardener_phone, msg), sendEmail(v.gardener_email, 'Visit reminder', msg)];
    }));

    // Only now — after the notification insert and the external sends have
    // both been attempted — mark these visits as reminded.
    const ids = claimed.map((v) => v.id);
    await tx.q('UPDATE visits SET reminder_sent_at = now() WHERE id = ANY($1)', [ids]);

    await log(actorId, actorId ? 'reminder.bulk' : 'reminder.auto', 'visit', null,
      `Sent ${claimed.length} visit reminder(s) for ${date}`);
    return claimed.length;
  });
}

/**
 * Create in-app reminder notifications for every assigned, scheduled visit on
 * `date` (YYYY-MM-DD). Safe under concurrency: the claim runs inside a
 * transaction with SELECT ... FOR UPDATE SKIP LOCKED, so a cron retry
 * overlapping the supervisor's "bulk reminders" click can't double-claim the
 * same visits (see sendRemindersForDateWith's doc comment for the full
 * crash-recovery story). Optionally also sends SMS/email if a provider is
 * configured (see notify.js). Returns count sent.
 *
 * @param {string} date
 * @param {{actorId?: number|null, force?: boolean}} opts force re-sends even if already reminded
 */
async function sendRemindersForDate(date, opts = {}) {
  return sendRemindersForDateWith({ withTransaction, sendSms, sendEmail, logActivity }, date, opts);
}

/**
 * Safety net for recurring contracts: ensure every active, in-term job has a
 * future scheduled visit. Catches jobs whose only visit was skipped/cancelled
 * outside the normal advance path, or created before forward-scheduling.
 * Returns the number of visits created.
 */
async function backfillSchedules() {
  const { nextOccurrenceOnOrAfter } = require('./recurrence');
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
    const next = nextOccurrenceOnOrAfter(job.start_date, job.frequency, today);
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
 * Retention housekeeping for the two tables that otherwise grow unbounded:
 *   - activity_log: kept 1 year — plenty for audit/reporting, and this table
 *     backs the admin activity page that would otherwise get slower every day.
 *   - notifications: read ones are purged after 90 days (the common case —
 *     the user has already seen and dismissed them); as a safety net, ANY
 *     notification (read or not) older than 1 year is also purged, so a
 *     never-marked-read pile can't grow forever either. This bounds the
 *     per-request unread-count COUNT(*) in server.js's session middleware.
 * Uses pool.query directly (not the q() helper) to read rowCount without
 * pulling every deleted row's data back over the wire.
 * Only logs when something was actually deleted, so this doesn't spam the
 * activity log with a "deleted 0 rows" entry every single day.
 */
async function pruneOldRecords() {
  const activityRes = await pool.query(
    `DELETE FROM activity_log WHERE created_at < now() - interval '1 year'`);
  const notifRes = await pool.query(`
    DELETE FROM notifications
    WHERE (read_at IS NOT NULL AND read_at < now() - interval '90 days')
       OR created_at < now() - interval '1 year'`);
  const activityDeleted = activityRes.rowCount || 0;
  const notifDeleted = notifRes.rowCount || 0;
  if (activityDeleted || notifDeleted) {
    await logActivity(null, 'system.prune', null, null,
      `Pruned ${activityDeleted} old activity_log row(s) and ${notifDeleted} old notification(s)`);
  }
  return { activityDeleted, notifDeleted };
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
    await pruneOldRecords();
    if (sent) console.log(`[reminders] auto-sent ${sent} reminder(s) for ${today}`);
  }, { timezone: TZ });
}

module.exports = {
  sendRemindersForDate, sendRemindersForDateWith, backfillSchedules, pruneOldRecords, startReminderScheduler,
};
