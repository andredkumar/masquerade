# Output Round 1b — report: F2, the masking work restricted to the crop

**Status:** built 2026-09-23 on `main` @ `2dea93e` per `OUTPUT_ROUND1B_KICKOFF.md`, `OUTPUT_ROUND1B_STEP1.md` and `OUTPUT_ROUND1B_SIGNOFF.md` (step 2 = **F2 only**; F1 not built by the step-1 rule). **Uncommitted** — Andre writes the runbook and commits. `tsc` 12 (the same 12) · A3 frozen · `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, extraction, the reuse guard, `automask*.ts` untouched · `apply.output`, the sidecar and the manifest bytes unchanged · server only · one commit, one `git revert`.

## 0. Headline

**F2 is pixel-identical everywhere it was checked, and removes the Keep-mode mask loop.**

| proof | result |
|---|---|
| unit, three real code paths (batch + filtered prebuilt mask, batch per-stack fallback, per-frame) vs whole-frame masking; 4 masks × Original/256 × Letterbox/Crop × JPEG/PNG | **32/32 cases byte-identical on all three paths**; a negative control (a filter that drops in-crop offsets) is detected |
| real frames, `serial_bench.ts`: F2-masked frame vs fully masked frame, encoded | **46/46** (Kidney, Keep rectangle) · **348/348** (reference clip, cone) |
| `check.ts` geometry, fan MP4 / E9 trapezoid + T0 DICOM / image batch × letterbox, crop × original, 256, 512, 640 × 480 | **24/24 rows, reference diff 0 / 0**, exact dims, sidecar == manifest (same table as Output Round 1) |

| serial (`UV_THREADPOOL_SIZE=1`, sharp concurrency 1), per frame | before | after F2 |
|---|---|---|
| Kidney 1920 × 1080, 46 fr, **Keep** 225 × 152 — offsets / `mask_ms` (server) | 2 039 400 / 2.53–2.71 | **0 / 0.00** |
| Kidney, auto-mask cone — offsets / `mask_ms` | 1 820 201 / 2.14–2.22 | in-crop only / 0.33–0.35 |
| reference clip 1536 × 796, 348 fr, cone — offsets / `mask_ms` | 680 420 / 0.75–0.78 | 250 580 / 0.33–0.35 |
| `apply.mask_build` (Kidney Keep) | 275–333 ms | 276–307 ms (unchanged, as required) |

## 1. What shipped

| file | change |
|---|---|
| `server/services/outputTransform.ts` (+18) | `offsetsInCrop(offsets, frameW, frameH, crop)`: the masked byte offsets whose pixel lies inside the crop, order kept; a crop covering the frame returns the input array itself (no copy — the Remove-mode drawn-rectangle case costs nothing) |
| `server/services/videoProcessor.ts` (+41 −17) | **video setup:** the once-per-apply step is now `planPrebuiltMask(jobId, prebuiltMask, outputSettings, outputSize)` — keep bbox, `planApplyOutput` (unchanged, still the one `apply.output` line), then `prebuiltMask.maskedOffsets = offsetsInCrop(…, plan.crop)`; `maskedPixels` keeps the mask's own count. **Batch path, per-stack fallback** (image batches, alpha frames, a stack whose dims differ): the alpha scan walks the crop rectangle instead of the frame. **Per-frame path:** the plan moves above the mask loop and the loop walks the crop rectangle; the transform call below uses it. Same test, same writes, inside the crop |
| `server/services/__tests__/outputF2.test.ts` (new) | the §0 proof: 32 cases × 3 paths, the negative control, `offsetsInCrop` vs a naive filter |
| `scripts/output_eval/serial_bench.ts` (new — step 1 added it; step 2 extended it) | `mask` vs `mask_f2` timed on the same frame in alternating order, the F2 byte check per frame, `--mask keep-rect:x,y,w,h` |
| docs | this report; `OUTPUT_ROUND1B_KICKOFF.md`, `_STEP1.md`, `_SIGNOFF.md`; `CLAUDE.md` status block with the working-loop rule and the two runbook conventions (sign-off §3) |

## 2. Deviation from the sign-off's wording (for Andre to keep or strike)

The sign-off says "filter `maskedOffsets` … at all four `keepBbox` sites". Only one of the four has an offsets list. The video setup has `prebuiltMask.maskedOffsets`, which is filtered once per apply. The batch per-stack fallback and the per-frame path mask by scanning the alpha raster, with no offsets list. For them F2 is **the same scan restricted to the crop rectangle**, the equivalent change for that loop. The image setup (`processImages` `:819`) only plans the transform for the sidecar and masks nothing, so it has no change. All three masking paths are in the 32-case proof.

## 3. Test matrix — results

| row (kickoff §3 / sign-off §4) | result |
|---|---|
| identity (unit) | §0: 32/32 × 3 paths byte-identical; negative control detected; `offsetsInCrop` equals a naive filter on four crops (interior, left column, last pixel, right part), returns the input for a full-frame crop, empty in → empty out |
| geometry | §0: 24/24, reference diff 0 (the reference still masks the whole source frame and runs the pure plan; the server now masks only the crop and matches it byte for byte). The "no-resample row" column reads "54/57 bytes differ" on the DICOM and image rows for the Output Round 1 reason (report §5.6: a row across a non-rectangular keep crosses blanked pixels); unchanged |
| serial perf, harness | §0 and §4 |
| Keep (serial, server) | `mask_ms` 2.53–2.71 → **0.00** ms/frame; `apply.mask_build` unchanged; output identical (harness 46/46) |
| Remove on the reference clip (server) | `apply.done` 3 080–3 402 ms before, 3 122–3 358 ms after (within the run-to-run spread, first run slowest both times); `mask_ms` 0.76 → 0.34 |
| invariants | `tsc` 12 (5 `frameExtractor.ts` + 7 `maskWorker.ts`); outputF2 3, outputTransform 5, outputParity 1, outcomeRounding 2, automaskShape 6, automaskOutcome 4, automaskHold 2, automask.endpoint 13, automaskWorkerClient 5, automask.fixture 2 (+1 skipped, PHI dir unset), applyPaths 8, saveProcessedImage 11, imageBatchFrames 6, frameAccess 8 — all green; `npm run build` → `dist/index.js` 265 KB + `dist/automaskWorker.js` 52 KB; `git diff` on the untouched list = 0 |
| prod rows | **not run — the runbook's** (§6) |

## 4. The expectation on prod

In the sandbox the Keep loop's summed time (46 × 2.6 ms ≈ 120 ms) came off `apply.done` only partly: 864 → 840 ms mean, −24 ms. On the M4 under `UV_THREADPOOL_SIZE=1` the main-thread loop runs on its own core while the single libvips thread works, so most of it was hidden. **Prod has no spare core:** one physical core, two hyperthreads, shared by the main thread and libvips. The prod log already shows the loop adding serially. The Keep job's gap to Remove beyond `apply.mask_build` is ~0.7 s, which is ≈ 46 frames × ~15 ms `mask_ms`. So the sign-off's expectation stands: **Keep on the 46-frame 1920 × 1080 job ≈ 3.5–3.8 s** (from 4.26 s). The remaining gap to Remove is `apply.mask_build` (1.55 s, backlog). The runbook should judge F2 by **`mask_ms` ≈ 0 on Keep, `apply.mask_build` unchanged, `apply.done` not up**, then read the `apply.done` drop against that range.

On the reference clip's cone the sign-off expected no change. Offsets actually fall by 63 % (680 420 → 250 580: the strips left and right of the fan's bbox), and `mask_ms` halves (0.76 → 0.34 ms). On prod that is ≈ 348 × (8.4 → ~3.8 ms) ≈ 1.6 s of loop time at the 2026-09-11 rate. It is worth watching, but it is inside the run-to-run spread the sign-off documented (8.5 vs 11.1 s on identical code), so don't gate on it.

## 5. Measurement method (for the next round)

- Serial server runs force `sharp.concurrency(1)` with a `NODE_OPTIONS=--import=<preload>` that wraps `sharp.concurrency` (no code change; the boot line reads "sharp concurrency set to 1"), plus `UV_THREADPOOL_SIZE=1`. `apply.env` confirms both on every apply. The preload, the apply driver and the window-based log parser stay out of the tree, as the sign-off requires.
- Before and after ran on the same sandbox jobs (Kidney `780b80bd`, reference `506cd243`), same mask, three applies each (two for the Kidney cone), server stopped with SIGKILL between phases so the frames survived.
- The harness's `mask` column reads higher than in step 1 (1.52 vs 0.74 ms on the reference clip) because the F2 copy of the decoded frame now precedes it and evicts the cache; the server's `mask_ms` (0.76) is the clean number. The before/after comparison inside the harness is still like for like (alternating order).

## 6. Runbook facts

- **Commit by explicit paths:** `server/services/outputTransform.ts`, `server/services/videoProcessor.ts`, `server/services/__tests__/outputF2.test.ts`, `scripts/output_eval/serial_bench.ts`, `docs/refactor/OUTPUT_ROUND1B_{KICKOFF,STEP1,SIGNOFF,REPORT}.md`, `CLAUDE.md`. Not `scripts/sandbox/`, `scripts/automask_spike/dicoms.json`, `.idea/`, `docs/refactor/ITEM22_REPORT.md` (Andre's own edit), `docs/refactor/OUTPUT_ROUND1A_HOTFIX.md` (1a's, not built in this tree).
- **1a is not in this tree** (`MaskingCanvas.tsx` / `MaskingTools.tsx` unchanged). If it ships in the same deploy: one deploy, two commits, one `git revert` each (sign-off §4).
- **Rows:** a Keep apply on a 1080p clip → `apply.frame` `mask_ms` ≈ 0 (was ~15), `apply.mask_build` ≈ unchanged (~1.8 s), `apply.done` down toward 3.5–3.8 s on the 46-frame job; a Remove / cone apply on the reference clip → `apply.done` within the box's spread of the prior run on the same job; `apply.output` unchanged in shape; a download's `manifest.json` `output_transform` unchanged.
- **Collect:** `pm2 logs masquerade --raw --nostream --lines 4000 | grep '"stage":"apply\.' ` (sign-off §3: `--nostream`, and `grep --line-buffered` on every stage but the last of a live tail).
- **Before step 2's numbers are read against prod, sign-off §2's D4 checks (Andre):** CloudWatch `CPUCreditBalance` / `CPUUtilization` for 2026-09-11 18:55–19:10 and 2026-09-23 14:55–15:10 PDT, and the credit mode; P4 twice back to back on a quiet box.
- **Rollback:** one `git revert`; F2 changes no output byte, so frames applied under it are ordinary.

## 7. Known limitations carried forward

- **Keep-mode `apply.mask_build`** (1.8 s on prod for 2 M offsets) is untouched — backlog: "Keep-mode `buildApplyMask` cost: emit only in-bbox offsets; needs the pixel-equivalence proof, own round". F2 now does that filtering one step later; building only the in-crop offsets in the first place would also remove the 2 M-entry array and the ~8 ms filter pass.
- The prod regression attribution (sign-off §2) is Andre's CloudWatch check, not something this tree can settle.
- `processBatchesInParallel` (dead) and `maskWorker.ts` (dead) are untouched, as before.
