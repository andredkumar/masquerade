# Phase 5C-2 Proposal — Direct Cutover to Postgres

**Decision:** Option B — direct flip. No dual-write, no backfill, no reconciliation.
MemStorage is ephemeral today (wiped on every restart), so there is no persistent
data to protect. PgStorage is already proven **35/35 vs real Aurora** (5C-1). This
phase is the flip + production provisioning only; the storage logic and schema are
frozen.

The five confirmations the kickoff asked for, tight:

---

## 1. The exact flip

The single behavioral change is in `server/storage.ts`, at the bottom of the file
(**line 287** today — the kickoff said `284`; it is the `export const storage = …`
line):

```ts
export const storage = new MemStorage();   // → new PgStorage();
```

It is **not literally one line**, because today the file deliberately does *not*
import `PgStorage` (a comment there explains the omission was to keep `./db` from
loading). The flip therefore touches `server/storage.ts` only, in three spots:

1. Add `import { PgStorage } from './pgStorage';` near the top.
2. Change the export to `export const storage = new PgStorage();`.
3. Rewrite the now-inverted comment (it currently explains why PgStorage is *absent*).

`MemStorage` the class **stays** in the file untouched — it is the rollback target.

**`PgStorage`'s constructor connects nothing lazily-or-otherwise itself.** It only
does `this.processingProgress = new Map()` (`pgStorage.ts:59`). The database
connection is established by the **module import** `import { db } from './db'` at
`pgStorage.ts:3`: loading `db.ts` constructs the `pg` Pool and (critically) throws
synchronously if `DATABASE_URL` is unset. So wiring the connection = importing the
module, which the flip does. No connection init is added anywhere else, and no env
wiring changes in code (env is set on the server — see §2/§5).

**Nothing else instantiates the store.** Every live consumer imports the *singleton*
`storage`, not the class:

- `server/routes.ts:5` — `import { storage } from "./storage"`
- `server/services/videoProcessor.ts:1` — `import { storage } from '../storage'`
- `server/handlers/templateMaskApply.ts:14` — `import { storage } from '../storage'`

The only code that constructs the classes directly is `scripts/conformance-storage.ts`
(the 5C-1 harness — not the app). A source grep for `new MemStorage(`/`new PgStorage(`
confirms no other live construction.

> **Circular-import note (verified safe).** After the flip, `storage.ts` imports
> `pgStorage.ts`, which already imports `mapVideoJobStatusToJobStatus` back from
> `storage.ts` — a cycle. It is safe because that symbol is a **hoisted `export
> function`** (`storage.ts:22`), so its binding exists during circular evaluation,
> and it is only *called* inside `PgStorage` methods at request time, never during
> module load. `PgStorage`'s constructor needs nothing from `storage.ts`. `tsc`
> stays 17 (verified).

> **Out of scope — stale artifact.** `deployment-package/server/storage.ts:112` is a
> git-tracked *snapshot* of an older build (it still contains `FileUpload.tsx`,
> deleted back in 4d-2). It is **not** the live source tree and is **not** touched.
> If `deployment-package/` is what actually ships to EC2, that is a separate,
> pre-existing packaging problem to raise — flag it, do not fold it into 5C-2.

---

## 2. Boot behavior (exact sequence against Postgres)

Boot is a synchronous import chain before the server ever listens:

```
server/index.ts
  → import { registerRoutes } from "./routes"      (index.ts:2)
    → import { storage } from "./storage"           (routes.ts:5)
      → import { PgStorage } from "./pgStorage"      (NEW, after flip)
        → import { db } from "./db"                  (pgStorage.ts:3)
          → db.ts: if (!process.env.DATABASE_URL) throw …   (db.ts:12)
          → db.ts: new Pool({ connectionString, ssl: resolveSsl(...) })
```

Two failure shapes, both loud, neither silent:

- **`DATABASE_URL` unset / malformed-empty** → `db.ts` **throws at import**, before
  `server.listen`. The process exits non-zero; under PM2 this is a **crash-loop**
  you see immediately in `pm2 logs`. This is the loud boot failure the kickoff wants
  for the misconfig case.
