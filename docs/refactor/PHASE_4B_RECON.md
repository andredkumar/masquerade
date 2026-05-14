# Phase 4b Reconnaissance Report — Template Mask Spoke Migration

**Date:** 2026-05-12
**Phase:** 4b.0 (recon pass, pre-implementation)
**Status:** Awaiting user approval before proceeding to 4b.1

---

## Answers to Reconnaissance Questions

### Q1. `Job.templateMask` schema

**File:** `shared/schema.ts`

`templateMask` is an **optional** field on the `Job` type:

```typescript
export interface Job {
  id: string;
  filename: string;
  uploadedAt: string;
  phiStatus: 'raw' | 'user_attested';
  attestationRecord?: AttestationRecord;
  source: JobSource;
  extractionRate: number;
  status: 'extracting' | 'ready' | 'failed';
  errorMessage: string | null;
  templateMask?: TemplateMaskState;  // ← optional
  labeling?: LabelingState;
  ai?: AIState;
}
```

`TemplateMaskState` fields:

```typescript
export interface TemplateMaskState {
  status: 'idle' | 'applying' | 'complete' | 'failed';
  maskData: MaskData;
  outputSettings: OutputSettings;
  outputDir: string;
  completedAt: string | null;
}
```

Status values: `'idle'`, `'applying'`, `'complete'`, `'failed'`.

---

### Q2. Canonical apply handler state-writing

**File:** `server/handlers/templateMaskApply.ts` (full file, 76 lines)

The canonical `POST /api/jobs/:jobId/template-mask/apply` handler does **NOT** write to `Job.templateMask`. It only:

1. Validates inputs (line 39-41)
2. Looks up the legacy `VideoJob` via `storage.getVideoJob(jobId)` (line 48)
3. Persists maskData + outputSettings on the **legacy VideoJob** via `storage.updateVideoJob(jobId, { maskData, outputSettings })` (line 51)
4. Fires off `videoProcessor.processVideo()` or `processImages()` (lines 59-72)
5. Returns `{ ok: true, jobId }` (line 74)

No call to `storage.setTemplateMaskState()` anywhere.

**Minimal change to write `Job.templateMask`:** Insert a `storage.setTemplateMaskState()` call right after the `updateVideoJob` call at line 51. The handler should set status `'applying'` at apply-time. The `'complete'` status needs to be written when processing finishes — this happens in `videoProcessor.processVideo()` around line 386-395 where it sets `status: 'completed'` on the legacy job. A second `setTemplateMaskState` call is needed there with `status: 'complete'` and `completedAt`.

**Hub Tile 1 reads from `job.templateMask`** (`client/src/pages/hub.tsx`, lines 51-55):

```typescript
const templateMaskStatus = job.templateMask
  ? job.templateMask.status === "complete"
    ? "Applied"
    : job.templateMask.status
  : "Not started";
```

So until the handler writes to `Job.templateMask`, Tile 1 will always show "Not started".

---

### Q3. Legacy `ProcessingControls` coupling

**File:** `client/src/components/ProcessingControls.tsx` (299 lines)

**URL called:** `PATCH /internal/mask-processing/${jobId}` (line 83-90):

```typescript
const response = await apiRequest('PATCH', `/internal/mask-processing/${jobId}`, {
  maskData,
  outputSettings: settings,
  samplingFps,
});
```

This is the legacy non-API route registered in `server/index.ts:29`, not the canonical `POST /api/jobs/:jobId/template-mask/apply`.

**Socket.IO subscriptions:** None. `ProcessingControls` has zero Socket.IO listeners. Progress is handled by the sibling `ProcessingStatus` component.

**Props:**

```typescript
interface ProcessingControlsProps {
  jobId: string | null;
  maskData: MaskData | null;
  videoMetadata: any;
  samplingFps?: number | null;
  onStartProcessing: (outputSettings: OutputSettings) => void;
  disabled: boolean;
  hasExistingMask?: boolean;
  isProcessing?: boolean;
  lastProcessedSettings?: OutputSettings | null;
}
```

**Coupling to MaskingCanvas/MaskingTools:** Loose. They communicate through the parent's state:
- `MaskingCanvas` calls `onMaskUpdate(maskData)` → parent stores `maskData`
- `MaskingTools` reads/writes `selectedTool` and `maskData` through parent
- `ProcessingControls` receives `maskData` as a prop from parent
- No direct references between these components

