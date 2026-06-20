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

test('schema init + core invariants', { skip: !TEST_DB && reason }, async (t) => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DB_SKIP_INIT = '';
  const { ready, q1, pool } = require('../../src/db');
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
});
