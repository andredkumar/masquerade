# Output Round 1 — report: crop to the cone, Keep / Exclude, and the four leftovers (+ O6)

**Status:** built 2026-09-16 on `main` @ `c909d36` per `OUTPUT_ROUND1_KICKOFF.md`, `OUTPUT_ROUND1_RECON.md` and `OUTPUT_ROUND1_SIGNOFF.md` (D1–D7 as taken, O6 in, §3's two clarifications in). **Uncommitted** — Andre writes the runbook, commits (§7 path list), deploys. `tsc` 12 (the same 12) · A3 frozen (`output_settings` written exactly as today) · `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, the offsets loop, extraction, the reuse guard, `automask*.ts`, the worker untouched (`git diff` hunks listed in §6) · no new dependencies · not flag-gated, one `git revert`.

## 0. Headline — the geometry table

Sandbox, `scripts/output_eval/check.ts` (new): upload → a mask PNG built from the job's auto-mask proposal (red outside the keep, black inside — the server's own convention) → `POST …/template-mask/apply` per mode × size → the masked frame 0 the server wrote and the `output_transform.json` beside it. **reference diff** = the source frame masked with the same keep and pushed through the pure `applyOutputTransform` with the sidecar's plan, compared with the server's frame **byte for byte** (PNG output); **placed** = where the sidecar says the keep landed; **pad** = left − right / top − bottom of the recorded placement; **no-resample** = a row of the kept region vs the source; **round-trip** = the sidecar's output → source mapping applied to the keep's corner and the T0 corner; **sidecar == manifest** = `manifest.json.output_transform` and the ten `metadata.csv` columns from the download ZIP equal the sidecar.

| clip | mode | size | output | reference diff (px / max Δ) | placed at (offset) w×h | pad L−R / T−B | no-resample | round-trip Δ | sidecar == manifest | apply ms |
|---|---|---|---|---|---|---|---|---|---|---|
| fan `Normal_Lung` 1536 × 796, keep bbox (268, 0) 996 × 796 | letterbox | original | 1536 × 796 ✅ | **0 / 0** | (270, 0) 996 × 796 | 0 / 0 | **identical** | 0 | ✅ | 2088 (png) |
| | letterbox | 256 | 256 × 256 ✅ | **0 / 0** | (0, 25) 256 × 205 | 0 / −1 | — | 0 | ✅ | 1663 |
| | letterbox | 512 | 512 × 512 ✅ | **0 / 0** | (0, 51) 512 × 409 | 0 / −1 | — | 0 | ✅ | 1581 |
| | letterbox | 640 × 480 | 640 × 480 ✅ | **0 / 0** | (19, 0) 601 × 480 | −1 / 0 | — | 0 | ✅ | 1655 |
| | crop | original | 1536 × 796 ✅ | **0 / 0** | (270, 0) 996 × 796 | 0 / 0 | **identical** | 0 | ✅ | 2029 |
| | crop | 256 | 256 × 256 ✅ | **0 / 0** | (−32, 0) 320 × 256 | 0 / 0 | — | 0 | ✅ | 1639 |
| | crop | 512 | 512 × 512 ✅ | **0 / 0** | (−64, 0) 641 × 512 | 1 / 0 | — | 0 | ✅ | 1618 |
| | crop | 640 × 480 | 640 × 480 ✅ | **0 / 0** | (0, −15) 640 × 511 | 0 / 1 | — | 0 | ✅ | 1679 |
| trap + T0 `ge_e9_2124113685` 1164 × 873, keep bbox (4, 170) 1050 × 541, box (2,109)–(1055,805) | letterbox | original | 1164 × 873 ✅ | **0 / 0** | (57, 166) 1050 × 541 | 0 / 0 | see §5.6 | 0 | ✅ | 518 |
| | letterbox | 256 | 256 × 256 ✅ | **0 / 0** | (0, 62) 256 × 132 | 0 / 0 | — | 0 | ✅ | 514 |
| | letterbox | 512 | 512 × 512 ✅ | **0 / 0** | (0, 124) 512 × 264 | 0 / 0 | — | 0 | ✅ | 514 |
| | letterbox | 640 × 480 | 640 × 480 ✅ | **0 / 0** | (0, 75) 640 × 330 | 0 / 0 | — | 0 | ✅ | 512 |
| | crop | original | 1164 × 873 ✅ | **0 / 0** | (57, 166) 1050 × 541 | 0 / 0 | see §5.6 | 0 | ✅ | 514 |
| | crop | 256 | 256 × 256 ✅ | **0 / 0** | (−120, 0) 497 × 256 | 1 / 0 | — | 1e-14 | ✅ | 514 |
| | crop | 512 | 512 × 512 ✅ | **0 / 0** | (−241, 0) 994 × 512 | 0 / 0 | — | 1e-14 | ✅ | 515 |
| | crop | 640 × 480 | 640 × 480 ✅ | **0 / 0** | (−146, 0) 932 × 480 | 0 / 0 | — | 1e-14 | ✅ | 514 |
| image batch 3 × `bfly_frame_000092` 632 × 1080, keep bbox (0, 26) 632 × 796 | letterbox | original | 632 × 1080 ✅ | **0 / 0** | (0, 142) 632 × 796 | 0 / 0 | see §5.6 | 0 | ✅ | 513 |
| | letterbox | 256 / 512 / 640 × 480 | exact ✅ ×3 | **0 / 0** ×3 | (26, 0) 203 × 256 · (52, 0) 407 × 512 · (129, 0) 381 × 480 | −1 / 0 ×3 | — | 0 | ✅ ×3 | 512–516 |
| | crop | original | 632 × 1080 ✅ | **0 / 0** | (0, 142) 632 × 796 | 0 / 0 | see §5.6 | 0 | ✅ | 516 |
| | crop | 256 / 512 / 640 × 480 | exact ✅ ×3 | **0 / 0** ×3 | (0, −33) 256 × 322 · (0, −66) 512 × 645 · (0, −163) 640 × 806 | 0 / 0, 0 / 1, 0 / 0 | — | 0 | ✅ ×3 | 512–513 |

