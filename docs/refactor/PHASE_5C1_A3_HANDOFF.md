# Phase 5C-1 / A3 — Handoff status (for next-agent confirmation)

**Date:** 2026-06-30
**State:** A3 implementation complete and locally verified. **Nothing committed.**
Awaiting (1) a confirmation pass and (2) the operator (Andre) RDS conformance run.

This document is a point-in-time status snapshot for a reviewing agent. The
authoritative design write-up is `PHASE_5C1_REPORT.md`; this file says **where things
stand right now** and **what the verifier should check**.

---

## 1. What this session did

Corrected the earlier 5C-1 pass (which shipped **A1**'s substance — `VideoJob` stored
whole in a `video_job` jsonb blob + `has_job_v2` gate) into true **A3**: one `jobs` row
per id as the single source of truth, every fact in exactly one column, with the legacy
`VideoJob` and clean `Job` shapes **derived** in the `PgStorage` shim. No blob, no
`has_job_v2`, no `video_jobs` table.

Ordered work completed:

1. **Gate A** — dispositioned all 21 `VideoJob` columns (Direct / Derived / Unused).
   - 19 Direct (own column on `jobs`).
   - `fileCount` → **Derived** (`fileList?.length ?? 1`); grep proved it is written
     (`routes.ts:361,401` + `createVideoJob`) but **never read** — consumers read
     `fileList.length`. No column.
   - `outputZipPath` → **Unused** (no live producer/consumer) → synthesized `null`. No
     column.
   - `status` → the **only** genuinely two-fact case → two columns (`video_status`,
     `job_status`), Option 1, user-approved.
2. **Schema** (`shared/schema.ts`) — A3 `jobs` table (28 cols); dropped the `video_jobs`
   table; hand-authored `VideoJob` interface + `insertVideoJobSchema` to preserve exact
   consumer types.
3. **Migration** — regenerated `migrations/0000_hard_cable.sql` (3 tables) +
   hand-authored `migrations/down/0000_hard_cable.down.sql`; removed the old A1
   `0000_fluffy_star_brand.*` files and the A1 snapshot; reset `meta/_journal.json` to the
   single A3 entry.
4. **PgStorage** (`server/pgStorage.ts`) — rewritten as the derivation shim (all 21
   `IStorage` methods).
5. **Docs** — rewrote `PHASE_5C1_REPORT.md` for A3; updated `PHASE_5C1_RDS_RUNBOOK.md`
   (migration name + A3 wording); rewrote the `CLAUDE.md` 5C-1 block for A3 (kept the 5D
   status-mirror note).

---

## 2. Verification status (local)

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` error count | **17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`) — exactly the baseline; **0** in `schema.ts` / `pgStorage.ts` / `db.ts` / `scripts/` |
| MemStorage conformance (`npx tsx scripts/conformance-storage.ts`) | **35/35 cases, 84 assertions, ALL SUITES PASSED** |
| Oracle (`server/storage.ts`) behavior | **Unchanged.** Only edit is `export` on `mapVideoJobStatusToJobStatus` (private → exported); logic + `MemStorage` identical |
| PgStorage-vs-RDS conformance | **NOT RUN** — requires `TEST_DATABASE_URL` against a provisioned RDS; **this is Andre's step** and is the actual proof the A3 derivation holds |

---

## 3. Git state — UNCOMMITTED

Working tree vs HEAD (`masquerade-aws-latest/`):

```
 M .env.example          (TEST_DATABASE_URL — prior 5C-1 foundation)
 M CLAUDE.md             (A3 5C-1 block + resolved backlog bullets; 5D note retained)
 M drizzle.config.ts     (dbCredentials.ssl via shared resolveSsl — SSL fix, migrate path)
 M package-lock.json     (pg + @types/pg — prior 5C-1)
 M package.json          (pg deps + db:generate/db:migrate scripts — prior 5C-1)
 M server/db.ts          (neon-http → pg/node-postgres; CommonJS pg import; SSL via shared resolveSsl)
 M server/pgStorage.ts   (A3 derivation shim — THIS session)
 M server/storage.ts     (export mapVideoJobStatusToJobStatus ONLY — behavior unchanged)
 M shared/schema.ts      (A3 jobs table; dropped video_jobs; hand-written VideoJob — THIS session)
?? docs/refactor/PHASE_5C1_PROPOSAL.md
?? docs/refactor/PHASE_5C1_RDS_RUNBOOK.md
?? docs/refactor/PHASE_5C1_REPORT.md
?? docs/refactor/PHASE_5C1_A3_HANDOFF.md   (this file)
?? migrations/                              (0000_hard_cable.sql + down/ + meta/)
?? scripts/conformance-storage.ts
?? server/dbSsl.ts                          (shared SSL resolver — db.ts + drizzle.config.ts)
```

