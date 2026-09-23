# Output Round 1 — recon (step 1; stop here for sign-off)

**Status:** recon, 2026-09-16, against `main` @ `c909d36` (clean tree apart from Andre's `ITEM22_REPORT.md` edit and the untracked `scripts/sandbox/`). Answers `OUTPUT_ROUND1_KICKOFF.md` §5 in order with `file:line` from this tree; §8 lists what the kickoff assumed that the code contradicts, §9 the decisions sign-off has to take, §10 the do-not-touch list. **No production code written.**

## 1. Where output settings live (§5.1)

- **Type:** `OutputSettings` `shared/schema.ts:216-227` (`aspectRatioMode: 'stretch' | 'letterbox' | 'crop'` `:226`); a second, optional copy of the same union on `MaskData.aspectRatioMode` `:178` (set by the canvas, read by nothing server-side).
- **It is not per-request only.** `jobs.output_settings` jsonb exists (`shared/schema.ts:61`; `migrations/0000_hard_cable.sql:41`; `VideoJob.outputSettings: unknown` `:123`, insert schema `:146`) and the apply handler **writes it on every apply**: `server/handlers/templateMaskApply.ts:60` `storage.updateVideoJob(jobId, { maskData, outputSettings })` → `pgStorage.ts:421` (create leaves it null `:73`; read-back `:473`).
- **Readers:** `routes.ts:731` (whole-job manifest `output_format`), `:1441-1445` (`inference.json` exposes `{ size, aspectRatioMode }` for the viewer's warning gate, `FrameViewer.tsx:242-248`), `:1910` (run manifest format). The processor never reads it back — `'original'` takes `job.width/height` from storage (`videoProcessor.ts:1101-1105`, with a **632 × 1080 fallback** if those are null; never hit today, but it is the wrong size if it ever is).
- **Consequence (A3 frozen, kickoff §4):** keep writing `output_settings` exactly as today (a stale `'stretch'` is stored as received and read as letterbox); the new `output_transform` does **not** go into that column. It goes into a sidecar, `spokes/template_mask/<jobId>/output_transform.json`, next to the masked frames both downloads read (`routes.ts:852` `tempDir`; the run download's masked-first base frames), same 24 h lifecycle, no schema change — the 2B-1 `t0.json` / `automask.json` pattern (§9 D1).

## 2. The two resize sites (§5.2)

| | batch / "3D" path | per-frame path |
|---|---|---|
| function | `processFrameBatch` `videoProcessor.ts:1593-1857` | `processFrame` `:1859-2110` |
| reached from | `processVideo` `:1300` (with `prebuiltMask`), `processImages` `:852` and `:1164` (no prebuilt) | **only** the per-image fallback after a batch throws, `processImages` `:914-928` |
| Sharp from pixels | `:1748-1754` | `:2028-2034` |
| mode switch | `:1758-1777`, `resizeOptions = { kernel: 'lanczos3' }` `:1762` | `:2038-2058`, no kernel (sharp's default **is** lanczos3 — no behavioural split) |
| `'original'` gate | dims equality `:1780-1782` (`outputSize` ≠ volume dims) | `size !== 'original' && w > 0 && h > 0` `:2061-2066` |
| encode | `:1794-1798` (JPEG q90 / PNG level 3) | `:2071-2075` (same constants) |
| extras | — | debug writes `:2077-2096` (**and a third at `:1877`**, `debug_frame_0_original.png`, before masking) |

`outputSize` is computed by the two callers the same way (`processImages` `:798-819`: `'original'` → first image's dims; `processVideo` `:1081-1116`: `'original'` → `job.width/height`), so the two gates agree except for a custom size equal to the frame (batch skips, per-frame resizes to identity) — no visible difference. One `outputTransform(bbox, frameW, frameH, settings)` replaces `:1756-1786` and `:2036-2066`; the encoders stay.

**Where the mask is built once and where the bbox goes.** `processVideo` `:476` `prebuiltMask = await this.buildApplyMask(jobId, extractedBuffers[0], maskData)` → `ApplyMask` `:32-39` (`maskRgba`, `maskedOffsets`, `maskedPixels`, `width`, `height`) → `:501` → `processFrameBuffersInParallel` `:1252` → `:1304` → `processFrameBatch(…, prebuiltMask)` `:1606`, consumed at `:1668-1678`; the per-stack fallback `:1682` `createMaskRgbaBuffer(firstTask.maskData, …)` is what the **image path always takes** (`:852` passes no prebuilt). Per-pixel reads: offsets loop `:1712+`, alpha scan `:1728` (batch), `:1977` (`processFrame`). The keep bbox (alpha = 0 pixels, clipped to the frame) is derived: **once per apply right after `:476`** for video/DICOM (a 1.2 M-alpha pass, ~5 ms, carried in the frame task), beside `:1682` for the image fallback (per stack, images are small), beside `:1963` in `processFrame`. `buildApplyMask` `:628-672` is not edited.

## 3. Mask contract (§5.3)

- `buildApplyMask` `:643` → `createMaskRgbaBuffer` `:2113-2140`: **if `maskData.canvasDataUrl` is present it is the only input** — `createMaskFromBase64` `:2137` → `createTransformedMask` `:181-262` reads `originalCanvasDimensions` (`:192-193`) and `imageDisplayInfo` / `imageDimensions` (`:208-212`) to size the resize chain, then `convertToRgbaBuffer`'s `r > 150 && a > 128` threshold `:285`. Neither `type` nor `coordinates` is touched on this path. `calculateTransformationMatrix` `:73-150` reads canvas dims and display info only (`:77-79`).
- `coordinates` / `type` are read in two places only: (a) the **percentage fallback** `:2142-2200+` (`switch (maskData.type)` `:2156`, coordinates `:2160-2168`), reachable only when `canvasDataUrl` is absent; (b) `processFrame` `:1902-1941`, where `pixelCoords` is computed, clamped and logged and **never used for masking** — the mask there comes from `createMaskRgbaBuffer` at `:1963`.
- **When is `canvasDataUrl` absent?** `updateMaskFromCanvas` always sets it (`MaskingCanvas.tsx:1140` → the `maskData` literals below it), except: `handleClearMask` sends `{ type: 'rectangle', coordinates: [], opacity: 75 }` (no PNG); `enableEraserTool` sends `canvasDataUrl: ''`; and the canvas-context-failure branch sends normalised coordinates. So the coordinate fallback is live exactly for **Apply after Clear / Erase All** — `coordinates: []` destructures to `undefined`s and masks nothing, and Apply is enabled because `maskData` is non-null: a download of unmasked frames labelled as masked. Pre-existing, out of this round's scope, filed (§8.6).
- **Decision for O2:** Keep mode never needs to force `type: 'freeform'` — every drawn object exports a PNG and every server path with a PNG ignores `type`/`coordinates`. What it does need is a rule for the no-PNG case: with the toggle on and no objects, the spoke treats `maskData` without `canvasDataUrl` as "no mask" (`setMaskData(null)`), so the Exclude-semantics fallback can never run under a Keep toggle (§9 D3).

## 4. Manifest builders (§5.4)

- Shared core `server/handlers/frameManifest.ts:54-89` is **per-frame only**: `frames[]` `:57-77`, CSV headers `:82`, rows `:83-85`. Per-job fields are each wrapper's: whole-job `routes.ts:741-751` (`manifest` object) + README `:766-808`; run `:1922-1940`.
- **One implementation:** `PerFrameManifestInput` gains `outputTransform?: OutputTransform | null` (`:23-30`); the CSV adds ten scalar columns (`crop_x, crop_y, crop_w, crop_h, scale_x, scale_y, offset_x, offset_y, output_w, output_h`; blank when null) at `:82-85` — pandas-friendly, no JSON-in-CSV (§9 D2); each wrapper adds `output_transform` to its manifest object (`:741`, `:1922`) from `readOutputTransform(jobId)` (new, in `frameAccess.ts`, the home of the frame-dir helpers), and the whole-job README gets its sentence at `:789-796`. The run download applies it only when `run.inputSource === 'template_mask'` (`:1928`); raw runs get `null` (§9 D5). This changes manifest bytes deliberately (Phase 6 D1 was already broken deliberately by item 27's plan).
- **A third geometry consumer the kickoff does not list:** `inference.json` (`routes.ts:1424-1445`: `imageWidth = job.width` `:1433`; `exposedOutputSettings` `:1442-1445`) and the viewer's gate `FrameViewer.tsx:242-248` — "letterbox keeps the source aspect, so the source-space viewBox aligns" (`:236-241`). Under O1 that premise holds only at `original` size (the keep is re-centred inside the source dims, output dims = source dims, and the AI bbox is drawn on that same output frame, `ai-spoke.tsx:67`); at any other size the letterboxed content is the **keep's** aspect. The gate should become `size !== 'original'` — one line at `:247`, part of O1 (§9 D4).

## 5. Sidebar (§5.5)

Chain: `template-mask-spoke.tsx:346` `div.flex h-[calc(100vh-65px)]` → `:348` `aside.w-80 … overflow-y-auto` (**no `shrink-0`**: it shrinks to min-content when the row overflows) + `:386` `main.flex-1 flex flex-col` (**no `min-w-0`**: a flex item's default `min-width: auto` is its widest descendant) → `:404` `div.flex-1 p-6 relative` → `MaskingCanvas.tsx:1390` `div.h-full relative … overflow-hidden` → `:1463-1469` `div.w-full h-full flex items-start justify-center` with `transform: scale(zoom/100) translate(pan)`, `transformOrigin: 'center top'` → fabric's own wrapper `div.canvas-container` (fabric 5.3.0 `_initWrapperElement`, `fabric.js:12600-12610`: inline `width: W px; height: H px`, W/H = the frame from `setDimensions` `:335-338`) → the two canvases. The wrapper's inline width is the min-content width that propagates up the chain; the transform changes nothing in layout.

Fix, layout only: (1) `:348` `aside` + `shrink-0`; (2) `:386` `main` + `min-w-0`, `:404` pane `overflow-auto`; (3) the element that gets the sized wrapper is `:1463` — a new `div` of `frameW·zoom/100 × frameH·zoom/100` (a `frameDims` state set where `:335` runs), `mx-auto`, containing the existing transformed `div` with `transformOrigin: 'top left'`; pan stays the inner translate. The zoom and pan overlays are `absolute` children of `:1390` and keep working; `handleFitToScreen` `:1335-1337` sets 100 % without measuring anything; fabric's `getPointer` reads the upper canvas's bounding rect (2B-2 plan §2), so drag/draw mapping is unchanged.

## 6. Test drivers (§5.6)

| row | driver | where |
|---|---|---|
| geometry | new `scripts/output_eval/check.ts`: upload (curl) → build a `maskData` PNG from the job's proposal `keep` (red outside, black inside, via `renderKeepMask` + sharp) → `POST …/template-mask/apply` → decode `spokes/template_mask/<id>/frame_000000.*` → dims, non-black bbox centre vs output centre, padding symmetry, transform round-trip of the T0 corner; the **no-resample** row runs with `format: 'png'` (JPEG q90 is not byte-identical by construction) and compares a row of the extracted keep with the source frame | sandbox, unattended (≈ 24 applies, ≤ 10 s each) |
| parity | structural (both sites call the one `outputTransform`) **plus** a tsx test that calls `processFrame` and `processFrameBatch` on the same synthetic image and hashes the output — `processFrame` is otherwise reachable only through the image-batch exception path | unattended |
| edges | all-red mask PNG → `apply.output {bbox:'empty'}` + full frame; `aspectRatioMode:'stretch'` via curl → letterbox + one log line; the E9 trapezoid (w_bottom 1275 on 1164, `b4cc93bb`-style) → clipped bbox | unattended |
| co-indexing | needs the GPU services (`AI_SERVICE_URL` points at a closed port in the sandbox) | **prod, Andre** (Round 2B U6 repeated) |
| Keep / Exclude | Browser pane: same rectangle drawn under Exclude before/after → `mask_data.canvasDataUrl` hash identical; Keep → output keeps the rectangle only; lock with a proposal present (`AUTOMASK_UI=1` in the sandbox), unlocked after Draw from scratch; `_aiOverlay` preview both modes | Browser pane |
| O3 | `ls output/` before / after an apply | unattended |
| O4 | emulated 1440 × 900, the 1536-px reference clip at 75 %: sidebar 320 px, Apply reachable; 150 % scrolls inside `<main>`; drag / draw at 50 / 150 land where the pointer is (`javascript_tool` readouts, as in 2B-2) | Browser pane, then **Andre's real window** |
| O5 | unit test on `buildOutcome` (`useAutomaskProposal.ts:139`) + one sandbox outcome line | unattended |
| invariants | `tsc` 12; the six automask test files; `git diff --stat` on the untouched list; `apply.done` on the reference clip vs 8.5 s ± 10 % (sandbox: vs its own 1.2 s baseline, prod: the runbook) | unattended / prod |

## 7. Effort (§5.7)

| item | days |
|---|---|
| O1: `outputTransform` + keep bbox at three sites + sidecar + manifest/CSV/README + viewer gate + `check.ts` | 1.0 |
| O2: toggle + export swap + lock rule + no-PNG rule | 0.5 |
| O3 / O4 / O5 | 0.1 / 0.3 / 0.1 |
| matrix + report | 0.5 |
| **total** | **2.5** vs ~2 |

Over by about half a day: **cut O2 first** (kickoff §5.7); the parity row's private-method test is the next thing to drop (the structural argument stands).

## 8. What the kickoff assumed that the code contradicts (or adds)

1. `output_settings` **is stored and written on every apply** (`templateMaskApply.ts:60`), with three readers (§1) — the transform therefore needs its own home (the sidecar), and the settings keep being written unchanged.
2. The per-pixel read the kickoff cites at `:1977-1987` is **`processFrame`, the fallback**; the batch path reads at `:1712-1740`, and the image path never has a prebuilt mask (`:852`) — the bbox has to be computed at three sites, not one.
3. There are **three** debug writes, not two: `:1877` (`_original`, before masking, in `processFrame`) plus `:2081` / `:2093`. O3 removes all three and the now-dead `outputDir` / `ensureOutputDir` (`:57-67`, no other use).
4. The two `'original'` gates differ in kind (size string vs dims equality) — harmless today, unified by the shared function; the `632 × 1080` fallback at `:1103-1104` is a latent wrong-size path worth a `[PERF]`-style warn, not a fix.
5. `processFrame` reads `coordinates` (`:1902-1941`) but only for a logged clamp — the PNG is the only masking input everywhere it exists (§3); Keep mode does not need `freeform` forcing.
6. **Apply after Clear / Erase All produces unmasked output** (§3): `maskData` without a PNG, Apply enabled, coordinate fallback masks nothing. Pre-existing; file as a `CLAUDE.md` backlog item (candidate fix: Clear → `setMaskData(null)`), not this round's.
7. The viewer's letterbox premise breaks at non-original sizes under O1 (§4) — a one-line gate change belongs in O1.
8. Mixed-dimension image batches (backlog 29): the bbox comes from image 0's mask and may exceed a smaller image — the kickoff's clip rule covers it; say so in the report.

## 9. Decisions for sign-off

| # | decision | recommendation |
|---|---|---|
| D1 | where `output_transform` persists | sidecar `spokes/template_mask/<jobId>/output_transform.json`, written by both apply loops after the frames, read by `frameAccess.readOutputTransform` |
| D2 | CSV shape | ten scalar columns, blank when null |
| D3 | Keep toggle with no PNG (Clear / Erase All) | treat as no mask (`setMaskData(null)`); Exclude keeps today's behaviour and the hazard is filed separately |
| D4 | viewer gate | `FrameViewer.tsx:247` → `size !== 'original'`, inside O1 |
| D5 | run download | `output_transform: null` unless `run.inputSource === 'template_mask'` |
| D6 | budget | 2.5 d as scoped, or cut O2 to land in 2 |
| D7 | `'stretch'` | stays in the server-side union and in `MaskData.aspectRatioMode`; removed from the `Select` (`ProcessingControls.tsx:235`) and the help copy (`:223-225`, `:241`) only |

## 10. Do not touch
`buildApplyMask` `:628-672`, `createMaskRgbaBuffer` `:2113+`, `createTransformedMask` `:181-262`, the offsets loop `:1695-1740`, extraction, the reuse guard, `automask*.ts`, the worker, `MaskingCanvas` export except the O2 swap (`:1101-1102` background fill, `:1123` / `:1129` object fill), storage / schema / migrations, `package.json`.

---
> Recon approved with D1–D7 as recommended (or as amended) → build Output Round 1 per `OUTPUT_ROUND1_RECON.md`, `tsc` 12, A3 frozen, `buildApplyMask` untouched, stop after `OUTPUT_ROUND1_REPORT.md` for the runbook.
