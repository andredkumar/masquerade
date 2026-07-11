# Phase 5C-1 Report — PgStorage foundation (Option **A3**, no cutover)

**Implemented against:** the 5C-1 correction directive (build true **A3**, not A1).
The first 5C-1 pass shipped A1's *substance* under an "Option A" label — the legacy
`VideoJob` was persisted **whole** in a `video_job` jsonb blob alongside clean Job
columns, gated by a `has_job_v2` boolean (two records, the same fact stored twice). The
decided shape is **A3**: **one `jobs` row per id as the single source of truth**, every
fact in exactly one column, with the legacy `VideoJob` shape **derived** in the PgStorage
shim. No blob. No `has_job_v2`. No field stored in two places in the same row.

This phase makes the storage layer *swappable and proven*, not *swapped*. `MemStorage`
remains the only runtime backend (`server/storage.ts` still ends
`export const storage = new MemStorage()`); `PgStorage` is wired to nothing live. `tsc`
held at the **17** baseline (10 `frameExtractor.ts` + 7 `maskWorker.ts`) after every step.

No client file was touched. No production data path changed. **The oracle
(`MemStorage` in `server/storage.ts`) was not modified** — it remains the contract the
harness checks `PgStorage` against.

> **Scope guard:** 5C-1 = foundation validation (schema, migrations, full PgStorage,
> conformance harness, RDS runbook). The production cutover (app reads Postgres,
> dual-write/backfill, flip `storage.ts`) is **5C-2** — out of scope here.

---

## Summary

| Item | What landed | Reversible? |
|------|-------------|-------------|
| Driver swap + gated SSL | `server/db.ts` neon-http → `pg` Pool + `drizzle-orm/node-postgres`; `pg` + `@types/pg` added. SSL gated on (host contains `rds.amazonaws.com` ∨ explicit `sslmode`) via one shared `server/dbSsl.ts`, imported by **both** `db.ts` (harness) and `drizzle.config.ts` (`db:migrate`), so RDS works on every path and local stays SSL-off. | Yes |
| Schema (**A3**) | **One** `jobs` row per id; every fact in exactly one column. Shared facts in one shared column read by both derivations; **two** status columns (`video_status`, `job_status`) — the only place two columns model two genuine facts — that double as facet-existence markers; VideoJob-only and Job-only facts each in their own nullable column. `ai_runs` real child (FK→`jobs.id` cascade); `frame_processing_batches` FK→`jobs.id`. **No** `video_job` blob, **no** `has_job_v2`, **no** standalone `video_jobs` table. | Yes |
| `VideoJob` type | The retired `video_jobs` table backed `VideoJob` via `$inferSelect`. With the table gone, `VideoJob` + `insertVideoJobSchema` are **hand-authored** in `shared/schema.ts`, reproducing the exact field types so no consumer's types shift. | Yes |
| Migrations | Versioned baseline `0000_hard_cable.sql` (forward-only, 3 tables) + hand-authored down-path; `db:generate` / `db:migrate` scripts | Yes |
| PgStorage (**derivation shim**) | All **21** `IStorage` methods assemble/disassemble the `VideoJob` and `Job` shapes from `jobs` columns. No record is stored twice; facet presence is read from the status columns. | Yes |
| Conformance harness | `scripts/conformance-storage.ts`: 35 cases / 84 assertions over all 21 methods; `MemStorage` oracle vs `PgStorage`; runs PG only when `TEST_DATABASE_URL` set | n/a (test) |
| RDS runbook | `PHASE_5C1_RDS_RUNBOOK.md` — operator (Andre) executes; agent provisioned nothing | n/a (doc) |
| `CLAUDE.md` | 5C-1 status block (true A3) + retained 5D loading-hang root-cause note | Yes |

---

## Gate A — VideoJob field disposition (every column resolved)

A3 requires each `VideoJob` fact to map to **exactly one** place. The gate dispositions
all 21 columns as **Direct** (own column on `jobs`), **Derived** (computed on read, no
column), or **Unused** (no live producer/consumer → synthesized). No column was left
**Open** (the one Open the correction flagged — `fileCount` — was resolved by
verification, below).

