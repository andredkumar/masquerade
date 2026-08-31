# Round 2C — experiment: ffmpeg-driven apply (one last try; current state is accepted)

**Status:** proposed 2026-08-30. **Framing matters:** the operator is happy with the current state
(apply 8.7 s, extraction 8.0 s on the reference clip). This is a bounded experiment, not a commitment.
It ships **behind a switch with the current path as default**, gets measured on prod, and then one of
the two engines is **deleted** — we do not keep two apply engines.

## 1. Idea

The current apply loop spends its time on PNG decode → 3.7 MB raw buffer into Node → zero ~1.5 k
bytes → 3.7 MB back into libvips → JPEG encode, ×348, with 58 stacks queueing on a 4-thread pool.
Round 2B-3b showed what one multithreaded ffmpeg process does to that shape (45 s → 8 s). So: let
ffmpeg read the raw PNG sequence, overlay the mask, and write the JPEG sequence in one process:

```
ffmpeg -start_number 1 -i temp_extracted/<jobId>/frame_%06d.png \
       -i <apply-dir>/mask_bbox.png \
       -filter_complex "[0:v][1:v]overlay=x=<bx>:y=<by>:format=auto[out]" -map "[out]" \
       -q:v 2 -threads 0 spokes/template_mask/<jobId>/frame_%06d.jpg
```

`mask_bbox.png` is the prebuilt mask (`buildApplyMask`, unchanged) **cropped to its bounding box**,
RGBA, black where masked (alpha 255), transparent elsewhere — the `overlay` filter only touches the
overlay's extent, so a small PHI box costs almost nothing (this is *not* the 3a full-frame composite).
Arbitrary drawn shapes are handled by the alpha; no rectangle assumption.

**Expected:** 8.7 s → 3–4 s on the t3.large. If it isn't at least **1.5×** faster on prod, it loses.

## 2. Scope of the experiment (deliberately narrow)

- New `applyEngine: 'sharp' | 'ffmpeg'`, read from env `APPLY_ENGINE` (default **`sharp`**, i.e. today).
  Logged in `apply.env`. No UI.
- ffmpeg engine handles **only**: MP4/DICOM jobs on the **reuse** path (frames already in
  `temp_extracted/`), `outputSettings.format` **JPEG**, output size **`original`**. Anything else
  (PNG output, resize/letterbox/crop, re-extract fallback, image batches) → the sharp engine, exactly
  as today. This keeps the experiment to one variable. If the engine wins, a follow-up can add
  `scale`/`pad`/`crop` filters and PNG output; do not do it now.
- Frame naming/indexing unchanged: input pattern `-start_number 1`, output `frame_%06d.jpg` 1-indexed;
  the Phase 6 co-indexing invariant is preserved because ffmpeg processes the sequence in order and
  writes one output per input. **Verify count in == count out** and fail the apply (fall back to
  sharp) on mismatch.
- Progress: fluent-ffmpeg `.on('progress')` → same socket payload as the sharp loop, 500 ms throttle.
- Probes: `[PERF] apply.engine {engine, frames, ms}`; keep `apply.mask_build`, `apply.source`,
  `apply.done`. The sharp path's per-frame probes are untouched.
- JPEG quality: `-q:v 2` (mjpeg scale; ≈ libjpeg q90–93). Report the actual output size per frame vs
  the sharp path's (~80 KB) and adjust `-q:v` so sizes match within ~10 % before measuring speed.
- Encoder gotcha to check: ffmpeg's mjpeg encoder defaults to `yuvj420p` (4:2:0 chroma). sharp's
  default is also 4:2:0. Confirm both, note it in the report.

## 3. Equivalence standard — different from the previous rounds, and stated up front

ffmpeg's mjpeg encoder is not libjpeg-turbo, so **bytes will differ and unmasked pixels will differ
within JPEG tolerance.** Byte-identity is not the bar here. The bar, checked on frames 1, 174, 348 of
the reference clip, both engines decoded to raw:

| region | requirement |
|---|---|
| masked pixels (from the offsets list) | every channel ≤ 8 after decode on **both** engines (JPEG ringing at the box edge is expected on both); interior of the box exactly 0 on both |
| unmasked pixels | mean abs diff ≤ 2.0, 99.9th percentile ≤ 16, max ≤ 32 (encoder variance) |
| frame count / names | 348 in, 348 out, `frame_000001.jpg … frame_000348.jpg` |
| downstream | AI run on the ffmpeg output works; ZIP + manifest unchanged in shape |

The operator accepts "different JPEG encoder, same pixels within tolerance" for this experiment. If
the engine is adopted, that becomes the standing definition of the masked-output contract — say so in
the report so it isn't rediscovered later.

## 4. Deploy + measure (operator)

Same runbook shape; snapshot `pre-round2c-deploy`. Then, on the same reference clip:

1. Upload once. Apply with the default (`APPLY_ENGINE` unset → sharp). Note `apply.done`.
2. `pm2 restart masquerade --update-env` with `APPLY_ENGINE=ffmpeg` in the PM2 env (ecosystem `env`
   or `APPLY_ENGINE=ffmpeg pm2 restart masquerade --update-env`). Confirm `apply.env … engine:"ffmpeg"`.
3. **Redo apply on the same job** (reuse path, same frames, same mask). Note `apply.done` and
   `apply.engine`. Repeat once more each way if the numbers are close.
4. Download both ZIPs; eyeball frame 1 and 348 from the ffmpeg run; run the §3 pixel comparison
   (Claude Code supplies the script; it takes the two job dirs).
5. DICOM multiframe with `APPLY_ENGINE=ffmpeg` (its raw frames are PNGs in `temp_extracted/` too).

## 5. Decision rule (pre-committed)

- ffmpeg ≥ 1.5× faster **and** §3 passes → make it the default, extend to resize/PNG in a follow-up,
  delete the sharp mask loop later once the follow-up lands.
- Otherwise → **delete the ffmpeg engine** in the next commit. Not "keep it behind the flag."

Either way the round ends with one engine.

## 6. Constraints
tsc 12 (same 12) · A3 frozen · `extractAllFramesSequential`, DICOM branch, background extraction
untouched · `buildApplyMask` reused, not reimplemented · sharp path byte-for-byte as deployed · no
change to what the UI sends.

## 7. Kickoff for Claude Code

> Continuing Masquerade (bring CLAUDE.md, whose top block now summarizes the perf/UX round). The
> operator is happy with the current state; this is **one bounded experiment**, per
> `docs/refactor/ROUND2C_FFMPEG_APPLY_EXPERIMENT.md`. Add an `APPLY_ENGINE=ffmpeg` path (default stays
> `sharp`, unchanged) that, on the reuse path with JPEG output at original size only, writes the
> prebuilt mask cropped to its bbox as an RGBA PNG and runs one ffmpeg process:
> `-start_number 1 -i temp_extracted/<jobId>/frame_%06d.png -i mask_bbox.png -filter_complex
> overlay=x:y -q:v 2 -threads 0 spokes/template_mask/<jobId>/frame_%06d.jpg`, with progress from
> `.on('progress')`, in==out frame-count check (fall back to sharp on mismatch), and a
> `[PERF] apply.engine` probe. Everything else routes to the sharp engine exactly as today. Provide a
> script that decodes frames 1/174/348 from two job dirs and reports the §3 metrics (masked-region max,
> unmasked mean/p99.9/max), and calibrate `-q:v` so output sizes match the sharp path within ~10 %.
> tsc 12, A3 frozen, no extraction changes. Output `docs/refactor/ROUND2C_REPORT.md` and stop before
> deploying. The decision rule in §5 is pre-committed: if it doesn't win on prod, the engine gets deleted.
