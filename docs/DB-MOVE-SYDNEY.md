# Runbook: move the database (and photos) to the new Supabase project

**Why.** The app runs on Vercel in Sydney (`syd1`) but its original Supabase
database is in Seoul (`ap-northeast-2`). Every query crosses ~8,000 km (≈130–160
ms per round trip), and a page makes several of them one after another. The new
project (Pro plan, its own organisation) should be in **Sydney
(`ap-southeast-2`)** — confirm that in Supabase → project → Settings → General
before starting; if it isn't, tell whoever is running this, because the point of
the move is lost otherwise.

**What moves.**
- The database (everything in the `public` schema) from the old project to the new.
- Photos: they are inside the database today (~590 MB). After the switch they are
  moved into the **new project's Supabase Storage** (S3 protocol), which keeps the
  database small and serves photos from Sydney.

**Constraints.**
- A Supabase project's region can't be changed, so this is "copy to the new
  project", not "change region".
- The new Pro project includes an 8 GB database and 100 GB of storage, so the
  ~650 MB database (photos still inside) restores comfortably.
- The old project is **not** deleted: it stays paused as the rollback.
- Mixed state is fine: while some photos are still inside the database and some
  are already in Storage, the app serves both.

**Downtime.** About 20–40 minutes, from pausing the old project until the app
points at the new one (the dump is large because photos are still inside it).
Do it outside working hours and tell the gardeners. Anything saved to the old
database after the dump would be lost, which is why the old project is paused
straight after the dump.

**You'll need.** PostgreSQL 17+ client tools (`pg_dump`, `pg_restore`, `psql`;
on WSL `sudo apt install postgresql-client-17`), this repo checked out and
`npm install` done, access to both Supabase projects and to the Vercel
project's environment variables.

---

## 1. Before the day (no downtime)

1. **Merge the branch** that contains the live-photo / Supabase Storage code and
   let Vercel deploy it. Production must be running this code before the switch.
2. **Collect the new project's details** (Supabase → new project):
   - **Database:** *Connect* → *Session pooler* URL (port **5432**, host
     `…pooler.supabase.com`) — used for the restore. Also the *Transaction pooler*
     URL (port **6543**, add `?pgbouncer=true`) — used by the app. Not the direct
     `db.<ref>.supabase.co` host (IPv6-only).
   - **Storage:** *Storage → Settings → S3 Connection*: the endpoint
     (`https://<ref>.storage.supabase.co/storage/v1/s3`), the region, and a new
     **access key** (ID + secret). These keys bypass row-level security: server-side only.
3. **Prepare the bucket** from your machine (creates a private `photos` bucket if
   missing and self-tests a real upload; nothing touches your data):
   ```bash
   export S3_BUCKET=photos S3_REGION=<region> S3_ENDPOINT=<endpoint>
   read -rp "Access key ID: " S3_ACCESS_KEY_ID
   read -rsp "Secret: " S3_SECRET_ACCESS_KEY; echo
   export S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
   npm run storage:setup -- https://<your-app-domain>
   ```
   Every line should be ✔ (a ⚠ on the CORS preflight is acceptable: phones then
   upload through the app).

## 2. The move

1. **Get the old connection string.** Old project → **Connect** → *Session
   pooler* (port **5432**).
2. **Dump** (app still running — this is a consistent snapshot):
   ```bash
   scripts/db-move.sh dump "<old session-pooler URL>"
   ```
   It warns that photos are still inside the database — expected this time.
   Note the folder it prints, e.g. `./db-move/20261201-201500`.
3. **Pause the old project** (old project → Settings → General → *Pause
   project*). The app is down from here.
4. **Restore** into the new project (session pooler URL), then verify:
   ```bash
   scripts/db-move.sh restore "<new session-pooler URL>" ./db-move/<stamp>
   scripts/db-move.sh verify  "<new session-pooler URL>" ./db-move/<stamp>
   ```
   `verify` must say the row counts match and sequences are OK.
5. **Switch the app.** Vercel → Project → Settings → Environment Variables
   (Production):
   - `DATABASE_URL` = the new project's **transaction pooler** URL (port 6543,
     `?pgbouncer=true`).
   - `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
     `S3_SECRET_ACCESS_KEY` = the new project's Storage values (replace any
     older S3 values, e.g. from a previous provider).
   - Leave everything else alone — in particular `SETTINGS_KEY` /
     `SESSION_SECRET`, which decrypt the saved SMTP/PropertyIQ settings and keep
     everyone signed in.
6. **Redeploy** (Deployments → latest → Redeploy). The app is back, on the new
   database; photos still inside the database are served as before.

## 3. Photos into Storage (app stays up)

From your machine, with the **new** database URL (session pooler) and the Storage
variables from step 1 exported:
```bash
export DATABASE_URL="<new session-pooler URL>"
npm run migrate:photos
```
Each photo is checked in the bucket (right size) before its database copy is
cleared; it is safe to stop and re-run. Then, in the new project's SQL editor at
a quiet moment (it briefly locks the photos table):
```sql
VACUUM FULL photos;
```

## 4. Check (10 minutes)

- `https://<app>/health` responds OK and shows no database warning.
- Sign in; dashboard, a site, an old completed job with photos (before *and*
  after step 3), invoices.
- Start a test job, take a photo, complete it; check the report email arrives.
  The photo should appear in Supabase → Storage → `photos`.
- Admin → Settings: SMTP/PropertyIQ still configured.
- The pages should feel quicker — that's the point.

## 5. Afterwards

- Keep the old project **paused** for 2–4 weeks as the rollback, then delete it.
- Delete the `./db-move/<stamp>` folder (it contains customer data).
- Delete any leftover provider credentials you no longer use (e.g. an old R2 token).

## Rollback

Before anyone has used the new database: restore the old project (Supabase
dashboard → *Restore project*), set `DATABASE_URL` back to its transaction pooler
URL (and remove/replace the `S3_*` values if photos were not yet migrated),
redeploy.

After the new database has taken real work, rolling back loses that work — fix
forward instead, or dump the new database and restore it into the old project
with the same script. If step 3 already ran, photos live in the new project's
Storage: keep that project (and its keys) available.
