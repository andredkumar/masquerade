# Phase 5C-2 — Production Cutover Runbook

**Audience:** Andre (operator). **You execute every step** — each touches AWS,
production secrets, or the live server. Nothing here is automated by the codebase
and no secret is committed to the repo.

**Goal (the whole phase):** point the running app at a **production** RDS Postgres
so jobs **survive a restart**, with a proven one-edit rollback to MemStorage.

Each step is labelled **[AWS]**, **[SERVER]** (the app EC2, `3.136.48.97`),
**[LOCAL]** (your laptop), or **[BROWSER]**. Unlike 5C-1, migration runs **on the
server**, because the prod RDS security group allows only the app EC2 on 5432 — not
your laptop.

> **The one check that defines success (§7):** create a job → `pm2 restart` → the
> job is still there. Everything else is setup around that.

---

## 0. Prerequisites

- **[AWS]** Permission to create an RDS instance + security group in the app's VPC.
- **[SERVER]** SSH access to the app EC2 (`3.136.48.97`); the repo checked out there;
  `pm2` already running the app (find the process name with `pm2 list` — this runbook
  assumes it is `masquerade`; substitute yours).
- **[SERVER]** `psql` client for the connectivity probe (§4.5).
- Know the app EC2's **VPC** and **security-group ID** (the RDS SG will allow that SG,
  or the EC2's private IP, inbound on 5432).

---

## 1. [AWS] Provision the production RDS instance

This is a **NEW** instance — not the disposable 5C-1 test DB.

- **Engine:** PostgreSQL 15+ (schema uses `gen_random_uuid()`, built into PG13+).
- **Encryption at rest:** **ON at creation** (KMS). Required PHI posture; cannot be
  added later without a snapshot+restore.
- **Backups:** automated snapshots + PITR (RDS default) — leave enabled.
- **Network:** private subnet. Security group inbound rule: **`5432` from the app EC2
  only** — either the EC2's security group as source, or `3.136.48.97/32`. Do **not**
  open it to your laptop or `0.0.0.0/0`.
- **Credentials:** strong generated master password. Store it in your secrets manager,
  **never** in the repo. Note the **endpoint host** (ends in `rds.amazonaws.com`), the
  **db name**, **user**, and **password**.

> The agent created none of this. Provisioning, credentials, and KMS are yours.

---

## 2. [LOCAL] Assemble the DATABASE_URL (do not commit it)

```
postgresql://USER:PASSWORD@PROD-ENDPOINT.rds.amazonaws.com:5432/DBNAME
```

SSL is handled **in code** by the shared `resolveSsl` (5C-1): any host containing
`rds.amazonaws.com` auto-enables SSL (`rejectUnauthorized:false`). So the plain URL
above works as-is for **both** `db:migrate` and the running app — you do **not** need
to append `?sslmode=`. (A `psql` probe is a separate client and may need its own
`?sslmode=require` — see §4.5.)

Keep this string somewhere transient (your secrets manager / a shell you will close).
It goes into the **server's PM2 environment** (§5) and is exported for the migrate
step (§4).

---

## 3. [SERVER] Get the 5C-2 code onto the app EC2

```bash
cd /path/to/masquerade-aws-latest
git fetch && git checkout main && git pull      # must include the 5C-2 flip commit
npm install                                     # FULL install — build+migrate need
                                                # devDeps (drizzle-kit, esbuild, vite)
```

> Do **not** use `--omit=dev` / `--production` here: `drizzle-kit` (migrate) and
> `esbuild`/`vite` (build) are devDependencies. `pg` and `drizzle-orm` are prod
> dependencies, so the *running* app has them regardless.

---

## 4. [SERVER] Apply the `0000` baseline migration to prod RDS

Run this **before** the app points at the DB, from the app EC2 (it is inside the SG
that can reach RDS):

```bash
cd /path/to/masquerade-aws-latest
export DATABASE_URL="postgresql://USER:PASSWORD@PROD-ENDPOINT.rds.amazonaws.com:5432/DBNAME"
npm run db:migrate
```

`db:migrate` (drizzle-kit) reads `drizzle.config.ts` → `DATABASE_URL` + `resolveSsl`
(SSL auto-on for the RDS host) and applies `migrations/0000_hard_cable.sql`, recording
it in `__drizzle_migrations`. Re-runs are idempotent.

> `export`-ing `DATABASE_URL` in this shell is for the **migrate command only**. The
> long-lived app gets it from PM2 (§5), not from this shell.

---

## 4.5 [SERVER] Prove the connection before deploying the app

Isolate an infra/SSL problem from a real app issue **before** you restart the app.

```bash
psql "$DATABASE_URL" -c "SELECT 1;"
```

- **Returns `1`** → network + SSL + credentials all good.
- **Hangs / times out** → security group: the app EC2 isn't allowed inbound on 5432.
  Fix the RDS SG (§1). (If you are SSH'd into the app EC2 and it still times out, the
  SG source is wrong.)
