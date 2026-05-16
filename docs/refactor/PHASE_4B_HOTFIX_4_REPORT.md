# Phase 4b Hotfix 4 Report — Spoke Independence: AI canvas and inference fall back to raw frames

**Date:** 2026-05-16

---

## Summary

Two spoke-independence violations were fixed:

1. **Canvas mismatch (frontend):** The AI spoke canvas fetched raw frames via `GET /api/jobs/:jobId/frames/0`, but AI inference read from `spokes/template_mask/<jobId>/`. The user drew bboxes on raw pixels while AI processed masked pixels — different images.

2. **Backend hard dependency:** AI inference called `listFrameFiles(jobId)` which defaults to `SPOKE_TEMPLATE_MASK_DIR`. If no template mask was applied, `frameFileNames.length === 0` → 400 error. AI could not run without a template mask, violating spoke independence.

**After this hotfix:** The AI canvas and AI inference both operate on the same frames — masked if a template mask was applied, raw (from `global.extractedFrames`) otherwise.

---

## Files changed

| File | Change type | Summary |
|------|------------|---------|
| `shared/schema.ts` | Modified | Widened `AIRun.inputSource` from `'extracted' \| 'template_mask'` to `'extracted' \| 'template_mask' \| 'raw'` |
| `server/routes.ts` | Modified | (1) Frames endpoint: added `?source=template_mask` query parameter support — reads from `spokes/template_mask/<jobId>/` on disk when specified, returns 404 if no masked frames exist. Default (no param) unchanged — reads raw from `global.extractedFrames`. (2) AI inference handler: added raw-frame fallback from `global.extractedFrames` when no masked frames exist on disk. Sets `inputSource` dynamically (`'template_mask'` or `'raw'`). Preserved `singleFrameFallback` escape hatch. |
| `client/src/pages/ai-spoke.tsx` | Modified | Frame-fetching `useEffect` now tries `?source=template_mask` first; if 404, falls back to raw `frames/0`. Same blob URL pattern with revocation on unmount. |
| `CLAUDE.md` | Modified | Added backlog item #15: download/ZIP handler has the same masked-vs-raw asymmetry. |

---

## Endpoint approach chosen

**Option A — query parameter on existing endpoint.**

`GET /api/jobs/:jobId/frames/0?source=template_mask` reads from `spokes/template_mask/<jobId>/frame_*.png` on disk. Without the param, the endpoint reads from `global.extractedFrames` as before.

**Why:** Less route surface. The source is metadata about which directory to read from — not a fundamentally different resource. The existing frames endpoint handler was straightforward to extend with a conditional branch at the top.

---

## Verification log

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` error count | **17** (unchanged — all in `frameExtractor.ts` and `maskWorker.ts`) |
| `npm run build` | **Success** (built in 2.14s) |
| `singleFrameFallback` preserved | Yes — the `frameBase64` body parameter path is unchanged |
| Download/ZIP handler unchanged | Confirmed — not modified. Asymmetry noted in CLAUDE.md backlog item #15 |
| Template Mask spoke unchanged | Confirmed — `template-mask-spoke.tsx` not modified |

---

## Backend change details

### Frames endpoint (`GET /api/jobs/:jobId/frames/:n`)

Added a branch at the top of the handler:

```
if source === 'template_mask':
  → listFrameFiles(jobId, SPOKE_TEMPLATE_MASK_DIR)
  → return PNG from disk, or 404 if no masked frames
else (no param / default):
  → read from global.extractedFrames (unchanged behavior)
```

Status codes for the `?source=template_mask` path mirror the raw path: 200 (PNG bytes), 404 (no masked frames or frame out of range), 500 (internal error).

### AI inference handler

Added fallback logic before the `singleFrameFallback` check:

```
1. Try listFrameFiles(jobId, SPOKE_TEMPLATE_MASK_DIR)  → frameFileNames
2. If empty, check global.extractedFrames.get(jobId)   → rawFrameMap
3. useRawFrames = !frameFileNames.length && rawFrameMap?.size > 0
4. singleFrameFallback = !frameFileNames.length && !useRawFrames && frameBase64
5. If none of the above → 400 "No frames available"
```

The run record's `inputSource` is set dynamically:
- `'template_mask'` when masked frames used
- `'raw'` when raw frames from `global.extractedFrames` used
- `'extracted'` value exists in the type but is not set by this handler (reserved)

The raw-frame branch iterates `rawFrameMap` keys (sorted numerically), converts each `Buffer` to base64, and feeds it to the same inference pipeline as the masked-frame path. No temp directory write needed — the inference call accepts base64 input.

---

## Surprises

1. **`listFrameFiles` returns `{ dir, files }` not just files.** The destructured `dir` (tempDir) was already used downstream for `path.join(tempDir, fileName)`. The raw-frame fallback doesn't need `tempDir` since it reads from in-memory buffers.

2. **`SPOKE_TEMPLATE_MASK_DIR` was not imported in the frames endpoint section of `routes.ts`.** It was already available in the AI inference section (different part of the same file). Added to the existing import from `frameAccess.ts` at the top of the file.

3. **No new error states in the frontend.** The AI spoke canvas fetch is a simple two-step: try masked → if 404 → try raw. Both paths return the same PNG response shape. The canvas doesn't need to know which source was used.
