#!/usr/bin/env bash
# One guided run of the whole move: dump the old database, restore it into the
# new Supabase project, verify, then move the photos into the new project's
# Storage. It stops and waits at each point where YOU have to act (pausing the
# old project, switching Vercel). Nothing is deleted anywhere.
#
# Needs these exported in your shell (see docs/DB-MOVE-SYDNEY.md):
#   OLD_DB_URL NEW_DB_URL                      session-pooler URLs (port 5432)
#   S3_BUCKET S3_ENDPOINT S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
#                                              the NEW project's Storage
# Run from the repo:   scripts/db-move-guided.sh
# Safe to Ctrl+C at any prompt. Output contains no passwords or keys.
set -euo pipefail
cd "$(dirname "$0")/.."

for v in OLD_DB_URL NEW_DB_URL S3_BUCKET S3_ENDPOINT S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || { echo "error: $v is not set — see docs/DB-MOVE-SYDNEY.md" >&2; exit 1; }
done
step() { echo; echo "=================== $1 ==================="; }
wait_for() { echo; read -rp ">>> $1 — then press Enter (Ctrl+C to stop): " _; }
mask() { sed -E 's#//([^:/@]+):[^@]*@#//\1:<PASSWORD>@#'; }

step "1/5  Backup of the OLD database (the app keeps running)"
scripts/db-move.sh dump "$OLD_DB_URL"
DIR=$(ls -dt db-move/*/ | head -1); DIR=${DIR%/}
echo; echo "Row counts in the backup:"; cat "$DIR/counts.txt"

step "2/5  Pause the OLD project"
echo "From here on the app is DOWN until Vercel is switched (step 4). Anything saved"
echo "to the old database after the backup would be lost, so pause it now."
wait_for "In Supabase, open the OLD (Seoul) project → Settings → General → Pause project, and wait until it shows Paused"

step "3/5  Restore into the NEW database and verify"
scripts/db-move.sh restore "$NEW_DB_URL" "$DIR"
scripts/db-move.sh verify  "$NEW_DB_URL" "$DIR"

step "4/5  Switch the app (Vercel)"
TX=$(printf '%s' "$NEW_DB_URL" | sed -E 's#:5432/#:6543/#')
case "$TX" in *\?*) ;; *) TX="$TX?pgbouncer=true";; esac
echo "In Vercel → Project → Settings → Environment Variables (Production), set:"
echo
echo "  DATABASE_URL         = $(printf '%s' "$TX" | mask)"
echo "                         (copy the real one: Supabase → new project → Connect → Transaction pooler)"
echo "  S3_BUCKET            = $S3_BUCKET"
echo "  S3_ENDPOINT          = $S3_ENDPOINT"
echo "  S3_REGION            = $S3_REGION"
echo "  S3_ACCESS_KEY_ID     = (the same key ID you used here)"
echo "  S3_SECRET_ACCESS_KEY = (the same secret)"
echo
echo "Leave every other variable alone (SESSION_SECRET and SETTINGS_KEY especially)."
wait_for "Set those, then REDEPLOY in Vercel (Deployments → latest → ⋯ → Redeploy), and open the app to check it loads"

step "5/5  Move the photos into Storage (the app stays up)"
DATABASE_URL="$NEW_DB_URL" npm run -s migrate:photos

echo
echo "DONE. Paste this whole output to Claude, who will check the new database from the other side"
echo "and shrink it (VACUUM FULL). The old project stays paused as your fallback."