`ProcessingControls` can be replaced standalone — it's a leaf component that takes props and fires a fetch. `MaskingCanvas` and `MaskingTools` don't depend on it.

---

### Q4. Frame access patterns

**How MaskingCanvas gets the first frame:**

`MaskingCanvas` receives `firstFrame: string | null` as a prop (base64 data URL). The spoke page (`template-mask-spoke.tsx`, lines 41-47) reads it from sessionStorage:

```typescript
useEffect(() => {
  if (!jobId) return;
  const cached = getCachedFirstFrame(jobId);
  if (cached) setFirstFrame(cached);
}, [jobId]);
```

`getCachedFirstFrame()` reads from `sessionStorage` (`client/src/lib/frameCache.ts`). This was populated by the upload page (`upload.tsx`) via `cacheUploadData()` when the upload response returns a base64-encoded first frame.

**Original source of the first frame:** The upload handler (`server/routes.ts:156`) extracts it during upload:

```typescript
const firstFrameBuffer = await frameExtractor.extractFirstFrame(req.file.path);
// ...
firstFrame: `data:image/png;base64,${firstFrameBuffer.toString('base64')}`
```

**Does the canvas need masked frames after apply?** No. `MaskingCanvas` only displays the first (unmasked) frame as the background for the mask drawing surface. After apply, `ProcessingStatus` shows progress and a download button. The canvas itself never shows masked/processed frames.

**Does any code read from `global.extractedFrames`?** No. `global.extractedFrames` is written to by `startBackgroundFrameExtraction()` (`videoProcessor.ts:1076-1077`) but **never read by any endpoint or component**. Grep confirms zero `.get()` calls on this map. However, `processVideo()` (the template mask apply path) does its own extraction via `extractAllFramesSequential()` to a staging directory, reads those files into buffers, and processes them — completely separate from the background extraction path.

**Correction to kickoff assumption:** The kickoff doc says the 4b frames endpoint should read from `global.extractedFrames`. While this is technically possible (the data is there after background extraction), the `processVideo` path doesn't use it at all. The background extraction uses `extractFrameBatch()` (batch-based, stores in memory), while `processVideo` uses `extractAllFramesSequential()` (sequential, writes to disk staging dir). These produce different frame sets. The frames endpoint should read from `global.extractedFrames` as the kickoff prescribes, since that's what's available after the background extraction that runs on upload.

---

### Q5. Frame serving endpoint design

**Proposed endpoint:** `GET /api/jobs/:jobId/frames/:n`

- `:n` is 0-indexed frame number (matching `global.extractedFrames` Map keys)
- Returns `Content-Type: image/png` with raw PNG bytes (not JSON envelope)
  - Rationale: directly usable as `<img src="...">`, browser-cacheable, no base64 overhead
- Cache header: `Cache-Control: private, max-age=3600` (matches existing frame endpoints)
- Status codes:
  - `200` + PNG body on success
  - `404` if job not found or frame number out of range
  - `503` with `{ error: "Extraction in progress" }` if `Job.status !== 'ready'` (frames not yet available)
  - `410` with `{ error: "Frames lost on restart" }` if job exists but `global.extractedFrames` has no entry for the jobId (PM2 restart wiped in-memory frames)

**Frame count:** No separate endpoint needed. `Job.source.totalFrames` (already returned by `GET /api/jobs/:jobId`) provides the frame count. The spoke page already has this via `useJob()`.

**No range/batch support in 4b.** The spoke only needs frame 0 (first frame for canvas background). Batch fetching is a future optimization.

---

### Q6. Socket.IO events for hub refetch

**Current emit pattern:** `videoProcessor.ts:999`:

```typescript
this.io.emit('progress', { jobId, ...progress });
```

This fires on every progress update, including the final `{ stage: 'completed', progress: 100 }` (line 392-395).

**`JobContext.tsx` subscription** (lines 50-63): Listens for `progress` events and calls `fetchJob()` when `data.jobId === jobId`:

```typescript
socket.on("progress", handleProgress);
```

So when template-mask processing completes, the chain is:
1. `videoProcessor.processVideo` sets `status: 'completed'` on VideoJob
2. `updateVideoJob` mirrors to Job V2 via `mapVideoJobStatusToJobStatus` (`completed → ready`)
3. `this.io.emit('progress', { jobId, stage: 'completed', progress: 100 })`
4. `JobContext` hears it, calls `fetchJob()`, which fetches `GET /api/jobs/:jobId`
5. Hub re-renders with updated Job V2 data

