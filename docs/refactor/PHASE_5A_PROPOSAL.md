# Phase 5A Proposal — AI-Spoke Canvas Polish

**To:** Andre
**From:** Claude Code
**Status:** Proposal for review (no application code edited yet)
**Baseline:** `main`, `tsc` = 17 (10 `frameExtractor.ts`, 7 `maskWorker.ts`)

This proposal confirms-or-corrects each recorded hypothesis against the **current `main` source**, then describes the minimal fix, the shared-component blast radius, and a browser-observable verification step. Per the kickoff, no code has been edited.

---

## Summary of confirmed diagnoses

| Bug | Recorded hypothesis | Verdict after reading code | Fix surface |
|-----|---------------------|----------------------------|-------------|
| 1 | `MaskingCanvas` has no per-spoke mode scoping; needs a `mode` prop | **Confirmed** (with a nuance — the AI-spoke instance also discards its own output) | `MaskingCanvas.tsx` + `ai-spoke.tsx` + `template-mask-spoke.tsx` |
| 2 | Coordinate-space/scaling mismatch at draw time | **Corrected** — the inference-bound bbox math in `CommandInput.tsx` is correct and self-consistent. The visible "small/offset" is an artifact of Bug 1's surface, not a coordinate bug. | None (resolved by Bug 1) — see caveat |
| 3 | `runId`-less or unwired download handler | **Confirmed** — `onContinueToDownload` is wired to a no-op in `ai-spoke.tsx`. Matches the kickoff's "silent = unwired handler" prediction. | `FrameViewer.tsx` + `ai-spoke.tsx` (frontend-only) |

---

## Bug 1 — `MaskingCanvas` exposes the template-mask toolset inside the AI spoke

### Files & lines
- `client/src/components/MaskingCanvas.tsx:8-15` — props interface (`firstFrame, selectedTool, onMaskUpdate, zoom, onZoomChange, maskData`). **No `mode`/context prop exists.**
- `client/src/components/MaskingCanvas.tsx:287-394` — tool dispatch on `selectedTool` (rectangle/circle/polygon/brush/eraser/pan/select); rectangle draw emits a green mask rect via `updateMaskFromCanvas()` → `onMaskUpdate`.
- `client/src/pages/ai-spoke.tsx:338-345` — the AI-spoke instance:
  ```tsx
  <MaskingCanvas
    firstFrame={firstFrame}
    selectedTool="rectangle"
    onMaskUpdate={() => {}}
    zoom={75}
    onZoomChange={() => {}}
    maskData={maskData}
  />
  ```
- `client/src/pages/template-mask-spoke.tsx:234-241` — the template-mask instance (the path that must not regress).

### Confirmed root cause
`MaskingCanvas` is a single shared component with no concept of which spoke it is rendering in. The AI spoke instantiates it with `selectedTool="rectangle"`, so it renders the full template-mask **mask-rectangle** affordance (green fill `rgba(34,197,94,0.3)`, the masking semantics), which is the wrong affordance for the AI spoke. Confirmed: there are exactly two consumers (`template-mask-spoke.tsx`, `ai-spoke.tsx`).

**Nuance worth recording:** the AI-spoke instance also passes `onMaskUpdate={() => {}}`, so whatever the user draws on this surface is **discarded** — it never reaches inference. The functional AI prompt geometry is drawn elsewhere, in `CommandInput.tsx` (see Bug 2). So this canvas is currently a non-functional, wrong-mode drawing surface. That is exactly what makes the AI spoke confusing.

### Proposed minimal fix
Add an explicit, defaulted mode prop to `MaskingCanvas` (no URL sniffing inside the shared component, per the constraint):

```ts
// MaskingCanvas.tsx props
mode?: 'template-mask' | 'ai-bbox';   // default 'template-mask'
```

- **Default `'template-mask'`** so the template-mask spoke needs *zero* changes and is held byte-for-byte constant. (Optionally pass `mode="template-mask"` explicitly from `template-mask-spoke.tsx` for readability — behavior identical either way.)
- In `'ai-bbox'` mode, scope the rendered affordances to bbox drawing only: a single rectangular prompt with the AI/bbox visual treatment, and suppress the mask-specific toolset (circle/polygon/brush/eraser and the green mask-fill semantics).
- `ai-spoke.tsx:338-345` passes `mode="ai-bbox"`.

This is the minimal correct fix because the divergence is purely "which affordances render," and a single defaulted enum prop expresses exactly that without altering the template-mask default path.

> **Open product question for review:** Bug 1 and Bug 2 together suggest the AI spoke has *two* drawing surfaces — the dead main `MaskingCanvas` and the live `CommandInput` preview. The cleanest 5A-scoped fix may be to make the main `MaskingCanvas` the real bbox surface (mode `ai-bbox`, wired `onMaskUpdate`), **or** to remove the dead main surface and keep `CommandInput` as the single prompt surface. I default to the former (mode prop) in this proposal because it matches your recorded hypothesis and is the smaller blast radius, but I want your call before implementing — see Bug 2.