**No commit has been made.** The directive was "diff before commit"; the `CLAUDE.md`
diff and full status were shown in chat and are awaiting review.

> Note: the diff for the `CLAUDE.md` 5C-1 block and the 5D note appears as fully
> **added** (not modified) because the intermediate A1 version of that block was never
> committed — HEAD has no 5C-1 block at all. Expected.

---

## 4. The locked A3 design (for the verifier to sanity-check)

- **`jobs` (28 cols), single source of truth.**
  - **Shared (one fact, one column, read by both derivations):** `filename`, `duration`,
    `width`, `height`, `frame_rate`, `total_frames`, `error_message`. Safe because the
    harness never diverges these across coexisting facets (verified across all 35 cases).
  - **Status markers (two genuine facts + existence flags):** `video_status` (legacy
    6-value), `job_status` (V2 3-value). `video_status IS NOT NULL` ⟺ VideoJob facet;
    `job_status IS NOT NULL` ⟺ Job facet.
  - **VideoJob-only:** `file_path, original_size, progress, mask_data, output_settings,
    created_at, completed_at, job_type, file_list, ai_labels`.
  - **Job-only:** `uploaded_at, phi_status, attestation_record, source_type,
    extraction_rate, template_mask, labeling`, `ai_initialized` (bool, default false).
- **Derived on read (no column):** `VideoJob.outputZipPath` = `null`; `VideoJob.fileCount`
  = `fileList?.length ?? 1`; `Job.source` = shared dims + `source_type`.
- **Children:** `ai_runs` (FK → `jobs.id` ON DELETE cascade), `frame_processing_batches`
  (FK → `jobs.id`).
- **Facet-independent deletes:** deleting one facet clears only its exclusive columns +
  its status marker, leaving shared columns + the other facet intact; the row is dropped
  only when no facet survives.

### Suggested verifier spot-checks
- `pgStorage.ts` existence gates: `getVideoJob` returns `undefined` on `video_status ==
  null`; `getJobV2`/Job-spoke methods on `job_status == null`.
- `rowToVideoJob` derives `outputZipPath: null` and `fileCount` from `fileList`.
- `jobToColumns` writes `source_type = job.source.type`; `rowToJob` reassembles `source`.
- `updateVideoJob` mirrors status to `job_status` **only when `job_status` already
  non-null** (matches `MemStorage`'s "mirror only if jobsV2 entry exists").
- `deleteJobV2` deletes `ai_runs` explicitly on the column-clear path (cascade only fires
  on the row-drop path).
- Migration `0000_hard_cable.sql`: 3 tables, no `video_job`/`has_job_v2`/`video_jobs`.

---

## 5. Open decisions / next-step candidates (for the reviewing agent to confirm)

1. **Commit the A3 work?** Currently uncommitted by design. If yes: confirm message +
   whether to stage docs/migrations/scripts alongside the code. (Per repo rules, the
   agent will not commit without an explicit instruction.)
2. **RDS conformance run (Andre).** The real proof. Set `TEST_DATABASE_URL` against a
   migrated disposable RDS and run `npx tsx scripts/conformance-storage.ts`; expect
   `PgStorage: 35/35` and a 2-backend `ALL SUITES PASSED`. Paste the block into
   `PHASE_5C1_REPORT.md` under "Conformance results vs. RDS".
3. **`listAiRuns` ordering assumption.** A3 orders by `created_at` (ISO string), assuming
   it is distinct + monotonic per job to reproduce MemStorage's insertion order. If the
   RDS run ever shows ordering drift on equal timestamps, add a tiebreaker. (No failure
   observed; flagged for awareness.)
4. **Stale line ref in CLAUDE.md 5D note.** It cites `storage.ts:128–137` for the status
   mirror; the actual block is ~`storage.ts:129–140`. Pre-existing text, left as-is per
   "keep the 5D note." Confirm whether to correct the line numbers.

---

## 6. Hard constraints honored (do not regress)

- `MemStorage` is still the live runtime (`server/storage.ts` ends
  `export const storage = new MemStorage()`); `PgStorage`/`./db` are wired to nothing live.
- `tsc` stays exactly **17**.
- No frontend changes; no scope creep into 5C-2 / 5D / Phase 6.
- Migrations reversible (down-path present).
- RDS provisioned/run by Andre — the agent holds no credentials and provisioned nothing.
- `deployment-package/` is a frozen duplicate, NOT the live tree — untouched.
