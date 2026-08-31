## Status — PERF / UX round COMPLETE (deployed + verified 2026-08-30)

> Paste this block at the top of `CLAUDE.md`, above "Phase 7A DEPLOYED", and **delete** the old
> "▶ ACTIVE WORK — PERFORMANCE / UX" section it supersedes. Everything below is verified on prod
> (`t3.large`, 2 vCPU) on one reference clip: `Normal Lung sliding 2.mp4`, 348 frames, 1536×796, 43 fps.

**Result on the reference clip (upload-complete → masked frames on disk): ~81 s → ~17 s.**

| stage | Round 1 (before) | now | change |
|---|---|---|---|
| first frame on disk (user can draw) | never — UI blocked until `ready` | ~1–2 s | Round 2A |
| background extraction (`bg_extract.done`) | 45.6 s | **8.0 s** | 2B-3b |
| apply: re-extraction (`apply.extract_all`) | 19.5 s | **0** (`apply.source: reuse`) | 2B-1 |
| apply: mask loop | 13.4 s | ~8.4 s | 2B-3a + hotfix |
| apply total (`apply.done`) | 33.3 s | **8.7 s** | |

### What shipped (each its own deploy, each re-measured on the same clip)

- **Round 1 — instrumentation.** `server/services/perf.ts`; `[PERF] {json}` lines at every pipeline
  stage (`upload.*`, `bg_extract.*`, `apply.*`). **They stay in prod.** Collect with
  `pm2 logs masquerade --raw | grep '\[PERF\]'`; pivot commands in `docs/refactor/PERF_ROUND1_REPORT.md`
  Appendix C. Numbers: `PERF_ROUND1_RESULTS.md`.
- **Round 2A — draw while extracting restored.** Frames endpoint raw branch serves frame *n* during
  `extracting` if on disk and a complete PNG (IEND check, `frameAccess.isCompletePngBuffer`), 503
  `no-store` otherwise; hub Template Mask tile enabled during `extracting` (AI tile still gated on
  `ready`); spoke polls `frames/0` on 503; **Apply disabled until `status === 'ready'`** with live
  extraction progress (`JobContext` now exposes the `progress` payload). History of why it was blocked:
  `FRAME0_GATE_HISTORY.md` (a Phase-4b design default for an in-memory store, carried forward — no
  error ever required it).
- **2B-1 — apply reuses `temp_extracted/`.** `tryReuseRawFrames` in `processVideo`: guards
  `samplingFps == null`, `jobV2.status === 'ready'`, on-disk count `=== totalFrames`, every file IEND-
  complete; any doubt → the unchanged re-extract path (`extractAllFramesSequential` + `_apply/`,
  DICOM branch intact). `[PERF] apply.source {mode: reuse|reextract, reason}`. Upload-time metadata
  reused on the reuse path (`apply.metadata {mode: cached|probe}`), existing A3 columns only.
- **2B-2 — `sharp.concurrency(os.cpus().length)`** at boot (`index.ts`). Measured **no gain** on the
  mask loop by itself — the loop was main-thread JS, not libvips. Kept; harmless.
- **Output format fix.** Masked frames were **JPEG bytes in `.png` files** (encoder unconditionally
  JPEG, extension from `outputSettings.format || 'png'`). Now the encoder follows the format:
  **default JPEG q90 → `.jpg` / `image/jpeg`**; PNG (`compressionLevel: 3`) only when the user selects
  it (UI copy: "Lossless. About 3× larger files."). Default path is byte-identical to before.
  `listFrameFiles` accepts `png|jpg|jpeg`; `mimeForFrameFile` derives Content-Type; manifest
  `outputFormat` fallback is `'jpg'`. Operator decision: JPEG default, PNG opt-in (disk: ~100 MB clips).
- **2B-3a + hotfix — mask built once, applied by offset list.** `buildApplyMask` once per apply
  (`[PERF] apply.mask_build {ms, masked_px, total_px, offsets}`), then per frame zero a precomputed
  `Uint32Array` of masked byte offsets on the raw buffer (`mask_mode: 'offsets'`). Byte-identical to
  the old full-scan loop at 0.12 %, 16 %, and 100 % coverage; faster at all three. The intermediate
  libvips-composite version was **slower on prod** (full-frame premultiply/blend to change 0.12 % of
  pixels) and is deleted.
- **2B-3b — single-pass background extraction (MP4).** `frameExtractor.extractAllFramesSinglePass`
  (new method, additive): one ffmpeg run, `-vsync 0 -compression_level 1`, image2 muxer straight into
  `temp_extracted/<jobId>/frame_%06d.png` (1-indexed). Progress from fluent-ffmpeg `.on('progress')`,
  throttled 500 ms, same socket payload. **DICOM keeps the 15-frame batch loop** (byte-identical
  verified). `bg_extract.done` carries `path`, `expected`, `parity`, `corrected`: on MP4 a count
  mismatch vs the ffprobe estimate is reconciled into `totalFrames` (shared A3 column, via
  `updateVideoJob`) **before** `ready`; on DICOM it is **not** (exact count → mismatch = missing frames
  → let reuse fall back). `isDicomHint` passed from the upload handlers so `isDicomFile` doesn't
  re-read the file.

- **2C — ffmpeg apply engine: tried, measured, DELETED.** One ffmpeg process (PNG sequence →
  `overlay` → JPEG sequence) ran the same apply in **7.73 s vs sharp 8.47 s (1.10×)**, below the
  pre-committed 1.5× bar, so the engine was removed (`ROUND2C_REPORT.md`, outcome: deleted).
  **Conclusion: ~8 s is the decode+encode floor for 348 frames on one physical core.** Node overhead
  was ~1 s, not the 4 s assumed. The software track on this box is closed; remaining levers are *less
  work* (grayscale raw frames, sampling rate, output size) and *more cores*.

