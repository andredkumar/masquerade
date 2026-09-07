# Auto-mask Round 1 — Proposal: cone proposer for the template-mask spoke

**Date:** 2026-09-04. **Kickoff:** `~/Downloads/AUTOMASK_ROUND1_KICKOFF.md` (recon + offline spike + proposal; no production code).
**Tree examined:** `main` @ `dc45954` (items 22 and 28 landed after the kickoff's `21e588b`; the working tree also carries an uncommitted CLAUDE.md item-30 note and an ITEM22_REPORT edit from another session — both left untouched).
**Written for:** the agent that implements Round 2, and for Andre's sign-off. Everything below is either a `file:line` fact, a measured number, or a decision labelled as such.

**Nothing in `server/`, `client/`, `shared/` was changed.** The only additions are the throwaway spike under `scripts/automask_spike/` (its `out/` is gitignored because the DICOM contact sheets carry burned-in PHI) and this document. `tsc` untouched (12), A3 untouched, apply path untouched.

---

## 0. Decisions made in this round (the agent's, per Andre's instruction)

| # | Decision | Basis |
|---|---|---|
| D1 | **Design = T0 + T1 only.** T0 is the DICOM `(0018,6011)` box used as a *hard outer bound* for T1, never as the mask by itself. | §3: T0 alone leaks 38–62 % of the reference-masked area (the box contains the grayscale bar, depth scale, vendor label and the bottom annotation). T0-bounded T1 lifts the colour-Doppler still from IoU 0.72 → 0.84 and cuts its leak 17.8 % → 0.6 %. |
| D2 | **T2 (static-overlay subtraction, as specified) — measured, not adopted.** | §4: moves the accept count by 0; IoU lower than T1 on 6 of 8 clips; the furniture it targets is already removed by the density/opening step. |
| D3 | **T2max (temporal max-projection support) — measured, not adopted, kept on the backlog.** | §4: fixes the dim-far-field over-blank on 3 clips (z7 0.56 → 0.74) but makes 5 clips slightly worse and also moves the accept count by 0. Revisit with Andre's clips. |
| D4 | **Placement = (a) in-process Node, pure-TS core under `shared/automask/`, run in a `worker_threads` worker, computed lazily on first request and cached on disk.** | §5.1. Measured front half 5–11 ms decode+downscale + 1–11 ms JS on one thread here; whole T1 32–68 ms in Python; ≤ 250 ms budgeted on the t3.large. No new runtime, no PHI over the network. |
| D5 | **Sign-off gate before Round 2 code:** re-run `scripts/automask_spike/automask_spike.py` on the kickoff's seven clips with *Andre's* drawn masks as references. Proceed if ≥ 5/7 positive clips meet the tolerant criterion (§4.2). | §3.0: none of the kickoff's named clips were on this machine; the references used here are agent-authored. |
| D6 | The pre-committed strict rule (IoU ≥ 0.97 **and** leak ≤ 0.5 %) is reported as committed — **0 clips pass it on any tier** — and a boundary-tolerant secondary criterion is reported next to it, labelled post-hoc. | §4.2 explains why 0.5 % is below the reference's own boundary uncertainty (±3–10 px). |

Bottom line for §1 of the kickoff (*"well enough that the user usually rubber-stamps it"*): **not yet "usually", but "usually close".** On 11 positive clips the frame-1 proposer is rubber-stampable (tolerant) on 3, within one edge-drag (IoU 0.88–0.95) on 5, fail-closed-but-useless (over-blanks 26–41 % of the cone) on 2, and withheld correctly on all 3 negative controls. Worst core leak on any positive clip is 4.3 % of the reference-masked area, and it sits below the bottom arc of a Butterfly cone (black + depth scale), not on a text region.

---

## 1. Recon answers (§4 of the kickoff)

### Q1 — Mask representation, client → server

- The spoke POSTs one `maskData` object plus `outputSettings` and `samplingFps` to `POST /api/jobs/:jobId/template-mask/apply` — `client/src/components/ProcessingControls.tsx:94-98`. Type `MaskData` at `shared/schema.ts:174-214`.
- `maskData` carries **both** a shape (`type: 'rectangle'|'circle'|'polygon'|'freeform'`, `coordinates` in **absolute frame pixels**) **and** a raster: `canvasDataUrl`, a PNG data URL of the mask painted red on black at canvas size — built in `updateMaskFromCanvas`, `client/src/components/MaskingCanvas.tsx:846-1132` (temp canvas `:906-952`, `toDataURL('image/png')` `:952`; shapes `:975-1112`).
- **Canvas space = frame pixel space, 1:1.** The Fabric canvas is resized to the frame's natural size and the image placed at scale 1 — `MaskingCanvas.tsx:225-256` ("DIRECT PIXEL MAPPING", `canvas.setDimensions({width: imgWidth, height: imgHeight})`, `scaleX: 1`). Zoom is a CSS `transform: scale()` on the container, `MaskingCanvas.tsx:1279`, so it never touches coordinates. The payload still ships `imageDisplayInfo {scale: 1, offsetX: 0, offsetY: 0}` and `imageDimensions` (`:875-891`); the server's `calculateTransformationMatrix` (`server/services/videoProcessor.ts:72-130`) then computes an identity transform.
- Every drawn object is unioned: all non-image objects are cloned and filled red (`:924-947`), so multiple shapes → one raster.

**Consequence for the proposer:** emit a `MaskData` whose `canvasDataUrl` is a frame-sized PNG (the *complement* of the keep-region painted red) with `type: 'freeform'`, bbox `coordinates`, `canvasWidth/Height = frame`, `imageDisplayInfo` identity. That is exactly what the canvas produces today; Apply cannot tell the difference. The shape parameters (§5.2) travel alongside so the client can also render an *editable* object.

### Q2 — `buildApplyMask` input contract

- `buildApplyMask(jobId, firstFrame: Buffer, maskData: MaskData)` — `server/services/videoProcessor.ts:627-676`. It reads frame dimensions from frame 0 (`:637-644`), calls `createMaskRgbaBuffer(maskData, width, height)` (`:642`) and flattens alpha > 0 into the `Uint32Array` offset list (`:652-663`).
- `createMaskRgbaBuffer` — `videoProcessor.ts:2106`: **if `maskData.canvasDataUrl` is present it is the raster path** (`:2121-2131` → `createMaskFromBase64`, which base64-decodes the PNG, resizes it to frame size with `fit: 'fill'`/lanczos3 and thresholds the red channel into alpha). Without it, the legacy *percentage* coordinate fallback runs (`:2134-2200`) — note this fallback interprets `coordinates` as 0–1 fractions, **not** pixels, so a proposer must never send shape-only `maskData`.
- **Yes, a raster path exists and it is the primary one.** The proposer's output becomes input to `buildApplyMask` via `canvasDataUrl`; no parallel path.

### Q3 — Saved templates

- **None.** `grep -rn "localStorage|savedMask|saveTemplate|templateLibrary|reuseMask"` over `client/src`, `server`, `shared` finds only `client/src/lib/frameCache.ts:6-31` — a `sessionStorage` cache of the *first frame*, superseded by the frames endpoint (spoke comment at `client/src/pages/template-mask-spoke.tsx:59`).
- `maskData` is persisted **per job**: `jobs.mask_data` (`shared/schema.ts:60`) via `storage.updateVideoJob(jobId, { maskData, outputSettings })` and `TemplateMaskState.maskData` (`shared/schema.ts:304-306`), both written in `server/handlers/templateMaskApply.ts:60-71`. No cross-job reuse exists.
- **Format decision for the proposal (does not preclude a library):** a small JSON with the parametric shape (§5.2). A template library later is "store this JSON keyed by a layout fingerprint"; nothing here fights that.

### Q4 — Frame access for the proposer

- MP4: `startBackgroundFrameExtraction` (`videoProcessor.ts:1363`) → `extractAllFramesSinglePass` (`server/services/frameExtractor.ts:297-333`) writes `temp_extracted/<jobId>/frame_%06d.png`, 1-indexed, one ffmpeg run with `-vsync 0 -compression_level 1` (`:319`). The `bg_extract.first_frame_on_disk` probe (`videoProcessor.ts:1407-1420`) polls for `frame_000001.png`; the PERF round measured it at ~1–2 s on the reference clip (CLAUDE.md status table). The full set is on disk when `status: 'ready'` is written (`videoProcessor.ts:1561`), after the parity reconcile (`:1531-1550`).
- DICOM: the branch at `frameExtractor.ts:206-218` loops `i = 0..totalFrames-1`, `extractDicomFrame(i)`, and writes `frame_${i+1}` — **frame 1 first**, synchronously.
- Image batch: no extraction; frame *n* is `uploads/<fileList[n].filename>` (`server/routes.ts:1634-1657`, item 28) — **original bytes, JPEG or PNG**.
- **Raw frame format.** MP4 frames: PNG, 8-bit RGB (ffmpeg's png encoder picks `rgb24` for `yuv420p` input; the single pass sets no `-pix_fmt`, the first-frame helper sets `rgb24` explicitly, `:353`). DICOM mono: **8-bit single-channel** PNG — `processDicomPixelDataHelper` writes `sharp(raw, {channels: 1}).png()` (`frameExtractor.ts:669-675`), with 16-bit data windowed to 8 (`:617-650`). DICOM RGB (`SamplesPerPixel 3`): the single-frame path uses `channels: 3` (`:893` region); the *multiframe* helper is `channels: 1` only — an RGB multiframe DICOM would extract wrongly. Pre-existing, out of scope; filed in §8.
- The proposer must therefore accept 1- or 3-channel PNG and JPEG; it converts to 8-bit gray at 4× downscale and never depends on channel count.

### Q5 — DICOM `SequenceOfUltrasoundRegions (0018,6011)`

- The dcmjs dictionary bundled in the app has the whole group: `(0018,6011) SequenceOfUltrasoundRegions SQ`, `(0018,6012) RegionSpatialFormat`, `(0018,6014) RegionDataType`, `(0018,6016) RegionFlags`, `(0018,6018) RegionLocationMinX0`, `(0018,601A) RegionLocationMinY0`, `(0018,601C) RegionLocationMaxX1`, `(0018,601E) RegionLocationMaxY1` — `node_modules/dcmjs/build/dcmjs.js:8483` (dictionary literal).
- `DicomMetaDictionary.naturalizeDataset` — the call the app already makes at `frameExtractor.ts:49-50`, `:375-376`, `:689-690` — exposes it as `dataset.SequenceOfUltrasoundRegions: Array<{RegionSpatialFormat, RegionDataType, RegionFlags, RegionLocationMinX0, RegionLocationMinY0, RegionLocationMaxX1, RegionLocationMaxY1, PhysicalUnitsXDirection, PhysicalDeltaX, PhysicalDeltaY, ReferencePixelX0, ReferencePixelY0, …}>`. Verified live with `scripts/automask_spike/dcmjs_regions.mjs` on three of the files. **The current code never reads it** (zero hits for `SequenceOfUltrasoundRegions|00186011` under `server/`).
- **On-hand DICOMs (18, all GE LOGIQ E9, Explicit VR LE):** every one carries exactly one region.

| Files | Frame size | Region box (x0,y0)-(x1,y1) | SpatialFormat / DataType | ReferencePixel |
|---|---|---|---|---|
| 8 single-frame mono, 993 KB | 1164×873 | (2,109)-(1055 or 1057, 805) | 1 (2D) / 1 (tissue) | (527, 22) |
| 2 single-frame RGB, 2.9 MB | 1164×873 | (2,109)-(1057,805) | 1 / **2 (colour flow)** | (528, 21) |
| 8 multiframe mono, 67–318 f | 1054×802 | (0,40)-(1053,736) | 1 / 1 | (527, −1) |

- **Fact that changes the design:** the box is the *image data area as GE defines it* and it contains the grayscale bar, the depth scale, the `LOGIQ E9` label and the bottom body-part annotation. As a mask on its own it keeps all of that (leak 38–62 % vs the reference, §4). It is exact as an **outer bound** — and that is how D1 uses it. `ReferencePixelX0/Y0` is the sector apex hint for curved probes; not needed for these linear/trapezoid images but worth passing into the fan fit later.

### Q6 — Image-batch jobs

- Same spoke, same contract. `applyTemplateMask` (`server/handlers/templateMaskApply.ts:82-90`) routes `job.jobType === 'images'` to `processImages(jobId, uploads/<fileList[i]>, maskData, outputSettings)` (`videoProcessor.ts:747`) with the identical `maskData`. The canvas paints image 0 from the item-28 branch of the frames endpoint (`routes.ts:1634-1657`).
- The proposer handles them as the single-frame case (T1 on image 0). Caveats already on the backlog and unchanged by this round: item 29 (mixed-dimension batches apply one absolute-pixel mask to every image) and item 30 (uploads reclaimed after Apply, so the canvas 410s on re-open).

### Q7 — Where the spoke first paints the canvas

- `fetchFirstFrame` in `client/src/pages/template-mask-spoke.tsx:64-109`: on 200 it `setFirstFrame(blobUrl)` and `setFrameStatus("ready")` (`:69-73`). `MaskingCanvas` then paints in its `[firstFrame]` effect, `MaskingCanvas.tsx:222-256`, inside the `fabric.Image.fromURL` callback (canvas sized there).
- **The natural moment:** immediately after the 200 in `fetchFirstFrame` — fire `GET …/template-mask/proposal` in parallel with painting; when it resolves, hand the proposal to the canvas.
- **Existing hook worth reusing:** `MaskingCanvas` already renders an *external* `maskData.canvasDataUrl` as a 50 %-opacity, non-selectable overlay image tagged `_aiOverlay` — `MaskingCanvas.tsx:258-283`. That is exactly a "proposed, not drawn" visual and it is driven by the `maskData` prop the spoke already passes (`template-mask-spoke.tsx:342`). It is an *image*, not an editable object, which is what makes Accept/Edit a real design point (§5.3).

---

## 2. The spike (`scripts/automask_spike/`, throwaway)

Python 3.10 + numpy/OpenCV (installed for this round; `imageio-ffmpeg`'s bundled binary is the only ffmpeg on this Mac). `cv2.setNumThreads(1)` so every number is single-thread.

**Pipeline (T1, frame 1 only), all at 4× downscale (`DOWN = 4`):**
1. gray → *not-black* (`> 3`; the background is pure 0 on every clip measured, corners 50th/90th pct = 0) → local density over an 11×11 window → `density > 0.35` is "image content" (thin text lines score ≤ 0.27 and drop out).
2. open 5 → close 7 → **largest component** → close 15 *on that component only* (so header bars / parameter panels can never be bridged in) → fill holes → open 9 (cut appendages such as the GE grayscale bar) → largest → fill.
3. **Union rule:** if other components ≥ 10 % of the largest exist and one fan covers ≥ 95 % of their union at ≤ 4× its area, the union is the support (a sector split by an echo-free band — `use this clip.mov`).
4. **Model selection** — fan (two side lines from the two longest non-horizontal, non-frame-border edges of the simplified convex hull → apex → radii/angles from polar percentiles → coordinate-descent refinement) vs **quad** (hull simplified with `approxPolyDP`, for linear/trapezoid/virtual-convex). Fan wins unless the quad beats it by > 0.03 IoU.
5. **Far-field completion (fan only):** walk outward from `r_out` in 2-px radial bins across the wedge; extend while ≥ 12 % of the bin is not-black; stop at the first gap. Text inside the wedge cannot carry the profile.
6. Render at full res, erode 2 px (fail-closed margin), emit keep-region.
7. **Confidence** `conf = fit − 0.5·outside_blob − 1.0·static_inside` with gates → 0: masks < 5 % of the frame; interior mean > 150 or std < 15 (a white UI panel / photo is not ultrasound). `fit` = IoU(model, support), or coverage for a union.

T2 (kickoff spec): 20 evenly-sampled frames, 4×, per-pixel std/mean → `static = std < 6 ∧ mean > 60` (dilated 1) → subtracted before step 1. **T2max:** same, but the support comes from the temporal *max* projection. T0: box from the tag, eroded 2 px. **T0∩T1:** T1 run on the frame with everything outside the T0 box zeroed first.

**Test set actually used (the kickoff's list was not on this machine — §3.0):**

| id | file | what it is |
|---|---|---|
| bfly_z2, z2b, z7, z9 | four Butterfly exports from Andre's folder outside the repo (now `sandbox/clips/`) | Butterfly iQ exports, 632×1080, Lung preset, 55–295 f |
| bfly_z3 | Butterfly export (Andre's folder, now `sandbox/clips/`) | Butterfly export, **736×1080** — cone clipped by the frame on both sides and the top |
| png_still | Butterfly PNG still (Andre's folder, now `sandbox/clips/`) | Butterfly still, 632×1080 |
| sector_mov | sector clip (Andre's folder, now `sandbox/clips/`) | 948×776 phased/curved **sector**, echo-free band between near and far field |
| dcm_single_mono / _rgb | `STSS82c09c1/…113685.dcm`, `…094661.dcm` | GE LOGIQ E9 single-frame, 1164×873; the RGB one is colour Doppler |
| dcm_multi_67 / _114 | `…124429.dcm` (67 f), `…500391.dcm` (114 f) | GE LOGIQ E9 multiframe, 1054×802, virtual-convex trapezoid |
| screenrec | `Video1.mp4` | 1920×1080 screen recording of the app with a cone inside — out of distribution |
| neg_stock, neg_stairs | stock demo footage, and a personal video that was later removed (corpus-hygiene rule, tuning pass 1) | negative controls: correct output is *no proposal* |

Missing vs the kickoff: `Normal Lung sliding 2.mp4` (the perf reference clip), `Kidney.mp4`, a cart-vendor MP4 with a scale bar touching the fan edge.

### 2.1 References — read this before the numbers

There are **no hand-drawn masks on this machine** (`uploads/`, `temp_extracted/` empty; no apply artifacts). The references in `scripts/automask_spike/refs.json` are **agent-authored**: max-intensity projection over *all* frames → the same pipeline at 2× → visual review on `out/_refs/<clip>.png` → hand-corrected where the automatic candidate followed echo content instead of imaging geometry (all four GE trapezoids, bfly_z3, bfly_z7). One correction was itself wrong on the first pass (bfly_z3: I used the frame corners as the cone sides; the T1 fit at ±26° was right and the reference was fixed — `refs.json` records it). `out/_refs_final/<clip>.png` shows every final reference on the max projection and on frame 1. Boundary uncertainty is ±3 px on Butterfly sides, ±10 px on the sector's bottom arc, and bfly_z7's far field is the least certain reference in the set.

---

## 3. Spike results

### 3.0 Honesty box
- Different clips than the kickoff named; references not Andre's. The **relative** conclusions (T0 alone leaks; T2-spec adds nothing; T1 fails on dim far fields) are robust to that; the **absolute** accept counts are not, and D5 exists for that reason.
- Timings are Apple M4 Pro, one thread. The t3.large has never run any of this; §6 budgets a 3–4× factor and says how to measure.

### 3.1 Clip × tier (final run; `scripts/automask_spike/out/results.md`, contact sheets `out/<clip>/contact.png`, overview `out/_overview_frame1_tier.png`)

IoU / leak / over-blank are vs the reference keep-region; **leak** = reference-masked pixels the proposal keeps (fraction of reference-masked); **over-blank** = reference-kept pixels the proposal blanks. `*_core6` = the same, ignoring a ±6 px band around the reference boundary. `—` = no proposal (withheld), which is the *correct* output for the last three rows.

| clip | size | frames | tier | IoU | leak | over-blank | leak_core6 | over_core6 | conf | ms |
|---|---|---|---|---|---|---|---|---|---|---|
| bfly_z2 | 632x1080 | 95 | T1 | 0.8895 | 0.0 | 0.1105 | 0.0 | 0.0885 | 0.771 | 35.6 |
| bfly_z2 | 632x1080 | 95 | T2 | 0.8455 | 0.0064 | 0.1509 | 0.0031 | 0.1305 | 0.7007 | 116.1 |
| bfly_z2 | 632x1080 | 95 | T2max | 0.9162 | 0.0103 | 0.0775 | 0.0049 | 0.0608 | 0.8501 | 115.6 |
| bfly_z2b | 632x1080 | 295 | T1 | 0.8837 | 0.0000 | 0.1162 | 0.0 | 0.0990 | 0.8572 | 37.0 |
| bfly_z2b | 632x1080 | 295 | T2 | 0.7709 | 0.0101 | 0.2256 | 0.0058 | 0.2109 | 0.9012 | 87.7 |
| bfly_z2b | 632x1080 | 295 | T2max | 0.8725 | 0.0276 | 0.1167 | 0.0177 | 0.1028 | 0.946 | 113.2 |
| bfly_z3 | 736x1080 | 124 | T1 | **0.9557** | 0.0110 | 0.0426 | **0.0** | 0.0338 | 0.9518 | 39.5 |
| bfly_z3 | 736x1080 | 124 | T2 | 0.93 | 0.0050 | 0.0693 | 0.0 | 0.0603 | 0.9508 | 157.0 |
| bfly_z3 | 736x1080 | 124 | T2max | 0.9312 | 0.0061 | 0.0679 | 0.0000 | 0.0592 | 0.9528 | 158.6 |
| bfly_z7 | 632x1080 | 110 | T1 | 0.5618 | 0.0452 | 0.4102 | 0.0429 | 0.3871 | 0.8066 | 36.0 |
| bfly_z7 | 632x1080 | 110 | T2 | 0.5407 | 0.0 | 0.4593 | 0.0 | 0.4337 | 0.7805 | 104.6 |
| bfly_z7 | 632x1080 | 110 | T2max | 0.7383 | 0.0487 | 0.2221 | 0.0361 | 0.2030 | 0.8655 | 75.8 |
| bfly_z9 | 632x1080 | 55 | T1 | 0.8255 | 0.0025 | 0.1643 | 0.0010 | 0.1200 | 0.7561 | 35.2 |
| bfly_z9 | 632x1080 | 55 | T2 | 0.7619 | 0.0016 | 0.2320 | 0.0004 | 0.1927 | 0.5715 | 92.8 |
| bfly_z9 | 632x1080 | 55 | T2max | 0.775 | 0.0302 | 0.1075 | 0.0233 | 0.0914 | 0.6294 | 92.8 |
| dcm_multi_114 | 1054x802 | 114 | T0 | 0.7708 | 0.5931 | 0.0 | 0.5714 | 0.0 | 1.0 | 0.9 |
| dcm_multi_114 | 1054x802 | 114 | T1 | 0.9483 | 0.0058 | 0.0489 | 0.0000 | 0.0344 | 0.8382 | 41.5 |
| dcm_multi_114 | 1054x802 | 114 | **T0T1** | **0.9483** | 0.0058 | 0.0489 | **0.0000** | 0.0344 | 0.8586 | 45.7 |
| dcm_multi_114 | 1054x802 | 114 | T2 | 0.8429 | 0.0 | 0.1571 | 0.0 | 0.1356 | 0.6992 | 199.3 |
| dcm_multi_114 | 1054x802 | 114 | T2max | 0.8467 | 0.0 | 0.1533 | 0.0 | 0.1320 | 0.7396 | 198.9 |
| dcm_multi_67 | 1054x802 | 67 | T0 | 0.7465 | 0.6171 | 0.0 | 0.597 | 0.0 | 1.0 | 1.1 |
| dcm_multi_67 | 1054x802 | 67 | T1 | 0.663 | 0.2568 | 0.2433 | 0.2476 | 0.2349 | 0.7598 | 33.7 |
| dcm_multi_67 | 1054x802 | 67 | T0T1 | 0.7158 | 0.0567 | 0.2619 | 0.0413 | 0.2521 | 0.7709 | 34.9 |
| dcm_multi_67 | 1054x802 | 67 | T2 | 0.6918 | 0.0039 | 0.3067 | 0.0016 | 0.2898 | 0.6746 | 174.7 |
| dcm_multi_67 | 1054x802 | 67 | T2max | 0.7712 | 0.0064 | 0.2261 | 0.0033 | 0.2075 | 0.6801 | 173.8 |
| dcm_single_mono | 1164x873 | 1 | T0 | 0.7568 | 0.3799 | 0.0023 | 0.3624 | 0.0 | 1.0 | 1.0 |
| dcm_single_mono | 1164x873 | 1 | T1 | 0.9505 | 0.0068 | 0.0441 | 0.0000 | 0.0254 | 0.7246 | 45.8 |
| dcm_single_mono | 1164x873 | 1 | **T0T1** | **0.9469** | 0.0059 | 0.0484 | **0.0** | 0.0290 | 0.8054 | 46.6 |
| dcm_single_rgb | 1164x873 | 1 | T0 | 0.7278 | 0.4086 | 0.0023 | 0.3928 | 0.0 | 1.0 | 1.0 |
| dcm_single_rgb | 1164x873 | 1 | T1 | 0.7203 | 0.1785 | 0.1630 | 0.1688 | 0.1521 | 0.6584 | 47.9 |
| dcm_single_rgb | 1164x873 | 1 | T0T1 | 0.8396 | 0.0056 | 0.1561 | 0.0 | 0.1376 | 0.764 | 42.9 |
| neg_stairs | 1280x720 | 576 | T1 / T2 / T2max | — | — | — | — | — | 0.0 | 7.7 / 245 / 245 |
| neg_stock | 640x360 | 1706 | T1 / T2 / T2max | — | — | — | — | — | 0.0 | 1.8 / 41 / 41 |
| png_still | 632x1080 | 1 | T1 | 0.9438 | 0.0597 | 0.0084 | 0.0426 | 0.0019 | 0.7997 | 31.9 |
| screenrec | 1920x1080 | 704 | T1 / T2 / T2max | — | — | — | — | — | 0.0 | 16.0 / 283 / 278 |
| sector_mov | 948x776 | 229 | T1 | 0.9435 | 0.0627 | 0.0071 | 0.0392 | 0.0009 | 0.9509 | 68.3 |
| sector_mov | 948x776 | 229 | T2 | 0.914 | 0.0488 | 0.0487 | 0.0306 | 0.0296 | 0.8822 | 130.9 |
| sector_mov | 948x776 | 229 | T2max | 0.9225 | 0.0516 | 0.0377 | 0.0304 | 0.0257 | 0.6028 | 130.9 |

`ms` is the tier's wall-clock on one thread, M4 Pro, excluding frame-1 PNG decode (2–12 ms, `results.json → ms_decode_frame1`). T2/T2max include reading and decoding the 20 sampled frames.

### 3.2 What the pictures say (per-clip `contact.png`: red = leak, orange/blue = over-blank)
- **Butterfly (z2, z2b, z9):** sides and top arc right; the only error is the bottom arc placed too shallow where frame 1's far field is dim (over-blank 11–16 %, all in the last 1–2 cm). Fail-closed. z7 is the extreme case (over-blank 41 %): frame 1 has echoes only in the top third.
- **bfly_z3** (cone clipped by a 736-px frame): correct once frame-border hull edges are excluded from the side candidates; IoU 0.956.
- **sector_mov:** the union rule reconstructs the whole sector across the black band (IoU 0.94). Its 6 % leak is a rim a few px outside the reference along the whole boundary — reference uncertainty, mostly; `leak_core6` 3.9 % is the bottom arc, where the reference itself is ±10 px.
- **GE trapezoids:** T0∩T1 gets the two "0-cm tick at y≈96" images right (0.947–0.948). dcm_multi_67 (0-cm tick at y=83) over-blanks the echo-free bottom-left corner (26 %) and keeps a 40-px band above the trapezoid top (leak 5.7 %) where the `LOGIQ E9` label sits 20 px from the image edge and the 28-px pre-component closing bridges it. The colour-Doppler still is saved by the T0 bound (the dense PDI parameter panel right of the box merged into the image without it).
- **png_still:** leak 6 % — the far-field completion extends the bottom arc ~20 px past the reference into sparse noise. That is the one place the completion trades leak for over-blank; `R_PROFILE_MIN` (0.12) is the knob and the sweep below shows the sensitivity.
- **Negative controls and the screen recording: withheld** (interior gate: white UI mean 228–243; the photo/stock support is the whole frame → masks < 5 %).

### 3.3 Parameter sensitivity (`sweep.py`, 9 configs, T1 and T2max)
`T_LOW ∈ {2,3,5}` × `D_MIN ∈ {0.25,0.35,0.45}`: T1 mean IoU 0.71–0.85, best at `D_MIN 0.35` (chosen); `D_MIN 0.25` lets a text block through on the RGB still (max leak 0.58), `0.45` drops the sector's far band (min IoU 0.25). `T_LOW` barely matters (background is 0). T2max is flatter (0.84–0.87) and less sensitive. Nothing in the grid reaches the strict criterion.

---

## 4. T2 verdict (pre-committed rule, §6 of the kickoff)

### 4.1 Strict rule as committed — IoU ≥ 0.97 **and** leak ≤ 0.5 %
**0 clips pass, on every tier.** So by the letter of the rule T2 "moves the count" by 0 and is dropped. But the rule is also unmeetable on this set independent of the algorithm: the 2-px fail-closed erosion alone costs ~1.5 % IoU on a 632×1080 cone (ceiling ≈ 0.985), and a 0.5 % leak on a reference whose boundary is ±3–10 px requires the proposal to sit within ~0.7 px of it on average. **Recommendation:** re-commit, before the D5 re-run, to a boundary-tolerant rule — the one below — and keep the 2-px margin.

### 4.2 Tolerant rule (post-hoc, labelled as such) — IoU ≥ 0.90 **and** leak_core6 ≤ 1 %

| tier | positive clips passing | which |
|---|---|---|
| T1 (T0∩T1 on DICOM) | **3 / 11** | bfly_z3, dcm_multi_114, dcm_single_mono |
| T2 (spec) | 1 / 8 | bfly_z3 |
| T2max | 2 / 8 | bfly_z2, bfly_z3 |

Close misses under the tolerant rule: bfly_z2 (0.89, leak 0), bfly_z2b (0.88, leak 0), bfly_z9 (0.83), sector_mov (0.94 but leak_core6 3.9 %), png_still (0.94 but 4.3 %), dcm_single_rgb (0.84, leak 0).

### 4.3 Decision
- **T2 (static-overlay subtraction): measured, not adopted.** It fixes no leak T1 cannot (its two leak reductions — z7 4.5 → 0 %, dcm_67 5.7 → 0.4 % — come with 46 % and 31 % over-blank), and lowers IoU on 6 of 8 clips. The furniture it targets (Butterfly header/scale, GE panels) is already separated by density + opening + the T0 bound. Static *inside* the cone (a still pleural line, `static_inside_frac` up to 0.14 on z9) is what it actually subtracts.
- **T2max: measured, not adopted for Round 2; backlog.** It is the right idea for the dim-far-field failure (z7 0.56 → 0.74, dcm_67 0.66/0.72 → 0.77, z2 0.89 → 0.92) but it also nudges 5 clips down, it moves the tolerant count 3 → 2 when substituted for T1 (it is not additive with T1 as measured), and it needs frames that only exist at `ready` — which is exactly when the user has already drawn. If it comes back, it comes back as a *refinement offered at `ready`* ("we can extend the cone bottom by N px — apply?"), not as the first proposal.
- **T0: keep, as a bound only** (D1).

---

## 5. Production design (Round 2, behind `AUTOMASK`)

### 5.1 Placement — (a) in-process Node, with the trade-offs weighed

| option | for | against | verdict |
|---|---|---|---|
| **(a) Node in-process, `sharp` raw buffers, pure-TS core, `worker_threads`** | No new runtime or deploy artifact; PHI never leaves the box; measured front half 5–11 ms decode+4× downscale+gray (`sharp`, one thread) + 1–11 ms JS density/CC on M4 Pro (`scripts/automask_spike/node_t1_timing.mjs`); whole T1 32–68 ms in OpenCV → ≤ 250 ms budgeted on the t3.large; the core is isomorphic and can move to the browser later with no algorithm change | Must re-implement hull / Douglas-Peucker / line fit / small binary morphology in TS (~300 lines, no OpenCV); runs on the same core as ffmpeg for ~0.2 s once per job | **chosen** |
| (b) Python sidecar on the app server | Direct port of the spike (numpy/OpenCV) | Second PM2 app, pip/venv on a box that has no Python toolchain in `deploy.sh`, ~100 MB resident, PHI frames over local HTTP/stdin, one more thing to restart | not now; fallback if the TS port stalls |
| (c) FastAPI on the GPU box | Already has `opencv-python-headless` + numpy (`sam2-service/requirements.txt:4,6`) | A different instance (`18.222.109.87`); frame travels as base64 PNG (~350 KB) over the network; couples the template spoke to the AI service's availability (its API key is unset on prod, 7A-4); adds ≥ 1 s latency before the overlay appears | no |
| (d) *not in the kickoff:* in the browser, Web Worker on the painted frame | Zero server CPU; the frame is already in the canvas; coordinates 1:1 by construction | T0 still needs a server endpoint (the header is only parsed server-side); no server-side record of what was proposed (hurts the template-library backlog); algorithm ships in the 661 KB client bundle | keep as the escape hatch: the `shared/automask/` core is written so a later switch is a one-file change |

**CPU contention (the kickoff's one-core warning):** the proposer is computed **lazily on first `GET …/proposal`** (the moment the spoke opens), cached on disk, and never re-run. On the reference clip that request lands ~2–3 s after upload, while ffmpeg is still extracting (8 s). The proposer costs ≤ 0.25 core-seconds once; ffmpeg loses at most that. It runs in a `worker_threads` worker so the event loop (frames endpoint, socket progress) is not blocked by the JS part. `sharp` work already runs off-thread. Log it: `[PERF] automask.done {tier, model, conf, ms, w, h}` and `automask.skipped {reason}` (existing `perfMark`/`perfSpan`, `server/services/perf.ts`).

### 5.2 Proposal data and where it lives (no A3 change)

`temp_extracted/<jobId>/automask.json` for every job type (mkdir -p; `listRawFrameFiles` only matches `frame_*.png` — `frameAccess.ts:150-154` — so the file cannot be counted as a frame by the frames endpoint or the reuse guard; the directory is already a 6-h sweep target and is purged with the job). Written once by the worker, read by the endpoint.

```jsonc
{
  "version": 1,
  "status": "ready" | "none",                 // "none" carries reason: withheld | error | disabled
  "tier": "T0T1" | "T1",                      // T0 alone is never proposed
  "model": "fan" | "poly",
  "frame": "frame_000001.png", "width": 632, "height": 1080,
  "keep": { "kind": "fan", "ax": 307.7, "ay": -264.9, "r_in": 264.3, "r_out": 1181.5,
            "th_l": -0.391, "th_r": 0.408 }   // or { "kind": "poly", "pts": [[x,y],...] } — full-res px
  "bound": { "x0": 0, "y0": 40, "x1": 1053, "y1": 736 } | null,   // T0 box when DICOM
  "margin_px": 2,
  "confidence": 0.86,
  "components": { "fit": 0.88, "outside_blob": 0.002, "masked_frac": 0.39, "interior_mean": 47, "interior_std": 53 },
  "ms": 41, "createdAt": "…"
}
```
Shape parameters, not a raster: 200 bytes, renders at any size, and is what a template library would store. The client renders the raster (it already does for drawn shapes).

**Endpoint (new, read-only, additive):** `GET /api/jobs/:jobId/template-mask/proposal` → `200 {status:'ready', …}` | `200 {status:'none', reason}` | `200 {status:'pending'}` (worker running; client retries once after 1 s) | `404` unknown job. With `AUTOMASK` unset/`0` it returns `{status:'none', reason:'disabled'}` without touching the disk — the spoke then renders exactly today's canvas. Frame resolution reuses the frames-endpoint logic (raw branch / image-batch branch / IEND check); if frame 1 is not on disk yet → `pending`.

### 5.3 Spoke UX (the only UI this round)
- On frame-1 200 (`template-mask-spoke.tsx:69`), fetch the proposal in parallel. `status:'ready'` and `confidence ≥ 0.70` → paint the **complement** of `keep` as a *proposed* layer: hatched blue at 35 % opacity, non-selectable, tagged `_proposal` (the existing `_aiOverlay` image path at `MaskingCanvas.tsx:258-283` is the precedent; the proposal layer must use a distinct tag so the two never clear each other). Below 0.70: nothing (today's blank canvas). 0.70 is fitted to n = 11 (true positives 0.72–0.95, negatives 0) and is a tunable, not a finding.
- A small bar over the canvas: **"Proposed mask — keeps the ultrasound image, blanks everything else"** with **Accept**, **Edit**, **Dismiss**, and the confidence as a word (High ≥ 0.85 / Medium).
- **Accept:** remove the `_proposal` layer; add one `fabric.Path` with `fillRule: 'evenodd'` = frame rectangle + the cone path (arcs as SVG `A` commands, quads as `L`), red, selectable. `updateMaskFromCanvas` clones and rasterises it like any other object → `canvasDataUrl` → Apply **unchanged**. `type: 'freeform'`, `coordinates` = bbox. (`fabric.util.object.clone` preserves `fillRule`; verify in the first smoke test — if it does not, Accept falls back to setting `maskData` from a client-rendered raster, and Edit adds shapes on top; still fail-closed, less editable.)
- **Edit:** same as Accept, then select the path so the handles show; brush/rect/polygon add to it (union, existing behaviour); Undo/Clear work unchanged.
- **Dismiss:** remove the layer; today's canvas.
- Apply gating (`canApply`, `:172`) unchanged: still `status === 'ready'`.
- Copy must not say "de-identified" or "PHI removed": it is a cone proposal.

### 5.4 When it runs
- **T1 / T0∩T1:** on first `GET …/proposal` after frame 1 exists (video ~1–2 s after upload; DICOM immediately; images immediately). Cached; a second open is a file read.
- **T2-class refinements:** not in Round 2 (D3). If T2max returns, it runs at `ready` and is *offered*, never auto-applied.

### 5.5 Degradation — every path ends at today's blank canvas
| failure | behaviour |
|---|---|
| `AUTOMASK` unset/0 | endpoint returns `none/disabled`; spoke draws nothing extra |
| frame 1 not yet on disk / torn PNG | `pending`; one retry; then nothing |
| worker throws, times out (> 2 s), or sharp cannot decode | `none/error` written and logged; nothing shown |
| confidence gate | `none/withheld` with components logged (that is the negative-control path) |
| user Dismisses | layer removed, no state kept |
| `temp_extracted/<jobId>/` swept | frames endpoint 410s first; proposal never requested |
| image batch after Apply (item 30) | canvas 410s as today; unaffected |

Nothing here can change the bytes Apply produces for a user who never clicks Accept: the proposal is a layer, and the `_proposal` tag is excluded from `updateMaskFromCanvas` (filter alongside `type !== 'image'`, `MaskingCanvas.tsx:849`).

---

## 6. Perf budget

| stage | measured here (M4 Pro, 1 thread) | budget on t3.large (×3–4, to be measured) |
|---|---|---|
| frame-1 PNG decode + 4× downscale + gray (`sharp`) | 5–11 ms (632×1080 → 1920×1080) | ≤ 40 ms |
| density / morphology / CC / hull / fit (JS) | 1–11 ms front half; full T1 32–68 ms in OpenCV | ≤ 200 ms |
| render keep-region + JSON write | not measured; O(w·h) once | ≤ 20 ms |
| **T1 total, once per job** | **≈ 40–70 ms** | **≤ 250 ms wall, ≤ 0.25 core-s** |
| T2max (20 frames read+decode+stats) | 90–280 ms | ~1 s — not in Round 2 |

Relative to extraction: `bg_extract.done` is 8.0 s on the reference clip; the proposer takes ≤ 3 % of that once, on demand, and does not gate `ready` (it is not in the extraction path at all). **Measure at production shape** (binding lesson): first deploy with `AUTOMASK=1` on the reference clip, read `automask.done.ms` and compare `bg_extract.done` and `apply.done` against the PERF-round numbers (8.0 s / 8.7 s); the acceptance bar is no measurable change in either.

---

## 7. Rollout

- **Flag:** `AUTOMASK=0|1`, default 0, read once at boot next to `ALLOWED_ORIGINS` (`routes.ts:113`). Deploy = revert-safe: with the flag off the only new code path executed is the endpoint's early return.
- **Files (Round 2 estimate):** `shared/automask/{core.ts,fan.ts,geometry.ts}` (pure functions, unit-testable with `npx tsx` like `applyPaths.test.ts`); `server/services/automask.ts` (worker + cache + frame resolution); one route in `routes.ts`; `client/src/pages/template-mask-spoke.tsx` (fetch + bar); `client/src/components/MaskingCanvas.tsx` (proposal layer, Accept → evenodd path). No changes to `buildApplyMask`, the apply loop, the reuse guard, frame naming, extraction, `storage.ts`, `pgStorage.ts`, `schema.ts`, `migrations/`.
- **Tests before deploy:** port the spike's frame-1 PNGs for the 14 clips (kept out of git; PHI) into a local fixture dir and assert the TS core reproduces the Python keep-regions to IoU ≥ 0.98 on each — the pixel-equivalence habit from 2B-3a applied to the proposer. `tsc` = 12.

**Test matrix (Round 2A runbook style):**

| # | case | expected |
|---|---|---|
| A1 | `AUTOMASK` unset, MP4 upload, open spoke | canvas identical to today; `GET …/proposal` → `none/disabled`; no `[PERF] automask.*` line |
| A2 | `AUTOMASK=1`, reference clip (`Normal Lung sliding 2.mp4`), open spoke at ~3 s | proposal layer within 1 s of the canvas; `automask.done` logged with ms; `bg_extract.done` and `apply.done` within noise of 8.0 s / 8.7 s |
| A3 | A2, Accept, Apply | `apply.mask_build.masked_px` equals the proposal's complement ± margin; masked frames show only the cone; ZIP unchanged in structure |
| A4 | A2, Edit, add a brush stroke, Apply | union of proposal + stroke; `apply.mask_build` offsets ≥ A3's |
| A5 | A2, Dismiss, draw by hand, Apply | byte-identical to the pre-round apply for the same drawn mask |
| A6 | DICOM single-frame (mono) | tier `T0T1`, bound = the (0018,6011) box, proposal inside the box |
| A7 | DICOM colour-Doppler still | as A6; the PDI parameter panel is not kept |
| A8 | DICOM multiframe | as A6; frame 1 arrives before extraction ends; proposal available while `extracting` |
| A9 | image batch (uniform dimensions, item 29 caveat) | T1 on image 0; JPEG input decodes; Apply unchanged |
| A10 | non-ultrasound upload (stock video) | `none/withheld`; blank canvas; components logged |
| A11 | open spoke before frame 1 exists (fast click) | `pending` → retry → proposal; no error state introduced |
| A12 | kill the worker mid-run / corrupt `automask.json` | `none/error`, blank canvas, no 5xx from the endpoint |
| A13 | second open of the same job | proposal served from cache; no second `automask.done` |
| A14 | server restart between upload and open | frames endpoint behaviour unchanged (2A §4 rows); proposal follows the frame's availability |

---

## 8. Backlog opened

1. **Template library / layout fingerprinting** — the proposal JSON (§5.2) is the storage format; a fingerprint (frame size + T0 box or fitted-shape hash + vendor header crop hash) keyed to a saved shape would make repeat uploads from the same device/preset instant and human-verified. Expected next round.
2. **T2max far-field completion offered at `ready`** (D3) — measured here; needs Andre's clips to decide.
3. **Reference-mask capture tooling** — the spike needs Andre's drawn masks for the seven kickoff clips as PNGs; simplest is a debug route or a one-off script that dumps `templateMask.maskData.canvasDataUrl` for a job to disk. Blocks D5.
4. **Furniture within ~28 px of the image edge gets merged** (GE `LOGIQ E9` label on the 0-cm-tick-at-83 layout: leak 5.7 %). Candidate fix: run the pre-component closing only inside the T0 box shrunk by that margin, or lower `K_CLOSE_SMALL` when a T0 bound exists.
5. **RGB multiframe DICOM extraction** — `processDicomPixelDataHelper` writes `channels: 1` unconditionally (`frameExtractor.ts:669-675`); a colour-Doppler *cine* would extract as garbage. Pre-existing, found in recon Q4, unverified with data (no such file on hand). Separate item; not this round.
6. **Image-batch JPEG originals** at the proposer input (recon Q6): the core must decode JPEG; note only.
7. **Proposal telemetry** — log Accept/Edit/Dismiss to `[PERF]`-style lines so the 0.70 confidence gate can be tuned on real use (client → one POST, or piggyback on the apply request body as a non-persisted field).

---

## 9. Invariants checked
`tsc --noEmit` = 12 (no source touched) · A3 frozen (no schema/status/column change proposed; proposal state on disk under `temp_extracted/<jobId>/`) · masked 0-indexed / raw 1-indexed untouched · reuse guard, `extractAllFramesSequential`, DICOM branch, `buildApplyMask`, apply loop, frame naming untouched · Phase 6 co-indexing untouched · one flag, one deploy, one `git revert` · measure at production shape before believing any millisecond in §6.

## Appendix — files
- `scripts/automask_spike/automask_spike.py` — the spike (tiers, scoring, contact sheets). `python3 automask_spike.py --frames <root>`; frames as `<clip>/frame_%06d.png` extracted with `-vsync 0 -compression_level 1`.
- `scripts/automask_spike/make_refs.py`, `verify_refs.py`, `refs.json`, `refs_candidates.json` — reference construction and its audit trail.
- `scripts/automask_spike/dicoms.json` — clip id → DICOM path (for T0). `dcmjs_regions.mjs` — the recon Q5 check. `node_t1_timing.mjs` — the placement timing. `sweep.py` — §3.3.
- `scripts/automask_spike/out/` (gitignored, PHI): `results.json`, `results.md`, `<clip>/contact.png`, `<clip>/{t0,t1,t0t1,t2,t2max,ref}_keep.png`, `_overview_frame1_tier.png`, `_refs/`, `_refs_final/`, `_thresh_sweep.png`.
