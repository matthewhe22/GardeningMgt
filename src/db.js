const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'gardening.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','supervisor','gardener')),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  address      TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  lat          REAL,
  lng          REAL,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id    INTEGER NOT NULL REFERENCES properties(id),
  gardener_id    INTEGER REFERENCES users(id),
  scheduled_date TEXT NOT NULL,            -- YYYY-MM-DD
  time_window    TEXT,                     -- e.g. "08:00-10:00"
  status         TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled','in_progress','completed','skipped','cancelled')),
  route_order    INTEGER,                  -- position in the optimized route for that day
  reminder_sent_at TEXT,
  started_at     TEXT,                     -- job timer: set when gardener starts the job
  finished_at    TEXT,                     -- job timer: set when gardener finishes
  duration_minutes INTEGER,                -- derived from timer, editable by supervisor
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (gardener_id, scheduled_date);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  assignee_id INTEGER REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT,
  due_date    TEXT,                        -- YYYY-MM-DD, for tasks not tied to a visit
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','in_progress','done','blocked')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id, due_date);

CREATE TABLE IF NOT EXISTS issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT,
  property_id INTEGER REFERENCES properties(id),
  visit_id    INTEGER REFERENCES visits(id),
  priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  reported_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  original_name TEXT,
  caption     TEXT,
  visit_id    INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  issue_id    INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  uploaded_by INTEGER REFERENCES users(id),
  shared      INTEGER NOT NULL DEFAULT 1,  -- visible to the whole team
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gps_points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'ping' CHECK (kind IN ('start','ping','finish')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gps_visit ON gps_points (visit_id, recorded_at);

CREATE TABLE IF NOT EXISTS visit_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    INTEGER NOT NULL REFERENCES visits(id),
  number      TEXT NOT NULL UNIQUE,        -- e.g. INV-2026-0001
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  issued_at   TEXT,
  paid_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 1,
  unit_price  REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,               -- e.g. visit.create, issue.update
  entity_type TEXT,
  entity_id   INTEGER,
  details     TEXT,                        -- human-readable summary / JSON diff
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  visit_id   INTEGER REFERENCES visits(id),
  type       TEXT NOT NULL DEFAULT 'reminder',
  message    TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at);
`);

module.exports = db;
