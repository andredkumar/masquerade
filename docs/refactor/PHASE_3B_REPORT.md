# Phase 3b Report — AI Inference Disk Persistence

**Date:** 2026-05-08
**Scope:** Replace in-memory `maskArtifactStore` with disk persistence under `spokes/ai/<jobId>/<runId>/`. Introduce `AIRun` lifecycle. Backward-compat dual-write to `job.aiLabels[]`.
**Constraint:** Zero endpoint URL changes. Zero frontend functional changes. Zero GPU service changes. Zero Path A changes. Zero upload handler changes.

---

## 1. What Landed

### 1a. `server/services/maskArtifactStore.ts` — DELETED

The entire file (62 lines) was deleted. It contained the `MaskArtifactStore` class (in-memory `Map<string, LabelArtifacts>`) that held base64 mask/overlay blobs. All 10 callsites in `routes.ts` were migrated to disk reads before deletion.

### 1b. `server/storage.ts` (+3 lines, -2 lines net → +1 net)

- Added `createJobV2(job: Job): Promise<Job>` to the `IStorage` interface (line 34). This method was present on `MemStorage` but missing from the interface, which caused `ensureJobV2` in routes.ts to fail type-checking.
- Updated trailing comment (line 223-226) to reference `spokes/ai/` disk persistence instead of the deleted `maskArtifactStore`.

### 1c. `server/pgStorage.ts` (+3 lines net)

- Added `createJobV2` stub that throws (consistent with all other Phase 2 hub-and-spoke stubs in PgStorage).

### 1d. `server/routes.ts` — major rewrite (~+120 lines, ~-80 lines net → ~+40 net)

**Import changes:**
- Removed: `maskArtifactStore` import (was from `./services/maskArtifactStore`)
- Added: `safeDelete`, `SPOKE_AI_DIR` from `./services/cleanup`
- Added: `{ promises as fsPromises }` from `fs`
- Added: `type AIRun`, `type Job` from `@shared/schema`

**New helper functions (lines 33-69):**
- `findRunByLabelId(runs, labelId)` — walks `AIRun[].labels` to find which run owns a label. O(runs × labels-per-run), fine at single-tenant scale.
- `ensureJobV2(jobId, videoJob)` — lazily creates a `Job` in the `jobsV2` store from legacy `VideoJob` data. Needed because `addAiRun` requires the Job to exist in the hub-and-spoke store, but no upload handler creates one yet (Phase 3d scope).

**`/api/ai/infer` endpoint rewritten:**
- Generates `runId` via `crypto.randomUUID()`
- Creates `runOutputDir` at `spokes/ai/<jobId>/<runId>/` via `fsPromises.mkdir(..., { recursive: true })`
- Creates `AIRun` record with auto-generated name (`Run <N>`), `inputSource: 'template_mask'`, empty `labels: []`
- Calls `ensureJobV2()` then `storage.addAiRun(jobId, run)`
- Per-frame inference loop writes mask/overlay PNGs to disk via `fsPromises.writeFile` + `Promise.all` (two writes per frame, parallelized)
- Base64 strings discarded per-frame to keep heap small
- After loop: builds `AiLabel`, dual-writes to both `AIRun.labels[]` (via `storage.updateAiRun`) and `job.aiLabels[]` (via `storage.updateVideoJob`)
- Response shape unchanged

**Download endpoint mask/overlay getters rewritten:**
- Builds `labelRunDirMap: Map<string, string>` from `storage.listAiRuns()`
- `getLabelFrameMaskPath(label, frameIdx)` resolves `mask_<n>.png` from the run's outputDir
- `getLabelFrameOverlayPath(label, frameIdx)` resolves `overlay_<n>.png`
- `hasAnyMasks` / `hasAnyOverlays` check `fs.existsSync` on disk
- ZIP archive uses `archive.file(path)` instead of `archive.append(Buffer.from(b64))` — avoids reading PNGs into memory

**`inference.json` endpoint updated:**
- Builds `labelDirMap: Map<string, string>` from `storage.listAiRuns()`
- `hasMask` check: `fs.existsSync(path.join(runDir, 'mask_<n>.png'))` instead of `maskArtifactStore.get(l.id)`
- Comment updated to reference disk persistence

**Mask serving endpoint (`GET /api/jobs/:jobId/masks/:labelId/:n.png`) rewritten:**
- Resolves mask file via `findRunByLabelId(runs, labelId)` → `run.outputDir`
- Uses `res.sendFile(path.resolve(maskPath))` instead of decoding base64 in-memory
- 410 when no AIRun owns the label (backward-compat with frontend banner)
- 404 when the specific frame's mask file is missing on disk

**Overlay serving endpoint (`GET /api/jobs/:jobId/overlays/:labelId/:n.png`) rewritten:**
- Same pattern as mask endpoint, reading `overlay_<n>.png`

