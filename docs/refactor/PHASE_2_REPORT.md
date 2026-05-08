# Phase 2 Report — Schema & Storage Plumbing

**Date:** 2026-05-08
**Scope:** Additive-only type definitions, MemStorage methods, disk layout, cleanup infrastructure.
**Constraint:** Zero changes to HTTP endpoints, processVideo, processImages, frameAccess.ts, FrameViewer, frontend files, or Drizzle table definitions.

---

## 1. What Landed

### 1a. New TypeScript types (`shared/schema.ts` — +91 lines)

| Type | Purpose |
|---|---|
| `AttestationRecord` | Tracks PHI attestation checkbox state, timestamp, and text. |
| `JobSource` | Video/image-batch metadata (dimensions, duration, frameRate, totalFrames). |
| `Job` | Hub object — central state for a job across all spokes. |
| `TemplateMaskState` | Path A spoke state (mask application status, maskData, outputSettings, outputDir). |
| `LabelingState` | Path B placeholder (`= unknown`). Reserved for Phase 3+. |
| `AIState` | Path C container — holds array of `AIRun` objects. |
| `AIRun` | Single AI segmentation run (input source, modality, bbox, labels, approval). |

Design decisions:
- `samplingFps` → lives on `Job.extractionRate`, not on `TemplateMaskState`.
- `phiStatus` + `attestationRecord` → live at `Job` level (not spoke-specific).
- `AIRun.labels` reuses existing `AiLabel` type (metadata-only, no base64 blobs).
- `LabelingState = unknown` — intentional placeholder per architecture doc.

### 1b. MemStorage methods (`server/storage.ts` — +108 lines)

New `IStorage` interface methods and `MemStorage` implementations:

| Method | Signature |
|---|---|
| `getJobV2` | `(jobId: string) → Promise<Job \| undefined>` |
| `setPhiStatus` | `(jobId, phiStatus, attestationRecord?) → Promise<Job \| undefined>` |
| `setTemplateMaskState` | `(jobId, state) → Promise<Job \| undefined>` |
| `getTemplateMaskState` | `(jobId) → Promise<TemplateMaskState \| undefined>` |
| `addAiRun` | `(jobId, run) → Promise<Job \| undefined>` |
| `updateAiRun` | `(jobId, runId, updates) → Promise<AIRun \| undefined>` |
| `getAiRun` | `(jobId, runId) → Promise<AIRun \| undefined>` |
| `listAiRuns` | `(jobId) → Promise<AIRun[]>` |
| `deleteAiRun` | `(jobId, runId) → Promise<boolean>` |

All backed by a new `private jobsV2: Map<string, Job>`. Existing `videoJobs`, `frameBatches`, and `processingProgress` maps are untouched.

### 1c. PgStorage stubs (`server/pgStorage.ts` — +38 lines)

All 9 new `IStorage` methods added as stubs that throw `"not implemented — use MemStorage"`. PgStorage is scaffolding (never used at runtime) but must satisfy the interface for `tsc`.

### 1d. Disk layout & cleanup (`server/services/cleanup.ts` — +158 lines net)

New constants:
- `SPOKES_ROOT_DIR` → `<cwd>/spokes/`
- `SPOKE_TEMPLATE_MASK_DIR` → `spokes/template_mask/`
- `SPOKE_AI_DIR` → `spokes/ai/`
- `SPOKE_LABELING_DIR` → `spokes/labeling/`
- `SPOKES_MAX_AGE_MS` → 24 hours (uniform across all spokes)

New generalized sweep mechanism:
```typescript
export const SWEEP_TARGETS: ReadonlyArray<readonly [string, number]> = [
  [UPLOADS_DIR,              UPLOADS_MAX_AGE_MS],        // 2h
  [TEMP_EXTRACTED_DIR,       TEMP_EXTRACTED_MAX_AGE_MS], // 6h
  [TEMP_PROCESSED_DIR,       TEMP_PROCESSED_MAX_AGE_MS], // 24h
  [SPOKE_TEMPLATE_MASK_DIR,  SPOKES_MAX_AGE_MS],         // 24h
  [SPOKE_AI_DIR,             SPOKES_MAX_AGE_MS],         // 24h
  [SPOKE_LABELING_DIR,       SPOKES_MAX_AGE_MS],         // 24h
];
```

Adding a future spoke is a one-line addition to this array — no new functions needed.

New functions:
- `purgeTempProcessedOnStartup()` — mirrors `purgeUploadsOnStartup()` for temp_processed/.
- `ensureSpokeDirectories()` — `mkdir -p` for all three spoke dirs on boot.

Updated functions:
- `cleanupJobArtifacts(jobId)` — now cleans temp_extracted, temp_processed (legacy), and all three spoke dirs.
- `startCleanupScheduler()` — iterates `SWEEP_TARGETS` instead of hard-coded list.

### 1e. Boot sequence (`server/index.ts` — +14 lines)

Updated the cleanup import block to call:
1. `purgeUploadsOnStartup()` (existing)
2. `purgeTempProcessedOnStartup()` (new)
3. `ensureSpokeDirectories()` (new)
4. `startCleanupScheduler()` (existing, now sweeps all targets)

### 1f. CLI tool (`scripts/cleanup-now.ts` — +96 lines net)

