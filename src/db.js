const { Pool, types } = require('pg');

// Render DATE / TIMESTAMP columns as plain strings so views can print them
// directly, and parse bigint/numeric aggregates as JS numbers.
types.setTypeParser(1082, (v) => v);                       // date -> 'YYYY-MM-DD'
types.setTypeParser(1114, (v) => v.replace('T', ' ').slice(0, 19)); // timestamp
types.setTypeParser(1184, (v) => v.replace('T', ' ').slice(0, 19)); // timestamptz
types.setTypeParser(20, (v) => parseInt(v, 10));           // int8 (COUNT)
types.setTypeParser(1700, (v) => parseFloat(v));           // numeric (SUM)

// Fail closed: a production-like boot with no DATABASE_URL used to fall
// through silently to a hardcoded local fallback (nonstandard port 5433), so
// the app would boot fine and only 500 on the first real query. Mirrors the
// SESSION_SECRET fail-closed check in server.js — require the env var
// explicitly instead of inferring "is this production" after the fact.
if (!process.env.DATABASE_URL && (process.env.VERCEL || process.env.NODE_ENV === 'production')) {
  throw new Error(
    'DATABASE_URL must be set — refusing to start without a database connection in production. ' +
    'Set DATABASE_URL to your Postgres connection string.'
  );
}
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5433/gardeningmgt';
const isLocal = /localhost|127\.0\.0\.1/.test(DB_URL);
// A connection pooler (Supabase's pgBouncer on :6543, Neon's "-pooler" host,
// a self-hosted pgBouncer on its default :6432, or ?pgbouncer=true) can
// absorb more connections safely, so we open a few more per instance to get
// more out of the parallel (Promise.all) page queries. On a direct connection
// we stay conservative to avoid exhausting Postgres across serverless
// instances. DB_POOL_MAX overrides explicitly.
const usingPooler = /pgbouncer=true|:6543\b|:6432\b|pooler\./i.test(DB_URL);
// On Vercel, every serverless instance opens its own independent pool — a
// direct (non-pooler) DATABASE_URL means N concurrent instances can each hold
// up to `max` connections with no coordination between them, so a real
// traffic spike can exhaust Postgres' connection slots and 500 the whole app
// at once (see docs/REVIEW.md, P2-25). Exposed so /health and the admin
// Settings page can surface this beyond just a cold-start log line.
const dbPoolerRisk = !!(process.env.VERCEL && !usingPooler && !isLocal);
// Opt-in hard guardrail once you've confirmed DATABASE_URL is a pooled
// connection string: refuses to boot instead of just warning. Off by default
// so flipping in this stricter check can never surprise-break an existing
// deploy that hasn't switched yet.
if (dbPoolerRisk && process.env.REQUIRE_DB_POOLER === '1') {
  throw new Error(
    'REQUIRE_DB_POOLER=1 is set, but DATABASE_URL does not look like a pooled connection string ' +
    '(no :6543/:6432/"pooler."/?pgbouncer=true) — refusing to start on Vercel with a direct connection. ' +
    'Point DATABASE_URL at your provider\'s pooler (e.g. Supabase port 6543, or Neon\'s "-pooler" host).'
  );
}
const pool = new Pool({
  connectionString: DB_URL,
  // Hosted Postgres (e.g. the Supabase pooler) presents a certificate signed
  // by the provider's own CA, which Node does not trust by default, so full
  // verification fails with SELF_SIGNED_CERT_IN_CHAIN. Verify only when the
  // CA is supplied via DB_SSL_CA (PEM contents); otherwise still encrypt but
  // skip chain verification.
  ssl: isLocal
    ? false
    : process.env.DB_SSL_CA
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA }
      : { rejectUnauthorized: false },
  max: process.env.DB_POOL_MAX
    ? Number(process.env.DB_POOL_MAX)
    : (process.env.VERCEL ? (usingPooler ? 8 : 2) : 10),
});

