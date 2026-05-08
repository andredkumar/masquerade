# Phase 3a Report — Backend Processing Path Migration

**Date:** 2026-05-08
**Scope:** Migrate disk write paths from `temp_processed/` to `spokes/template_mask/<jobId>/`. Fix two bypass callsites. Reads resolve against the new location.
**Constraint:** Zero endpoint URL changes. Zero frontend changes. Zero `maskArtifactStore` changes. Zero upload handler changes.

---

## 1. What Landed

### 1a. `server/services/tempFolderManager.ts` (+10 lines net)

- `TEMP_BASE` changed from `path.join(process.cwd(), 'temp_processed')` to import of `SPOKE_TEMPLATE_MASK_DIR` from `cleanup.ts`.
- Added top-of-file doc comment noting the legacy name and that the file no longer touches `temp_processed/`.
- All exported function names and signatures preserved unchanged: `createJobTempFolder`, `cleanupJobTempFolder`, `cleanupAllTempFolders`, `getJobTempFolder`, `saveProcessedImage`, `getProcessedImages`, `hasProcessedImages`, `initialize`.
- Callers in `videoProcessor.ts` get the new behavior automatically with zero code changes there.

### 1b. `server/services/frameAccess.ts` (+86 lines, -9 lines net)

- Replaced import of `TEMP_PROCESSED_DIR` with import of `SPOKE_TEMPLATE_MASK_DIR`.
- Added optional `baseDir` parameter (defaulting to `SPOKE_TEMPLATE_MASK_DIR`) to:
  - `resolveFramePath(jobId, frameIndex, baseDir?)`
  - `tempDirExists(jobId, baseDir?)`
  - `countFrames(jobId, baseDir?)`
- Path-traversal guard in each function now uses the passed-in `baseDir` (resolved via `path.resolve`), not a hardcoded constant.
- Added new `listFrameFiles(jobId, baseDir?)` function that returns `{ dir: string; files: string[] }` — sorted, deduped frame filenames. This provides the abstraction both bypass callsites needed.
- All existing callsites (viewer-info, frame serving, etc.) continue to work with zero-argument defaults.

### 1c. `server/routes.ts` — bypass callsite migration (+46 lines, -63 lines net → -17 net)

**Download endpoint** (was line 475, now ~line 473):
- Replaced `const tempDir = path.join(process.cwd(), 'temp_processed', job.id)` + `fs.existsSync(tempDir)` + `fs.readdirSync(tempDir)` with a single call to `listFrameFiles(job.id)`.
- The streaming ZIP build uses the returned `{ dir, files }` — `archive.file(path.join(dir, filename), ...)` is unchanged in structure.
- Eliminated 9 lines of boilerplate (manual readdir, filter, dedup, sort, existence check).

**AI inference endpoint** (was line 805, now ~line 794):
- Replaced `const tempDir = path.join(process.cwd(), 'temp_processed', jobId)` + `fs.existsSync(tempDir)` + `fs.readdirSync(tempDir)` with a single call to `listFrameFiles(jobId)`.
- The `let frameFileNames` became `const` from destructuring.
- The single-frame fallback logic (`singleFrameFallback`) and per-frame `path.join(tempDir, filename)` reads remain structurally identical.

**SIGTERM handler** (was line 1383-1385):
- Replaced three individual `sweepDirectory(UPLOADS_DIR, 0)` / `sweepDirectory(TEMP_EXTRACTED_DIR, 0)` / `sweepDirectory(TEMP_PROCESSED_DIR, 0)` calls with a single `for (const [dir] of SWEEP_TARGETS)` loop.
- This removes the `UPLOADS_DIR`, `TEMP_EXTRACTED_DIR`, and `TEMP_PROCESSED_DIR` imports from routes.ts, and also sweeps spoke directories on shutdown (correct behavior post-3a).

**Import changes:**
- Removed: `UPLOADS_DIR`, `TEMP_EXTRACTED_DIR`, `TEMP_PROCESSED_DIR`
- Added: `SWEEP_TARGETS`
- Added: `listFrameFiles` from `frameAccess.ts`

**Comment updates:**
- Updated 4 comments that referenced `temp_processed` to reference `spokes/template_mask`.

**Result:** `grep -rn "temp_processed\|TEMP_PROCESSED" server/routes.ts` returns zero matches.

### 1d. `server/services/videoProcessor.ts` — zero changes

Confirmed: `videoProcessor.ts` uses only `TempFolderManager` methods (`createJobTempFolder`, `cleanupJobTempFolder`, `getJobTempFolder`, `saveProcessedImage`). No direct filesystem paths. Changing `TEMP_BASE` in `tempFolderManager.ts` automatically redirects all writes.

Two pre-existing comments at lines 371 and 643 still mention `temp_processed` descriptively. These are not code paths and are not worth changing in this scope (would modify a file the kickoff says should require zero changes).

### 1e. `server/services/cleanup.ts` (+1 line — comment only)

- Added inline comment on the `TEMP_PROCESSED_DIR` entry in `SWEEP_TARGETS`: `// retained as defensive sweep target post-3a; remove once confirmed no writes occur`
- No other changes. `purgeTempProcessedOnStartup()` continues running on boot. `TEMP_PROCESSED_DIR` remains exported.

### 1f. `CLAUDE.md` (+19 lines, -8 lines net → +11 net)