24 rows: every output has exactly the target dimensions; the server's frame equals the planned transform of the masked source in every pixel; the placement is centred to the floor of a half pixel (asymmetry ≤ 1 px on odd remainders); at Original Size the kept pixels are the source pixels (no resampling); the sidecar's mapping round-trips to floating-point noise; the ZIP's manifest and CSV carry the sidecar. Raw rows: `sandbox/results/2026-09-16_output_round1_geometry_v2.md`. **Perf:** default JPEG apply on the reference clip (348 frames, reuse) `apply.done` **1094 ms** vs the 2B-2 sandbox baseline 1196 ms — the extract costs nothing measurable.

## 1. O6 and Keep / Exclude (Browser pane, 1440 × 900, the reference clip)

| row | result |
|---|---|
| Draw from scratch → toggle unlocked, Rectangle tool, hint "What you draw is blanked; everything else stays." | ✅ |
| draw → Apply controls appear; **Clear Mask → gone** ("Draw a mask on the first frame…"); draw → appear; **Erase All → gone**; draw → appear | ✅ ×5 (O6) |
| lock: with the proposal on the canvas the toggle is disabled, hint "Auto-mask active — the drawn region is blanked."; unlocked after Draw from scratch | ✅ |
| **Exclude** apply of one rectangle: stored PNG = transparent canvas + red rectangle (today's convention, §5.1), server `mask_build masked_px 60 915` (312 × 192 + stroke), `apply.output bbox` = full frame, output: rectangle region mean 0.2 (blanked), frame above it mean 20.3 (intact) | ✅ |
| **Keep** apply of the same drawing: stored PNG = red canvas + black rectangle (95.0 % red), `masked_px 1 161 740`, sidecar `crop (571, 535) 314 × 194`, `offset (611, 301)` = centred, output 1536 × 796: placed region mean 20.3 (kept), above it mean 0 (blanked) | ✅ |
| `_aiOverlay` preview: Exclude shows the red rectangle only; Keep shows the frame tinted red with the rectangle clear | ✅ (screenshots in the session) |
| Exclude byte-identical to today's PNG | by construction (§5.1): the Exclude branch runs the pre-round code with the same constants; no measurable path changed |

## 2. What shipped

| file | change |
|---|---|
| `server/services/outputTransform.ts` (new, 118) | `keepBbox` (alpha = 0 pixels), `normaliseAspectMode` (stale `'stretch'` → letterbox, flagged), `planOutputTransform` (the record + the plan; `'original'` = centre without scaling for both modes, else contain / cover; empty bbox → full frame, `bbox_empty`), `applyOutputTransform` (extract → extend / resize, lanczos3), `outputToSource`, the ten CSV columns |
| `server/services/videoProcessor.ts` (+80 −108) | `ApplyMask.keepBbox`; the plan once per apply in `processFrameBuffersInParallel` (after its size block; returns `{ frames, transform }`), `planApplyOutput` (one `[PERF] apply.output` line per apply: bbox / `'empty'`, mode, size, output, scale, offset, `warn: 'stretch_as_letterbox'` / `'dims_fallback'` / `'prebuild_failed'`); the batch path plans per stack from `prebuiltMask.keepBbox` or its own build and calls `applyOutputTransform` in place of the mode switch + resize; the per-frame path likewise; `processImages` plans once at setup (one extra mask build, §5.4); the sidecar written after the last frame and before `completed` in both applies; **O3:** the three debug writes and `outputDir` / `ensureOutputDir` removed (no `'output'` string left) |
| `server/services/templateMaskFolderManager.ts` (+14) | `saveOutputTransform(jobId, t)` → `spokes/template_mask/<jobId>/output_transform.json` (`.json` is invisible to every frame listing; swept with the frames) |
| `server/services/frameAccess.ts` (+19) | `readOutputTransform(jobId)` — null when absent (pre-round jobs, swept dirs) |
| `server/handlers/frameManifest.ts` (+14) | `outputTransform?` input; ten scalar columns on every CSV row, blank when null |
| `server/routes.ts` (+13) | whole-job manifest `output_transform` + README sentence; run manifest `output_transform` (`null` unless `run.inputSource === 'template_mask'`) |
| `client/src/components/MaskingCanvas.tsx` (+65 −22) | **O2** `maskMode` prop (ref-read at export); Keep = `backgroundColor: 'red'` on the fabric export canvas + black objects (§5.1); a mode flip re-exports the current drawing; **O4** `frameDims` state, the scroller (`absolute inset-0 overflow-auto`) + sized wrapper (`frameW·zoom/100 × frameH·zoom/100`, `mx-auto`) + `transformOrigin: 'top left'` |
| `client/src/components/MaskingTools.tsx` (+41 −2) | "What you draw is: Blanked / Kept" toggle (Radix ToggleGroup) with hint and lock note |
| `client/src/pages/template-mask-spoke.tsx` (+22 −3) | `maskMode` state, locked to Exclude while a session (proposal or accepted cone) exists; **O6** no PNG = no mask (`setMaskData(null)` in `handleMaskUpdate`); **O4** `aside shrink-0`, `main min-w-0`, pane `min-h-0 overflow-auto` |
| `client/src/components/ProcessingControls.tsx` (+5 −7) | Stretch removed from the `Select` and the help; cone-level copy; Original-Size sentence per mode |
| `client/src/components/FrameViewer.tsx` (+7 −7) | **D4** gate `size !== 'original'` |
| `client/src/hooks/useAutomaskProposal.ts` (+11 −1) | **O5** `roundDeltas` (2 decimals, `-0` → `0`) in `buildOutcome` |
| tests (new) | `outputTransform.test.ts` (5: keepBbox / plan / normalise / sharp geometry on a synthetic gradient / CSV), `outputParity.test.ts` (1: `processFrame` vs `processFrameBatch` byte-identical on 4 settings), `outcomeRounding.test.ts` (2) |
| `scripts/output_eval/check.ts` (new, 180) | the §0 driver; `--fresh-per-apply` for image batches (§5.3) |
| docs | this report; `OUTPUT_ROUND1_KICKOFF.md`, `_RECON.md`, `_SIGNOFF.md` |

## 3. Test matrix (kickoff §6) — results

| row | result |
|---|---|
| geometry | §0 — 24 rows, all ✅; the "keep-bbox centre within 1 px" and "padding symmetric ±1 px" rows are read off the validated record (§5.6 explains why not off the pixels) |
| parity | `outputParity.test.ts` 1/1 — per-frame vs batch byte-identical on original / 256 letterbox / 256 crop / custom 200 × 100; plus the §0 reference comparison proves the batch path against the pure plan on 24 real rows |
| edges | **stale `'stretch'`** → sidecar `mode: letterbox`, 256 × 256, one `apply.output {…, warn: 'stretch_as_letterbox', received: 'stretch'}` line ✅ · **all-red mask** → `apply.output {bbox: 'empty'}`, sidecar `bbox_empty: true`, crop = full frame, output 1536 × 796 with 0 non-black px, apply completes ✅ · **overhanging keep** (E9, `w_bottom` 1275 on 1164): the proposer's keep is already clipped to the T0 box, so the bbox `(4, 170) 1050 × 541` never leaves the frame; the clip rule is unit-tested (`keepBbox` / `clipToFrame`) |
| co-indexing | **not run — prod, Andre** (the sandbox's AI services point at a closed port); the frame list and its order are unchanged by this round |
| Keep / Exclude | §1 |
| O3 | `ls output/` = 0 entries before and after 38 applies in the session; nothing creates the dir any more (§5.5) |
| O4 | 1440 × 900, 1536-px clip at 75 %: `aside` 320 px, `main` 1120, canvas box 1152 × 597 laid out inside a 1070-px scroller (`scrollWidth 1152` → scrolls), Apply reachable; at 100 % the scroller holds 1536 × 796 and scrolls both ways; a rectangle dragged at the higher zoom lands under the pointer (screenshot) — **Andre's real window is the human check** |
| O5 | untouched Accept → Apply on the fan job → `automask.outcome … "deltas":{"d_half_angle_deg":0,"d_apex_px":0,"d_top_px":0,"d_arc_px":0,"d_top_width_px":0,"d_depth_px":0}` — no exponent anywhere in the raw JSON; `outcomeRounding.test.ts`: 3.9e-14 → `0`, 1.23456 → `1.23`, null kept |
| invariants | `tsc` 12 (5 + 7); tests: outputTransform 5, outputParity 1, outcomeRounding 2, automaskShape 6, automaskOutcome 4, automaskHold 2, automask.endpoint 13, automaskWorkerClient 5, automask.fixture 2 (+1 skipped, PHI dir unset), applyPaths 8, saveProcessedImage 11, imageBatchFrames 6, frameAccess 8 — all green; `npm run build` → `dist/index.js` 263 KB + `dist/automaskWorker.js` 52 KB; `git diff --stat` on the untouched list = 0; `apply.done` 1094 ms vs 1196 ms |

## 4. Sandbox numbers worth keeping

| measurement | value |
|---|---|
| `apply.done`, reference clip, 348 frames, JPEG q90, reuse, letterbox original | 1094 ms (2B-2 baseline 1196 ms) |
| the same with PNG output | 2029–2088 ms (PNG encoding, not the crop) |
| E9 single-frame DICOM apply | 512–518 ms |
| `apply.mask_build` on a 2× (3072 × 1592) export PNG | 52 ms (Exclude), 176 ms (Keep, 1.16 M masked px) |

## 5. Findings and deviations (for Andre to strike or keep)

1. **Today's export background was never black.** `updateMaskFromCanvas` fills the temp canvas black, then hands it to `new fabric.Canvas(...)`, whose `renderAll` clears it before drawing — so every mask PNG the app has ever sent has a **transparent** background with red objects, which the server reads as unmasked (`a > 128` fails). Harmless and unchanged for Exclude. For Keep, the red background therefore has to be fabric's own `backgroundColor` (the only fill `renderAll` preserves); a `fillRect` version silently masked nothing — caught by the §1 Keep row, fixed, re-verified.
2. **The retina export path ran in this matrix.** The Browser pane's tab reported `devicePixelRatio` 2 this time (it was 1 in the 2B-2 session), so the Keep / Exclude PNGs were 3072 × 1592 for a 1536 × 796 canvas; `createTransformedMask` resized them and the masks applied correctly. The 2B-2 sign-off backlog item (2× payloads) stands; nothing in this round touches it.
3. **Image batches apply once per job** (backlog item 30: the apply reclaims the uploaded originals), so the driver re-uploads before every mode × size (`--fresh-per-apply`). Not a regression; the image rows in §0 are eight uploads.
4. **`processBatchesInParallel` (`videoProcessor.ts:1044`) is dead code** — defined, never called. The recon's `:1081-1116` citation was that method; the live size logic is the condensed block in `processFrameBuffersInParallel` (`:1275-1289`), whose `'original'` fallback is **512 × 512**, not 632 × 1080. The `dims_fallback` warn (sign-off §3.2) sits on the live path; the dead method is untouched. Deleting it is a backlog item (it carries none of the 12 tsc errors).
5. **`keepBbox` is called at four sites, not three:** video setup (`prebuiltMask`), image setup (one extra `createMaskRgbaBuffer` per image apply, so the sidecar can be written after the loop — the per-stack build inside the batch derives the same bbox), the batch fallback, the per-frame path. One function, one unit test.
6. **The "no-resample row" check is confounded for non-rectangular keeps** (a row across the bbox crosses pixels the mask blanks; the DICOM and image rows report "57 / 54 bytes differ" for that reason) — the reference comparison, which masks the source the way the apply does, is the proof and reads 0 on every row; the fan rows, whose row lies inside the cone, read "identical". The column stays in the driver for a rectangular keep (`--mask rect`).
7. **Empty-bbox output is all black by design** (the mask blanked everything; the fallback preserves the frame geometry so the apply completes and the manifest is consistent).
8. **`output/` exists on prod from earlier boots** (the old constructor created it); nothing writes there now. An `rmdir output` is a harmless runbook line; do not commit the directory (it is empty, so git ignores it anyway).

## 6. Where `videoProcessor.ts` changed (hunks, old line numbers)
`:14` import · `:38` `ApplyMask.keepBbox` · `:52`, `:57-67` `outputDir` / `ensureOutputDir` removed · `:495` call site destructures `{ frames, transform }` · `:530` sidecar write (video) · `:820` image setup plan · `:961` sidecar write (images) · `:1253` return type · `:1268` `dims_fallback` warn · `:1275` the once-per-apply plan · `:1341` return + `planApplyOutput` · `:1686` per-stack bbox + plan · `:1756-1786` → `applyOutputTransform` · `:1872-1880` debug write removed · `:2036-2066` → `applyOutputTransform` · `:2077-2096` debug writes removed. `buildApplyMask` (`:628-672`), `createMaskRgbaBuffer` (`:2113+`), `createTransformedMask` (`:181-262`) and the offsets loop (`:1695-1740`) have no hunk.

## 7. Runbook facts

- **Commit by explicit paths:** `server/services/{outputTransform,videoProcessor,frameAccess,templateMaskFolderManager}.ts`, `server/handlers/frameManifest.ts`, `server/routes.ts`, `server/services/__tests__/{outputTransform,outputParity,outcomeRounding}.test.ts`, `scripts/output_eval/check.ts`, `client/src/components/{MaskingCanvas,MaskingTools,ProcessingControls,FrameViewer}.tsx`, `client/src/hooks/useAutomaskProposal.ts`, `client/src/pages/template-mask-spoke.tsx`, `docs/refactor/OUTPUT_ROUND1_{KICKOFF,RECON,SIGNOFF,REPORT}.md`, `CLAUDE.md`. Not `output/`, `uploads/`, `temp_extracted/`, `spokes/`, `.DS_Store`, `scripts/automask_spike/dicoms.json`, `.idea/`.
- **What changes in every download from this deploy:** every frame is cropped to the kept region first; Letterbox at Original Size centres it without scaling (pixel scale identical across a dataset), other sizes scale it to fit; Centre Crop fills the output (identical to Letterbox at Original Size); Stretch is gone from the UI (a stale client's `'stretch'` is applied as letterbox and logged once); `manifest.json` gains `output_transform` and `metadata.csv` ten columns (`x_src = crop.x + (x_out − offset.x) / scale.x`); the README says so.
- **Behaviour change:** Clear Mask and Erase All now disable Apply until something is drawn (O6). The Keep / Blanked toggle defaults to Blanked, is locked while an auto-mask proposal or accepted cone is on the canvas, and unlocks after Draw from scratch.
- **Jobs applied before the deploy** have no sidecar → `output_transform: null` in their manifests and blank CSV columns — correct.
- **Verify:** upload a GE E9 `.dcm` → Apply (Letterbox, Original Size) → the masked frame shows the trapezoid centred on black → download → `manifest.json` has `output_transform {mode:'letterbox', size:'original', crop, offset, output, resampled:false}` and `metadata.csv` ends in `crop_x,…,output_h`; `pm2 logs masquerade --raw | grep '"stage":"apply.output"'` shows one line per apply; `ls output/` unchanged across an apply; Clear Mask → Apply disappears.
- **`apply.done` on the reference clip** vs the 8.5 s prod baseline (sandbox: 1094 vs 1196 ms).
- **Rollback:** one `git revert`; sidecars left behind are ignored by the reverted code (a `.json` beside the frames).

## 8. Handoff — outside the sandbox
1. **O4 on Andre's real window** (1440-px wide, the 1536-px clip): sidebar visible, Apply reachable, drawing lands under the pointer at 50 / 150.
2. **Co-indexing** (kickoff §6): an AI run on a cropped output → overlays line up (Round 2B U6 row, repeated) — needs the GPU services.
3. Prod smoke per §7, then the download Andre started this round with: the cone centred, even black.

---
> Output Round 1 built per `OUTPUT_ROUND1_RECON.md` + sign-off; report `OUTPUT_ROUND1_REPORT.md`. Headline: 24 geometry rows (fan / E9 trapezoid + T0 / image batch × letterbox, crop × original, 256, 512, 640 × 480) — exact dims, server frame == the planned transform of the masked source byte for byte, no resampling at Original Size, round-trip 0, sidecar == manifest; O6 and Keep / Exclude verified in the pane (the Keep fix in §5.1 is the one thing that changed after the first pass); `apply.done` 1094 vs 1196 ms. Eight findings in §5; uncommitted; commit by the §7 path list. Next: runbook → deploy → your O4 window and the co-indexing row.
