# Phase 5C-1 Proposal — Postgres Foundation (no cutover)

**To:** Andre
**From:** Claude Code
**Type:** Implementation proposal (proposal-only; no migrations/impl code written yet)
**Scope:** Stand up Postgres, design the persisted schema, plan a fully-implemented-and-tested `PgStorage` against `IStorage` — **with the live app still entirely on MemStorage.** Nothing reads from Postgres at the end of 5C-1.

This document presents **Decision A** (data model) and **Decision B** (where Postgres lives) for your call. I recommend, with reasoning, but do **not** pick. No schema is provisioned and no migration/implementation code is written until your amendment lands.

---

## 1. Storage-surface inventory (read against current source)

Read from `server/storage.ts`, `server/pgStorage.ts`, `server/db.ts`, `shared/schema.ts`, `drizzle.config.ts`, and the live call sites in `server/routes.ts`. **Not** trusting the kickoff summary.

### 1.1 `IStorage` — 21 methods, 8 groups (`storage.ts:38–77`)

| Group | Methods | Backing state |
|-------|---------|---------------|
| Video Jobs | `createVideoJob`, `getVideoJob`, `updateVideoJob` | `videoJobs` map |
| Frame Batches | `createFrameBatch`, `getFrameBatches`, `updateFrameBatch` | `frameBatches` map |
| Progress | `getProcessingProgress`, `updateProcessingProgress`, `deleteProcessingProgress` | `processingProgress` map |
| Job V2 (hub) | `createJobV2`, `getJobV2` | `jobsV2` map |
| PHI | `setPhiStatus` | `jobsV2` map |
| Template-mask spoke | `setTemplateMaskState`, `getTemplateMaskState` | `jobsV2[id].templateMask` |
| AI spoke | `addAiRun`, `updateAiRun`, `getAiRun`, `listAiRuns`, `deleteAiRun` | `jobsV2[id].ai.runs[]` |
| Deletion | `deleteVideoJob`, `deleteJobV2` | `videoJobs` + `processingProgress` / `jobsV2` |

### 1.2 `MemStorage` — 4 in-memory maps (`storage.ts:80–91`)

- `videoJobs: Map<string, VideoJob>` — legacy linear-pipeline record.
- `frameBatches: Map<string, FrameProcessingBatch>` — batch rows; each carries its own `jobId`.
- `processingProgress: Map<string, ProcessingProgress>` — **ephemeral** live progress, keyed by `jobId`.
- `jobsV2: Map<string, Job>` — hub-and-spoke record (the Phase 2/3 target shape).

### 1.3 How the records relate (the load-bearing facts for Decision A)

1. **`VideoJob` ↔ `Job` is a strict 1:1 keyed by the same UUID.** At every upload entry point the route mints the UUID via `createVideoJob` (which calls `randomUUID()`), then **eagerly** creates the Job V2 record with `id: job.id`:
   - video w/ immediate extraction — `routes.ts:162` → `routes.ts:167`
   - video deferred — `routes.ts:241` → `routes.ts:246`
   - image batch — `routes.ts:365` → `routes.ts:368`
   So there is no orphan case in the live path: every `VideoJob` has exactly one `Job` with the same id, created microseconds later in the same handler.

2. **Status is mirrored one-way, `VideoJob` → `Job`.** `updateVideoJob` (`storage.ts:119–140`) runs `mapVideoJobStatusToJobStatus` and, **only if a `jobsV2` record already exists**, copies the mapped status onto `Job.status` (Phase 4a hotfix). The map collapses 6 legacy statuses into the 3 V2 statuses (`extracting` / `ready` / `failed`). `Job.status` is never the source of truth; it is a derived mirror. *(This one-way mirror, plus the hub UI keying off `Job.status`, is the root-cause surface for the 5D loading-hang — out of scope here, noted for §6/CLAUDE.md.)*

3. **`frameBatches` → `videoJobs` is a child FK.** In Drizzle, `frame_processing_batches.job_id` already declares `.references(() => videoJobs.id)` (`schema.ts:34`). In Mem it is an unindexed `jobId` field filtered by scan (`storage.ts:156`).