- Added "Phase 3a landed" line at top with date and summary.
- Updated disk lifecycle table:
  - `temp_processed/` row: changed from "(RETIRING) Still written by old endpoints" to "(LEGACY — no longer written to post-3a.) Retained as defensive sweep target."
  - `spokes/template_mask/<jobId>/` row: changed from "Path A output (Phase 3)" to "Path A output — **active processing target post-3a.** `tempFolderManager.ts` and `frameAccess.ts` both resolve against this directory."
- Updated narrative paragraph below the table to reflect that `temp_processed/` is fully retired.
- All existing parking-lot items preserved.

---

## 2. Deviations from Prompt / Architecture Doc

| Deviation | Justification |
|---|---|
| Added `listFrameFiles` to `frameAccess.ts` | The kickoff said "replace with `frameAccess.ts` helpers" for both bypass callsites. Neither existing helper (`resolveFramePath`, `countFrames`) returns the filename list that both the download and AI inference endpoints need. `listFrameFiles` is the natural abstraction — it encapsulates path-traversal validation, readdir, filter, dedup, and sort in one call. |
| SIGTERM handler refactored to use `SWEEP_TARGETS` | The kickoff's verification #4 requires `TEMP_PROCESSED_DIR` to appear only in `cleanup.ts`. The SIGTERM handler at `routes.ts:1383-1385` used `TEMP_PROCESSED_DIR` directly. Replacing the three individual `sweepDirectory` calls with a `SWEEP_TARGETS` loop is the minimal change to satisfy the verification and is semantically better (sweeps all targets including spoke dirs on shutdown). |

No other deviations. All 6 deliverables implemented as specified.

---

## 3. Deferred — Phase 3b/c/d and Future Cleanup Attention

1. **`tempFolderManager.ts` rename** — File still has its legacy name. A future cleanup PR should rename to something like `templateMaskOutputManager.ts` and update all imports. Kickoff decision #4 explicitly defers this.

2. **`temp_processed/` sweep target removal** — Retained defensively per kickoff decision #5. Remove from `SWEEP_TARGETS` once production confirms zero writes for a full retention cycle.

3. **`videoProcessor.ts` comments** — Lines 371 and 643 still mention `temp_processed/{jobId}/` in comments. Not worth changing in this scope (kickoff says zero changes to this file), but should be updated in a future cleanup PR.

4. **TempFolderManager path-traversal guard** — Still absent (Phase 1 surprise #4). The kickoff explicitly says "do not yet add" — remains a separate PR.

5. **SIGTERM spoke directory sweeps** — Now handled by the `SWEEP_TARGETS` loop. Previously only uploads/, temp_extracted/, and temp_processed/ were swept on SIGTERM; now all six targets are swept. This is correct behavior but was an incidental improvement from the `TEMP_PROCESSED_DIR` removal.

6. **`purgeTempProcessedOnStartup` can be removed** — Once `temp_processed/` is confirmed quiet in production, both the startup purge and the sweep target can be removed together in a single cleanup PR.

7. **AI inference reads from template_mask only** — Per kickoff decision #3, AI inference always reads from `spokes/template_mask/<jobId>/`. The architecture doc's "user choice of source frames" (extracted vs. masked) is a Phase 4 frontend concern.

---

## 4. Verification Results

| # | Test | Result | Notes |
|---|---|---|---|
| 1 | `npx tsc --noEmit` shows exactly 17 pre-existing errors | **PASS** | 10 in `frameExtractor.ts`, 7 in `maskWorker.ts`. Zero from Phase 3a files. |
| 2 | Server-side esbuild succeeds | **PASS** | 186.2 KB output, one pre-existing `import.meta` warning from `vite.ts`. |
| 3 | `grep -rn "'temp_processed'" server/` — only in cleanup.ts | **PASS** | Single match: `cleanup.ts:45` (the constant definition). |
| 4 | `grep -rn "TEMP_PROCESSED_DIR" server/` — only in cleanup.ts | **PASS** | 7 matches, all in `cleanup.ts` (export, sweep target, cleanupJobArtifacts, purgeTempProcessedOnStartup). Zero in routes.ts, frameAccess.ts, tempFolderManager.ts, videoProcessor.ts. |
| 5 | Local end-to-end smoke test | **SKIPPED** | Agent environment doesn't have ffmpeg, GPU service, or a running dev server. Must be run manually on the deployed server. |
| 6 | Server boots cleanly | **SKIPPED** | Same as above — requires `npm run dev` with full dependencies. |
| 7 | `git diff -- client/` is empty | **PASS** | Zero frontend changes. |
| 8 | `git diff -- server/services/maskArtifactStore.ts` is empty | **PASS** | Untouched. |

---

## 5. Files Modified

```
 CLAUDE.md                            | 19 ++++----
 server/routes.ts                     | 46 +++++++------------
 server/services/cleanup.ts           |  2 +-
 server/services/frameAccess.ts       | 86 +++++++++++++++++++++++++++---------
 server/services/tempFolderManager.ts | 10 ++++-
 5 files changed, 100 insertions(+), 63 deletions(-)
```

**Files NOT modified** (confirming scope discipline):
- `client/` — zero frontend changes
- `server/services/videoProcessor.ts` — zero changes (gets new behavior via TempFolderManager)
- `server/services/maskArtifactStore.ts` — untouched
- `server/storage.ts` — untouched
- `shared/schema.ts` — untouched
- Upload handler logic in `server/routes.ts` — untouched (only download + AI infer + SIGTERM changed)