| # | VideoJob field | Disposition | `jobs` column / derivation |
|---|----------------|-------------|----------------------------|
| 1 | `id` | Direct (shared) | `id` (PK) |
| 2 | `filename` | Direct (**shared**) | `filename` |
| 3 | `filePath` | Direct (VideoJob-only) | `file_path` |
| 4 | `originalSize` | Direct (VideoJob-only) | `original_size` |
| 5 | `duration` | Direct (**shared**) | `duration` |
| 6 | `width` | Direct (**shared**) | `width` |
| 7 | `height` | Direct (**shared**) | `height` |
| 8 | `frameRate` | Direct (**shared**) | `frame_rate` |
| 9 | `totalFrames` | Direct (**shared**) | `total_frames` |
| 10 | `status` | Direct (**two-column**) | `video_status` (legacy 6-value lifecycle) |
| 11 | `progress` | Direct (VideoJob-only) | `progress` |
| 12 | `maskData` | Direct (VideoJob-only) | `mask_data` (jsonb) |
| 13 | `outputSettings` | Direct (VideoJob-only) | `output_settings` (jsonb) |
| 14 | `createdAt` | Direct (VideoJob-only) | `created_at` |
| 15 | `completedAt` | Direct (VideoJob-only) | `completed_at` |
| 16 | `errorMessage` | Direct (**shared**) | `error_message` |
| 17 | `outputZipPath` | **Unused → null** | no column; synthesized `null` on read |
| 18 | `jobType` | Direct (VideoJob-only) | `job_type` |
| 19 | `fileCount` | **Derived** | no column; `fileList?.length ?? 1` |
| 20 | `fileList` | Direct (VideoJob-only) | `file_list` (jsonb) |
| 21 | `aiLabels` | Direct (VideoJob-only) | `ai_labels` (jsonb) |

**Shared columns (every fact once).** `filename, duration, width, height, frame_rate,
total_frames, error_message` are genuinely **one** fact each: in the live 1:1 app the
VideoJob and Job facets that share an id always carry identical values for them. Verified
against the harness — across all 35 cases, no test ever diverges these on a coexisting id
(every dual-facet fixture sets them equal). They therefore occupy one column read by both
derivations; deleting one facet leaves them intact for the survivor.

**Two status columns — Option 1 (accepted).** `status` is the **one** fact that genuinely
diverges between facets: the `VideoJob.status` → `Job.status` mirror is lossy and
non-invertible (6 legacy values → 3 V2 values), and the harness asserts the two lifecycles
hold different values on the same id. So `video_status` and `job_status` are two columns
modeling two facts — and they double as existence markers
(`video_status IS NOT NULL` ⟺ VideoJob facet; `job_status IS NOT NULL` ⟺ Job facet),
replacing the blob/`has_job_v2` entirely.

**`fileCount` — verified before being denied a column.** Grep of the live tree
(`routes.ts:361,401` + `createVideoJob`) shows `fileCount` is **written but never read** —
every consumer reads `fileList.length` instead. With no live reader it earns no column; it
is derived `fileList?.length ?? 1`, matching MemStorage's value for every fixture.

