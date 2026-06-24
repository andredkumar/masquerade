# Phase 5A Report — AI-spoke canvas fixes (relocation + download wiring)

**Implemented against:** `PHASE_5A_AMENDMENT.md` (which overrides the proposal's
Open Question 1 default). Frontend-only across all three fixes. No backend edit.

---

## Summary

| Bug | Root cause (confirmed) | Fix shape |
|-----|------------------------|-----------|
| 1 | AI spoke rendered a dead, wrong-mode `MaskingCanvas` (`selectedTool="rectangle"`, `onMaskUpdate` no-op, hardcoded `zoom={75}`) in the main canvas area, while the *functional* bbox surface lived in the cramped ~288px sidebar `CommandInput`. | Relocate `CommandInput`'s existing bbox surface into the main canvas area via a React portal — move + resize, zero functional changes. Remove the dead `MaskingCanvas` instance. |
| 2 | No standalone coordinate defect (`toImagePixelBox` math confirmed correct). The "small/offset" symptom was the perceptual artifact of Bug 1. The *one* real risk introduced by moving to a larger container: a stale `getBoundingClientRect()` latched before the bigger frame lays out. | Add a `ResizeObserver` on the frame `<img>` so `displaySize` always tracks the actual rendered box at the new size. No math change. |
| 3 | `onContinueToDownload` was wired to a no-op (`() => setViewerActive(false)`); no download was ever triggered. Backend endpoint `GET /api/jobs/:jobId/ai/runs/:runId/download` already exists. | Derive the per-frame `runId` (4d-1) from the inference payload and `window.open` the canonical run-scoped download URL — same pattern as the working template-mask download in `ProcessingStatus.tsx`. |

---

## Files touched (3, all client-side)

### 1. `client/src/components/CommandInput.tsx` (785 lines)

The bbox drawing surface (instruction copy + tool toolbar + `relative inline-block`
`<img>`/`<canvas>` block + "Clear box" control) was lifted verbatim into a
`drawingSurface` const and is now portaled into the host the AI spoke provides.
**All drawing logic is unchanged** — same pointer handlers (`onMouseDown/Move/Up`,
`onClick`, `onDoubleClick`), same `syncCanvasSize`/`displaySize` measurement, same
`toImagePixelBox` display→source-pixel transform, same `handleSubmit` POST to
`/api/jobs/:jobId/ai/runs`.

- `import { createPortal } from "react-dom";`
- `CommandInputProps`: added `canvasContainer?: HTMLElement | null;`
- Destructured `canvasContainer` in the component signature.
- **Bug 2 hardening:** the `syncCanvasSize` effect now also attaches a
  `ResizeObserver` to `imgRef.current` and disconnects on cleanup; deps widened to
  `[syncCanvasSize, canvasContainer, firstFrameBase64]` so the observer reattaches
  when the portaled frame mounts.
- Return restructured to a fragment: the sidebar keeps the modality selector,
  command input + Run AI button, and status area; the surface renders via
  `createPortal(drawingSurface, canvasContainer)` when a host is present, with an
  inline fallback (`{!canvasContainer && drawingSurface}`) if no host is supplied.

**Load-bearing constraint honored:** the `<canvas>` is `absolute inset-0` over the
`<img>` element itself, and the `<img>` keeps `block w-full h-auto select-none`.
The canvas therefore overlays the exact frame element `displaySize` is measured
from — not a surrounding/letterboxed container — so the transform stays correct at
the larger size with no coordinate math change.

### 2. `client/src/pages/ai-spoke.tsx` (340 lines)

- Removed `import MaskingCanvas` and dropped `MaskData` from the `@shared/schema`
  type import.
- Removed the now-dead `maskData` state and `handleAiMaskGenerated` (they only fed
  the removed `MaskingCanvas`). The AI overlay preview is unaffected — it is shown
  by `CommandInput`'s own `overlayDataUrl`/`previewSrc` on the relocated surface.
- Added `const [canvasHost, setCanvasHost] = useState<HTMLDivElement | null>(null);`
  (callback ref, so the portal target re-renders into existence once mounted).
- `CommandInput`: `onMaskGenerated={() => {}}` and new `canvasContainer={canvasHost}`.
- Replaced the dead `MaskingCanvas` block in `<main>` with the portal host:
  `<div ref={setCanvasHost} className="flex-1 min-h-0 overflow-auto p-6 flex items-start justify-center" data-testid="ai-canvas-host" />`.

### 3. `client/src/components/FrameViewer.tsx` (658 lines)

- Added a `distinctRunIds` memo collecting distinct non-null `runId`s across
  `inferenceData.frames` (the 4d-1 per-frame label payload).
- Added `handleContinueToDownload` (`useCallback`): `window.open` the run-scoped
  download URL for each distinct run, then call `onContinueToDownload()`. Single
  run is the normal 5A case (one shape per Run); >1 run falls back to N sequential
  single-run downloads — **no multi-run UI, no run-picker, no composition.**
- Footer button `onClick` changed from the `onContinueToDownload` no-op to
  `handleContinueToDownload`.

---

## Blast radius

- **Only consumer of `CommandInput`** is `ai-spoke.tsx` — the portal change cannot
  affect any other surface.
- **`MaskingCanvas` consumers after the change:** `template-mask-spoke.tsx` only
  (grep-confirmed). The AI spoke no longer references `MaskingCanvas` except in a
  comment. The shared-component regression risk on the template-mask spoke is
  therefore eliminated; `template-mask-spoke.tsx` is byte-for-byte unchanged.
- No backend edit. No change to `frameExtractor.ts`/`maskWorker.ts`.

## `tsc` — stays at exactly 17

`npx tsc --noEmit` → **17 errors**, identical to the pre-5A baseline:
- `server/services/frameExtractor.ts` — 10 (dcmjs decl, possibly-undefined
  `pixelBuffer`, Uint16Array iteration, unknown `e`/`error`).
- `server/services/maskWorker.ts` — 7 (union-array indexing, `feather` prop).

Zero errors in `CommandInput.tsx`, `ai-spoke.tsx`, or `FrameViewer.tsx`.
(Note: `tsconfig` has no `noUnusedLocals`/`noUnusedParameters`, so the removed
state introduced no new diagnostics.)

---

## Out of scope (observed, untouched per amendment)

Inert `zoom`/`onZoomChange` on `MaskingCanvas`, crop/stretch overlay aspect drift
(`aspectMaybeOff` gate already warns), and all 5B/5C items. No multi-bbox work.

---

## Browser verification steps (run post-deploy on 3.136.48.97)

**Bug 1 / relocation**
1. Open a job → AI spoke. The bbox drawing surface (toolbar + frame + canvas)
   now renders in the **main canvas area**, over the frame as backdrop.
2. The sidebar `CommandInput` shows modality selector + text input + Run AI only —
   it no longer holds the drawing surface.
3. Open the template-mask spoke → its `MaskingCanvas` behaves exactly as before.

**Bug 2 / scale at new size**
1. Draw a bbox on the now-centered surface → it sits exactly where drawn, at
   correct scale on the displayed frame.
2. Resize the browser window / collapse-expand panels → the box stays aligned
   (ResizeObserver re-measures; no stale-rect mis-scale).
3. Type a label, click **Run AI** → the returned overlay in `FrameViewer` aligns
   with the drawn region (proves stored source-pixel coords still match the SVG
   `viewBox` at the new size).

**Bug 3 / download**
1. Run inference, open the viewer → click **Continue to Download**.
2. The single-run AI ZIP (masks/overlays/manifest) downloads from
   `/api/jobs/:jobId/ai/runs/:runId/download`.
3. Console shows no error.