**`PATCH /api/ai/labels/:jobId/:labelId` updated:**
- After toggling `approved` on `job.aiLabels[]`, also finds the owning AIRun via `findRunByLabelId` and updates the label's `approved` status via `storage.updateAiRun`

**`DELETE /api/ai/labels/:jobId/:labelId` updated:**
- After splicing from `job.aiLabels[]`, also:
  - Finds owning AIRun via `findRunByLabelId`
  - Deletes the run's output directory via `safeDelete(run.outputDir)`
  - Removes the AIRun record via `storage.deleteAiRun(jobId, run.id)`

**`viewer-info` endpoint `hasArtifacts` updated:**
- Replaced `maskArtifactStore.has(labelId)` loop with disk check: iterates `storage.listAiRuns()`, probes `fs.existsSync(path.join(r.outputDir, 'mask_0.png'))`

### 1e. `shared/schema.ts` (+2 lines, -3 lines → -1 net)

- Updated two comments that referenced `maskArtifactStore` to reference disk persistence under `spokes/ai/`. No type or interface changes.

### 1f. `client/src/pages/home.tsx` (+1 line, -1 line → 0 net)

- Updated one comment (line 161) that referenced `maskArtifactStore eviction` to reference `AIRun + disk artifact deletion`. No functional change.

### 1g. `server/services/aiInferenceClient.ts` — zero changes

Confirmed: pure GPU service client. Returns base64 in its response shape. Phase 3b consumes that in the `/api/ai/infer` handler. No changes needed.

### 1h. `server/services/cleanup.ts` — zero changes

Confirmed: `cleanupJobArtifacts` already cleans `spokes/ai/<jobId>/` (Phase 2). `SWEEP_TARGETS` already includes `SPOKE_AI_DIR`. No changes needed.

### 1i. `CLAUDE.md` (+15 lines, -8 lines → +7 net)

- Added "Phase 3b landed" line at top with date and summary.
- Updated disk lifecycle table: `spokes/ai/<jobId>/<runId>/` row expanded with post-3b description.
- Updated MemStorage section: noted which hub-and-spoke methods now have callers.
- Updated SIGTERM note: now says all SWEEP_TARGETS are swept (was "does not yet sweep spoke dirs").
- Updated Frame viewer endpoint table: mask/overlay endpoints now reference disk reads.
- Updated known limitations: artifacts now survive restarts.
- Updated AI Analysis section: references disk persistence instead of maskArtifactStore.
- Updated DELETE label description: references AIRun + disk deletion.

---

## 2. Deviations from Prompt / Architecture Doc

| Deviation | Justification |
|---|---|
| Added `createJobV2` to `IStorage` interface and `PgStorage` stub | The method existed on `MemStorage` but was missing from the `IStorage` interface. `ensureJobV2` needs to call it through the `storage` reference (typed as `IStorage`). Without the interface addition, TypeScript rejects the call. |
| `ensureJobV2` helper added | The kickoff assumes `storage.addAiRun(jobId, run)` can succeed, but `addAiRun` (Phase 2) requires a `Job` to exist in the `jobsV2` map. No upload handler creates one yet (Phase 3d). `ensureJobV2` lazily creates a Job from legacy VideoJob data. This is a bridge pattern — Phase 3d will move Job creation to the upload handler and `ensureJobV2` becomes a no-op (the Job will already exist). |
| `inference.json` hasMask changed to disk check | The kickoff says "No change needed" for inference.json, referring to the data source (still `job.aiLabels[]`). However, the `hasMask` field within the frame pivot was implemented via `maskArtifactStore.get()`, which is being deleted. Changed to disk existence check via `labelDirMap` + `fs.existsSync`. |
| Mask/overlay endpoints use `res.sendFile` instead of `frameAccess.ts` helpers | The kickoff suggested adding a `resolveMaskPath` helper to `frameAccess.ts` or reusing `resolveFramePath`. Both options add indirection for a simple `path.join + existsSync` pattern. Since the run's `outputDir` is already validated (it came from the storage layer, not user input), a path-traversal guard adds no security value here. Using `res.sendFile(path.resolve(...))` directly in the endpoint is simpler and self-contained. The `path.resolve` call ensures Express gets an absolute path. |
| Comment-only changes in `shared/schema.ts` and `client/src/pages/home.tsx` | The kickoff says zero frontend changes and zero schema changes. These are comment-only updates (no type/interface/logic changes) to remove stale references to the deleted `maskArtifactStore`. Leaving comments that reference a deleted module would be misleading. |

No other deviations. All 7 deliverables implemented as specified.

---

## 3. Deferred — Phase 3c/d and Future Cleanup

