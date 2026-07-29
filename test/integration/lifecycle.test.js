// Integration tests that need a real Postgres. They run only when
// TEST_DATABASE_URL is set (e.g. a CI service container or a throwaway local
// DB) and skip otherwise, so `npm test` stays green without a database.
//
//   TEST_DATABASE_URL=postgres://localhost/gardeningmgt_test npm run test:integration
//
// This is the scaffold the review flagged as missing — extend it with route /
// auth / ownership cases (ideally via supertest against src/server.js).

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const reason = 'set TEST_DATABASE_URL to run integration tests';

// A single top-level test shares one process-wide db.js (and its connection
// pool) across every sub-test below — splitting these into separate
// top-level test() blocks would each try to close the same shared pool in
// their own t.after(), and the second block's queries would then fail with
// "Cannot use a pool after calling end on the pool".
test('schema init + core invariants', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  const { ready, q, q1, pool } = require('../../src/db');
  await ready();
  t.after(() => pool.end());

  await t.test('core tables exist after init', async () => {
    const { c } = await q1(
      "SELECT COUNT(*)::int AS c FROM information_schema.tables " +
      "WHERE table_name IN ('users','visits','invoices','photos','issues')");
    assert.equal(c, 5);
  });

  await t.test('invoice sequence yields increasing numbers', async () => {
    const a = await q1("SELECT nextval('invoice_seq')::int AS n");
    const b = await q1("SELECT nextval('invoice_seq')::int AS n");
    assert.ok(b.n > a.n);
  });

  await t.test('bootstrap created an admin user', async () => {
    const { c } = await q1("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
    assert.ok(c >= 1);
  });

  await t.test('login_attempts table exists with the expected columns', async () => {
    const cols = await q(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'login_attempts'");
    assert.deepStrictEqual(cols.map((c) => c.column_name).sort(), ['count', 'first_at', 'key']);
  });

  await t.test('uq_invoices_visit_open rejects a second live invoice for one visit, but allows a void one', async () => {
    const property = await q1("INSERT INTO properties (name, address) VALUES ('IT Site A', 'IT Addr A') RETURNING id");
    const visit = await q1(
      "INSERT INTO visits (property_id, scheduled_date, status) VALUES ($1, CURRENT_DATE, 'completed') RETURNING id",
      [property.id]);
    await q("INSERT INTO invoices (visit_id, number, status) VALUES ($1, $2, 'sent')", [visit.id, `IT-${visit.id}-A`]);

    await assert.rejects(
      q("INSERT INTO invoices (visit_id, number, status) VALUES ($1, $2, 'draft')", [visit.id, `IT-${visit.id}-B`]),
      /uq_invoices_visit_open/
    );

    // A void invoice for the same visit is NOT blocked — the partial index is
    // scoped to status <> 'void' precisely so re-invoicing after a void works.
    await assert.doesNotReject(
      q("INSERT INTO invoices (visit_id, number, status) VALUES ($1, $2, 'void')", [visit.id, `IT-${visit.id}-C`])
    );
  });

  await t.test('uq_jobs_property_active rejects a second active job for one property, but allows an inactive one', async () => {
    const property = await q1("INSERT INTO properties (name, address) VALUES ('IT Site B', 'IT Addr B') RETURNING id");
    await q(
      "INSERT INTO jobs (property_id, start_date, end_date, active) VALUES ($1, CURRENT_DATE, CURRENT_DATE + 365, true)",
      [property.id]);

    await assert.rejects(
      q("INSERT INTO jobs (property_id, start_date, end_date, active) VALUES ($1, CURRENT_DATE, CURRENT_DATE + 365, true)",
        [property.id]),
      /uq_jobs_property_active/
    );

    await assert.doesNotReject(
      q("INSERT INTO jobs (property_id, start_date, end_date, active) VALUES ($1, CURRENT_DATE, CURRENT_DATE + 365, false)",
        [property.id])
    );
  });
});