4. **`processingProgress` is deliberately not persisted.** The existing `PgStorage` keeps it in a private in-memory `Map` with the comment *"Progress is ephemeral — no need to persist it in the database"* (`pgStorage.ts:19–24`, `94–123`). It is keyed by `jobId` but holds **no** FK and is freed on delete (`deleteVideoJob` folds in `deleteProcessingProgress`, the 5B change at `storage.ts:267–273`).

### 1.4 Type shapes (`shared/schema.ts`)

- **Drizzle-backed (have tables today):** `VideoJob` = `videoJobs.$inferSelect` (`schema.ts:6–30, 54`); `FrameProcessingBatch` = `frameProcessingBatches.$inferSelect` (`schema.ts:32–41, 56`). Insert types are `createInsertSchema(...).omit(...)`.
- **Plain TS interfaces (NO table yet):** `Job` (`schema.ts:181–196`), `JobSource`, `AttestationRecord`, `TemplateMaskState` (`199–205`), `LabelingState` (= `unknown`, reserved), `AIState`, `AIRun` (`225–236`), `AiLabel`, `MaskData`, `OutputSettings`, `ProcessingProgress` (`248–261`).
- `Job` is **deeply nested**: `source` (object), optional `templateMask` (object holding `MaskData` + `OutputSettings`), optional `labeling` (TBD), optional `ai` (`{ runs: AIRun[] }`), and each `AIRun` holds a `labels: AiLabel[]` array (metadata only — heavy PNGs live on disk under `spokes/ai/<jobId>/<runId>/`, never in the record).

### 1.5 The schema gap this phase must close

`shared/schema.ts:155–157` states it outright: *"Drizzle table definitions above are NOT updated here … Drizzle table changes will be reconciled in the Postgres migration (separate from this refactor)."* **5C-1 is that reconciliation.** Today Drizzle covers only `video_jobs` and `frame_processing_batches`; the **entire hub-and-spoke `Job` model has no persisted representation.** That is exactly why Decision A is the most consequential call in 5C — the schema we pick for `Job` is what 5C-2 will cut over onto.

### 1.6 `PgStorage` current state (`pgStorage.ts`)

- **Real (Drizzle) today:** `createVideoJob`, `getVideoJob`, `updateVideoJob`, `createFrameBatch`, `getFrameBatches`, `updateFrameBatch` — all via `db` against the two existing tables.
- **In-memory today:** the 3 progress methods (mirrors Mem, by design).
- **Throw-stubs (12):** `createJobV2`, `getJobV2`, `setPhiStatus`, `setTemplateMaskState`, `getTemplateMaskState`, `addAiRun`, `updateAiRun`, `getAiRun`, `listAiRuns`, `deleteAiRun`, `deleteVideoJob`, `deleteJobV2` — each `throw new Error('… not implemented — use MemStorage')`. 5B added the now-real `deleteProcessingProgress` (so the file is no longer pristine). **Full implementation = turning these 12 stubs into real persistence** (plus folding progress-cleanup into the real `deleteVideoJob`).

### 1.7 Isolation today (backs §8's guarantee)

`storage.ts:280–284`: `export const storage = new MemStorage();` is the **only** storage instance. A source grep confirms **nothing** under `server/` imports or constructs `PgStorage` or imports `./pgStorage` / `./db` on any live path. Because `./db` throws if `DATABASE_URL` is unset and is never imported by the live tree, no Neon client is ever initialized. This is the property 5C-1 must preserve.

---

## 2. Decision Point A — data model **(DO NOT pick; for your decision)**

**The question:** how do we persist the `VideoJob` (legacy) + `Job` (jobsV2) dual record? Both share one UUID and are written together today, but the frontend still reads legacy `VideoJob` shapes, and 5C-2 wants to cut over to `Job` cleanly.

### Option A1 — Persist both as-is (two tables, 1:1 by id)

Keep `video_jobs` (exists) and add a `jobs` table (+ child tables / jsonb for spokes). `PgStorage` mirrors at write-time exactly as MemStorage does today.

- **Costs now:** lowest-risk, smallest delta from current runtime; `PgStorage` mirrors a behavior that already works. Two sources of truth persisted; the one-way status mirror becomes a persisted write-amplification (two rows per status change).
- **Sets up 5C-2:** cutover is a faithful port of today's Mem behavior — least surprising. But it **persists the transitional dual-record mess into the database**, which is exactly the kickoff's stated fear. Retiring `video_jobs` later becomes its own migration.
- **Frontend (still legacy):** zero pressure — `video_jobs` stays readable verbatim.

