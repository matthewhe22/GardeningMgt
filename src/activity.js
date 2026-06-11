const { pool } = require('./db');

/**
 * Record an auditable change. Call from every mutating route.
 * @param {number|null} userId  actor (null for system jobs e.g. cron reminders)
 * @param {string} action       dotted verb, e.g. "visit.create"
 * @param {string} entityType   "visit" | "task" | "issue" | ...
 * @param {number|null} entityId
 * @param {string} details      human-readable summary of the change
 */
async function logActivity(userId, action, entityType, entityId, details) {
  await pool.query(
    `INSERT INTO activity_log (user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, action, entityType, entityId, details || null]
  );
}

module.exports = { logActivity };
