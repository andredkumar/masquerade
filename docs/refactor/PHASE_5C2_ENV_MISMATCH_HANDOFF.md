# Phase 5C-2 — Post-cutover "relation \"jobs\" does not exist" — Handoff

**For:** the agent/operator working on the app EC2 (`3.136.48.97`).
**Status:** root cause identified as an **environment mismatch** (not a code bug). A
diagnostic commit (`131074c`) makes the mismatch self-reporting at boot. The operative
fix is on the server (PM2 environment) and is **not** yet applied.

---

## 1. Symptom

After the Postgres cutover, a clean `pm2 restart` boots green but every write 500s:

```
POST /api/uploads/video 500 :: {"error":"relation \"jobs\" does not exist"}
```

Observed facts:
- Boot log: `database reachable (SELECT 1 OK) — running on Postgres`.
- `.env` `DATABASE_URL` = `…masquerade-prod.cluster-…rds.amazonaws.com:5432/masquerade?sslmode=no-verify`.
- `psql` against that **exact** URL shows `jobs`, `ai_runs`, `frame_processing_batches` in `public`.
- A clean restart does not help.

---

## 2. Root cause — env mismatch, not a connection split in code

The initial hypothesis was that the boot probe and `PgStorage` use different
connections. **The code rules this out:**

- `server/db.ts:19-22` builds **one** `pool` / `db` from `process.env.DATABASE_URL` —
  no fallback, no hardcoded/Neon URL, no second env var.
- The boot probe (`server/index.ts`) does `await import('./db')`; `pgStorage.ts:3` does
  `import { db } from './db'`. **Same module, same singleton `db`, same Pool.** They
  cannot reach different databases from each other.
- `server/dbSsl.ts` `resolveSsl` reads no env var and does not rewrite the connection
  string; it only decides `ssl` on/off.

Therefore `SELECT 1 OK` **and** `relation "jobs" does not exist` means the process is
pointed at a **reachable but unmigrated** database — and that database is **not** the
one in `.env`/`psql`. The real divergence:

> **`DATABASE_URL` in the running PM2 process ≠ `DATABASE_URL` in the `.env` file.**

`SELECT 1` passes against any reachable Postgres, so it never caught this. The stale
value is almost certainly the **pre-5C-1 Neon URL** (or a different db name): it
connects fine but has no A3 `jobs` table → exactly this error.

Why a clean restart doesn't help: a plain `pm2 restart` **reuses the PM2 daemon's
cached environment**. And a `DATABASE_URL` in the ecosystem `env` / `env_production`
block **overrides** `env_file: .env`. So the process keeps using the wrong URL while
`psql` (reading `.env`) uses the right one.

### The four suspects, answered
1. **Different Pools?** No — one shared `db` singleton; one read of `process.env.DATABASE_URL`.
2. **Leftover Neon fallback in code?** No hardcoded URL/default anywhere (`db.ts` throws
   if unset). The Neon-connects-but-has-no-jobs *mechanism* is right, but it is supplied
   via the **process env**, not a code fallback.
3. **Wrong schema/search_path?** Tables are in `public`; drizzle default is `public`.
   The new probe now prints `current_schema()` to confirm.