// Every timestamp column in SCHEMA is a naive TIMESTAMP (no zone), and
// src/time.js's toDate() interprets those naive strings as UTC when
// formatting them for display. That's only correct if the Postgres session
// itself is running in UTC — which depends on the server/database's
// configured default TimeZone, not anything this app controls otherwise. Pin
// every pooled connection to UTC explicitly so display is correct regardless
// of how the server/database is configured.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'UTC'").catch((e) =>
    console.error('[db] failed to set session time zone to UTC:', e.message));
});

// A hosted DB with no DB_SSL_CA connects with rejectUnauthorized: false —
// i.e. encrypted but with no certificate-chain verification, so a
// man-in-the-middle with a self-signed cert would go undetected. That's a
// deliberate, documented tradeoff (see the ssl: block above) for providers
// whose CA Node doesn't trust out of the box, but it should be loud, not
// silent, so it shows up in the logs rather than being discovered later.
if (!isLocal && !process.env.DB_SSL_CA) {
  console.warn('[db] WARNING: connecting to a non-local DATABASE_URL with no DB_SSL_CA set — ' +
    'TLS is encrypted but the server certificate chain is NOT verified (rejectUnauthorized: false). ' +
    'Set DB_SSL_CA to the provider\'s CA certificate (PEM) to verify the connection.');
}

if (dbPoolerRisk) {
  console.warn('[db] WARNING: running on Vercel with a direct (non-pooler) DATABASE_URL. ' +
    'Under real concurrency this can exhaust Postgres\' connection slots and 500 the whole app at ' +
    'once. Point DATABASE_URL at your provider\'s pooler (e.g. Supabase port 6543, or Neon\'s ' +
    '"-pooler" host) — this also shows on GET /health and the admin Settings page until fixed. ' +
    'Once switched, set REQUIRE_DB_POOLER=1 to make this a hard boot-time failure instead of a warning.');
}

/** All rows. */
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
/** First row or null. */
const q1 = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;

