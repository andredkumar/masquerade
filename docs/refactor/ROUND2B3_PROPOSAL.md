# Round 2B-3 — mask loop on the main thread + single-pass background extraction

**Status:** proposed 2026-08-30, after the 2B-1/2B-2 prod run (job `64b6b1d9`, same 348-frame clip).

## 0. What the 2B deploy measured

| stage | Round 1 (before) | 2B-1/2B-2 (after) |
|---|---|---|
| `bg_extract.done` | 45.6 s | 45.4 s (untouched — this round) |
| `apply.extract_all` | 19.5 s | **gone** (`apply.source: reuse`) |
| `apply.read_all` | 0.17 s | 0.21 s |
| mask loop | 13.4 s | **13.2 s** |
| `apply.done` | 33.3 s | **13.4 s** |
| `sharp_concurrency` | 1 | 2 |

2B-1 did exactly what it promised (−19.5 s, apply is 2.5× faster). **2B-2 did nothing measurable**:
doubling libvips threads left the mask loop at 13.2 s. On a t3.large the two vCPUs are one physical
core, so some of that is expected — but *zero* gain says libvips was never the bottleneck of the loop.

## 1. Where the 13 s actually goes — hypothesis to confirm from source first

Round 1's per-stack lines carry `mask_build_ms`, and it climbs **linearly with stack index**:
734, 903, 1090, 1363, 1605, 1786, 1996, 2154, 2396, 2575 … 5788 ms — about +100–150 ms per stack,
58 stacks. That is the signature of 58 stacks queueing on **one** resource, each waiting for the
previous one's build to finish, and it sums to roughly **6–7 s**. The mask is a static shape: it is
being **rebuilt once per stack** when it should be built **once per apply**.

Second suspect: the report describes Step 3 as "the synchronous pixel loop" — `mask_ms` ≈ 10 ms ×
348 frames ≈ **3.5 s of JavaScript on the event loop**, which no libvips concurrency can touch.

Together those two account for ~10 s of the 13 s loop, on the **Node main thread**. If the source
confirms it, the fix is not more threads; it is doing less on the one thread that matters.

**Confirm before changing anything** (report these with file:line):
1. Where is the mask raster built (`mask_build`)? Is it inside `processFrameBatch` (per stack) or
   hoisted to `processVideo` (per apply)? Is it sync JS or a sharp call?
2. Is Step 3 a JS `for` loop over the pixel buffer? Does it run on the main thread?
3. Is anything else per-stack that is actually per-apply (resize geometry, letterbox pad, feather)?

## 2. Changes

### 2B-3a — Build the mask once per apply; mask with libvips, not JS   ← do first, measure, then 2B-3b

1. **Hoist** the mask raster (and any derived geometry: bbox union, feather kernel, letterbox/crop
   plan) out of `processFrameBatch` into `processVideo`, built once, passed into every stack as a
   read-only buffer. Add `[PERF] apply.mask_build` (once) and drop `mask_build_ms` from `apply.stack`.
2. **Replace the JS pixel loop** with a libvips operation, so per-frame work runs in sharp's threads
   and the event loop only orchestrates. The natural form for "black out everything outside the
   shape, with a feathered edge" is a single alpha composite of the frame over black:
   ```ts
   sharp(frameBuf)
     .composite([{ input: maskRgba, blend: 'dest-in' }])   // maskRgba: alpha = 255 inside, 0 outside, feathered edge
     .flatten({ background: '#000' })
     .resize(...)                                          // existing output-size/letterbox logic, unchanged
     .jpeg({ quality: 90 }) / .png({ compressionLevel: 3, adaptiveFiltering: false })
   ```
   Pixel result should equal the current loop's. **Prove it**: mask one frame both ways in the agent
   environment and diff the raw pixels (max abs diff ≤ 1 for the feathered band, 0 elsewhere). If
   the current loop does something the composite can't express exactly, report and stop — do not
   approximate silently.
3. Keep batch/stack structure as-is (it's harmless now). Keep `apply.frame` probes; `mask_ms` should
   collapse toward ~0 on the main thread and the work shows up inside libvips.

**Expected:** mask loop 13 s → **~3–5 s** on this box (decode + encode + composite in libvips at
2 threads, no serialized JS). `apply.done` → **~4–6 s**.

### 2B-3b — Single-pass background extraction (45 s → ~15–20 s)

As specified in `ROUND2B_PROPOSAL.md` §2B-3, unchanged: one ffmpeg invocation writing
`frame_%06d.png` (1-indexed, image2 muxer) straight into `temp_extracted/<jobId>/`, replacing the
15-frame `extractFrameBatch` loop for MP4 only; DICOM loop untouched. Progress from ffmpeg's
`frame=` stderr (fluent-ffmpeg `.on('progress')`), same socket payload as today. `-compression_level 1`
on the PNG encoder (raw frames are intermediate; lossless at every level). Honor `samplingFps` exactly
as the batch path does. **Frame-count parity gate: 348 → 348 on this clip**, and frame 1 eyeballed vs
the current extractor.

Note the reuse guard from 2B-1 (`files.length === totalFrames`) is what makes this safe to change:
any count drift shows up as `apply.source {mode:'reextract', reason:'count_mismatch'}` — not as a
silent wrong frame set.

Also fold in: `extractVideoMetadata` re-read on the DICOM apply path (ROUND2B_REPORT §1 "residual
cost") — cache the metadata from upload time on the job record if a column already exists for it
(duration/dims/frameRate do — A3 `jobs` columns); if it needs a new column, leave it.

### 2B-3c — Grayscale evaluation (decision, small experiment, no product change yet)

Raw frames are ~350 KB each (123 MB for 348 frames measured on the box); B-mode is single-channel.
Experiment only: extract the same clip with `-pix_fmt gray` and report size + time; check one color
Doppler clip to confirm the chroma test that would gate it (frame-1 max |R−G|,|G−B| below a threshold
→ gray). Output: numbers + a recommendation. No default change in this round.

## 3. Constraints
tsc stays at 12 · A3 frozen (no schema/status change; 2B-3b's metadata cache only if columns exist)
· DICOM branch in `extractAllFramesSequential` untouched · `frame_%06d` 1-indexed naming and
positional indexing preserved · `[PERF]` probes stay · three deploys (3a, then 3b, then 3c-decision),
each re-measured on the same clip.

## 4. Kickoff for Claude Code (2B-3a only)

> Continuing Masquerade (bring CLAUDE.md). 2B-1/2B-2 are deployed: apply reuses raw frames
> (33 s → 13.4 s) but `sharp.concurrency(2)` changed nothing — the mask loop is still 13 s. Per
> `docs/refactor/ROUND2B3_PROPOSAL.md` §1, first **confirm from source** whether the mask raster is
> rebuilt per stack (`mask_build_ms` climbs linearly across 58 stacks) and whether Step 3 is a
> synchronous JS pixel loop on the main thread; report file:line. If confirmed, implement **2B-3a**:
> build the mask once per apply in `processVideo`, and replace the JS pixel loop with a libvips
> composite (`dest-in` over black, then the existing resize/encode). Prove pixel equivalence against
> the current loop on one frame (max abs diff ≤ 1 in the feathered band, 0 elsewhere) before
> switching; if not expressible exactly, stop and report. Keep batch/stack structure, probes, tsc 12,
> A3 frozen. Do not touch background extraction (that is 2B-3b, next). Output
> `docs/refactor/ROUND2B3A_REPORT.md` and stop before deploying.
