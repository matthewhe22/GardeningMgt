const { pool, q } = require('./db');
const { logActivity } = require('./activity');

/**
 * Create in-app reminder notifications for every assigned, scheduled visit on
 * `date` (YYYY-MM-DD) that has not been reminded yet. Returns count sent.
 * Used by the daily cron (local node-cron or Vercel Cron hitting
 * /cron/reminders) and the supervisor "bulk reminders" button.
 *
 * @param {string} date
 * @param {{actorId?: number|null, force?: boolean}} opts force re-sends even if already reminded
 */
async function sendRemindersForDate(date, opts = {}) {
  const { actorId = null, force = false } = opts;
  const visits = await q(
    `SELECT v.id, v.gardener_id, v.time_window, p.name AS property_name, p.address
     FROM visits v JOIN properties p ON p.id = v.property_id
     WHERE v.scheduled_date = $1 AND v.status = 'scheduled' AND v.gardener_id IS NOT NULL
       AND ($2 OR v.reminder_sent_at IS NULL)`,
    [date, force]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of visits) {
      const when = v.time_window ? ` (${v.time_window})` : '';
      await client.query(
        `INSERT INTO notifications (user_id, visit_id, type, message) VALUES ($1, $2, 'reminder', $3)`,
        [v.gardener_id, v.id, `Reminder: visit ${v.property_name}, ${v.address} on ${date}${when}`]
      );
      await client.query('UPDATE visits SET reminder_sent_at = now() WHERE id = $1', [v.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (visits.length > 0) {
    await logActivity(actorId, actorId ? 'reminder.bulk' : 'reminder.auto', 'visit', null,
      `Sent ${visits.length} visit reminder(s) for ${date}`);
  }
  return visits.length;
}

/**
 * Daily at 06:00 server time — used by `npm start` on a normal server.
 * On Vercel, the schedule in vercel.json calls /cron/reminders instead.
 */
function startReminderScheduler() {
  const cron = require('node-cron');
  return cron.schedule('0 6 * * *', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const sent = await sendRemindersForDate(today);
    if (sent) console.log(`[reminders] auto-sent ${sent} reminder(s) for ${today}`);
  });
}

module.exports = { sendRemindersForDate, startReminderScheduler };