### Blast radius
- `MaskingCanvas` is shared. The new prop **defaults to template-mask behavior**, so the template-mask spoke's draw/apply/preview/download path is unchanged. The only file that opts into new behavior is `ai-spoke.tsx`.

### Verification (browser, post-deploy)
- Open the AI spoke → the main canvas offers **only** a bbox-prompt affordance (no mask rectangle/circle/polygon/brush/eraser).
- Open the template-mask spoke → full mask toolset, draw/apply/preview/download all behave exactly as before.

---

## Bug 2 — "AI bbox renders small and offset to the side"

### Files & lines
- `client/src/components/CommandInput.tsx:644-664` — the **actual** functional bbox surface: a `<canvas>` overlaid `absolute inset-0` on a sidebar frame preview `<img class="block w-full h-auto">`.
- `client/src/components/CommandInput.tsx:229-241` — `syncCanvasSize` sets canvas pixel size from the displayed `getBoundingClientRect()` and records `displaySize`.
- `client/src/components/CommandInput.tsx:431-443` — `toImagePixelBox`: `sx = imgW/displaySize.w`, `sy = imgH/displaySize.h`, where `imgW/imgH = videoMetadata.width/height` (source-video pixels).
- `client/src/components/CommandInput.tsx:476-491` — submit sends `bbox: pixelBox` (source-pixel space) to `POST /api/jobs/:jobId/ai/runs`.
- `client/src/pages/ai-spoke.tsx:338-345` — the large main `MaskingCanvas` whose `onMaskUpdate` is a no-op (the dead surface).

### Confirmed root cause (recorded hypothesis corrected)
The recorded hypothesis was a **draw-time coordinate-space/scaling mismatch** in the bbox that goes to inference. Reading the code, that is **not** present:

- The functional prompt bbox is captured in `CommandInput`, in display space relative to the preview's bounding rect, then scaled to source-video pixels by `toImagePixelBox` using the same `displaySize` the pointer coords were measured against. The transform is self-consistent: display → `(imgW/displaySize.w, imgH/displaySize.h)` → source pixels, clamped to `[0,imgW]×[0,imgH]`. This is the space `inference.json` (`imageWidth/imageHeight`) and the FrameViewer SVG `viewBox` expect. No mismatch.

The visible "**small and offset to the side**" symptom is best explained by **Bug 1's architecture**, not a coordinate transform:
- The real, functional bbox drawing lives in the **narrow sidebar** `CommandInput` preview ("to the side", physically small because the sidebar is ~288px wide), while the large central area shows the wrong-mode, output-discarding `MaskingCanvas`. To a user the prompt box looks tiny and pushed to the side because the *useful* surface is the small sidebar one.

So Bug 2 is most likely **not a separate code defect** — it is the perceptual consequence of Bug 1. Fixing Bug 1 (making the main canvas the real `ai-bbox` surface, or removing the dead one) resolves the "small/offset" perception.

### Proposed fix
- **No standalone coordinate change.** Do **not** alter the stored coordinate space — `inference.json` and the FrameViewer overlay `viewBox` depend on source-pixel coords, and that path is already correct.
- Bug 2 is resolved as a side effect of the Bug 1 decision: whichever surface becomes the single AI bbox surface inherits `CommandInput`'s already-correct scaling (if we consolidate onto `CommandInput`) or must reuse the same `videoMetadata.width/height ÷ displaySize` transform (if we promote the main `MaskingCanvas`).

### Caveat (honest limitation, per kickoff §6)
I cannot fully disambiguate the *visual* symptom from source alone — there is no GPU/browser in the agent environment. The code shows the inference-bound math is correct; the remaining question is purely "which on-screen surface is the user looking at," which is a layout/Bug-1 question. **This bug's fix should be confirmed by your browser reproduction step before I treat it as closed.** If your repro shows an *actual* mis-scaled box on the live preview (not just the small-sidebar perception), that would point at `syncCanvasSize` timing (canvas sized before the img has laid out → `displaySize` stale), which I would then fix as a draw-time `displaySize` recompute — but I do not see evidence for that in the static source and will not pre-emptively "fix" a non-bug.

### Blast radius
- If consolidated onto `CommandInput`: contained to the AI spoke; no shared-component change.
- The documented crop/stretch overlay-drift parking-lot item stays parked (out of scope per §4).

### Verification (browser, post-deploy)
- Draw a bbox in the AI spoke → it sits where drawn at correct scale on the displayed frame.
- Run inference → the FrameViewer overlay aligns with the drawn region (proves the stored source-pixel coords still match `viewBox`).

---

## Bug 3 — "Continue to Download" button does nothing on click

### Files & lines
- `client/src/components/FrameViewer.tsx:60-64` — props: `onContinueToDownload: () => void`.
- `client/src/components/FrameViewer.tsx:616-619` — the button: `onClick={onContinueToDownload}`.
- `client/src/pages/ai-spoke.tsx:331-335` — **root cause**:
  ```tsx
  <FrameViewer
    jobId={jobId}
    onContinueToDownload={() => setViewerActive(false)}   // no-op for download
    onBackToInference={() => setViewerActive(false)}
  />
  ```