### Facts surfaced this round that were documented nowhere

- **Masked frames are 0-indexed; raw frames are 1-indexed.** `spokes/template_mask/<jobId>/` is
  `frame_000000.jpg … frame_000347.jpg` (save loop pads `frameNumber` from 0) and
  `frameAccess.resolveFramePath` builds the masked filename directly from `n`; `temp_extracted/<jobId>/`
  is `frame_000001.png …` (ffmpeg image2 muxer). Any code writing masked frames must use base 0 or
  `GET /frames/:n` serves every frame off by one while every count check still passes.
- **The parity reconcile fires in practice.** The second clip uploaded after 2B-3b decoded 124 frames
  against an ffprobe estimate of 123; `totalFrames` was reconciled before `ready` and reuse kept
  working (`corrected: true`). MP4 only — DICOM counts are exact and a mismatch there means missing
  frames, so DICOM is deliberately *not* reconciled.

### Binding lessons from this round (add to the project's list)

- **Measure at the production shape.** The 3a regression passed a laptop A/B with a 16 % mask on many
  cores; prod is a 0.12 % mask on one physical core. Any masking/pixel A/B must run at prod-like mask
  coverage and state coverage next to every number.
- **Pixel-equivalence proof before any change to masking arithmetic** (byte-identical vs the retained
  old path). It caught an inverted composite (`dest-in` would have blacked out everything *except* the
  PHI) that every count/co-indexing check would have passed.
- **Node main thread is a resource.** `sharp.concurrency` cannot help a synchronous JS loop; and moving
  work into libvips only helps if the libvips work is smaller than what it replaces.
- Round 1's `maskWorker.ts` is **dead code** (nothing imports it) and carries 7 of the 12 tsc errors.

### Constraints unchanged
tsc = **12** (same 12: 5 `frameExtractor.ts` pixelBuffer + 7 `maskWorker.ts`) · A3 frozen (no
schema/status/column changes in this round) · `extractAllFramesSequential` + DICOM branch untouched
(now the apply fallback) · `frame_%06d`, 1-indexed, positional indexing preserved · Phase 6
co-indexing invariant preserved (masked frame *i* now derives from the exact `listRawFrameFiles()[i]`
the AI fallback and run download index — stronger than before) · 7B one-way doors still parked.

### Infra facts
App server `t3.large` (2 vCPU = 1 physical core, burstable; check `CPUCreditBalance` if a run is
mysteriously slow). Disk 29 GB, ~19 GB free; raw frames ≈ 350 KB each (123 MB for the 348-frame clip).
**Verify `3.136.48.97` is an Elastic IP before any instance resize.** Candidate upgrade when other
users arrive: `c6i.xlarge` (4 dedicated vCPU) — every stage above is CPU-bound.

### Backlog opened by this round (none blocking)
1. **2B-3c grayscale evaluation** — raw frames as 8-bit gray (`-pix_fmt gray`) gated on a frame-1
   chroma check (color Doppler stays RGB); ~3× disk on `temp_extracted/`, and a lossless PNG option
   the size of JPEG. Experiment + recommendation only.
2. **"Review masked frames" in the template-mask spoke** — `FrameViewer` (Clean mode) already reads
   `?source=template_mask`; today the only way to check a mask result is the ZIP or the AI spoke.
3. **Stale-`extracting` reconciliation at boot** — after a restart mid-extraction, 2A now lets the user
   into a canvas whose Apply never enables (upload purged at boot). Mark such jobs `failed` at startup.
4. **Image-batch output mislabel** — always encodes PNG but names from the upload's extension
   (`image_001_photo.jpg` containing PNG). Mirror of the fixed video bug; `videoProcessor.ts:1801`.
5. **Delete `maskWorker.ts`** (dead) → tsc baseline 12 → 5. Separate pass; changes the invariant.
6. **Stack scheduling** — 58 stacks in flight vs a 4-thread libuv pool inflates `decode_ms`; maybe
   ~2× left in the 8 s apply. Diminishing; only if apply time matters again.
7. `ANTHROPIC_API_KEY` still unset on prod (7A-4). Orphan base64 `firstFrame` in the upload response
   (dead since 4b). MemStorage (rollback target only) doesn't mirror `totalFrames` to `jobsV2`, so the
   reuse guard would trip there — documented, A3-frozen.
8. Product: a usage/tier model keyed on frames × resolution × format (all already on the job record).

**Docs:** `docs/refactor/TEMPLATE_MASK_APPLY_PERF_ROUND1.md`, `PERF_ROUND1_REPORT.md`,
`PERF_ROUND1_RESULTS.md`, `FRAME0_GATE_HISTORY.md`, `ROUND2A_FRAME0_UNBLOCK.md`, `ROUND2A_REPORT.md`,
`ROUND2A_DEPLOY_RUNBOOK.md`, `ROUND2B_PROPOSAL.md`, `ROUND2B_REPORT.md`, `ROUND2B_ADDENDUM.md`,
`ROUND2B_DEPLOY_RUNBOOK.md`, `ROUND2B3_PROPOSAL.md`, `ROUND2B3A_REPORT.md`, `ROUND2B3A_HOTFIX.md`,
`ROUND2B3A_HOTFIX_REPORT.md`, `ROUND2B3B_REPORT.md`, `ROUND2C_FFMPEG_APPLY_EXPERIMENT.md`,
`ROUND2C_REPORT.md`. EBS snapshots `pre-round2a-deploy` … `pre-round2c-deploy` (2026-08-30).
Rollback for any single step is a plain `git revert`.
