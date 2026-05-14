# Phase 4b Report — Template Mask Spoke Migration

**Date:** 2026-05-14
**Phase:** 4b of 4 (4a routing/hub, **4b Template Mask spoke**, 4c AI spoke, 4d cleanup)

---

## Summary

Phase 4b migrates the Template Mask spoke from a hybrid wrapper (sessionStorage + legacy URLs) to a real spoke page that:
- Fetches the first frame from a new `GET /api/jobs/:jobId/frames/:n` endpoint
- Calls the canonical `POST /api/jobs/:jobId/template-mask/apply` URL
- Writes `Job.templateMask` state so the hub tile reflects apply status
- Handles all frames endpoint error states (404/503/410) with distinct UX

---

## Files changed

| File | Change type | Summary |
|------|------------|---------|
| `CLAUDE.md` | Modified | Added Phase 4a detailed landing notes, hotfix 1/2 details, five backlog entries (in-memory frames, ANTHROPIC_API_KEY, temp_extracted drift, hub download deferral, three extraction paths) |
| `server/routes.ts` | Modified | Added `GET /api/jobs/:jobId/frames/:n` endpoint (~45 lines). Reads from `global.extractedFrames`, returns PNG bytes with appropriate status codes (200/400/404/503/410). |
| `server/handlers/templateMaskApply.ts` | Modified | Added `setTemplateMaskState(jobId, { status: 'applying', ... })` call after `updateVideoJob`. Import of `TempFolderManager` added. Wrapped in try/catch. |
| `server/services/videoProcessor.ts` | Modified | Added `setTemplateMaskState` calls in both `processVideo` and `processImages`: `status: 'complete'` on success, `status: 'failed'` on failure. All four calls wrapped in try/catch to avoid blocking existing flow. |
| `client/src/components/ProcessingControls.tsx` | Modified | Changed URL from `PATCH /internal/mask-processing/${jobId}` to `POST /api/jobs/${jobId}/template-mask/apply` (canonical). One-line change. |
| `client/src/pages/template-mask-spoke.tsx` | Rewritten | Replaced sessionStorage `getCachedFirstFrame` with fetch to `GET /api/jobs/:jobId/frames/0`. Added `FrameStatus` state machine with distinct UX for loading/ready/extracting/not_found/gone/error. Calls `refetch()` from `useJob()` on apply start. Blob URL cleanup on unmount. Removed `getCachedMetadata` fallback (uses `job.source` exclusively). |
| `client/src/pages/upload.tsx` | Modified | Removed `cacheUploadData` import and callsite. Upload no longer populates sessionStorage cache. |
| `docs/refactor/PHASE_4B_RECON.md` | Created (in 4b.0) | Reconnaissance report answering 8 questions with implementation plan |

---

## New endpoint

### `GET /api/jobs/:jobId/frames/:n`

Serves raw extracted frames as PNG from the in-memory `global.extractedFrames` store.

| Status | Condition | Body |
|--------|-----------|------|
| 200 | Success | PNG bytes (`Content-Type: image/png`, `Cache-Control: private, max-age=3600`) |
| 400 | Invalid frame number (NaN, negative) | `{ error: "Invalid frame number" }` |
| 404 | Job not found, or frame number out of range | `{ error: "Job not found" }` or `{ error: "Frame not found" }` |
| 503 | Job status is `'extracting'` | `{ error: "Extraction in progress" }` |
| 410 | Job exists but in-memory frames are gone (server restart) | `{ error: "Frames are no longer available. The server may have restarted." }` |

**curl example:**
```bash
curl -s -o frame0.png http://localhost:5000/api/jobs/<jobId>/frames/0
# → 200 with PNG body

curl -s http://localhost:5000/api/jobs/<jobId>/frames/999
# → 404 { "error": "Frame not found" }
```

---

## `Job.templateMask` state lifecycle

```
User clicks Apply
  → templateMaskApply.ts sets { status: 'applying' }
  → fires processVideo / processImages

Processing completes
  → videoProcessor sets { status: 'complete', completedAt: <ISO> }
  → Socket.IO progress event fires with stage: 'completed'
  → JobContext refetches GET /api/jobs/:jobId
  → Hub Tile 1 reads job.templateMask.status === 'complete' → shows "Applied"

Processing fails
  → videoProcessor sets { status: 'failed' }
```

The `outputDir` field is populated with `TempFolderManager.getJobTempFolder(jobId)`, which resolves to `spokes/template_mask/<jobId>/` (confirmed: `TEMP_BASE = SPOKE_TEMPLATE_MASK_DIR`).

---

## Verification log

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` error count | **17** (unchanged — all in `frameExtractor.ts` and `maskWorker.ts`) |
| `npm run build` | **Success** (built in 1.81s) |
| No new files with tsc errors | Confirmed: only `frameExtractor.ts` (10) and `maskWorker.ts` (7) |
| `frameCache.ts` still exists | Yes — retained because `ai-spoke.tsx` imports it (AI spoke is out of scope for 4b). `cacheUploadData` callsite removed from `upload.tsx`, so the cache is never populated. AI spoke gets `null` from `getCachedFirstFrame`, which it already handles. |
| AI spoke unchanged | Confirmed: `ai-spoke.tsx` not modified |
| Legacy `/app` route intact | `home.tsx` untouched, `ProcessingControls` URL change affects both paths via same handler |

---

## Surprises and notes

1. **`frameCache.ts` not deleted.** The implementation spec said to delete it, but `ai-spoke.tsx` imports `getCachedFirstFrame` and `getCachedMetadata`. Since the constraint says "AI spoke untouched", the file is retained. The `cacheUploadData` write callsite is removed from `upload.tsx`, so the cache is effectively dead (never populated). 4c will migrate the AI spoke to the frames endpoint and `frameCache.ts` can be deleted then.

2. **`global.extractedFrames` is only written, never previously read.** The new frames endpoint is the first consumer. The map is populated by `startBackgroundFrameExtraction()` (line 1076-1077 of `videoProcessor.ts`). The `processVideo()` path does its own separate extraction — these are independent (see "Three extraction paths" backlog entry in CLAUDE.md).

3. **Blob URL for canvas.** The spoke page converts the PNG response to a blob URL (`URL.createObjectURL`) rather than a base64 data URL. This avoids the ~33% overhead of base64 encoding. The blob URL is revoked on component unmount to prevent memory leaks.

4. **`outputDir` confirmed correct.** `TempFolderManager.getJobTempFolder(jobId)` returns `spokes/template_mask/<jobId>/` via `TEMP_BASE = SPOKE_TEMPLATE_MASK_DIR`. No wrapper needed.

---

## Carry-forwards for 4c

- Migrate AI spoke from sessionStorage `frameCache` to frames endpoint (same pattern as 4b's template-mask spoke)
- Delete `client/src/lib/frameCache.ts` once AI spoke no longer imports it
- AI spoke URL migration (legacy AI endpoints → canonical)