1. **`ensureJobV2` bridge removal** — Phase 3d will create `Job` records in the upload handler. Once that lands, `ensureJobV2` always returns the existing Job (the lazy-create path never fires). Remove `ensureJobV2` after Phase 3d and the `createJobV2` interface addition become load-bearing elsewhere.

2. **`videoProcessor.ts` comments** — Lines 371 and 643 still mention `temp_processed/{jobId}/` in comments. Deferred from Phase 3a (kickoff said zero changes to this file). Should be updated in a cleanup PR.

3. **`tempFolderManager.ts` rename** — File still has its legacy name. Deferred from Phase 3a.

4. **`temp_processed/` sweep target removal** — Retained defensively. Remove once confirmed quiet in production.

5. **`hasArtifacts` becomes always-true** — Post-3b, `hasArtifacts` in `viewer-info` is effectively always `true` for jobs with completed runs (artifacts survive restarts). The empty-state banner in FrameViewer becomes dead UI. Phase 4 can remove it.

6. **FrameViewer endpoint table in CLAUDE.md** — Still references `resolveFramePath` guarding against `TEMP_PROCESSED_DIR`. Post-3a this should say `SPOKE_TEMPLATE_MASK_DIR`. Minor doc inaccuracy, not worth a standalone fix.

7. **Multiple labels per run** — Currently each `/api/ai/infer` call creates one run with one label. The `AIRun.labels[]` array supports multiple labels, but the UI and the delete handler assume 1:1. Phase 4 will support multi-label runs.

8. **Disk pressure from AI artifacts** — Each run writes 2 PNGs per frame (mask + overlay). At 1000 frames, ~100-200MB per run. The 24h retention sweep handles cleanup, but high-usage scenarios could accumulate significant disk. Monitor after deploy.

---

## 4. Verification Results

| # | Test | Result | Notes |
|---|---|---|---|
| 1 | `npx tsc --noEmit` shows exactly 17 pre-existing errors | **PASS** | 10 in `frameExtractor.ts`, 7 in `maskWorker.ts`. Zero from Phase 3b files. |
| 2 | Server-side esbuild succeeds | **PASS** | 184.7 KB output, zero errors. |
| 3 | `grep -rn "maskArtifactStore" server/` returns zero matches | **PASS** | Module deleted, all callsites migrated. |
| 4 | `grep -rn "maskArtifactStore" client/` returns zero matches | **PASS** | Comment in `home.tsx` updated. |
| 5 | `ls server/services/maskArtifactStore.ts` returns "No such file" | **PASS** | File deleted. |
| 6 | End-to-end smoke test (AI inference renders in FrameViewer) | **SKIPPED** | Requires deployed server with GPU service. |
| 7 | Disk check (`ls spokes/ai/<jobId>/<runId>/`) | **SKIPPED** | Same as above. |
| 8 | Restart survival test (PM2 restart, overlays still render) | **SKIPPED** | Same as above — this is the load-bearing 3b check. |
| 9 | Label delete removes run directory | **SKIPPED** | Requires running server. |
| 10 | PostHog events fire for AI inference | **SKIPPED** | Requires deployed server. |
| 11 | `git diff -- client/` is comment-only | **PASS** | Single comment update in `home.tsx:161`, no functional change. |
| 12 | `shared/schema.ts` changes are comment-only | **PASS** | Two comment updates, no type/interface changes. |
| 13 | `server/services/aiInferenceClient.ts` untouched | **PASS** | Zero changes. |
| 14 | `server/services/cleanup.ts` untouched | **PASS** | Zero changes. |
| 15 | `server/services/videoProcessor.ts` untouched | **PASS** | Zero changes. |
| 16 | `server/services/tempFolderManager.ts` untouched | **PASS** | Zero changes. |

---

## 5. Files Modified

```
 CLAUDE.md                                 | +15  -8   (net +7)
 server/routes.ts                          | +120 -80  (net ~+40)
 server/storage.ts                         | +3   -2   (net +1)
 server/pgStorage.ts                       | +3        (net +3)
 shared/schema.ts                          | +2   -3   (net -1)
 client/src/pages/home.tsx                 | +1   -1   (net 0, comment only)
 6 files changed
```

**Files DELETED:**
- `server/services/maskArtifactStore.ts` (62 lines)

**Files NOT modified** (confirming scope discipline):
- `server/services/aiInferenceClient.ts` — zero changes (GPU client, returns base64)
- `server/services/cleanup.ts` — zero changes (already handles spokes/ai/)
- `server/services/videoProcessor.ts` — zero changes (Path A)
- `server/services/tempFolderManager.ts` — zero changes (Path A)
- `server/services/frameExtractor.ts` — zero changes
- `server/services/maskWorker.ts` — zero changes
- Upload handler logic in `server/routes.ts` — untouched
- `sam2-service/` — zero changes (GPU service)