### Option A2 — Collapse into one persisted `Job` model

One `jobs` table is the source of truth. `VideoJob` is no longer persisted as a distinct row; the legacy fields the frontend needs are derived.

- **Costs now:** highest design effort — must prove every field the frontend/legacy routes read off `VideoJob` is derivable from `Job` (+ `source`). `Job` lacks several `VideoJob` columns today (`progress`, `maskData`, `outputSettings`, `outputZipPath`, `fileList`, `aiLabels`, `jobType`, `fileCount`, `errorMessage` semantics differ). Some of these have spoke-shaped homes in `Job`; some don't yet.
- **Sets up 5C-2:** cleanest possible target — no dual record baked in. But it forces the legacy/transitional reconciliation **now**, during a foundation phase whose whole point was to avoid touching the cutover.
- **Frontend (still legacy):** highest pressure — either the read routes start deriving `VideoJob` shapes, or we need A3's shim. Risks bleeding into 5C-2/frontend scope.

### Option A3 — Collapse with a `VideoJob` compatibility view/shim **(recommended)**

One `jobs` table is the source of truth (as A2), but the legacy `VideoJob` shape is served through a **compatibility layer** rather than a real table:
- either a **Postgres view** `video_jobs_compat` projecting `jobs` → the `VideoJob` columns, or
- a **storage-layer shim**: `PgStorage.getVideoJob/updateVideoJob` read/write `jobs` and map to/from the `VideoJob` type in code.

- **Costs now:** medium. Need the field-mapping (same analysis as A2) but expressed once in a view/shim, not smeared across routes. The shim is the natural home for the status mirror (one write, derive the legacy view).
- **Sets up 5C-2:** strong — DB has a single source of truth (clean target), while the still-legacy frontend keeps reading a `VideoJob` shape unchanged. When the frontend migrates (5D-ish), the shim is deleted with no schema change. Decouples "clean schema" from "frontend migration."
- **Frontend (still legacy):** zero pressure — sees `VideoJob` via the compat layer.

### Option A4 — Other (hybrid relational)

One `jobs` table + **`ai_runs` as a real child table** (rather than jsonb), template-mask/labeling as jsonb columns on `jobs`. Optional, orthogonal to A1–A3 (can combine with A3).

- **Costs now:** more tables/migrations; but `ai_runs` is the one genuinely list-shaped, separately-mutated spoke (`addAiRun`/`updateAiRun`/`deleteAiRun` operate per-run). A child table makes those operations indexed single-row writes instead of jsonb-array rewrites.
- **Sets up 5C-2:** best query/indexing story for AI runs; matches how the AI spoke is mutated. More moving parts to cut over.

### Recommendation