4. **Pool built before env loaded?** Not within the Node process — `db.ts` reads env at
   module load and the probe (same module) sees the identical value; empty env would
   throw a crash-loop (it didn't). The timing/precedence issue is at the **PM2 layer**
   (cached env + `env` block overriding `env_file`).

---

## 3. Diagnostic change already committed (`131074c`, `server/index.ts`)

On the PgStorage boot path the eager probe now:

- Logs the app's **actual** target parsed from `process.env.DATABASE_URL`
  (password stripped):
  `app DATABASE_URL target → <host>:<port>/<db> user=<user>`
- Runs `SELECT current_database(), current_user, current_schema(),
  to_regclass('public.jobs') IS NOT NULL AS has_jobs` and logs the row.
- If `public.jobs` is missing, prints a **FATAL** env-mismatch message naming the wrong
  database and `process.exit(1)`s (PM2 crash-loop) — converting the opaque first-write
  500 into an immediate, self-explaining boot failure.

No connection logic changed. `tsc` stays **17**. This commit is **local only** (branch
is 1 ahead of `origin/main`); push it or cherry-pick before deploying to the server.

Expected boot log **after** deploying this commit while still mis-pointed:
```
app DATABASE_URL target → <WRONG-host>:5432/<wrong-db> user=<user>
FATAL: connected to database "<wrong-db>" … public.jobs is MISSING there … ENVIRONMENT mismatch …
```
Expected boot log **after** the env is corrected:
```
app DATABASE_URL target → …masquerade-prod…rds.amazonaws.com:5432/masquerade user=<user>
database reachable (SELECT 1 OK) — running on Postgres · db=masquerade user=<user> schema=public public.jobs=true
```

---

## 4. The operative fix (server-side)

**Step 1 — confirm the mismatch.** On the app EC2:
```bash
pm2 list                                  # get the app's <id>/name
pm2 env <id> | grep -i DATABASE_URL       # what the PROCESS actually has
```
Compare that host/db to `.env`. They will differ (expected: process has the old
Neon/other URL; `.env` has `…masquerade-prod…/masquerade`).

**Step 2 — make the process use the correct URL.** Pick the source of truth:

- If `DATABASE_URL` is set in the ecosystem `env` / `env_production` block, either put
  the **correct** RDS URL there, or remove it so `env_file: .env` wins. (An `env` block
  value overrides `env_file`.)
- Then apply the env — a plain restart is not enough:
```bash
# cleanest when the daemon has stale cached env:
pm2 delete masquerade
export DATABASE_URL="postgresql://USER:PASSWORD@masquerade-prod.cluster-XXXX.rds.amazonaws.com:5432/masquerade?sslmode=no-verify"
pm2 start <your ecosystem file> --update-env    # or: pm2 start dist/index.js --name masquerade --update-env
pm2 save                                        # persist corrected env across reboots
```
`--update-env` is mandatory; without it PM2 reuses the old environment.

**Step 3 — verify.**
```bash
pm2 logs masquerade --lines 30
# expect: app DATABASE_URL target → …masquerade-prod…/masquerade … public.jobs=true
```
Then the smoke test: upload → mask → apply → AI → download, `pm2 restart masquerade`,
reload → **the job survives.**

---

## 5. Guardrails / notes

- **Do not** add `dotenv` to force `.env` from code — the project deliberately has none,
  and the 5C-2 design reads real process env only. The fix is correct PM2 env.
- Keep the real `DATABASE_URL` out of git (PM2 env / secrets manager only). The tracked
  `deployment-package/ecosystem.config.js` is a **stale artifact** (app name `maquerade`,
  no `DATABASE_URL`); edit whichever ecosystem file `pm2` actually launches from.
- Rollback is unchanged and still one edit: `server/storage.ts` `new PgStorage()` →
  `new MemStorage()`; the diagnostic probe self-disables on the MemStorage path
  (`storage.constructor.name` gate).
- `sslmode=no-verify` in the URL is handled by `resolveSsl` (SSL on,
  `rejectUnauthorized:false`); it is not related to this error.

---

## 6. One-line summary for the next agent

`PgStorage` already uses `process.env.DATABASE_URL`; nothing in code points it elsewhere.
The running PM2 process is carrying a stale/overriding `DATABASE_URL` (reachable but
unmigrated — likely old Neon), so `SELECT 1` passes but `jobs` is absent. Fix the PM2
process env (inspect with `pm2 env`, restart with `--update-env` / `pm2 delete` + fresh
start), redeploy commit `131074c`, and confirm the boot log shows `public.jobs=true`
against `…masquerade-prod…/masquerade`.
