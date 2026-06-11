const { Pool, types } = require('pg');

// Render DATE / TIMESTAMP columns as plain strings so views can print them
// directly, and parse bigint/numeric aggregates as JS numbers.
types.setTypeParser(1082, (v) => v);                       // date -> 'YYYY-MM-DD'
types.setTypeParser(1114, (v) => v.replace('T', ' ').slice(0, 19)); // timestamp
types.setTypeParser(1184, (v) => v.replace('T', ' ').slice(0, 19)); // timestamptz
types.setTypeParser(20, (v) => parseInt(v, 10));           // int8 (COUNT)
types.setTypeParser(1700, (v) => parseFloat(v));           // numeric (SUM)

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://postgres@localhost:5433/gardeningmgt',
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || 'localhost')
    ? false
    : { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10, // keep connections low per serverless instance
});

/** All rows. */
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
/** First row or null. */
const q1 = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','supervisor','gardener')),
  phone         TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS properties (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT NOT NULL,
  contact_name  TEXT,
  contact_phone TEXT,
  lat           REAL,
  lng           REAL,
  notes         TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id               SERIAL PRIMARY KEY,
  property_id      INTEGER NOT NULL REFERENCES properties(id),
  gardener_id      INTEGER REFERENCES users(id),
  scheduled_date   DATE NOT NULL,
  time_window      TEXT,
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','in_progress','completed','skipped','cancelled')),
  route_order      INTEGER,
  reminder_sent_at TIMESTAMP,
  started_at       TIMESTAMP,
  finished_at      TIMESTAMP,
  duration_minutes INTEGER,
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (gardener_id, scheduled_date);

CREATE TABLE IF NOT EXISTS tasks (
  id           SERIAL PRIMARY KEY,
  visit_id     INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  assignee_id  INTEGER REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT,
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','in_progress','done','blocked')),
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id, due_date);

CREATE TABLE IF NOT EXISTS issues (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  property_id INTEGER REFERENCES properties(id),
  visit_id    INTEGER REFERENCES visits(id),
  priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  reported_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id         SERIAL PRIMARY KEY,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Image bytes live in the database so the app works on serverless hosts
-- (Vercel's filesystem is read-only and not shared between invocations).
CREATE TABLE IF NOT EXISTS photos (
  id            SERIAL PRIMARY KEY,
  filename      TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime          TEXT NOT NULL DEFAULT 'image/jpeg',
  data          BYTEA NOT NULL,
  caption       TEXT,
  visit_id      INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  issue_id      INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  uploaded_by   INTEGER REFERENCES users(id),
  shared        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gps_points (
  id          SERIAL PRIMARY KEY,
  visit_id    INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'ping' CHECK (kind IN ('start','ping','finish')),
  recorded_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gps_visit ON gps_points (visit_id, recorded_at);

CREATE TABLE IF NOT EXISTS visit_comments (
  id         SERIAL PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id         SERIAL PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  number     TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  issued_at  TIMESTAMP,
  paid_at    TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          SERIAL PRIMARY KEY,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 1,
  unit_price  REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  details     TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  visit_id   INTEGER REFERENCES visits(id),
  type       TEXT NOT NULL DEFAULT 'reminder',
  message    TEXT NOT NULL,
  read_at    TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at);
`;

let readyPromise = null;

/**
 * Create the schema (idempotent) and, on an empty database, a bootstrap
 * admin account so the first deploy is immediately usable.
 * Called once per process before handling requests.
 */
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(SCHEMA);
      const { c } = (await pool.query('SELECT COUNT(*)::int AS c FROM users')).rows[0];
      if (c === 0) {
        const bcrypt = require('bcryptjs');
        const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
        const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin1234';
        await pool.query(
          `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
          ['Admin', email.toLowerCase(), bcrypt.hashSync(password, 10)]
        );
        console.log(`[bootstrap] created admin account ${email} — change its password!`);
      }
    })();
  }
  return readyPromise;
}

module.exports = { pool, q, q1, ready };
