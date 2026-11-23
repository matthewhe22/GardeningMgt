#!/usr/bin/env bash
# Copy the app's database to another Postgres (e.g. a new Supabase project in
# Sydney). Run the phases in order — see docs/DB-MOVE-SYDNEY.md for the full
# runbook (when to pause the old project, switching Vercel, rollback).
#
#   scripts/db-move.sh dump    "$OLD_DB_URL"   # writes ./db-move/<stamp>/{app.dump,counts.txt}
#   scripts/db-move.sh restore "$NEW_DB_URL" ./db-move/<stamp>
#   scripts/db-move.sh verify  "$NEW_DB_URL" ./db-move/<stamp>
#
# Use each project's SESSION pooler URL (port 5432, "…pooler.supabase.com"):
# the direct db.<ref>.supabase.co host is IPv6-only, and the transaction pooler
# (6543) doesn't support pg_dump/pg_restore. Needs pg_dump/pg_restore/psql 17+
# (the server version) — e.g. `brew install libpq` on a Mac.
#
# Only the app's `public` schema is copied (it uses nothing else). The dump
# holds customer data and encrypted settings: keep it private, delete it once
# the new database has been running fine for a while.
set -euo pipefail

phase="${1:-}"; url="${2:-}"; dir="${3:-}"
die() { echo "error: $*" >&2; exit 1; }
[ -n "$phase" ] && [ -n "$url" ] || die "usage: $0 dump|restore|verify <db-url> [dump-dir]"
for t in pg_dump pg_restore psql; do command -v "$t" >/dev/null || die "$t not found (install PostgreSQL 17+ client tools)"; done

server_major() { psql "$url" -Atc "SHOW server_version_num" | cut -c1-2; }
client_major() { pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/'; }
check_versions() {
  local s c; s="$(server_major)"; c="$(client_major)"
  [ "$c" -ge "$s" ] || die "pg_dump $c is older than the server ($s) — install PostgreSQL $s+ client tools"
}

# Row count of every table in public, one "table count" per line, sorted.
counts() {
  psql "$url" -qAt -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE r record; n bigint; BEGIN
  CREATE TEMP TABLE _c (t text, n bigint);
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.tablename) INTO n;
    INSERT INTO _c VALUES (r.tablename, n);
  END LOOP; END $$;
SELECT t || ' ' || n FROM _c ORDER BY t;
SQL
}

case "$phase" in
  dump)
    check_versions
    out="./db-move/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$out"; chmod 700 "$out"
    inline=$(psql "$url" -Atc "SELECT count(*) FROM photos WHERE octet_length(data) > 0")
    if [ "$inline" != "0" ]; then
      echo "warning: $inline photo(s) still stored inside the database — run 'npm run migrate:photos' first" >&2
      echo "         so the dump (and the new database) stay small." >&2
    fi
    echo "Dumping public schema…"
    pg_dump "$url" --schema=public --no-owner --no-privileges --format=custom --file "$out/app.dump"
    counts > "$out/counts.txt"
    echo "Done: $out ($(du -h "$out/app.dump" | cut -f1)). Row counts saved to $out/counts.txt"
    echo "Next: pause the OLD project, create the new one, then: $0 restore <new-url> $out"
    ;;
  restore)
    [ -f "$dir/app.dump" ] || die "no $dir/app.dump"
    check_versions
    existing=$(psql "$url" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
    [ "$existing" = "0" ] || die "the target already has $existing table(s) in public — restore into a fresh project"
    # A new Supabase project already has the public schema: skip re-creating it.
    pg_restore --list "$dir/app.dump" | grep -vE ' SCHEMA - public | COMMENT - SCHEMA public ' > "$dir/restore.list"
    echo "Restoring…"
    pg_restore --dbname "$url" --no-owner --no-privileges --exit-on-error --single-transaction \
      --use-list "$dir/restore.list" "$dir/app.dump"
    echo "Restored. Next: $0 verify <new-url> $dir"
    ;;
  verify)
    [ -f "$dir/counts.txt" ] || die "no $dir/counts.txt"
    counts > "$dir/counts-new.txt"
    if diff -u "$dir/counts.txt" "$dir/counts-new.txt"; then
      echo "Row counts match on all $(wc -l < "$dir/counts.txt") tables."
    else
      die "row counts differ (see diff above) — do not switch DATABASE_URL"
    fi
    v=$(psql "$url" -Atc "SELECT value FROM settings WHERE key = 'schema_version'")
    echo "schema_version = $v"
    # Sequences come across with the dump; make sure the next ids won't collide.
    psql "$url" -qAt -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE r record; mx bigint; cur bigint; bad int := 0; BEGIN
  FOR r IN SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(format('public.%I', c.relname), a.attname) AS seq
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0
             AND pg_get_serial_sequence(format('public.%I', c.relname), a.attname) IS NOT NULL LOOP
    EXECUTE format('SELECT COALESCE(max(%I), 0) FROM public.%I', r.col, r.tbl) INTO mx;
    EXECUTE format('SELECT last_value FROM %s', r.seq) INTO cur;
    IF cur < mx THEN bad := bad + 1; RAISE WARNING 'sequence % (%) is behind max id %', r.seq, cur, mx; END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION '% sequence(s) behind', bad; END IF;
END $$;
SQL
    echo "Sequences OK. Safe to point DATABASE_URL at the new database."
    ;;
  *) die "unknown phase '$phase' (dump|restore|verify)";;
esac