- `client/src/components/FrameViewer.tsx:32-44` — per-frame label payload carries `runId: string | null` (added 4d-1).
- `client/src/components/FrameViewer.tsx:283-287, 395-399` — existing precedent for using the per-frame `runId` to build canonical run-scoped URLs.
- `server/routes.ts:1742-1817` — canonical single-run download endpoint **exists and works**: `GET /api/jobs/:jobId/ai/runs/:runId/download` → streams a ZIP (masks/, overlays/, manifest.json).

### Confirmed root cause
The button is wired, but to a handler that only closes the viewer (`setViewerActive(false)`) — it performs **no download**. This is exactly the kickoff's "**silent (no error) = unwired handler**" branch. The backend endpoint already exists; this is purely a missing frontend wire-up. **Frontend-only fix is viable** — no backend change needed.

### Proposed minimal fix (frontend-only)
The canonical download endpoint is per-`runId`. `FrameViewer` already has `runId` on every per-frame label, so it can determine the run(s) present without any new backend lookup:

1. In `FrameViewer`, derive the set of distinct `runId`s present across the loaded inference labels (reusing the same per-frame `runId` already consumed at lines 285/399).
2. Wire the button to trigger the canonical download for the run(s):
   - **Single run (the contract / common case — one shape per Run, §5):** `window.open('/api/jobs/${jobId}/ai/runs/${runId}/download', '_blank')` (same pattern as the working template-mask download in `ProcessingStatus.tsx:93`).
   - **Multiple runs:** trigger one download per distinct `runId` (sequentially). This stays within "one shape per Run" — it does not compose multiple bboxes into one artifact; it just downloads each existing run's bundle.
3. Keep `onContinueToDownload` for its existing nav side-effect if desired, but the download itself must originate from data `FrameViewer` already holds.

This mirrors the 4d-1 principle: thread the **existing** `runId` already present in the runs hierarchy rather than adding a backend lookup or a silent fallback.

> **Scope note for review:** the multi-run case nudges toward the §5 boundary. If you'd rather 5A only guarantees the **single-run** download (the stated contract) and explicitly defers multi-run bundling, say so and I'll scope the fix to single-run + a clear disabled/explanatory state when >1 run is present. My default is single-run-correct, multi-run = N sequential downloads.

### Why not a backend change
A frontend-only fix does **not** require any legacy fallback or silent 404: `runId` is already in the viewer's payload and the endpoint already exists. So the §3.2 backend exception does not apply — no backend edit is justified.

### Blast radius
- `FrameViewer`'s only consumer is `ai-spoke.tsx` (confirmed via grep). No shared-component risk. Template-mask download path (`ProcessingStatus.tsx` → `/template-mask/download`) is untouched.

### Verification (browser, post-deploy)
- Run inference in the AI spoke, open the viewer, click **Continue to Download** → the single-run AI ZIP (masks/overlays/manifest) downloads; DevTools Console shows **no error**.

---

## Observed but out of scope (noted, not fixed)

- **AI-spoke main `MaskingCanvas` `onMaskUpdate={() => {}}` (ai-spoke.tsx:341)** — the main surface discards drawing entirely. Surfaced here because it shapes the Bug 1/Bug 2 decision; the actual fix is whatever you green-light for Bug 1.
- **`zoom={75}` / `onZoomChange={() => {}}` hardcoded in the AI spoke (ai-spoke.tsx:342-343)** — zoom controls in the AI-spoke canvas are inert. Not in the three-bug scope; flag only.
- Crop/stretch overlay coordinate drift (documented parking-lot item) — untouched unless Bug 2's repro proves otherwise.
- All 5B/5C items (`tempFolderManager.ts` rename, `SWEEP_TARGETS`, debug endpoints, `MemStorage`/Postgres, `ANTHROPIC_API_KEY` prod fix, `FrameViewer.tsx` subcomponent split) — untouched.

---

## Constraints check

- **Template-mask no-regress:** Bug 1's `mode` prop defaults to `'template-mask'`; template-mask spoke unchanged (or passes its mode explicitly with identical behavior).
- **Frontend-only:** all three fixes are frontend-only. Bug 3's backend endpoint already exists; no backend edit.
- **`tsc` stays 17:** new prop is optional/defaulted; no changes to `frameExtractor.ts`/`maskWorker.ts`.
- **No 5B/5C scope creep; no multi-bbox composition:** confirmed (multi-run download = N single-run bundles, not composition).
- **No non-bug fixes:** Bug 2's recorded hypothesis is corrected to "perceptual artifact of Bug 1 / no coordinate defect found in source," pending your browser repro.

---

## Open questions for your amendment before implementation

1. **Bug 1/2 surface decision:** promote the main `MaskingCanvas` to the real `ai-bbox` surface (mode prop, wire `onMaskUpdate`), **or** remove the dead main surface and keep `CommandInput` as the single prompt surface? My default: mode prop (matches your hypothesis, smaller blast radius).
2. **Bug 3 multi-run:** single-run-only (defer multi) vs. N sequential downloads for multiple runs? My default: N sequential.
