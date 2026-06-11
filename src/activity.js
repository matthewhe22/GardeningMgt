const db = require('./db');

const insert = db.prepare(`
  INSERT INTO activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (?, ?, ?, ?, ?)`);

/**
 * Record an auditable change. Call from every mutating route.
 * @param {number|null} userId  actor (null for system jobs e.g. cron reminders)
 * @param {string} action       dotted verb, e.g. "visit.create"
 * @param {string} entityType   "visit" | "task" | "issue" | ...
 * @param {number|null} entityId
 * @param {string} details      human-readable summary of the change
 */
function logActivity(userId, action, entityType, entityId, details) {
  insert.run(userId, action, entityType, entityId, details || null);
}

module.exports = { logActivity };
