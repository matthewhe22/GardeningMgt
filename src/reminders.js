const cron = require('node-cron');
const db = require('./db');
const { logActivity } = require('./activity');

/**
 * Create in-app reminder notifications for every assigned, scheduled visit on
 * `date` (YYYY-MM-DD) that has not been reminded yet. Returns count sent.
 * Used both by the daily cron job and the supervisor "bulk reminders" button.
 *
 * @param {string} date
 * @param {{actorId?: number|null, force?: boolean}} opts force re-sends even if already reminded
 */
function sendRemindersForDate(date, opts = {}) {
  const { actorId = null, force = false } = opts;
  const visits = db.prepare(`
    SELECT v.id, v.gardener_id, v.time_window, p.name AS property_name, p.address
    FROM visits v JOIN properties p ON p.id = v.property_id
    WHERE v.scheduled_date = ? AND v.status = 'scheduled' AND v.gardener_id IS NOT NULL
      AND (? OR v.reminder_sent_at IS NULL)
  `).all(date, force ? 1 : 0);

  const insertNotification = db.prepare(`
    INSERT INTO notifications (user_id, visit_id, type, message) VALUES (?, ?, 'reminder', ?)`);
  const markSent = db.prepare(`UPDATE visits SET reminder_sent_at = datetime('now') WHERE id = ?`);

  const sendAll = db.transaction((rows) => {
    for (const v of rows) {
      const when = v.time_window ? ` (${v.time_window})` : '';
      insertNotification.run(
        v.gardener_id, v.id,
        `Reminder: visit ${v.property_name}, ${v.address} on ${date}${when}`
      );
      markSent.run(v.id);
    }
  });
  sendAll(visits);

  if (visits.length > 0) {
    logActivity(actorId, actorId ? 'reminder.bulk' : 'reminder.auto', 'visit', null,
      `Sent ${visits.length} visit reminder(s) for ${date}`);
  }
  return visits.length;
}

/** Daily at 06:00 server time: remind every gardener of today's visits. */
function startReminderScheduler() {
  return cron.schedule('0 6 * * *', () => {
    const today = new Date().toISOString().slice(0, 10);
    const sent = sendRemindersForDate(today);
    if (sent) console.log(`[reminders] auto-sent ${sent} reminder(s) for ${today}`);
  });
}

module.exports = { sendRemindersForDate, startReminderScheduler };