**Gap:** Even with this chain, `Job.templateMask` won't be populated unless the handler writes to it (Q2 finding). The progress event fires and triggers refetch, but the refetched Job V2 won't have `templateMask` unless we add the writes.

**No new Socket.IO event needed.** The existing `progress` event with `stage: 'completed'` is sufficient. The spoke page can also call `refetch()` via `useJob()` on apply-success for immediate feedback (belt and suspenders — the Socket.IO path handles it too, but the spoke's own callback gives faster UX).

---

### Q7. Backward compatibility during transition

**Coexistence:** The new spoke page at `/jobs/:jobId/template-mask` and legacy `home.tsx` at `/app` are completely separate routes. They share no React state, no context, no global JS state.

**Shared backend handler:** Both URL registrations (`PATCH /internal/mask-processing/:jobId` in `index.ts` and `POST /api/jobs/:jobId/template-mask/apply` in `routes.ts`) delegate to the same `applyTemplateMask()` function. Changes to this function affect both paths.

**Risk assessment:** The proposed changes to `applyTemplateMask` are purely additive — adding a `setTemplateMaskState()` call alongside the existing `updateVideoJob()`. The legacy flow doesn't read from `Job.templateMask`, so writing to it is invisible to `/app`. The `processVideo` modification (writing `status: 'complete'` to templateMask on completion) is similarly additive.

**No inadvertent breakage vectors identified.** The new frames endpoint is net-new (no collision with existing routes). The sessionStorage cache can be kept as a fallback throughout 4b.

---

### Q8. Tests / regression risk

**Existing tests:** None. Grep for `*.test.*` and `*.spec.*` matching `template-mask`, `templateMask`, or `mask-processing` returned zero results.

**Most likely regression mode:** If the `applyTemplateMask` handler changes break argument passing or error handling, both the legacy `/app` flow and the new spoke flow would fail on apply. Mitigation: the changes are a single additive `setTemplateMaskState()` call — no existing arguments or return values change.

**Second regression vector:** If the `processVideo` completion path (where we add `setTemplateMaskState(jobId, { status: 'complete', ... })`) throws, it could prevent the existing `updateVideoJob(jobId, { status: 'completed' })` from executing. Mitigation: wrap the new call in try/catch so it can't block the existing completion flow.

---

## Proposed Implementation Plan

### A. Files to be created

| File | Purpose |
|------|---------|
| None | No new files needed. The spoke page (`template-mask-spoke.tsx`) already exists and will be modified in place. The frames endpoint is added to existing `routes.ts`. |

### B. Files to be modified

| File | Changes |
|------|---------|
| `server/handlers/templateMaskApply.ts` | Add `setTemplateMaskState(jobId, { status: 'applying', maskData, outputSettings, outputDir, completedAt: null })` after the existing `updateVideoJob` call |
| `server/services/videoProcessor.ts` | In `processVideo()` completion block (~line 386), add `storage.setTemplateMaskState(jobId, { status: 'complete', ..., completedAt })`. In failure block (~line 400), add `setTemplateMaskState(jobId, { status: 'failed', ... })`. Both wrapped in try/catch. |
| `server/routes.ts` | Add `GET /api/jobs/:jobId/frames/:n` endpoint. Reads from `global.extractedFrames`, returns PNG bytes. |
| `client/src/pages/template-mask-spoke.tsx` | Replace sessionStorage `getCachedFirstFrame` with a fetch to `GET /api/jobs/:jobId/frames/0`. Switch the apply call from inheriting `ProcessingControls`' legacy URL to directly calling `POST /api/jobs/:jobId/template-mask/apply`. Call `refetch()` from `useJob()` on apply success. |
| `client/src/components/ProcessingControls.tsx` | Change URL from `PATCH /internal/mask-processing/${jobId}` to `POST /api/jobs/${jobId}/template-mask/apply`. Change method from `PATCH` to `POST`. |

### C. Order of operations

1. **Backend: frames endpoint** — Add `GET /api/jobs/:jobId/frames/:n` to `routes.ts`. Reads from `global.extractedFrames`. Test with curl.
2. **Backend: templateMask state writes** — Modify `templateMaskApply.ts` to write `status: 'applying'` to `Job.templateMask`. Modify `videoProcessor.ts` to write `status: 'complete'` on success and `status: 'failed'` on failure. Test with curl (apply, then check `GET /api/jobs/:jobId`).
3. **Frontend: ProcessingControls URL migration** — Switch from `PATCH /internal/mask-processing/:jobId` to `POST /api/jobs/:jobId/template-mask/apply`. This is a one-line change affecting both the legacy `/app` flow and the new spoke.
4. **Frontend: spoke page updates** — Replace sessionStorage firstFrame with fetch to frames endpoint. Add `refetch()` call on apply success. Verify hub tile status updates.
5. **Verification** — `npx tsc --noEmit` at 17, `npm run build` succeeds, smoke test both `/jobs/:jobId/template-mask` and `/app`.

### D. Estimated complexity

- **Total files modified:** 5
- **Estimated lines changed:** ~80-120
  - `templateMaskApply.ts`: +10 lines (import + setTemplateMaskState call)
  - `videoProcessor.ts`: +20 lines (two setTemplateMaskState calls with try/catch)
  - `routes.ts`: +30 lines (frames endpoint handler)
  - `template-mask-spoke.tsx`: +15 lines (replace sessionStorage with fetch, add refetch on apply)
  - `ProcessingControls.tsx`: +2 lines (URL + method change)
- **Nothing unexpectedly large.** All changes are localized.

### E. Risk callouts

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `setTemplateMaskState` throw in videoProcessor blocks completion | Low | High (job stuck in 'applying') | Wrap in try/catch, log error but don't re-throw |
| `global.extractedFrames` empty after PM2 restart | Known | Medium (frames endpoint returns 410) | Document clearly; client shows "frames unavailable" message |
| `ProcessingControls` URL change breaks legacy `/app` | Low | High | Both routes delegate to same handler; test `/app` in smoke test |
| `outputDir` value for `TemplateMaskState` | Low | Low | Use `TempFolderManager.getJobTempFolder(jobId)` which resolves to `spokes/template_mask/<jobId>/` |

### F. Open decisions for the user

1. **Remove sessionStorage `frameCache` in 4b or keep as fallback?**
   - Option A: Remove it entirely — the frames endpoint is the sole source. Simpler, but hard-refresh before extraction completes shows a blank canvas until frames endpoint returns.
   - Option B: Keep it as a fallback — try frames endpoint first, fall back to sessionStorage. More resilient during the transition, cleaned up in 4d.
   - **Recommendation:** Option B (keep as fallback). Low cost, reduces risk.

2. **Should `ProcessingControls` URL change happen in 4b or 4d?**
   - The component is used by both the legacy `/app` and the new spoke. Changing its URL to canonical is safe (same handler) but affects the legacy path.
   - Option A: Change in 4b — legacy flow starts using canonical URL immediately.
   - Option B: Leave for 4d — legacy flow keeps using legacy URL until deletion.
   - **Recommendation:** Option A (change in 4b). It's a one-line change, both URLs call the same handler, and it reduces the number of legacy URL dependencies to clean up later.

3. **Should the spoke page replace `ProcessingControls` with inline apply logic, or keep using the component?**
   - Option A: Keep `ProcessingControls` as-is (just change its URL). Lower risk, reuses tested UI.
   - Option B: Replace with a simpler inline apply button in the spoke. Cleaner separation, but more work.
   - **Recommendation:** Option A (keep component). Scope control — 4b's goal is canonical URL migration and frames endpoint, not a UI rewrite.

### G. Out of scope for 4b

- AI spoke migration (4c)
- Deleting `home.tsx` or legacy routes (4d)
- Moving raw frames to disk (backlog item)
- Job-level "Download all" on hub (4c/4d)
- Fixing `ANTHROPIC_API_KEY` 401 (separate)
- Fixing `temp_extracted/` doc drift (backlog)
- Fixing global progress broadcast (backlog item #6)
- Batch/range frame requests (future optimization)
- `ProcessingControls` UI rewrite or deletion (4d)

---

## Summary

The 4b implementation is straightforward:

1. The frames endpoint reads from `global.extractedFrames` — the data is already there post-extraction.
2. `Job.templateMask` writes are purely additive — insert two calls to `setTemplateMaskState` (one in handler, one in videoProcessor).
3. The URL migration is a one-line change in `ProcessingControls`.
4. The existing Socket.IO → JobContext refetch chain handles hub status updates automatically once `Job.templateMask` is populated.

No architectural surprises. Estimated scope: 5 files, ~100 lines changed.