- Added `--job=<jobId>` flag that calls `cleanupJobArtifacts(jobId)` to delete all artifacts for a single job across every directory.
- Made `--job` and `--dir` mutually exclusive (exit code 2 if both provided).
- Extended `DirKey` to include `'template_mask' | 'ai' | 'labeling'`.
- Default sweep now uses `SWEEP_TARGETS` array.
- Existing flags preserved: `--dry-run`, `--dir=<key>`, `--max-age-ms=<ms>`.

### 1g. CLAUDE.md (+73 lines)

- Added "Phase 2 landed" note at top.
- Added "Hub-and-spoke data model (Phase 2)" section describing new types and MemStorage methods.
- Updated disk lifecycle table with spoke directories and temp_processed retirement note.
- Updated "When does cleanup happen?" and manual cleanup sections.
- All existing parking-lot items preserved.

---

## 2. Deviations from Prompt / Architecture Doc

| Deviation | Justification |
|---|---|
| Added PgStorage stubs | Not in kickoff prompt, but required — `PgStorage implements IStorage`, and `tsc` would reject the build without matching method signatures. Stubs throw at runtime; PgStorage is never instantiated. |
| No `createJobV2` method | The kickoff listed `getJobV2` but not a create method. A create method will be needed in Phase 3 when upload endpoints start writing `Job` records. Deferred intentionally — Phase 2 is additive plumbing only. |
| `LabelingState = unknown` | Architecture doc says Path B is a placeholder. `unknown` was chosen over `{}` or `any` because it forces explicit type narrowing at call sites in Phase 3. |

No other deviations. All 6 deliverables from the kickoff were implemented as specified.

---

## 3. Deferred — Phase 3 Attention Items

1. **`createJobV2` method** — MemStorage has `getJobV2` but no way to create a Job. Phase 3 upload endpoint will need this.

2. **`temp_processed/` retirement** — Still written to by `processVideo()` and `processImages()`. Phase 3 should redirect those writes to `spokes/template_mask/<jobId>/` and then remove temp_processed from SWEEP_TARGETS.

3. **`maskArtifactStore` migration** — Heavy base64 mask/overlay blobs live in a separate in-memory store (`server/services/maskArtifactStore.ts`). Phase 3 should decide whether to fold this into `Job.templateMask` or keep it separate (recommend separate — blobs are too large for the Job object).

4. **Pre-existing build failure** — `npm run build` (Vite) fails due to a missing gif asset in `client/src/pages/landing.tsx` referencing `attached_assets/ezgif-*.gif`. This is not caused by Phase 2 but will block production builds if not resolved.

5. **Pre-existing tsc errors** — `frameExtractor.ts` and `maskWorker.ts` have type errors related to dcmjs types, pixelBuffer nullability, and MaskData missing a `feather` property. Not caused by Phase 2. May need attention before Phase 3 touches those files.

6. **PgStorage real implementation** — Phase 2 added stubs. If a Postgres migration is planned, the stubs need real implementations. If Postgres is indefinitely deferred, consider removing PgStorage entirely to reduce maintenance surface.

7. **`samplingFps` location** — Lives on `Job.extractionRate`. If spoke-specific sampling rates are needed later, this decision should be revisited.

---

## 4. Smoke Test Results

| # | Test | Result |
|---|---|---|
| 1 | Server-side esbuild (`npx esbuild server/index.ts --bundle --platform=node`) | **PASS** — 182.5 KB output |
| 2 | `npm run cleanup -- --dry-run` (sweeps all 6 directories) | **PASS** |
| 3 | `npm run cleanup -- --job=test123` (per-job cleanup) | **PASS** |
| 4 | `--dir` and `--job` mutual exclusion (exit code 2) | **PASS** |
| 5 | Sentinel file purge: create file in temp_processed/, run `purgeTempProcessedOnStartup()`, verify removed | **PASS** |
| 6 | Spoke directories created: `spokes/template_mask/`, `spokes/ai/`, `spokes/labeling/` all exist | **PASS** |
| 7 | `npm run cleanup -- --dir=template_mask` (new spoke dir key) | **PASS** |
| 8 | `npm run cleanup -- --dir=ai` (new spoke dir key) | **PASS** |

All 8 verification items pass.

---

## 5. Files Modified

```
 CLAUDE.md                  |  73 +++++++++++++++++----
 scripts/cleanup-now.ts     |  96 ++++++++++++++++++++-------
 server/index.ts            |  14 +++-
 server/pgStorage.ts        |  38 +++++++++++
 server/services/cleanup.ts | 158 ++++++++++++++++++++++++++++++++++++---------
 server/storage.ts          | 108 +++++++++++++++++++++++++++++--
 shared/schema.ts           |  91 ++++++++++++++++++++++++++
 7 files changed, 500 insertions(+), 78 deletions(-)
```

**Files NOT modified** (confirming scope discipline):
- `client/` — zero frontend changes
- `server/routes.ts` — no endpoint changes
- `server/services/videoProcessor.ts` — untouched
- `server/services/frameExtractor.ts` — untouched
- `server/services/frameAccess.ts` — untouched
- `server/services/tempFolderManager.ts` — untouched
- `server/services/maskArtifactStore.ts` — untouched
- `shared/schema.ts` Drizzle table definitions (`videoJobs`, `frameProcessingBatches`) — untouched
