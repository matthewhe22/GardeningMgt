const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// db.js's pooler-exhaustion guard (P2-25) runs at module load time and can
// throw, so it's tested by spawning a fresh `node -e` process per scenario
// (mirrors how SESSION_SECRET/DATABASE_URL's own fail-closed checks work —
// neither of those has test coverage either, since both are boot-time-only
// behavior with no code path reachable from a normal `require` in-process).

const DB_JS = path.join(__dirname, '..', 'src', 'db.js');

function run(env, script) {
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('dbPoolerRisk: local dev is never at risk, regardless of VERCEL', () => {
  const out = run(
    { DATABASE_URL: 'postgresql://postgres@localhost:5432/x', VERCEL: '1' },
    `console.log(require(${JSON.stringify(DB_JS)}).dbPoolerRisk)`
  );
  assert.strictEqual(out.trim(), 'false');
});

test('dbPoolerRisk: off Vercel, a direct DATABASE_URL is never at risk', () => {
  const out = run(
    { DATABASE_URL: 'postgres://user:pass@db.example.com:5432/x' },
    `console.log(require(${JSON.stringify(DB_JS)}).dbPoolerRisk)`
  );
  assert.strictEqual(out.trim(), 'false');
});

test('dbPoolerRisk: Vercel + a direct (non-pooler) URL is at risk', () => {
  const out = run(
    { DATABASE_URL: 'postgres://user:pass@db.example.com:5432/x', VERCEL: '1' },
    `console.log(require(${JSON.stringify(DB_JS)}).dbPoolerRisk)`
  );
  assert.strictEqual(out.trim(), 'true');
});

test('dbPoolerRisk: recognizes common pooler URL shapes as not at risk', () => {
  const poolerUrls = [
    'postgres://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres', // Supabase transaction pooler
    'postgres://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres', // Supabase session pooler
    'postgres://user:pass@ep-cool-forest-12345-pooler.us-east-2.aws.neon.tech/db',    // Neon pooled endpoint
    'postgres://user:pass@db.internal:6432/db',                                       // self-hosted pgBouncer default port
    'postgres://user:pass@db.internal:5432/db?pgbouncer=true',                        // explicit pgbouncer flag
  ];
  for (const url of poolerUrls) {
    const out = run({ DATABASE_URL: url, VERCEL: '1' }, `console.log(require(${JSON.stringify(DB_JS)}).dbPoolerRisk)`);
    assert.strictEqual(out.trim(), 'false', `expected no risk for pooler URL: ${url}`);
  }
});

test('REQUIRE_DB_POOLER=1 refuses to boot on Vercel with a direct URL', () => {
  assert.throws(() => {
    run(
      { DATABASE_URL: 'postgres://user:pass@db.example.com:5432/x', VERCEL: '1', REQUIRE_DB_POOLER: '1' },
      `require(${JSON.stringify(DB_JS)})`
    );
  }, /does not look like a pooled connection string/);
});

test('REQUIRE_DB_POOLER=1 boots fine on Vercel with a pooler URL', () => {
  const out = run(
    {
      DATABASE_URL: 'postgres://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      VERCEL: '1',
      REQUIRE_DB_POOLER: '1',
    },
    `console.log('booted:', require(${JSON.stringify(DB_JS)}).dbPoolerRisk)`
  );
  assert.match(out, /booted: false/);
});

test('REQUIRE_DB_POOLER unset never throws, even with a direct URL on Vercel', () => {
  assert.doesNotThrow(() => {
    run(
      { DATABASE_URL: 'postgres://user:pass@db.example.com:5432/x', VERCEL: '1' },
      `require(${JSON.stringify(DB_JS)})`
    );
  });
});