/**
 * Run fn(client) inside a transaction, with guaranteed COMMIT/ROLLBACK and
 * client release. fn receives a query helper bound to the transaction.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      q: async (sql, params = []) => (await client.query(sql, params)).rows,
      q1: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
      client,
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

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
  contact_email TEXT,
  lat           REAL,
  lng           REAL,
  lots          INTEGER,
  notes         TEXT,
  -- Invoice "bill to" details for this site, which can differ from the site
  -- itself (e.g. a property manager or head office receives the invoice, not
  -- the site's own on-the-ground contact_name/contact_email above). Any unset
  -- field falls back to the site's own name/address/contact_email.
  billing_name    TEXT,
  billing_address TEXT,
  billing_email   TEXT,
  gst_applicable  BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- A recurring contract: one job per site, serviced on a schedule by a
-- default gardener. Individual dated occurrences live in "visits".
CREATE TABLE IF NOT EXISTS jobs (
  id                SERIAL PRIMARY KEY,
  property_id       INTEGER NOT NULL REFERENCES properties(id),
  gardener_id       INTEGER REFERENCES users(id),     -- default gardener for every occurrence
  frequency         TEXT NOT NULL DEFAULT 'weekly'
                    CHECK (frequency IN ('weekly','fortnightly','monthly')),
  contract_years    INTEGER NOT NULL DEFAULT 1 CHECK (contract_years IN (1,2)),
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,                    -- start_date + contract term
  time_window       TEXT,
  gardening_fee     NUMERIC(10,2),                    -- admin-only flat fee; seeds the invoice line item
  last_completed_at TIMESTAMP,                        -- set every time an occurrence completes
  active            BOOLEAN NOT NULL DEFAULT true,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id               SERIAL PRIMARY KEY,
  job_id           INTEGER REFERENCES jobs(id),
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
-- Staff dashboard filters by date alone; idx_visits_day leads with gardener_id
-- so it can't serve that query.
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits (scheduled_date);

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

CREATE TABLE IF NOT EXISTS visit_comments (
  id         SERIAL PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
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
  thumb_data    BYTEA,
  caption       TEXT,
  visit_id      INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  issue_id      INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  visit_comment_id INTEGER REFERENCES visit_comments(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS invoices (
  id         SERIAL PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  number     TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  issued_at  TIMESTAMP,
  paid_at    TIMESTAMP,
  due_at     DATE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          SERIAL PRIMARY KEY,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity    NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL DEFAULT 0
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

-- App-wide configuration editable by admins (e.g. OneDrive credentials).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

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

-- Foreign-key indexes for hot detail-page joins.
CREATE INDEX IF NOT EXISTS idx_visits_job ON visits (job_id);
CREATE INDEX IF NOT EXISTS idx_visits_property ON visits (property_id);
CREATE INDEX IF NOT EXISTS idx_tasks_visit ON tasks (visit_id);
CREATE INDEX IF NOT EXISTS idx_photos_visit ON photos (visit_id);
CREATE INDEX IF NOT EXISTS idx_photos_issue ON photos (issue_id);
CREATE INDEX IF NOT EXISTS idx_visit_comments_visit ON visit_comments (visit_id);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments (issue_id);
CREATE INDEX IF NOT EXISTS idx_invoices_visit ON invoices (visit_id);
CREATE INDEX IF NOT EXISTS idx_jobs_property ON jobs (property_id);

-- Indexes for hot list/report query shapes (issues board, photo gallery,
-- date-range reports that aren't scoped to a single gardener).
CREATE INDEX IF NOT EXISTS idx_issues_status_priority ON issues (status, priority);
CREATE INDEX IF NOT EXISTS idx_photos_created ON photos (created_at);
CREATE INDEX IF NOT EXISTS idx_visits_scheduled ON visits (scheduled_date);

-- Prevent duplicate future occurrences of the same job on the same day
-- (closes the check-then-insert race in rollRecurringJob).
CREATE UNIQUE INDEX IF NOT EXISTS uq_visits_job_day_scheduled
  ON visits (job_id, scheduled_date) WHERE status = 'scheduled' AND job_id IS NOT NULL;

-- Kept for backward compatibility with already-issued invoice numbers (some
-- earlier deploys used nextval('invoice_seq') directly for every year, so it
-- never actually reset per year despite the name/comment above). New numbers
-- come from invoice_number_counters instead — see below.
CREATE SEQUENCE IF NOT EXISTS invoice_seq;

-- True per-year gapless invoice numbers: one counter row per year, atomically
-- incremented with INSERT ... ON CONFLICT ... RETURNING (see
-- nextInvoiceNumber() in routes/invoices.js), so INV-<year>-0001 actually
-- restarts each year instead of continuing the previous year's count.
CREATE TABLE IF NOT EXISTS invoice_number_counters (
  year   INTEGER PRIMARY KEY,
  next_n INTEGER NOT NULL DEFAULT 1
);
`;

let readyPromise = null;
let criticalSchemaPromise = null;

/**
 * A handful of small, idempotent DDL statements that critical app behavior
 * depends on directly (the login throttle table; the invoice/job race-
 * condition indexes) — kept out of SCHEMA/ready() so they run unconditionally,
 * even under DB_SKIP_INIT=1 (which every already-provisioned deployment is
 * expected to set, per the comment on ready() below). Skipping these on such
 * a deployment would otherwise break login outright the moment this code
 * ships, since auth.js queries login_attempts unconditionally.
 * Idempotent and cheap (a handful of IF NOT EXISTS checks), so paying this
 * on every cold start — including ones that already skip the full schema
 * pass — costs nothing meaningful.
 */
