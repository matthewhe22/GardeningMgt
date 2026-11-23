# Runbook: move the database to Sydney

**Why.** The app runs on Vercel in Sydney (`syd1`) but its Supabase database is
in Seoul (`ap-northeast-2`). Every query crosses ~8,000 km (≈130–160 ms per
round trip), and a page makes several of them one after another. A database in
Sydney (`ap-southeast-2`) cuts each to a few milliseconds: pages and photo
uploads get noticeably faster.

**Constraints (Supabase, at the time of writing).**
- A project's region can't be changed. The move is: new project in Sydney,
  copy the data, point the app at it.
- The Free plan allows **two active projects** across your organisations, and
  you have two (GardeningMgt, TOCStask). **Paused projects don't count**, so
  the old GardeningMgt project is paused, not deleted, during the move. Paused
  Free projects can be restored from the dashboard for a limited time (90 days
  when this was written) — that's the rollback.
- The Free plan's database limit is 500 MB. Today the database is ~654 MB,
  ~640 MB of it photos. **Move photos to R2 first** (step 1), or the new
  project starts over the limit and the copy is slow.

**Downtime.** About 20–30 minutes, from pausing the old project until the app
points at the new one. Do it outside working hours and tell the gardeners.
Anything saved to the old database after the dump would be lost, which is why
the old project is paused straight after the dump.

**You'll need.** PostgreSQL 17+ client tools (`pg_dump`, `pg_restore`, `psql`;
on a Mac `brew install libpq`), this repo, access to Supabase and to the Vercel
project's environment variables.

---

## 1. Before the day: photos out of the database (no downtime)

1. Set up Cloudflare R2 and the app's `S3_*` variables in Vercel — see
   *Optional: store photos in object storage* in the README — then redeploy.
   New photos now go to R2.
2. Move the existing photos (safe to re-run; each one is verified in the
   bucket before its database copy is cleared):
   ```bash
   DATABASE_URL="<old session-pooler URL>" S3_BUCKET=… S3_ENDPOINT=… S3_REGION=auto \
   S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npm run migrate:photos
   ```
3. In the Supabase SQL editor (old project), at a quiet time:
   ```sql
   VACUUM FULL photos;
   SELECT pg_size_pretty(pg_database_size(current_database()));
   ```
   Expect tens of MB instead of ~650 MB. Open a few old jobs in the app and
   check their photos still show.

## 2. The move

1. **Get the old connection string.** Supabase → old project → **Connect** →
   *Session pooler* (port **5432**, host `…pooler.supabase.com`). Not the direct
   `db.<ref>.supabase.co` host (IPv6-only) and not the transaction pooler (6543).
2. **Dump** (app still running — this is a consistent snapshot):
   ```bash
   scripts/db-move.sh dump "<old session-pooler URL>"
   ```
   It warns if photos are still inside the database. Note the folder it
   prints, e.g. `./db-move/20261201-201500`.
3. **Pause the old project** (Supabase → old project → Settings → General →
   *Pause project*). The app is down from here.
4. **Create the new project** in **Asia-Pacific (Sydney) `ap-southeast-2`**, in
   the same organisation. Save its database password somewhere safe.
5. **Restore** using the new project's *session pooler* URL:
   ```bash
   scripts/db-move.sh restore "<new session-pooler URL>" ./db-move/<stamp>
   scripts/db-move.sh verify  "<new session-pooler URL>" ./db-move/<stamp>
   ```
   `verify` must say the row counts match and sequences are OK.
6. **Switch the app.** Vercel → Project → Settings → Environment Variables →
   `DATABASE_URL` = the new project's **transaction pooler** URL (port 6543,
   host `aws-…-ap-southeast-2.pooler.supabase.com`, with `?pgbouncer=true`).
   Production (and Preview if it shares the database). Leave every other
   variable alone — in particular `SETTINGS_KEY` / `SESSION_SECRET`, which
   decrypt the saved SMTP/PropertyIQ settings and keep everyone signed in.
7. **Redeploy** (Deployments → latest → Redeploy).

## 3. Check (10 minutes)

- `https://<app>/health` responds OK and shows no database warning.
- Sign in; dashboard, a site, an old completed job with photos, invoices.
- Start a test job, take a photo, complete it; check the report email arrives.
- Admin → Settings: SMTP/PropertyIQ still configured.
- The pages should feel quicker — that's the point.

## 4. Afterwards

- Keep the old project **paused** for 2–4 weeks as the rollback, then delete it.
- Delete the `./db-move/<stamp>` folder (it contains customer data).

## Rollback

Before anyone has used the new database: restore the old project (Supabase
dashboard → *Restore project*), set `DATABASE_URL` back to its transaction
pooler URL, redeploy. Restoring the old project takes it back to the 2-project
limit, so pause or delete the new one first.

After the new database has taken real work, rolling back loses that work — fix
forward instead, or dump the new database and restore it into the old project
with the same script.
