# Phase 5C-2 Report — Direct Cutover to Postgres

**Type:** one-file code flip + operator-executed provisioning runbook. No dual-write,
no backfill, no schema/logic change (frozen from 5C-1, proven 35/35 vs real RDS).

**Status:** code flip landed and `tsc`-clean; production verification is operator-side
(runbook `PHASE_5C2_RDS_RUNBOOK.md`, executed by Andre on the app EC2).

---

## 1. Files touched

| File | Change |
|------|--------|
| `server/storage.ts` | **The flip.** Added `import { PgStorage } from './pgStorage';`; changed `export const storage = new MemStorage();` → `new PgStorage();`; rewrote the two comment blocks (the old one explained why PgStorage was *omitted*; the new ones document the cutover + rollback). `MemStorage` the class is **unchanged** — retained as the rollback target. |
| `server/index.ts` | **The eager boot probe.** Added `import { storage } from './storage';` and a startup-IIFE block that, gated on `storage.constructor.name === 'PgStorage'`, dynamically imports `./db` + `drizzle-orm` and runs `await db.execute(sql\`SELECT 1\`)` before `server.listen` — success logs `database reachable`, failure prints FATAL + `process.exit(1)`. No static `./db` import, so the MemStorage rollback path stays DB-free. |
| `docs/refactor/PHASE_5C2_PROPOSAL.md` | New — the five confirmations. |
| `docs/refactor/PHASE_5C2_RDS_RUNBOOK.md` | New — operator runbook. |
| `docs/refactor/PHASE_5C2_REPORT.md` | New — this file. |
| `CLAUDE.md` | Marked 5C-2: app now runs on Postgres; MemStorage retained as rollback target. |

**No** schema, `pgStorage.ts`, `db.ts`, `dbSsl.ts`, `drizzle.config.ts`, migration, or
frontend change. The behavioral surface is the flip in `server/storage.ts` (one source
line + its import) plus the rollback-safe boot probe in `server/index.ts`.

---

## 2. `tsc` = 17 (unchanged)

The baseline held: 10 in `frameExtractor.ts` + 7 in `maskWorker.ts`, zero in any file
touched here. The new `storage.ts → pgStorage.ts → storage.ts` import cycle type-checks
clean (`mapVideoJobStatusToJobStatus` is a hoisted `export function`, so its binding
exists during circular evaluation; it is only *called* at request time).

---

## 3. Boot behavior after the flip

The store is constructed at module-load time via the import chain
`index.ts → routes.ts → storage.ts → pgStorage.ts → db.ts`:

- **`DATABASE_URL` unset** → `db.ts` throws **synchronously at import**, before
  `server.listen` → PM2 crash-loop (loud, diagnostic).
- **`DATABASE_URL` set but DB unreachable / bad creds / SSL refused** → without a probe the
  `pg` Pool is lazy and this would only surface on the first request. **The eager boot probe
  (below) closes that gap:** it now fails at **boot** too.

> **Boot probe — ADDED (resolves the proposal §2 open decision).** `server/index.ts`'s
> startup IIFE runs an eager `await db.execute(sql\`SELECT 1\`)` **before** `server.listen`.
> On success it logs `database reachable (SELECT 1 OK)`; on failure it prints a FATAL
> message and `process.exit(1)` → PM2 crash-loop. So an unreachable RDS is now a **loud
> boot failure**, not a first-request surprise.
>
> **Rollback-safe by construction.** The probe is gated on `storage.constructor.name ===
> 'PgStorage'` and dynamically imports `./db` **only** on that path — `index.ts` has **no
> static `./db` import**. After a `storage.ts`-only rollback to MemStorage the gate is
> false, the block self-disables, and the app boots with **no `DATABASE_URL` requirement**.
> Rollback therefore stays a one-edit change. (Assumes the esbuild step does not minify
> class names — it does not.)

SSL server-side is the same shared `resolveSsl` proven in 5C-1: any `rds.amazonaws.com`
host auto-enables SSL (`rejectUnauthorized:false`), so the app's Pool connects to prod
RDS with SSL with no URL changes.

---

## 4. Verification steps for the operator (server)

Full detail in the runbook; the essentials:

1. **[SERVER]** `git pull` (incl. the 5C-2 commit), `npm install` (full — devDeps needed
   for build/migrate).
2. **[SERVER]** `export DATABASE_URL=…prod-rds…` then `npm run db:migrate` → applies
   `0000` to prod RDS.
3. **[SERVER]** `psql "$DATABASE_URL" -c "SELECT 1;"` and `\dt` → connection clean, three
   tables present (no `video_jobs`).
4. **[SERVER]** Set `DATABASE_URL` in **PM2 env** (no dotenv — `.env` files are not read),
   `npm run build`, `pm2 restart masquerade --update-env`.
5. **[SERVER]** `pm2 logs` → `serving on port …` with no DB throw = booted on Postgres.
6. **The defining check — [BROWSER]+[SERVER]:** run a full job (upload → mask → apply →
   AI → download), then `pm2 restart masquerade`, reload → **the job is still there.**
   Pre-5C-2 it vanished; surviving restart is the durability win and the pass criterion.

---

## 5. Rollback (data-free)

Revert the one edit (`new PgStorage()` → `new MemStorage()`, drop the import), `npm run
build`, `pm2 restart`. The app returns to its pre-5C-2, no-DB-dependency runtime; there
is no backfill to reverse and the RDS tables can simply be abandoned. `MemStorage` was
kept in the tree precisely to make this a one-edit revert.

---

## 6. Constraints honored

- `tsc` stays **17**.
- Storage logic + schema **frozen** (5C-1); this phase is flip + provisioning only.
- **No** frontend change; **no** scope creep into 5D (loading-hang) or Phase 6.
- Secrets from env only; `DATABASE_URL` set in PM2 env on the server, never committed.
- Production RDS is a **new** instance (encryption ON), provisioned by the operator; SG
  scoped to the app EC2 (`3.136.48.97`) on 5432.

**Conformance results vs. RDS:** _n/a to re-run for 5C-2 — the storage layer is
unchanged from 5C-1's green run (MemStorage 35/35, PgStorage 35/35, 168 assertions,
ALL SUITES PASSED vs real Aurora). The 5C-2 pass criterion is the restart-durability
smoke test above, recorded here after the operator's green run._