**A3 (collapse + `VideoJob` compatibility shim), combined with A4's `ai_runs` child table.** Reasoning:
- It gives 5C-2 the **clean single-source-of-truth target** the kickoff wants, without baking the dual record into the DB permanently (A1's downside).
- It **does not** force the frontend migration now (A2's downside) — the legacy shape is served by a shim that is deleted later with zero schema churn.
- A4's `ai_runs` child table matches the only spoke that is mutated per-element; everything else (single-object spokes: `templateMask`, `labeling`, `source`, attestation) is fine as jsonb on `jobs`.
- Concretely I'd implement the shim **in the storage layer** (not a SQL view) so the mapping lives next to `PgStorage` where the conformance tests already exercise it, and so it is driver-portable across Decision B.

I lean A3+A4, but **A1 is the legitimately safer call if you want 5C-1 to be a pure faithful port** and prefer to fight the dual-record collapse during 5C-2 with live data in hand. **Your decision.**

---

## 3. Decision Point B — where Postgres lives **(DO NOT pick; for your decision)**

The current `db.ts` uses `@neondatabase/serverless` + `drizzle-orm/neon-http` (`db.ts:1–14`) — i.e. the code is wired for **Neon** today. That is a real constraint on B: a standard RDS/EC2 Postgres speaks the wire protocol, not Neon's HTTP, so **Decision B carries a driver consequence** (see §5).

| Option | Cost | Ops burden | Backup/snapshot | Failure isolation | HIPAA-readiness (PHI later) | Driver impact |
|--------|------|-----------|-----------------|-------------------|----------------------------|---------------|
| **B1 — RDS (managed)** | $ (instance + storage, always-on) | Low (AWS manages patching/backups) | Automated snapshots + PITR out of the box | **Strong** — independent of the app EC2; app instance death ≠ DB death | **Strong** — encryption-at-rest, audit logging, BAA-eligible | Needs `pg` + `drizzle-orm/node-postgres` (swap from neon-http) |
| **B2 — Postgres on the existing app EC2** | ¢ (no new instance) | High (you patch, you back up) | DIY (cron `pg_dump` / EBS snapshots) | **Weak** — DB dies with the instance; one blast radius | Weak — you build encryption/audit yourself | Same `pg` driver swap |
| **B3 — Keep Neon (managed serverless)** | $ (usage-based; has free tier) | Low | Managed branching/PITR | Strong — fully external | Neon offers a HIPAA/BAA tier (verify plan); confirm before PHI | **Zero** — current `neon-http` driver already matches |
| **B4 — Other** (e.g. Aurora Postgres, containerized PG on ECS) | varies | varies | varies | varies | varies | varies |

### Recommendation

**B1 (RDS)** for the destination this is heading toward, because the kickoff explicitly flags PHI landing later and RDS gives encryption-at-rest, audit, automated backups, and failure isolation from the app instance with the least ops burden — the things that matter when PHI arrives. The one cost is the **driver swap** (neon-http → node-postgres), which is cheap and best done now while nothing live depends on it.

**However** — if you want 5C-1 to provision **nothing new** and validate the foundation against the driver already in the code, **B3 (Neon)** is the zero-friction path: the harness can point at a throwaway Neon branch with no driver change. Neon is a reasonable 5C-1 *test target* even if RDS is the eventual *production* home; the conformance suite is driver-agnostic at the `IStorage` level.

I lean **B1 for production, B3 acceptable as the 5C-1 test target if you'd rather not stand up RDS yet.** **Your decision** — and it determines the driver in §5 and the provisioning runbook.

---

## 4. Proposed schema (for recommended A3+A4; note on alternatives)

Conditional on Decision A. Presented for **A3+A4**; the note after shows the delta under A1.

### `jobs` (source of truth — replaces `Job`)
| Column | Type | Notes |
|--------|------|-------|
| `id` | `varchar` PK, default `gen_random_uuid()` | same UUID as today |
| `filename` | `text not null` | |
| `uploaded_at` | `text not null` | ISO 8601 (matches current string convention) |
| `phi_status` | `text not null default 'raw'` | `raw` \| `user_attested` |
| `attestation_record` | `jsonb` | nullable `AttestationRecord` |
| `source` | `jsonb not null` | `JobSource` |
| `extraction_rate` | `real not null` | locked at upload |
| `status` | `text not null default 'extracting'` | `extracting` \| `ready` \| `failed` |
| `error_message` | `text` | |
| `template_mask` | `jsonb` | nullable `TemplateMaskState` (single object) |
| `labeling` | `jsonb` | nullable, reserved (`LabelingState` TBD) |

Index: PK on `id`. (Status/phi indexes deferrable until query patterns exist — not needed for the per-id access the app uses.)

### `ai_runs` (child of `jobs`, per-run mutation — A4)
| Column | Type | Notes |
|--------|------|-------|
| `id` | `varchar` PK | `AIRun.id` |
| `job_id` | `varchar not null references jobs(id) on delete cascade` | |
| `name`, `target`, `output_dir` | `text` | |
| `input_source` | `text` | `extracted` \| `template_mask` \| `raw` |
| `modality` | `text` (nullable) | |
| `bbox` | `jsonb` (nullable) | |
| `labels` | `jsonb not null default '[]'` | `AiLabel[]` — metadata only; PNGs stay on disk |
| `approved` | `boolean not null default false` | |
| `created_at` | `text not null` | |

Index: PK on `id`; index on `job_id` (drives `listAiRuns`). `on delete cascade` makes `deleteJobV2` a single statement.

### `video_jobs` — **not a new table**
Under A3 it becomes the **compat shim**: `PgStorage.getVideoJob/updateVideoJob` map `jobs` (+ derived legacy fields) to/from the `VideoJob` type. No `video_jobs` table is created; the existing Drizzle table def is retired from the persisted set once the shim is proven. *(If you choose A1 instead, `video_jobs` stays a real table exactly as `schema.ts:6–30` defines it, and `jobs` is added alongside — two real tables, write-mirrored.)*

### `frame_processing_batches` — unchanged
Keep as-is (`schema.ts:32–41`), re-pointing its FK from `video_jobs.id` to `jobs.id` under A3 (one-line ref change), or leaving it on `video_jobs.id` under A1.

### `processing_progress` — **no table**
Stays ephemeral/in-memory in `PgStorage` (preserves current `pgStorage.ts:19–24` design). No persistence, no FK.

**Delta under A1:** `video_jobs` remains a real table verbatim; `jobs` added as above; `ai_runs` still recommended; `frame_processing_batches` FK stays on `video_jobs.id`; `PgStorage` write-mirrors `VideoJob`↔`Job` instead of shimming. Schema is *additive only* (no collapse), at the cost of persisting the dual record.

---

## 5. Migration tooling

**Confirmed: Drizzle is already the stack.** `drizzle-orm ^0.39.1`, `drizzle-kit ^0.30.4`, `drizzle-zod ^0.7.0` (`package.json:57–58, 111`); `drizzle.config.ts` (`out: ./migrations`, `dialect: postgresql`, `schema: ./shared/schema.ts`); a `db:push` script exists. **No second tool will be introduced.** There is **no `migrations/` directory yet** (confirmed by glob) — 5C-1 creates the first.

**Versioning/applying — recommendation (this is mine to propose, not part of A/B):**
- Use **`drizzle-kit generate`** (emits versioned SQL migration files under `./migrations`) **+ `drizzle-kit migrate`** to apply — **not** the existing `db:push` shortcut. `push` diff-applies with no files and no down-path; the kickoff (§2.7) wants **versioned, reversible** migrations, which `generate` gives as on-disk SQL that 5C-2 can review/roll back. I'd add `db:generate` and `db:migrate` scripts alongside the existing `db:push`.
- **Reversibility:** standing up a fresh schema is inherently low-risk (no data to lose). For 5C-2, where real dual-writes begin, each migration gets a reviewed down-path. On a fresh DB the rollback is "drop the new tables," captured in the runbook.
- **Driver (depends on Decision B):** if **B1/B2** (RDS/EC2 standard Postgres), `db.ts` swaps `@neondatabase/serverless` + `neon-http` → `pg` + `drizzle-orm/node-postgres` (add `pg`, `@types/pg`). If **B3** (Neon), **no driver change**. `drizzle-kit` itself is driver-agnostic for migration generation. I will flag the exact dependency delta in the amendment once B is chosen — **not** changing `db.ts` now.

---

## 6. `PgStorage` implementation plan

Goal: turn the 12 throw-stubs into real persistence while the file stays **type-clean so `tsc` holds at exactly 17** (a fully-implemented `PgStorage` is type-checked even though never loaded — same constraint that forced 5B's `deleteProcessingProgress` addition to keep 17).

Work items (post-green-light, conditional on A):
1. **New Drizzle table defs** in `shared/schema.ts` for `jobs` (+ `ai_runs` under A4), with `$inferSelect`/insert types. Under A3 these must produce types that the storage shim maps cleanly to `Job` / `VideoJob` so no `TS2420` reappears.
2. **Implement Job V2 + spokes** in `PgStorage`: `createJobV2`, `getJobV2`, `setPhiStatus`, `setTemplateMaskState`, `getTemplateMaskState`, `addAiRun`, `updateAiRun`, `getAiRun`, `listAiRuns`, `deleteAiRun`, `deleteJobV2` against the new tables (jsonb round-trips for single-object spokes; `ai_runs` rows for the AI spoke under A4).
3. **`deleteVideoJob`** (real) — fold `deleteProcessingProgress` in (mirror the Mem semantics from `storage.ts:267–273`) and, under A3, delete the underlying `jobs` row; `ai_runs` cascades.
4. **Compat shim (A3 only):** `getVideoJob`/`updateVideoJob`/`createVideoJob` map `jobs` ↔ `VideoJob`, including the one-way status mirror that `MemStorage.updateVideoJob` performs (`storage.ts:128–137`).
5. **No live wiring.** `storage.ts:284` stays `new MemStorage()`; `PgStorage` is constructed **only** by the test harness. `./db`/driver init happens only when the harness sets the test connection string.

`tsc` gate is checked after each step; target stays 17 (10 `frameExtractor.ts` + 7 `maskWorker.ts`), `frameExtractor.ts`/`maskWorker.ts` untouched.

---

## 7. Isolation test plan (zero production impact)

This is the crux of "Option-3-first is safe": correctness is proven **without any cutover** because the live process never constructs `PgStorage` and never reads the test DB.

**Harness design — `IStorage` conformance suite:**
- A single suite of behavioral assertions written against the **`IStorage` interface**, run twice: once against a fresh `MemStorage`, once against `PgStorage` pointed at a **throwaway** Postgres (a disposable schema/DB, or a Neon branch under B3). Both must produce **identical observable results** — this is the strongest possible 5C-2 cutover-confidence signal (Mem and PG provably agree, which is exactly what 5C-2's dual-write verify step will assert at runtime).
- Coverage: **every one of the 21 `IStorage` methods**, including round-trips (create→get returns equal), the dual-record 1:1 (`createVideoJob`+`createJobV2` same id), the status mirror (`updateVideoJob('ready')` ⇒ `getJobV2().status === 'ready'`), per-run AI ops (`addAiRun`→`listAiRuns`→`updateAiRun`→`getAiRun`→`deleteAiRun`), spoke set/get, and cascade-on-delete.

**Zero-production-impact guarantees:**
1. Test uses a separate **`TEST_DATABASE_URL`** (proposed new env var, test-only) so the harness can never touch whatever DB the app might later use.
2. `storage.ts` is **not modified** to select `PgStorage`; the harness imports `PgStorage` directly. The live `storage` export remains `MemStorage`.
3. The throwaway DB is created and dropped by the harness (or is an ephemeral Neon branch), so no shared/persistent state.
4. Runs in the agent env only as far as the agent env allows (no GPU needed; this is pure storage I/O). The **real** pass/fail is run by you on the server/AWS per §6 of the kickoff; the report will give exact commands.

---

## 8. What stays untouched (explicit confirmation)

At the end of 5C-1, verified against source:
- **MemStorage remains the live, authoritative store.** `storage.ts:284` stays `export const storage = new MemStorage();`. No route/handler/service switches to `PgStorage` (confirmed: zero `server/` imports of `pgStorage`/`db` on any live path).
- **`PgStorage` is wired to nothing live.** Constructed only by the conformance harness. `./db`/Neon (or `pg`) client initializes only under the test connection string.
- **No read/write path changes.** The app's behavior is byte-for-byte unchanged for users; a full smoke (upload → mask → apply → AI → download) runs exactly as today, on Mem.
- **`tsc` stays 17.** A fully-implemented, type-clean `PgStorage`; `frameExtractor.ts`/`maskWorker.ts` untouched.
- **No frontend changes.** The legacy `VideoJob` read shape is preserved (verbatim under A1; via the compat shim under A3).
- **No scope creep** into Phase 6 (manifest unification), 5D (loading-hang), or the backlog.
- **Secrets from env only.** New env vars flagged for you to set: `DATABASE_URL` (already referenced by `db.ts`/`drizzle.config.ts`) for the app-instance connectivity check, and **`TEST_DATABASE_URL`** (test-only) for the harness. Nothing committed to the repo.

---

## 9. What I need from you (the loop)

1. **Decision A** — A1 / A2 / **A3 (rec, +A4)** / other.
2. **Decision B** — **B1 RDS (rec for prod)** / B2 EC2 / **B3 Neon (acceptable 5C-1 test target)** / other.
3. Any constraint on the migration-tooling sub-recommendation (`generate`+`migrate` over `push`).

On your amendment + green-light I will: write the migrations, fully implement `PgStorage`, supply the Postgres provisioning **runbook** (you execute — it touches AWS/secrets you control), build the conformance harness, then deliver `PHASE_5C1_REPORT.md` **and** the §5 CLAUDE.md update (Phase 5D note + 5C-1 status) **with the diff shown before any commit**.

*Note: Phase 5B Deploy 1 is implemented but **not yet committed** (report + CLAUDE.md backlog written last session, awaiting your commit go-ahead). It does not block this proposal, but it is still uncommitted in the working tree.*