function ensureCriticalSchema() {
  if (!criticalSchemaPromise) {
    criticalSchemaPromise = (async () => {
      // Login brute-force throttle, keyed by "ip|email". Backed by the DB
      // (rather than an in-process Map) so the limit actually holds across
      // the many concurrent serverless instances a single deploy can scale
      // out to. A fresh table can never conflict with existing data, so a
      // failure here is a real problem — let it propagate.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          key      TEXT PRIMARY KEY,
          count    INTEGER NOT NULL DEFAULT 1,
          first_at TIMESTAMP NOT NULL DEFAULT now()
        )`);
      // One invoice per visit, and one active job per property: closes the
      // check-then-insert races in POST /invoices and POST /jobs. Unlike the
      // table above, a database that already has duplicate live invoices or
      // active jobs (possible — that's exactly the race these indexes close)
      // would fail to create these; don't let that take down every request,
      // just log it so an operator can dedupe. Until the index exists, those
      // routes' 23505 catch simply has nothing to catch, same as before this
      // fix shipped.
      for (const [name, sql] of [
        ['uq_invoices_visit_open',
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_visit_open ON invoices (visit_id) WHERE status <> 'void'`],
        ['uq_jobs_property_active',
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_property_active ON jobs (property_id) WHERE active`],
      ]) {
        try { await pool.query(sql); }
        catch (e) {
          console.error(`[db] could not create ${name} (likely duplicate rows already violate it) — dedupe manually:`, e.message);
        }
      }
    })();
    criticalSchemaPromise.catch(() => { criticalSchemaPromise = null; });
  }
  return criticalSchemaPromise;
}

// Bump when SCHEMA or the migrations below change, so existing databases
// re-run the DDL exactly once instead of on every serverless cold start.
const SCHEMA_VERSION = '11';

/**
 * Numeric, forward-only comparison of a stored schema_version against this
 * build's SCHEMA_VERSION. Deliberately not strict equality: a DB already at
 * or ahead of this build's version needs no migration work — that covers a
 * plain re-deploy of the same version, and an older app instance briefly
 * running against a DB a newer deploy already migrated (rolling deploy
 * overlap), without either case re-running the full DDL every cold start.
 */
function schemaUpToDate(storedValue) {
  return storedValue != null && Number(storedValue) >= Number(SCHEMA_VERSION);
}

/**
 * The expensive path: full schema DDL, column migrations, bootstrap admin,
 * and recording SCHEMA_VERSION. Shared by both ready() (normal boot) and the
 * DB_SKIP_INIT=1 boot path so a version bump self-heals either way instead of
 * only being applied on deployments that happen to run without the flag.
 */
async function runMigrations() {
  await pool.query(SCHEMA);
  await ensureCriticalSchema();
  // Migrations for databases created before these columns existed.
  await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS lots INTEGER');
  await pool.query('ALTER TABLE visits ADD COLUMN IF NOT EXISTS job_id INTEGER REFERENCES jobs(id)');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS visit_comment_id INTEGER REFERENCES visit_comments(id) ON DELETE SET NULL');
  // Renewal tracking: flag when a contract has been renewed/closed.
  await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS renewal_acknowledged BOOLEAN NOT NULL DEFAULT false");
  // Admin-only flat fee that seeds an invoice's line item.
  await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS gardening_fee NUMERIC(10,2)");
  // invoice_items money columns were REAL (binary float), which accumulates
  // cent-level drift in SUM(quantity * unit_price) aggregates. NUMERIC(10,2)
  // is exact; Postgres converts existing data automatically. Safe to run
  // every time this migration block runs — a same-type ALTER COLUMN TYPE is
  // a no-op, so no IF NOT EXISTS guard is needed.
  await pool.query('ALTER TABLE invoice_items ALTER COLUMN quantity TYPE NUMERIC(10,2), ALTER COLUMN unit_price TYPE NUMERIC(10,2)');
  // Invoice due date, so the invoice PDF/print view can show it.
  await pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_at DATE');
  // Client billing contact, alongside the existing contact_name/contact_phone.
  await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS contact_email TEXT');
  // Small JPEG thumbnail generated at upload time (src/upload.js), so gallery
  // pages stop serving up-to-10MB originals as list-view images. NULL on
  // existing rows and on any photo whose format sharp couldn't thumbnail —
  // the serve route (src/server.js) falls back to the original in both cases.
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_data BYTEA');
  // Per-site invoice "bill to" details, so a site whose billing contact
  // differs from its on-the-ground contact still invoices the right party.
  await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS billing_name TEXT');
  await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS billing_address TEXT');
  await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS billing_email TEXT');
  await pool.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS gst_applicable BOOLEAN NOT NULL DEFAULT true");
  // Cached PropertyIQ building match for this site, keyed by address (see
  // src/propertyiq.js). NULL until the first "send report to owners" lookup
  // succeeds, so repeat sends skip the address-matching pass over PIQ's
  // building list.
  await pool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS piq_building_id TEXT');
  const { c } = (await pool.query('SELECT COUNT(*)::int AS c FROM users')).rows[0];
  if (c === 0) {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
    // In production, never use a known default: take the env password or
    // generate a random one and print it once to the server logs.
    const inProd = process.env.VERCEL || process.env.NODE_ENV === 'production';
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
      || (inProd ? crypto.randomBytes(9).toString('base64url') : 'admin1234');
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      ['Admin', email.toLowerCase(), bcrypt.hashSync(password, 10)]
    );
    console.log(`[bootstrap] created admin ${email} with password: ${password} — sign in and change it now.`);
  }
  // Only ever move the recorded version forward: an older app instance still
  // running SCHEMA_VERSION N-1 during a rolling deploy must not stomp the N
  // a newer instance already wrote, which would make every subsequent cold
  // start re-run this whole block for nothing (or, worse, thrash forever).
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', $1, now())
     ON CONFLICT (key) DO UPDATE SET
       value = CASE WHEN EXCLUDED.value::int > settings.value::int THEN EXCLUDED.value ELSE settings.value END,
       updated_at = now()`,
    [SCHEMA_VERSION]
  );
}

/**
 * Create the schema (idempotent) and, on an empty database, a bootstrap
 * admin account so the first deploy is immediately usable.
 * Called once per process before handling requests.
 */
function ready() {
  // Once the database is provisioned, set DB_SKIP_INIT=1 so serverless cold
  // starts skip the full schema DDL + migrations. This still checks
  // schema_version (see readySkipInit) so a future version bump is not
  // silently ignored forever — only the *expensive* path is skipped once the
  // DB is already at or ahead of SCHEMA_VERSION.
  if (process.env.DB_SKIP_INIT === '1') return readySkipInit();
  if (!readyPromise) {
    readyPromise = (async () => {
      // Fast path: one cheap SELECT instead of replaying ~50 DDL statements
      // on every cold start (that DDL was the main cause of slow first
      // page loads on mobile). Any error (e.g. settings table missing on a
      // brand-new database) falls through to the full setup below.
      try {
        const v = (await pool.query("SELECT value FROM settings WHERE key = 'schema_version'")).rows[0];
        if (schemaUpToDate(v && v.value)) return;
      } catch (e) { /* first boot: settings table doesn't exist yet */ }
      await runMigrations();
    })();
    // Don't memoize failures: a transient DB outage at cold start should not
    // poison every later request in this process.
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

let skipInitPromise = null;

/**
 * DB_SKIP_INIT=1 boot path. ensureCriticalSchema() always runs (cheap,
 * memoized, see its own doc comment). The schema_version check is a single
 * indexed-PK SELECT, so it's cheap enough to run on every cold start even
 * under this flag; only the full runMigrations() pass is skipped once the DB
 * is already at or ahead of SCHEMA_VERSION. Without this, a deployment that
 * (as recommended) sets DB_SKIP_INIT=1 once provisioned would never apply a
 * future schema change — it would boot fine and then 500 the first time a
 * route touched a new column/table.
 */
function readySkipInit() {
  if (!skipInitPromise) {
    skipInitPromise = (async () => {
      const critical = ensureCriticalSchema();
      let stored = null;
      try {
        const v = (await pool.query("SELECT value FROM settings WHERE key = 'schema_version'")).rows[0];
        stored = v && v.value;
      } catch (e) { /* settings table missing/unreadable: treat as out of date */ }
      if (!schemaUpToDate(stored)) await runMigrations();
      await critical;
    })();
    skipInitPromise.catch(() => { skipInitPromise = null; });
  }
  return skipInitPromise;
}

module.exports = { pool, q, q1, ready, withTransaction, dbPoolerRisk };