**`outputZipPath` — Unused.** No live producer (only `createVideoJob`'s `?? null`) and no
live consumer. Synthesized as `null` on read.

**`source_type` (Job-only).** `Job.source.type` ('video' | 'image_batch') is a Job fact
that cannot be derived from the VideoJob-only `job_type`, because a Job facet can exist
**without** a VideoJob facet (harness "createJobV2 round-trips" is Job-only). It gets its
own `source_type` column; `Job.source` is assembled from the shared dims + `source_type`.

**`ai_initialized` (kept).** Distinguishes "never had ai" from "had ai, all runs deleted"
(present-but-empty `ai.runs`) — an empty child table alone cannot. Retained.

---

## Files touched

### 1. `server/db.ts` / `server/dbSsl.ts` / `drizzle.config.ts` — driver swap + gated SSL
`Pool` from `pg` + `drizzle(pool, { schema })` from `drizzle-orm/node-postgres`. Still
throws at boot if `DATABASE_URL` is unset — which is precisely why `storage.ts` never
imports `./db` (MemStorage path never loads it). node-postgres returns `.rowCount` on
writes; delete helpers use `(res.rowCount ?? 0) > 0`.

**`pg` CommonJS import fix (caught by the first real-RDS run).** The original driver
swap wrote `import { Pool } from 'pg'`. `pg` is CommonJS, and under this project's
ESM/tsx setup a *named value* import resolves to nothing at runtime —
`The requested module 'pg' does not provide an export named 'Pool'`. This never
surfaced in CI or agent runs because MemStorage-only conformance never loads `pg`; it
first appeared when the harness was pointed at real RDS (the PgStorage backend). Fixed
to the CommonJS-safe form `import pg from 'pg'; const { Pool } = pg;`. tsc still 17,
MemStorage still 35/35 — a storage/schema/A3 no-op; import statement only.

**SSL approach — one resolver, two connection paths (fixed after the first real-RDS
run).** RDS/Aurora rejects non-SSL connections and the `pg` driver does not infer SSL
from a `postgresql://…` URL, while a plain local Postgres speaks no TLS. The gating now
lives in a single shared module, `server/dbSsl.ts` → `resolveSsl(url)`, returning
`{ rejectUnauthorized: false }` when the host **contains `rds.amazonaws.com`** *or* the
URL carries an explicit `sslmode` (other than `disable`), and `undefined` otherwise.

> **Why this needed fixing — SSL gating didn't fire on the first real-RDS run.** The
> amendment put SSL only in `server/db.ts`. But there are **two independent connection
> paths**, constructed separately:
> - **harness** (`scripts/conformance-storage.ts`) imports `db` from `server/db.ts` —
>   *had* SSL;
> - **migrate** (`npm run db:migrate` → drizzle-kit → `drizzle.config.ts`) passed a bare
>   `url` with **no `ssl`** — so `db:migrate` went out unencrypted and Aurora rejected it
>   with `no pg_hba.conf entry … no encryption` (SQLSTATE `28000`).
>
> That mismatch also explains the confusing sequence (a migrate that appeared to
> "succeed," then a harness that couldn't find tables): the two paths were not
> connecting the same way. Fix: both `server/db.ts` and `drizzle.config.ts` now import
> the **same** `resolveSsl`, so every path — migrate and harness — makes the identical
> SSL decision against the identical DB. The host match was widened from
> `endsWith('.rds.amazonaws.com')` to `includes('rds.amazonaws.com')` so a standard
> Aurora endpoint with no special SSL parameter triggers it. Config only — credentials
> still come solely from the connection string in env; no secret in code. tsc stays 17,
> MemStorage 35/35.

> **5C-2 note (do not implement now):** `rejectUnauthorized: false` accepts RDS's
> certificate without CA verification — a deliberate disposable-test-DB choice. For
> the production / PHI data path, revisit to `rejectUnauthorized: true` with the RDS
> CA bundle.

### 2. `shared/schema.ts` — A3 single-source tables
- **`jobs`** (28 cols): `id` PK; **shared** (`filename, duration, width, height,
  frame_rate, total_frames, error_message`); **status markers** (`video_status`,
  `job_status`); **VideoJob-only** (`file_path, original_size, progress, mask_data,
  output_settings, created_at, completed_at, job_type, file_list, ai_labels`);
  **Job-only** (`uploaded_at, phi_status, attestation_record, source_type,
  extraction_rate, template_mask, labeling`, `ai_initialized` bool default false).
- **`ai_runs`** child: FK → `jobs.id` `ON DELETE cascade`.
- **`frame_processing_batches`**: FK → `jobs.id`.
- **`video_jobs` table removed.** `VideoJob` interface + `insertVideoJobSchema`
  `z.object` are now hand-authored, reproducing the exact `$inferSelect` /
  `createInsertSchema` field types.

### 3. `migrations/0000_hard_cable.sql` (+ `down/…down.sql`)
Regenerated by `drizzle-kit generate` (forward-only): creates **3** tables (`ai_runs`,
`frame_processing_batches`, `jobs` with 28 columns), then the two FK constraints — no
`video_jobs`, no `video_job` blob, no `has_job_v2`. The hand-authored down-path drops in
reverse dependency order (`frame_processing_batches` → `ai_runs` → `jobs`). The old A1
migration/snapshot/down files were removed and the journal reset to the single A3 entry.

### 4. `server/pgStorage.ts` — derivation shim (the core of A3)
All 21 `IStorage` methods persist to / read from the single `jobs` row, mirroring
`MemStorage` (the oracle):

- **Facet presence from status columns.** `getVideoJob` returns `undefined` when
  `video_status IS NULL`; `getJobV2` (and the Job-spoke methods) return `undefined` when
  `job_status IS NULL`. No blob, no `has_job_v2`.
- **Derivation on read.** `rowToVideoJob` synthesizes `outputZipPath: null` and
  `fileCount = Array.isArray(fileList) ? fileList.length : 1`; `rowToJob` assembles
  `source` from the shared dims + `source_type`.
- **Facet-preserving writes.** `createVideoJob` / `createJobV2` `onConflictDoUpdate` only
  their own facet's columns (+ shared), leaving the other facet's exclusive columns and
  status marker untouched.
- **Facet-independent deletes.** `deleteVideoJob`: if the Job facet survives
  (`job_status` set), it clears only the VideoJob-exclusive columns + `video_status`
  (shared columns stay for the survivor); otherwise it drops the row. `deleteJobV2`:
  deletes the job's `ai_runs`, then either clears the Job-exclusive columns +
  `job_status` + `ai_initialized` (VideoJob survives) or drops the row.
- **Status mirror — single source of truth.** `updateVideoJob` imports
  `mapVideoJobStatusToJobStatus` from `storage.ts` and writes `job_status` **only when
  the Job facet exists** (`job_status` already non-null) — reproducing MemStorage's rule
  rather than duplicating the mapping.
- **`ai_initialized` marker** + **`listAiRuns` `ORDER BY created_at`** (insertion order,
  matching the Mem array).

`PgStorage` is type-checked but never loaded at runtime.

### 5. `scripts/conformance-storage.ts` — IStorage conformance harness (unchanged)
Standalone `tsx` script (the project has no test framework). Its own assertion layer,
fixtures, and **35 cases** exercise all 21 methods: VideoJob round-trip, dual-record 1:1 +
independence, status mirror (incl. unmapped no-op and no-Job-facet no-op), PHI status,
template-mask spoke, AI lifecycle (incl. present-but-empty + seeded runs), frame batches,
progress, deletion + facet independence + cascade. Runs `MemStorage` always; runs
`PgStorage` only when `TEST_DATABASE_URL` is set (`TRUNCATE … CASCADE` between cases).

### 6. `docs/refactor/PHASE_5C1_RDS_RUNBOOK.md` — operator runbook (Andre executes)
Env vars, RDS provisioning, `db:migrate`, harness run, rollback via down-path. The agent
provisioned no AWS resources and holds no credentials. (Migration filename updated to
`0000_hard_cable`.)

### 7. `CLAUDE.md` — status + retained 5D note
5C-1 block rewritten for true A3; the 5D loading-hang root-cause subsection (status mirror
at `storage.ts:128–137`) is retained. Diff shown before any commit.

---

## tsc verification

```
$ npx tsc --noEmit | grep -c "error TS"
17
  10 server/services/frameExtractor.ts
   7 server/services/maskWorker.ts
```

Exactly the pre-existing baseline, re-confirmed after the A3 schema rewrite **and** the
PgStorage derivation-shim rewrite. No new error in `pgStorage.ts`, `db.ts`, `schema.ts`,
or `scripts/`.

---

## Conformance results

**MemStorage (oracle, untouched), no DB required:**

```
  MemStorage: 35/35 cases ran, PASS

84 assertions across 1 backend(s).
ALL SUITES PASSED
```

**PgStorage:** gated on RDS. The harness is PG-ready; with `TEST_DATABASE_URL` set against
a migrated disposable DB it runs the identical 35 cases against the A3 `PgStorage` shim and
asserts the two backends behave identically. This RDS run is the actual proof the A3
derivation holds, executed by Andre per `PHASE_5C1_RDS_RUNBOOK.md` §4.

> **Conformance results vs. RDS — GREEN (run against real Aurora PostgreSQL):**
>
> ```
>   MemStorage: 35/35 cases ran, PASS
>   PgStorage:  35/35 cases ran, PASS
>
> 168 assertions across 2 backend(s).
> ALL SUITES PASSED
> ```
>
> `PgStorage` matched the `MemStorage` oracle on every one of the 35 cases (168
> assertions across the two backends) against a real Aurora instance — the A3
> single-source derivation is proven behaviorally equivalent to the live in-memory
> store. **This is the proof 5C-1 rests on.**
>
> **SSL saga resolution.** Both the migrate path (`drizzle.config.ts`) and the harness
> path (`server/db.ts`) now connect through the shared `server/dbSsl.ts` resolver, so
> both reach Aurora with SSL (effectively `sslmode` no-verify — `rejectUnauthorized:
> false`, the disposable-test-DB posture). The remaining hurdles seen during the run —
> a doubled URL parameter and certificate-verification errors — were operator-side
> connection-string/config issues, now resolved. (5C-2 still tightens this to
> `rejectUnauthorized: true` + the RDS CA bundle before any real PHI path.)

---

## What is and isn't live

- `MemStorage` is still the runtime (`storage.ts` last line). The app's behavior is
  unchanged by 5C-1.
- `PgStorage` / `./db` are imported only by the harness (and type-checking), never by the
  running server. `db.ts`'s boot-throw therefore never fires in normal operation.
- No frontend change. No new runtime dependency in the request path.

---

## Rollback

- **Code:** `git revert` the deploy commit. The driver swap, A3 schema, PgStorage shim,
  harness, and doc edits are all mechanical reverts; nothing live depends on them.
- **Schema (test DB only):**
  `psql "$TEST_DATABASE_URL" -f migrations/down/0000_hard_cable.down.sql`
  (then clear the `__drizzle_migrations` row to re-apply cleanly). Lowest-risk option is
  simply deleting the disposable RDS instance — nothing live depends on it.

---

## Handoff to 5C-2 (not started)

Production cutover: point `DATABASE_URL` at the production RDS, apply the A3 baseline there,
dual-write/backfill MemStorage → PgStorage, then flip `storage.ts` to `PgStorage`. With A3
there is **no** vestigial `video_jobs` table to retire — `jobs` is already the sole
job-bearing table. Also harden the `db.ts` SSL posture: replace the test-foundation
`rejectUnauthorized: false` with `rejectUnauthorized: true` + the RDS CA bundle
before any real PHI flows. The 5D hub loading-hang (status-mirror root cause, recorded
in `CLAUDE.md`) is a separate track.