- **SSL error** (`no pg_hba.conf entry … no encryption`, or a TLS/cert error) → for
  the `psql` probe specifically, append `?sslmode=require`:
  `psql "$DATABASE_URL?sslmode=require" -c "SELECT 1;"`. The app and `db:migrate` use
  the shared `resolveSsl` (not `psql`'s), so this `sslmode` is only for the probe.
- **Auth error** (`password authentication failed`) → credentials in `DATABASE_URL`
  are wrong.

Confirm the migration created the tables:

```bash
psql "$DATABASE_URL" -c "\dt"
```

Expected: `jobs`, `ai_runs`, `frame_processing_batches` (+ the `__drizzle_migrations`
bookkeeping table). **No** `video_jobs` (A3 has none). If `gen_random_uuid()` errored
during migrate, run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` then re-run
`npm run db:migrate` (unlikely on PG15).

---

## 5. [SERVER] Set DATABASE_URL in the app's PM2 environment

**There is no `dotenv` in this project** — the running app reads **real** environment
variables only. A `.env` file is **not** auto-loaded. Set `DATABASE_URL` in PM2's
actual environment by one of these:

**Option A — ecosystem file env block (persistent, recommended):** in your PM2
ecosystem config's `env` (the live one on the server; the tracked
`deployment-package/ecosystem.config.js` is a stale artifact — edit whichever file
your `pm2` actually launches from), add:

```js
env: {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://USER:PASSWORD@PROD-ENDPOINT.rds.amazonaws.com:5432/DBNAME",
  // …existing vars (ANTHROPIC_API_KEY, AI_SERVICE_URL, SAM2_SERVICE_URL, PORT)…
}
```

then reload with the env applied (see §6). **This file lives on the server, not in
git** — do not commit the real URL.

**Option B — export + `--update-env` (quick):**

```bash
export DATABASE_URL="postgresql://…rds.amazonaws.com:5432/DBNAME"
pm2 restart masquerade --update-env
```

`--update-env` is required — without it PM2 reuses the old environment and the app
still won't see `DATABASE_URL`.

> Verify it landed: `pm2 env <id>` (from `pm2 list`) should show `DATABASE_URL`. Never
> paste the password into a shared terminal log.

---

## 6. [SERVER] Deploy the flip

```bash
cd /path/to/masquerade-aws-latest
npm run build                       # vite build + esbuild → dist/index.js
pm2 restart masquerade --update-env # or: pm2 reload <ecosystem file>
pm2 logs masquerade --lines 50
```

**Confirm boot against Postgres:**

- **Good:** logs show `serving on port 5000` (or your `PORT`) with no DB throw.
- **`DATABASE_URL is not set…` throw + crash-loop** → PM2 env didn't get the var. Redo
  §5 (this is the *loud boot failure* for a missing URL — expected and diagnostic).
- **`FATAL: DATABASE_URL is set but the database is unreachable at boot` + crash-loop**
  with `ECONNREFUSED` / timeout / `28000` / auth below it → the eager `SELECT 1` boot
  probe caught an unreachable/misconfigured DB **at boot** (before `listen`). Fix
  RDS/SG/creds (§1, §4.5) or **roll back** (§8). (The probe makes this a boot-time
  crash-loop, not a first-request 500 — see the proposal §2.)

---

## 7. [BROWSER] + [SERVER] Smoke test — the durability check that defines 5C-2

1. **[BROWSER]** Open the app. Run one full job: **upload → mask → apply → AI run →
   download**. Confirm each step works exactly as before (nothing user-visible should
   change).
2. **[BROWSER]** Note the job id / that it appears in the hub.
3. **[SERVER]** Restart the process:
   ```bash
   pm2 restart masquerade
   ```
4. **[BROWSER]** Reload the app. **The job from step 1 is still there.**

> **This is the whole point.** Pre-5C-2 that job vanished on restart (MemStorage was
> wiped). If it survives, the cutover worked. Optionally confirm server-side:
> `psql "$DATABASE_URL" -c "SELECT id, filename, video_status, job_status FROM jobs ORDER BY created_at DESC LIMIT 5;"`

---

## 8. Rollback (tested, not theoretical)

If the app won't boot against RDS, or the smoke test fails, get back to the known-good
MemStorage runtime — no data to reverse (MemStorage was always ephemeral):

**[LOCAL] or [SERVER]** revert the one edit:

```bash
git revert <5C-2 commit sha>        # cleanest: reverts server/storage.ts + docs
# — or hand-edit server/storage.ts: `new PgStorage()` → `new MemStorage()`
#   (and drop the `import { PgStorage }` line)
```

**[SERVER]** rebuild and restart:

```bash
git pull                            # if you reverted on the laptop and pushed
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 30      # expect `serving on port …`, no DB throw
```

The reverted app boots with **no `DATABASE_URL` requirement** — it is exactly the
pre-5C-2 runtime. You may leave `DATABASE_URL` in the PM2 env (MemStorage ignores it)
or remove it. The prod RDS instance can keep running idle (nothing reads it) or be
torn down separately.

> Because a missing/unreachable DB is a **loud boot** failure (crash-loop on unset URL,
> and — thanks to the eager `SELECT 1` probe — a crash-loop on unreachable too) — never a
> silent hang — you know at boot whether to roll back rather than debug a wedged app.

---

## 9. After a green run

Report back the smoke-test result (job survived restart) so it can be recorded in
`PHASE_5C2_REPORT.md`. Then:

- Keep `DATABASE_URL` out of any committed file (PM2 env / secrets manager only).
- 5C-2 ends here. `MemStorage` stays in the codebase as the rollback target — do not
  delete it. The 5D loading-hang and Phase 6 items remain out of scope.