- **`DATABASE_URL` set but the DB is unreachable / wrong credentials / SSL refused**
  → the raw `pg` Pool is **lazy** (it does not dial on construction), so absent a probe
  the process would *boot and listen*, then throw a loud `500` on the **first** storage
  call. **This gap is now closed at boot** by the eager `SELECT 1` probe (below), so an
  unreachable RDS is a boot-time crash-loop too, not a first-request surprise.

  > **Decision point — RESOLVED (probe ADDED).** Andre approved the eager probe. It is
  > now in `server/index.ts`'s startup IIFE: `await db.execute(sql\`SELECT 1\`)` **before**
  > `server.listen`, so an unreachable/misconfigured RDS fails at **boot**
  > (`process.exit(1)` → PM2 crash-loop). It is gated on `storage.constructor.name ===
  > 'PgStorage'` and **dynamically** imports `./db` only on that path (no static `./db`
  > import in `index.ts`), so a `storage.ts`-only rollback to MemStorage self-disables the
  > probe and the app still boots with **no `DATABASE_URL`** requirement — rollback stays a
  > one-edit change. Assumes the esbuild step does not minify class names (it does not).

---

## 3. The migration on prod

The `0000_hard_cable` baseline (3 tables — `jobs` 28-col, `ai_runs`,
`frame_processing_batches`) must be applied to the **production** RDS *before* the
app points at it. `npm run db:migrate` (= `drizzle-kit migrate`) reads
`drizzle.config.ts`, which uses `DATABASE_URL` + the **same `resolveSsl`** shared
resolver proven in 5C-1 (SSL auto-enables for any `rds.amazonaws.com` host — the
`sslmode=no-verify` / `rejectUnauthorized:false` path). Migrations are recorded in
`__drizzle_migrations`, so re-runs are idempotent.

**Where it runs matters this time.** The prod RDS security group allows only the
**app EC2 (`3.136.48.97`)** on 5432 — *not* your laptop. So unlike 5C-1 (laptop →
disposable DB with a temporary ingress rule), `db:migrate` for prod runs **on the
app EC2 server** (`SERVER` step in the runbook). That host needs devDependencies
installed (`drizzle-kit` is a devDependency), i.e. a full `npm install`, not
`--omit=dev`.

---

## 4. Rollback

Clean and data-free, because there is nothing to un-migrate:

1. Revert `server/storage.ts` to `export const storage = new MemStorage();` (git
   revert of this commit, or hand-edit the one line + drop the import).
2. `npm run build` and redeploy / `pm2 restart`.
3. The app is back to its **pre-5C-2, no-DB-dependency** state — MemStorage boots
   with no `DATABASE_URL` requirement. The prod RDS instance can be left running
   (idle, harmless) or torn down separately; nothing in the reverted app reads it.

No backfill to reverse, no schema to roll back (the RDS tables can simply be
abandoned). `MemStorage` the class is retained precisely so this path is a one-line
revert + rebuild.

---

## 5. What a running app on Postgres looks like vs. today

**User-visible: nothing changes — except the point of the whole phase.** Same API,
same routes, same frontend, same job lifecycle. The one difference: **jobs now
survive a process restart.** Today a `pm2 restart` wipes every in-memory job; after
5C-2 the job rows live in RDS and are still there after restart. That durability is
the entire deliverable and the single smoke test that defines success (kickoff §5).

Operationally, two things change on the server (not in code):

- The app now **requires `DATABASE_URL`** in its environment to boot at all.
- Because there is **no `dotenv`** in this project (verified — not a dependency, not
  imported), the running app reads **real process env vars only**. A `.env` file is
  **not** auto-loaded. `DATABASE_URL` must be set in PM2's actual environment — via
  the ecosystem `env` block, or exported before `pm2 start`, or
  `pm2 restart masquerade --update-env` after exporting it. The runbook uses the
  ecosystem/`--update-env` path and calls this out explicitly.

---

## Deliverables that follow this proposal

- The code flip (`server/storage.ts`, per §1), plus the eager `SELECT 1` boot probe in
  `server/index.ts` (the §2 decision point, approved and added — rollback-safe by gating).
- `PHASE_5C2_RDS_RUNBOOK.md` — operator-executed, `LOCAL/SERVER/AWS/BROWSER`-labelled:
  provision prod RDS (encryption ON, SG → app EC2:5432), apply `0000`, set
  `DATABASE_URL` in PM2 env, deploy the flip, verify boot, smoke test centered on
  **create job → `pm2 restart` → job survives**, and a tested rollback.
- `PHASE_5C2_REPORT.md` — files touched (~1), `tsc`=17, server verification steps.
- `CLAUDE.md` update — mark 5C-2, app now on Postgres, MemStorage retained as
  rollback target.

**Constraints honored:** `tsc` stays 17; storage logic/schema frozen; no frontend
changes; no scope creep into 5D or Phase 6; secrets from env only.
