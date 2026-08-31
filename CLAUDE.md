# Masquerade

## Status — PERF / UX round COMPLETE (deployed + verified 2026-08-30)

Verified on prod (`t3.large`, 2 vCPU) against one reference clip: `Normal Lung sliding 2.mp4`,
348 frames, 1536×796, 43 fps.

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

---

## Status — Phase 7A DEPLOYED + VERIFIED (2026-07-22)

Phase 7 is a **cleanup + hardening pass** to produce a clean build for a heavy manual-testing
period. **Not commercial work** — auth / HIPAA / billing / multi-tenancy are explicitly deferred
(operator: ~2–3 months out). Split into **7A (safe, reversible — batched)** and **7B (one-way
doors — plan-only until testing supplies the gate evidence)**.

**7A is deployed and verified in production (2026-07-22).** CORS confirmed working from both apex
and `www.` (live progress advanced on both hosts); flicker fix and base-frame toggle smoke tests
(8a/8b/8c incl. the raw-run case) passed. **Deployed tsc baseline is now 12** (the 17→12 drop from
7A-5's trivial fixes shipped). **New standing invariant: tsc stays at 12** — all future phases hold
12; the deferred 12-narrowing pass (7A-5 remainder) is the only sanctioned path to lower it.

7B remains **plan-only** — its one-way doors are gated on evidence from the heavy testing period
(watch `[DEADROUTE-HIT]` for 7B-1; watch `temp_processed/` staying empty for 7B-3).

> Note on the DICOM fix that followed 7A: a separate DICOM apply-path regression was found and fixed
> right after 7A deployed — see the "DICOM apply-path regression FIXED" block below. It also lives in
> `frameExtractor.ts` but is unrelated to 7A's changes.

**7A — safe cleanup (status: DEPLOYED + VERIFIED 2026-07-22):**
- 7A-0: base-frame toggle smoke tests (8a/8b/8c) — owed from Phase 6, folded into the 7A deploy
  verification (esp. 8c: raw run → toggle on → `images/` populated from raw frames). **Owed at deploy.**
- 7A-1: Socket.IO CORS `origin:"*"` → env-driven allow-list. ✅ **implemented** (`routes.ts`,
  re-locate): default `["https://masqueradeimage.com","https://www.masqueradeimage.com"]`; dev adds
  `http://localhost:5000`; `ALLOWED_ORIGINS` env overrides. ⚠️ **verify at deploy**: real upload w/
  live progress from BOTH apex and `www.` (WS handshake must pass CORS per host).
- 7A-2: remove Express request-dump middleware. ✅ **implemented** (`index.ts`, was `:9–21`) —
  confirmed pure logging (ran before `express.json`, `next()` only); API-response logger untouched.
- 7A-3: first-paint 0% progress flicker. ✅ **implemented** (`ProcessingStatus.tsx`, frontend-only):
  additive indeterminate "Connecting to processing updates…" branch when job present + `progress`
  null + not complete; self-healing. Visual check owed at deploy.
- 7A-4: `ANTHROPIC_API_KEY` invalid on prod. **operator-runbook (no code)** — `intentParser.ts` left
  unchanged (log-dedup declined). Fallback is graceful (keyword path is Stage-1 PRIMARY). Fix = set a
  valid key in the PM2 env; **no key committed.**
- 7A-5: the 17 pre-existing `tsc` errors. ✅ **5 trivial fixes landed** (`dcmjs` ambient decl in new
  `server/types/dcmjs.d.ts`; 2 catch-var narrows + 2 `Array.from` in `frameExtractor.ts`).
  **Working-tree tsc 17 → 12.** Per the amendment, the 12 risky narrowings (5 `frameExtractor`
  pixelBuffer + 5 `maskWorker` bbox-union + 2 `feather`) are **DEFERRED untouched** to a later pass.
  **New invariant once deployed: tsc stays at 12** (deployed baseline is still 17 until 7A ships).
- 7A-6: Vite chunk-size warning (661KB single bundle). **DEFERRED** (operator decision) —
  `vite.config.ts` unchanged; warning accepted for the testing period. Now a backlog item.
- 7A-7: `attached_assets/`. **report-and-stop (no gitignore)** — grep shows `landing.tsx:18` imports
  the hero GIF via `@assets` (build/runtime dep). Backlog premise was STALE: all **65** files are
  already git-tracked. No action; off-repo hosting (S3) is a future decision requiring the import to
  move off `@assets` first.

**7B — one-way doors (status: PLAN-ONLY; gated on testing evidence):**
- 7B-1: remove `/api/videos/:jobId/process` (dead legacy, item 16; handler at `routes.ts` ~`:453`,
  re-locate). Static sweep = ZERO client callers (live path is
  `POST /api/jobs/:jobId/template-mask/apply`). **`[DEADROUTE-HIT]` instrument ADDED** (first line of
  the handler, `console.warn` w/ jobId+origin+referer+UA) — operator watches prod logs for it during
  testing; **if it ever fires, the route is NOT dead.** Removal (handler + instrument) needs a clean
  **live-log no-hit gate** AND zero source+bundle grep before it happens. (HTTP 200 ≠ removal proof —
  SPA catch-all.) Handler NOT removed this session.
- 7B-2: `5B-1c` dead-code removal — **BLOCKED / could not re-confirm**: backlog's `routes.ts:361`
  ref is STALE (361 is live image-batch builder code). History sweep found no alternative target.
  Needs operator/planning input before any removal.
- 7B-3: drop `temp_processed/` from `SWEEP_TARGETS` (`cleanup.ts:68`) + `purgeTempProcessedOnStartup`
  (`cleanup.ts:328`, called `index.ts:135/140`) — static-clean in 5B; **the upcoming testing period
  IS the wait-and-watch window**. Remove after a clean observation window (dir stays empty ≥7
  continuous days under heavy use).
- 7B-4: item 15 (download masked-vs-raw asymmetry; whole-job 404 at `routes.ts:552–554`) —
  **operator decision** (unify raw fallback vs leave documented), not yet scheduled.

**Constraints:** A3 storage/schema/status/shim/migrations FROZEN (verified untouched this session).
No commercial work. 7B not executed until gates pass. Deferred to a later pass: the 12 tsc narrowings
(7A-5 remainder) + 7A-6 chunk-split. Docs: `docs/refactor/PHASE_7_PROPOSAL.md`,
`docs/refactor/PHASE_7A_REPORT.md`.

## Status — DICOM apply-path regression FIXED (deployed + verified 2026-07-22)

DICOM template-masking is restored and production-verified: **single-frame and multiframe
uncompressed DICOM both extract, mask, carry through to the AI spoke, and download correctly.**
Found during post-7A testing (issue #1 of two the operator reported; issue #2 = the upload/extraction
slowdown, **resolved** — see "PERF / UX round COMPLETE" at the top of this file).

**Root cause:** commit `280cb38` (2026-04-28, *pre-Phase-2*) rewrote the apply-path extraction to the
DICOM-blind `extractAllFramesSequential`, which handed the raw `.dcm` straight to ffmpeg
(`code 183: Invalid data found`). The DICOM interception (`isDicomFile()` → `extractDicomFrame`) that
the old `extractFrameBatch` route carried was never ported into the new method. Long-dormant — the
last working DICOM-apply build predated Phase 2; no one had re-tested a DICOM through apply→download
until now. (The investigation correctly refused to back-fit the bug onto the Phases 3–5 window the
kickoff suspected; git-diff proved the break predates them.)

**Fix (Option B):** one **additive** branch at the top of `extractAllFramesSequential`
(`frameExtractor.ts`, ~`:193-218`): `if (await this.isDicomFile(videoPath))` → loop
`extractDicomFrame(i)` for `i` in `0..totalFrames-1`, write `frame_${i+1}` padded to 6 digits
(`frame_%06d.png`, **1-indexed to match the ffmpeg image2 muxer** so the sorted readback and every
downstream consumer are identical), `return` the paths; `else` → the unchanged ffmpeg block. MP4 path
byte-for-byte unchanged. `tsc` stays **12** (the 5 deferred `pixelBuffer` errors merely shifted line
numbers +26; code at those sites untouched). A3 frozen.

**Key facts for future work:**
- **DICOM is still `type:'video'` / `filePath = uploads/<hash>`** — no `jobType:'dicom'` discriminator
  exists; DICOM-ness is detected at the extraction layer (`isDicomFile()`), by design.
- **DICOM extraction ignores `samplingFps`** (extracts every frame), matching pre-`280cb38` behavior.
  DICOM down-sampling would be a separate future feature.
- ~~**DICOM double-extraction exists**~~ — **FIXED in 2B-1.** `startBackgroundFrameExtraction` still
  extracts DICOM frames to `temp_extracted/<jobId>/` at upload time, but `processVideo` now **reuses
  them** instead of re-extracting from the raw `.dcm`. The Option-A "reuse frames already on disk"
  approach that was rejected for the DICOM hotfix (background-extraction timing race) became safe once
  Round 2A gated Apply on `status === 'ready'`. Re-extraction survives as the guarded fallback.
- **DICOM extraction is per-frame synchronous** (`await extractDicomFrame` in a loop, and it re-reads
  + re-parses the whole `.dcm` on every frame) — still true at **upload** time; 2B-3b left the DICOM
  batch loop alone deliberately (ffmpeg cannot demux a DICOM container). No longer paid at apply time.

**Verified:** single-frame `.dcm` (`frames:1`), multiframe `.dcm` (extracted count = `NumberOfFrames`),
mask carries into AI spoke, downloads good; **MP4 regression guard passed**. Docs:
`docs/refactor/DICOM_REGRESSION_DIAGNOSIS.md`, `DICOM_REGRESSION_FIX_REPORT.md`. Snapshot
`pre-dicom-fix-deploy 2026-07-22`.

**Known untested boundary (NOT a bug):** *compressed* DICOM (JPEG/JPEG2000/RLE transfer syntax) is
unverified — confirmed test data is uncompressed Explicit VR LE (`1.2.840.10008.1.2.1`). If a
compressed DICOM misbehaves later, that's a separate scoped item (add a decode path), not a
regression of this fix.

---

## Status — Phase 6 COMPLETE (deployed + verified 2026-07-21)

Phase 6 (manifest builder unification + base-frame toggle) is **deployed and verified in
production.** `tsc` baseline unchanged at **17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`)
*(historical — the standing baseline is now **12** as of 7A-5; see the Phase 7A block at top)*.

**What shipped:**
- **(b)-lite unification.** The per-frame `frames[]` assembly + `metadata.csv` derivation were
  extracted into one shared core, `server/handlers/frameManifest.ts`
  (`buildPerFrameManifestAndCsv({ frameCount, labels, outputFormat }) → { frames, csv }`;
  precedent `templateMaskApply.ts` from 3c). The whole-job builder
  (`templateMaskDownloadHandler`) and the run-scoped builder
  (`GET /api/jobs/:jobId/ai/runs/:runId/download`) each keep a thin wrapper that picks its own
  frame set + approval-filtered label set, calls the core, and wraps its own job/run-level
  metadata. Not merged into one branchy function — the wrappers genuinely diverge (label scope,
  frame source, ZIP payload).
- **Run download gained per-frame data.** The single-run AI ZIP now contains `frames[]` in
  `manifest.json` **and** a `metadata.csv` (previously it had neither — the drift 5A surfaced).
  Additive only; all pre-existing run-manifest fields unchanged (**D1**).
- **NEW: "Include base frames" toggle** on the FrameViewer "Continue to Download" flow
  (the one authorized frontend change, `FrameViewer.tsx`). Sends
  `?includeBaseFrames=true`; when on, the run ZIP also carries `images/` base frames via
  **masked-first / raw-fallback** (`listFrameFiles` → `listRawFrameFiles` from `frameAccess.ts`,
  keyed on `run.inputSource`, with masked-empty→raw fallback for swept template dirs). Invariant:
  the user always gets the frames the AI actually ran on. Toggle OFF = pre-Phase-6 behavior
  exactly (no `images/`).

**Key design facts (for future work):**
- **Run `frames[]` is enumerated from the run's own `mask_<i>.png` files** (`run.outputDir`),
  NOT from `template_mask/` — a `raw` run has an empty template-mask dir, so template-mask
  counting would wrongly yield zero. Metadata frame set and base-frame payload are **decoupled**:
  the toggle gates only whether `images/` files are added; `frames[]`/CSV are emitted identically
  regardless.
- **Co-indexing invariant (proven in the pre-deploy addendum):** for a completed run,
  `frames[].frame_number == i`, `mask_<i>.png`, `overlay_<i>.png`, and `images/frame_%06d(i)` all
  denote the same sorted-position `i`, because inference wrote `mask_<i>` while iterating the exact
  `listFrameFiles`/`listRawFrameFiles` array the download resolver re-reads (same deterministic
  function, same dir), and one mask is written per base frame unconditionally.
- **`filename` in `frames[]` is nominal** (synthesized `frame_%04d.<outputFormat>`), NOT a literal
  ZIP path — the whole-job builder already had 4-pad manifest vs 6-pad `images/` and a possibly
  different `ext`. Propagated knowingly to preserve D1 field-compatibility. One CSV parser works
  for both ZIPs.
- **`has_mask` is `true`** on both paths (run side: true by construction, since the frame set is
  derived from the mask files).
- **Intentional temporary asymmetry (item 15 still parked):** the run download has raw-fallback
  for base frames; the whole-job `templateMaskDownloadHandler` still 404s when `template_mask` is
  empty and was deliberately NOT given raw-fallback. If you later unify the download fallback, do
  it on purpose, not by accident.
- **Swept-dir behavior:** run download with `includeBaseFrames=true` when both frame dirs are
  swept → `images/` silently omitted, masks/overlays/manifest/CSV still returned (they live in
  `run.outputDir`, a separate lifecycle). Graceful degrade, not a 410.

**Verification status (honest):**
- **Run-download `frames[]` + per-frame `ai_labels`: VERIFIED** directly from the post-deploy AI
  manifest (job `8fa3a9bb`, Kidney.mp4, 46 frames, approved-only, co-indexed 0–45, bbox/confidence
  present). This was the actual bug fixed. ✅
- **Whole-job export structurally intact: VERIFIED** (post-deploy manifest has correct headers,
  populated `ai_labels`, `frames[]`). ✅
- **D1 byte-identical gate: ACCEPTED-AS-EXPLAINED, not cleanly proven.** The operator's before/after
  template downloads were taken in *different job states* (before-copy at 21:34 predated the AI run
  at 21:35, so `ai_labels: []` → `[{…}]` between the two). The delta is fully explained by the
  state change and shows no format regression, but a same-state before/after diff was not captured.
  Accepted given userbase = 1. ⚠️
- **Base-frame toggle smoke tests (8a/8b/8c): NOT YET RUN.** The toggle is additive and unverified
  in production — especially **8c (raw run: skip mask → run AI → download with toggle on → confirm
  `images/` populated from raw frames)**, the highest-risk new path. Worth a casual check when
  convenient; does not block the manifest-unification result.
- **tsc 17 + clean build: VERIFIED** (pre-flight). ✅

**Docs:** `docs/refactor/PHASE_6_PROPOSAL.md`, `PHASE_6_REPORT.md`, `PHASE_6_REPORT_ADDENDUM.md`
(the co-indexing proof + Q2/Q3 resolutions). EBS snapshot `pre-phase-6-deploy 2026-07-21` taken.
Rollback is a plain `git revert` (Phase 6 touched no storage/schema/migrations).

---

## Status — Phase 5 COMPLETE (verified 2026-07-14)

Phase 5 is **fully complete and production-verified.** The app now runs durably on
Postgres (RDS/Aurora, **A3** single-source-of-truth schema) — jobs survive restarts — and
all five sub-phases are landed: **5A** (AI-spoke canvas relocation + single-run download),
**5B** (backend/infra cleanup), **5C-1** (Postgres foundation, 35/35 conformance vs real
RDS), **5C-2** (production cutover — jobs survive restarts), **5D** (upload→hub
loading-hang fixed). `tsc` baseline unchanged at **17** (10 `frameExtractor.ts` +
7 `maskWorker.ts`).

### Phase 4 — COMPLETE (verified 2026-06-20)

Phase 4 (frontend hub-and-spoke migration) is **fully deployed and live-verified.**
The app now runs entirely on canonical `/api/jobs/:jobId/...` URLs; the legacy
`VideoJob` dual-record and legacy URL surface are gone from the active path.
`tsc` baseline unchanged at **17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`).

Sub-phases — all landed + verified:
- **4a** — routing scaffolding + hub page + both spoke pages (went beyond original scope).
- **4b-0** — raw frames moved to disk; `processVideo` made re-entrant (commit `b734e6d`);
  a tripwire test guards the directory-nesting class.
- **4b-i** — template-mask spoke on canonical URLs.
- **4b-ii** — AI spoke on canonical URLs; AI gate changed to `job.status==='ready'`
  (template masking is **OPTIONAL** — AI runs on raw frames via masked-first/raw-fallback);
  masked-frame staleness fixed with `&v=completedAt` cache-bust.
- **4d-1** — straggler migration (CommandInput infer, ProcessingStatus download,
  FrameViewer overlay) + surgical backend `runId` added to `inference.json` payload + exhaustive audit.
- **4d-1b** — migrated two queryKey-array status polls the 4d-1 literal-grep audit missed
  (ProcessingStatus + template-mask-spoke, `['/api/videos', jobId]` → `['/api/jobs', jobId]`/`useJob()`).
- **4d-2** — one-way teardown: removed 11 legacy URL aliases, the `/internal/mask-processing`
  wrapper, `getLegacyJobHandler`, `home.tsx`, `FileUpload.tsx`, and the `/app` route. App runs
  entirely on canonical URLs. Live-verified: zero 404s, zero legacy hits across every workflow;
  `/app` 404s by design; raw-frame durability intact.

### Phase 4 lessons (binding for future work)

- **Re-entrancy bugs are invisible to static path analysis** — test functions for safe
  re-invocation with first-run residue present (the 4b-0 saga).
- **Static URL audits miss dynamically-constructed URLs** — react-query queryKey arrays
  (`['/api/videos', jobId]`), base-path concatenation, segment joins. A literal-string grep is
  necessary but **NOT sufficient**; confirm with a **live log / Network check on a fresh session**
  before any irreversible removal. (The 4d-1b catch: a queryKey-array poll a literal grep missed,
  caught only by the live sweep before 4d-2 would have 404'd it.)
- **Split irreversible steps from reversible prep** — 4d-1/4d-1b (migrate + audit, reversible)
  then 4d-2 (one-way removal). This caught a real production-breaking dependency before removal.
- **Many "bugs" were observation artifacts, not real bugs** — phantom frame deletion
  (timing/stale-tab), "old code running" (server on wrong SHA / cached bundle), 0-frame reads
  (wrong working directory). Verify actual state before acting; don't fix non-bugs.
- **Measure at the production shape** (perf/UX round). The 2B-3a regression passed a laptop A/B with
  a 16 % mask on many cores; prod is a 0.12 % mask on one physical core, and the change was *slower*
  there. Any masking/pixel A/B must run at prod-like mask coverage, and every number must state its
  coverage next to it.
- **Pixel-equivalence proof before any change to masking arithmetic** — byte-identical against the
  retained old path, on a real frame. It caught an inverted composite (`dest-in` would have blacked
  out everything *except* the PHI) that every frame-count and co-indexing check would have passed.
- **The Node main thread is a resource.** `sharp.concurrency` cannot help a synchronous JS loop, and
  moving work into libvips only helps if the libvips work is *smaller* than what it replaces (2B-2
  measured zero; the 2B-3a composite measured worse).

### Deploy-hygiene checklist

- Confirm the server's `git log --oneline -1` matches the pushed SHA **before** building.
- Run `npm`/build from **inside** `~/template-masking-app`, not `~`.
- Hard-reload the browser after frontend deploys; confirm the `index-*.js` bundle hash changed.
- Shell variables + multi-step disk checks: **one command per line** (mashing
  `JOB_ID=... ls ... pm2 ...` onto one line silently fails).
- EBS snapshot before every deploy; smoke-test every workflow on destructive phases.

## Phase 5 — Post-refactor (priorities)

Phase 5 likely **starts with 5A** (small, self-contained, user-visible frontend wins) while
**5C** is scoped separately as the larger infra track. **5B** items are mostly independent small PRs.
*(Suggested sequencing — not a decision.)*

### 5A. AI-spoke canvas polish (frontend; flagged during Phase 4 — diagnosis recorded, not yet fixed)

1. Shared `MaskingCanvas` exposes the template-mask rectangle-drawing affordance inside the AI
   spoke; it should be **bbox-only** there. Likely needs a mode/context prop to scope drawing
   behavior per spoke.
2. The AI bbox renders **small and offset to the side** — likely a coordinate-space/scaling
   mismatch between the displayed canvas and the native frame dimensions.
3. The **"continue to download" button in the frame viewer renders but does nothing on click** —
   the AI image/bbox bundle won't download (manifest/metadata export works fine). Likely a
   runId-less or unwired handler on the single-run AI download path. *(To diagnose: open DevTools
   Console, click the button; a thrown error names the cause — runId undefined / failed fetch /
   404 — vs. silent = unwired handler.)*

### 5B. Backend/infra cleanup backlog (carried from Phase 4)

**Phase 5B Deploy 1 landed (2026-06-25)** — one reversible deploy; `tsc` held at 17. See
`docs/refactor/PHASE_5B_REPORT.md`. Completed: shared path-traversal guard `resolveWithinRoot`
(`cleanup.ts`, applied in `templateMaskFolderManager.ts` + `applyPaths.ts`), room-scoped progress
broadcast (`videoProcessor.ts:1081`), file rename (`tempFolderManager.ts` → `templateMaskFolderManager.ts`),
stale-comment fixes (vp:388/698), `deleteProcessingProgress` folded into `deleteVideoJob`, and removal
of the `/api/test-post` + `/test-non-api` debug endpoints. *(Numbered detail in the Post-refactor
cleanup backlog below, items 3–10.)*

**Still open after Deploy 1:**
- Remove `/api/videos/:jobId/process` (confirmed dead legacy, no caller; flagged in 4d-2 — backlog item 16). → **Phase 7B-1 (gated; plan-only)** — current `routes.ts:437`; live-log no-hit gate required.
- `5B-1c` dead-code lead — the original `routes.ts:361` ref is STALE (line 361 is live code); needs a corrected reference before removal. → **Phase 7B-2 (gated; plan-only)** — could not re-confirm; needs operator input.
- `5B-4` — drop `temp_processed/` from `SWEEP_TARGETS` + `purgeTempProcessedOnStartup`: PARKED on the runtime "quiet" confirmation (no code writes there — static-confirmed in 5B). → **Phase 7B-3 (gated; plan-only)** — testing period is the wait-and-watch window.
- Socket.IO CORS `origin: "*"` (`routes.ts:100–102`) — tighten before launch (new backlog item 17). → **Phase 7A-1 (PLANNED)**.
- Express request-dump middleware (`index.ts:9–20`) — logs every POST/PUT/PATCH; follow-up removal. → **Phase 7A-2 (PLANNED)**.
- Add a **canonical progress source** so `ProcessingStatus` doesn't show 0% for a beat before the
  first WebSocket progress event (the cosmetic first-paint flicker logged in 4d-1b). → **Phase 7A-3 (PLANNED)**.
- Resolve the invalid `ANTHROPIC_API_KEY` on prod (NLP intent parser currently falls back to the
  keyword path). → **Phase 7A-4 (PLANNED; likely operator/secret fix, not code)**.
- ~~`PgStorage` decision (keep stubs or remove).~~ **RESOLVED in 5C-1 (2026-06-30):** stubs fully implemented (Postgres-backed, **Option A3** single source of truth — `VideoJob`/`Job` derived from one `jobs` row, no blob). Still not wired to the live runtime — cutover is 5C-2.
- Address or `@ts-expect-error` the 17 pre-existing `tsc` errors (`frameExtractor.ts` 10, `maskWorker.ts` 7). → **Phase 7A-5 (PLANNED; sequenced LAST; changes tsc baseline, target 0)**.
- Vite chunk-size warning (code splitting). → **Phase 7A-6 (PLANNED; low-risk only, else defer)**.
- `attached_assets/` not in git (populated server-side) — commit or migrate to S3-served URLs. → **Phase 7A-7 (PLANNED; decision only, no implementation)**.

### 5C. Durability (the big infra item)

- Replace `MemStorage` with Postgres-backed storage to end job-record volatility (jobs currently
  wiped on PM2 restart; disk artifacts survive but `Job` records don't). Precondition for any
  feature that needs jobs to persist across restarts; pairs with the eventual login/commercial tier.

**5C-1 landed (2026-06-30) — foundation, no cutover; built as true Option A3.** Built and
validated the Postgres storage layer; `MemStorage` is still the live runtime (`storage.ts`
ends with `new MemStorage()`, unchanged — it stays the oracle). `tsc` held at 17.
Decision A = **Option A3 (single source of truth)**: **one** `jobs` row per id, every fact in
exactly one column. The legacy `VideoJob` and the clean hub-and-spoke `Job` are **derived** in
the `PgStorage` shim — **no** `video_job` blob, **no** `has_job_v2`, **no** standalone
`video_jobs` table (an earlier pass had shipped A1's blob/`has_job_v2` substance under an
"Option A" label; this corrects it). Shared facts (`filename, duration, width, height,
frame_rate, total_frames, error_message`) occupy **one** column read by both derivations; the
**only** two-column case is `status`, split into `video_status` (legacy 6-value) and
`job_status` (V2 3-value) because the mirror is lossy/non-invertible — these double as
facet-existence markers (`video_status IS NOT NULL` ⟺ VideoJob facet; `job_status IS NOT NULL`
⟺ Job facet). Gate A dispositioned all 21 VideoJob columns (Direct / Derived / Unused);
`outputZipPath` is Unused→`null` and `fileCount` is derived (`fileList?.length ?? 1`, verified
write-only/dead-read) — neither gets a column. `ai_runs` is a real child (FK → `jobs.id`
`ON DELETE cascade`); `ai_initialized` mirrors MemStorage's `job.ai` lifecycle (present-but-empty
`runs`). `VideoJob`/`insertVideoJobSchema` are now hand-authored in `shared/schema.ts` (the
table that backed `$inferSelect` is gone). Decision B = B1 RDS. Delivered: driver swap
(`db.ts` neon-http → `pg`/`drizzle-orm/node-postgres`), `migrations/0000_hard_cable.sql`
(3 tables, `jobs` = 28 cols) + hand-authored down-path, full `PgStorage` derivation shim (all
21 `IStorage` methods incl. the status mirror and facet independence), and
`scripts/conformance-storage.ts` (one suite, all 21 methods, run against `MemStorage` **and**
`PgStorage`). MemStorage oracle: **35/35 PASS**. The `PgStorage` run — the actual proof the A3
derivation holds — is gated on Andre provisioning RDS; see
`docs/refactor/PHASE_5C1_RDS_RUNBOOK.md` (env vars `DATABASE_URL`, test-only
`TEST_DATABASE_URL`). PgStorage subsequently ran **35/35 vs real Aurora** (168 assertions
across both backends, ALL SUITES PASSED). **Next: 5C-2** = production cutover.

**5C-2 COMPLETE (2026-07-13) — app durably on Postgres, verified in production.** Decision B = **direct flip**
(no dual-write, no backfill): MemStorage was ephemeral (wiped every restart), so there was no
persistent data to protect, and PgStorage was already proven in 5C-1. The behavioral change is
one source line in `server/storage.ts`: `export const storage = new PgStorage()` (was
`new MemStorage()`), plus the required `import { PgStorage } from './pgStorage'`. **`MemStorage`
the class is retained untouched as the rollback target** — reverting is a one-edit + rebuild with
no data to un-migrate. `tsc` held at 17. Boot now **requires `DATABASE_URL`**: the import chain
`index.ts → routes.ts → storage.ts → pgStorage.ts → db.ts` makes `db.ts` throw synchronously at
load if it is unset (loud PM2 crash-loop, not a silent MemStorage fallback); an unreachable/bad-cred
DB (URL set) is caught at **boot** by an eager `SELECT 1` probe in `index.ts` (added 5C-2) that
`process.exit(1)`s → PM2 crash-loop, rather than surfacing as a first-request 500 (the raw pg Pool is
lazy). The probe is gated on `storage.constructor.name === 'PgStorage'` and dynamically imports `./db`
only on that path, so a `storage.ts`-only rollback to MemStorage self-disables it (still boots with no
`DATABASE_URL`). **No `dotenv`** in this project, so `DATABASE_URL` must be a real PM2 env var
(ecosystem `env` / `--update-env`), not a `.env` file. SSL server-side is the same shared
`resolveSsl` (auto-on for `rds.amazonaws.com`). The circular import
`storage.ts ↔ pgStorage.ts` is safe (`mapVideoJobStatusToJobStatus` is a hoisted `export function`,
called only at request time). Nothing user-visible changes **except jobs now survive a restart** —
the entire point, and the smoke test that defines success (`create job → pm2 restart → job survives`).
Production RDS (new instance, encryption ON, SG → app EC2 `3.136.48.97:5432`) is provisioned and
migrated by the operator via `docs/refactor/PHASE_5C2_RDS_RUNBOOK.md`. `deployment-package/server/storage.ts` is a stale tracked
build snapshot, **not** flipped (not the live source tree).

**Production verification (2026-07-13):** job `eb553c54` (`Kidney.mp4`) survived a `pm2 restart`
and was confirmed present in the `jobs` table — the restart-durability pass criterion is met.
Getting there surfaced one env-mismatch failure: the running PM2 process carried a **stale Neon
`DATABASE_URL` cached in its environment** (reachable but unmigrated, so `SELECT 1` passed yet
`relation "jobs" does not exist` on every write); a plain `pm2 restart` reuses the daemon's cached
env, so the fix was `pm2 delete` + a fresh start with the correct RDS `DATABASE_URL`. The boot probe
was made schema-aware (`131074c`) so future boots self-report their actual DB target and FATAL-exit
on a schema-less DB — see `docs/refactor/PHASE_5C2_ENV_MISMATCH_HANDOFF.md`. **Next: Phase 6.**

### 5D — Hub loading-hang: COMPLETE (2026-07-13), Phase 5 complete

Upload→hub hang (hub stuck "loading" until a hard refresh) — **fixed. Frontend-only.**

**Corrected root cause.** The earlier hypothesis in this note named the `storage.ts:129–140`
status mirror ("mirror silently no-ops → hub hangs"). **The 5D trace proved that false.** The
backend was always correct: both facets are created eagerly at upload
(`routes.ts:162/167`, `:241/246`), extraction completion writes through `updateVideoJob`
(`videoProcessor.ts:1182`) which fires the mirror `ready → ready` into the already-present Job
facet, so `job_status = ready` at completion on **both** MemStorage and PgStorage (which is
*why* a hard refresh worked — a fresh `GET /api/jobs/:jobId` read the already-correct value).

The real defect was in the hub's data source: `client/src/contexts/JobContext.tsx` listened
for the `progress` socket event but **never emitted `socket.emit('join', jobId)`**, so its
socket never entered the room the emits are scoped to (`io.to(jobId)`, `videoProcessor.ts:1084`)
→ zero `progress` events → never refetched past the initial `extracting` snapshot. The two
working consumers (`ProcessingStatus.tsx`, `CommandInput.tsx`) both join; JobContext was the
lone anomaly.

**Exposed by 5B, not a 5B regression.** Pre-5B, progress was a global `io.emit` broadcast, so
the missing `join` was harmless. 5B correctly scoped emits to `io.to(jobId)` (stopping cross-job
leakage) — the right change — which turned the latent missing-join into a live hang. 5D closes
the pre-existing latent defect; it does not undo 5B's room-scoping.

**Fix.** `JobContext.tsx` joins the room + re-joins on every (re)connect, and reads via the
codebase's existing React Query `refetchInterval` mechanism, bounded to poll only while the
status is non-terminal and stop at `ready`/`failed` (self-heal against a missed/late emit).
Frontend-only, zero backend/status/schema change, `tsc` stays 17, A3 two-column model and the
conformance suite untouched. See `docs/refactor/PHASE_5D_PROPOSAL.md` / `PHASE_5D_REPORT.md`.

**Phase 5 complete** (5A, 5B, 5C-1, 5C-2, 5D).

## Phase 6 — backlog

### Phase 6 candidate — unify the two AI/export manifest builders — ✅ DONE (2026-07-21)

**Resolved via (b)-lite** — shared `frameManifest.ts` core + two thin wrappers; run download
gained `frames[]` + CSV; base-frame toggle added. See the Phase 6 status block at the top of this
file and `docs/refactor/PHASE_6_REPORT.md` / `PHASE_6_REPORT_ADDENDUM.md`. The original candidate
description is retained below for historical context.

**Discovered during Phase 5A** (not a 5A regression; 5A was frontend-only and
the manifest builders were untouched — `routes.ts` last changed at 4d-1).

There are two divergent manifest builders in `server/routes.ts`:

- **Frame-by-frame builder (~lines 621–747):** assembles `frames: manifestFrames`
  (per-frame array) plus a CSV derived from `manifestFrames` (~line 747). This is
  the per-frame manifest shape.
- **Run-scoped builder (lines 1742–1780):** the single-run AI download endpoint
  `GET /api/jobs/:jobId/ai/runs/:runId/download`. Emits run-level metadata
  (`runName`, `maskCount`, `overlayCount`, run-level `labels[]`) and the 87
  per-frame mask/overlay PNGs — but NO per-frame `frames[]` array and no CSV.

**Why it surfaced now:** Phase 5A wired the FrameViewer "Continue to Download"
button (previously a no-op) to the run-scoped endpoint (1742). So users now get
the run-scoped manifest from that button, which lacks the per-frame label
metadata the frame-by-frame builder produces. The per-frame masks/overlays ARE
present in the run-scoped ZIP; only the per-frame *metadata* (manifest `frames[]`
+ CSV) is absent.

**Phase 6 decision:** either (a) port the `manifestFrames` per-frame assembly
(and CSV) from 621–747 into the run-scoped builder at 1742–1780, or (b) unify
both builders into one shared manifest function so the two export paths can't
drift again. Confirm which export paths each builder serves before changing
either (the 621–747 path may be the legacy whole-job / template-mask download —
verify its callsite). Frame-by-frame metadata was never lost from the codebase;
this is reconciliation, not restoration.

---

**Phase 4a landed (May 2026):** Routing scaffolding, upload page, hub page. New routes: `/upload`, `/jobs/:jobId`, `/jobs/:jobId/template-mask`, `/jobs/:jobId/ai`. `/` now redirects to `/upload`. New `GET /api/jobs/:jobId` endpoint returns the `Job` V2 record (hub-and-spoke shape) from `jobsV2` MemStorage — the legacy `GET /api/videos/:jobId` still returns `VideoJob`. `JobContext` provider wraps all `/jobs/:jobId/*` routes, fetching job data and refetching on Socket.IO progress events. Upload page includes PHI attestation (radio group: "No PHI" / "Contains PHI") and sends `phiStatus: 'user_attested'` + `attestationRecord: { attestedAt, choice }` on POST. Hub page shows status strip (filename, PHI badge, source metadata), initializing panel (during extraction), and three spoke tiles (Template Mask, Classify or Label — disabled/"Coming soon", Run AI Models). Spoke pages are hybrid wrappers: they render the existing legacy UI components (`MaskingCanvas`, `MaskingTools`, `ProcessingControls`, `CommandInput`, `TaskSelector`, `FrameViewer`) inside the new route structure. Legacy components continue to read from legacy URLs — canonical URL migration is 4b/4c work. `home.tsx` remains in the codebase, accessible at `/app`; deleted in 4d. `AttestationRecord` type updated to `{ attestedAt: string, choice: 'contains_phi' | 'no_phi' }`.

### Phase 4a landed (2026-05-12)

- New wouter routes: `/upload`, `/jobs/:jobId`, `/jobs/:jobId/template-mask`, `/jobs/:jobId/ai`
- `/` redirects to `/upload`. `/app` preserved as escape hatch to legacy `home.tsx`.
- New `UploadPage` with PHI attestation (radio group: "Contains PHI" / "No PHI")
- New `HubPage` with status strip, initializing panel, three spoke tiles
- Spoke pages (`TemplateMaskSpokePage`, `AiSpokePage`) are hybrid wrappers around legacy components — to be replaced in 4b/4c
- `JobContext` provider on `/jobs/:jobId/*` subtree, exposes `useJob()` hook
- Backend: `GET /api/jobs/:jobId` returns `Job` V2 record (split from legacy `GET /api/videos/:jobId`)
- `AttestationRecord` schema reshaped from `{ checked, timestamp, text }` to `{ attestedAt, choice }`
- `JSON.parse(attestationRecord)` added to upload handlers (multer form-field gap fix from 3d)

### Phase 4a hotfix 1 (2026-05-12)

- `MemStorage.updateVideoJob` now mirrors `VideoJob.status` to `Job.status` via a new `mapVideoJobStatusToJobStatus` helper
- Required because the new hub reads V2 status and tiles never unlocked otherwise
- Status mapping: `uploaded/extracting → extracting`, `ready/masking/processing/completed → ready`, `failed → failed`
- Fix lives entirely in `server/storage.ts`; `videoProcessor.ts` unchanged

### Phase 4a hotfix 2 (2026-05-12)

- Hub spoke-tile navigation switched from absolute paths (`/jobs/${jobId}/template-mask`) to relative paths (`/template-mask`)
- Required because `HubPage` is rendered inside `<Route path="/jobs/:jobId" nest>`, and wouter prepends the nest base to absolute navigates, producing doubled URLs
- Same fix may apply to any "Back to job" links in spoke wrappers; verify when migrating them

**Phase 3d landed (May 2026):** Upload handlers create `Job` records eagerly. New upload URLs added (`POST /api/uploads/video`, `POST /api/uploads/images`); legacy URLs preserved. `phiStatus` and `attestationRecord` plumbing added (defaults to `'raw'` when frontend doesn't send it). `ensureJobV2` bridge removed. `samplingFps` recorded as `Job.extractionRate`. This completes the backend refactor; Phase 4 is frontend migration.

## Post-refactor cleanup backlog

Items deferred from Phases 1–3d. None are blocking Phase 4; all can be
tackled independently in any order after Phase 4 frontend migration is
verified.

1. ~~**Remove legacy URL aliases**~~ — **DONE in Phase 4d-2 (2026-06-20).** All 11 legacy alias registrations deleted from `routes.ts`; `getLegacyJobHandler`'s definition deleted too (legacy-exclusive dead code). Only canonical URLs registered.
2. ~~**Remove legacy thin-wrapper from `server/index.ts`**~~ — **DONE in Phase 4d-2 (2026-06-20).** `PATCH /internal/mask-processing/:jobId` wrapper + the dead `applyTemplateMask` import removed from `index.ts`; shared function and canonical route kept.
3. ~~**Rename `tempFolderManager.ts`**~~ — **DONE in Phase 5B (2026-06-25, 5B-2a).** Renamed to `templateMaskFolderManager.ts` via `git mv` (history preserved); class name `TempFolderManager` kept for call-site stability. 3 import specifiers updated, incl. the dynamic `await import()` in `index.ts:57`; boot log confirms `initialize()` fires (cleanup logs print downstream of it).
4. **Remove `temp_processed/` from `SWEEP_TARGETS`** and remove `purgeTempProcessedOnStartup()` once confirmed quiet in production for several days. **(5B-4 — PARKED.** Phase 5B static audit found no code writes to `temp_processed/` — only stale comments, since corrected. Removal gated on the runtime "quiet" confirmation from the live host, which can't be observed from source.) → **Phase 7B-3 (gated; plan-only)** — current `cleanup.ts:68` (SWEEP_TARGETS) + `cleanup.ts:328` (`purgeTempProcessedOnStartup`, called `index.ts:135/140`); testing period is the wait-and-watch window (≥7 clean days).
5. ~~**Fix path-traversal guard in `TempFolderManager`**~~ — **DONE in Phase 5B (2026-06-25, 5B-1a; scope expanded).** Added one shared `resolveWithinRoot(root, ...segments)` validator in `cleanup.ts` (resolve-and-compare, mirrors `safeDelete`) and applied it at every jobId/runId path boundary in BOTH `templateMaskFolderManager.ts` and `applyPaths.ts`. Byte-identical to `path.join` for valid UUIDs; rejects empty/`.`/`..`/separator/null-byte segments.
6. ~~**Fix global progress broadcast**~~ — **DONE in Phase 5B (2026-06-25, 5B-1b).** Live line was `videoProcessor.ts:1081` (backlog's `:999` was stale). `this.io.emit('progress', …)` → `this.io.to(jobId).emit('progress', …)`, scoping to the job's room (clients already `socket.join(jobId)`; the AI path was already room-scoped). **Verify with a two-tab test** — boot logs don't prove room isolation.
7. **Remove dead code at `routes.ts:361`** — **5B-1c OPEN (ref stale).** Phase 5B source check found `routes.ts:361` is LIVE code (`height: imageMeta.height` in an image-meta builder), not dead. Needs a corrected line reference before any removal — do NOT remove the current line 361. → **Phase 7B-2 (gated; plan-only)** — re-diagnosis in Phase 7 also could not re-confirm a dead target (history sweep found none); output is "could not re-confirm; needs operator input."
8. ~~**Remove debug endpoints**~~ — **DONE in Phase 5B (2026-06-25, 5B-1d).** `POST /api/test-post` + `POST /test-non-api` (console.log/json stubs, no client callers) deleted from `routes.ts`. *Note:* the express request-dump middleware in `index.ts:9–20` (logs every POST/PUT/PATCH) was out of Deploy 1 scope and remains — a follow-up removal candidate. → **Phase 7A-2 (PLANNED)** — current `index.ts:9–21`; confirmed pure logging, no side effects.
9. ~~**Update stale `videoProcessor.ts` comments**~~ — **DONE in Phase 5B (2026-06-25, 5B-2b).** The two stale `temp_processed/{jobId}/` comments were at lines **388 and 698** (backlog's `371`/`643` were stale); both now read `spokes/template_mask/{jobId}/`, matching where `TempFolderManager` actually writes.
10. ~~**Add `deleteProcessingProgress(jobId)` cleanup on job delete**~~ — **DONE in Phase 5B (2026-06-25, 5B-2c).** Added to `IStorage` + `MemStorage` + `PgStorage`, and folded INTO `deleteVideoJob` so every delete path frees the progress-map entry (Decision 3 — not an explicit call in the route handler).
11. ~~**`PgStorage` stub maintenance**~~ — **DONE in 5C-1 (2026-06-30).** All 12 throw-stubs replaced with real Postgres-backed implementations (**Option A3**: one `jobs` row as single source of truth; `VideoJob`/`Job` derived in the shim; no `video_job` blob, no `has_job_v2`, no `video_jobs` table; `ai_runs` child). Validated by `scripts/conformance-storage.ts` against the `MemStorage` oracle (35/35). All runtime storage is still `MemStorage`; cutover deferred to 5C-2.
12. **Fix 17 pre-existing `tsc` errors** — 10 in `frameExtractor.ts`, 7 in `maskWorker.ts`. *(Baseline is now **12**: 5 + 7. `maskWorker.ts` was confirmed dead code in Round 1 — nothing imports it — so deleting it alone takes 12 → 5; also PERF/UX backlog #5.)* Either fix the types or silence with `// @ts-expect-error`. → **Phase 7A-5 (PLANNED; sequenced LAST)** — sole item permitted to change the tsc=17 baseline (target 0); ~5 trivial fixes, ~12 need real type-narrowing (do NOT blanket-suppress; may mask latent bugs).
13. **Address chunks-larger-than-500-kB Vite warning** — code splitting in `landing.tsx` or main bundle to reduce initial load size. → **Phase 7A-6 (PLANNED; low-risk only)** — 661KB single bundle; route-level `React.lazy` for AiSpokePage + TemplateMaskSpokePage, else defer.
14. ~~**Delete `home.tsx` and any other legacy step containers in 4d**~~ — **DONE in Phase 4d-2 (2026-06-20).** `home.tsx` + `FileUpload.tsx` (home-only) deleted; `/app` route + `Home` import removed from `App.tsx`; `landing.tsx` CTA `/app`→`/upload`.
16. **Remove dead `POST /api/videos/:jobId/process`** — examined during Phase 4d-2: zero client callers (no constructor in `client/src`; the canonical processing path used by all spokes is `POST /api/jobs/:jobId/template-mask/apply`). It matches `/api/videos/`, so the empty live legacy sweep confirms no caller. Left in 4d-2 (not on the alias removal list) but it is dead legacy and can be deleted. → **Phase 7B-1 (gated; plan-only)** — current `routes.ts:437`; Phase 7 static sweep re-confirmed ZERO callers, but removal awaits a live-log no-hit gate across the testing period (HTTP 200 ≠ removal proof — SPA catch-all).
15. **Download/ZIP handler has same masked-vs-raw asymmetry** — the `GET /api/jobs/:jobId/template-mask/download` handler reads from `SPOKE_TEMPLATE_MASK_DIR` only. If no template mask was applied, it returns 404. Same pattern as the AI inference handler before hotfix 4 added the raw-frame fallback. Decide whether downloads should also fall back to raw extracted frames (exporting unmasked frames) or whether "no mask applied → no download" is correct UX. → **Phase 7B-4 (operator decision)** — whole-job 404 at `routes.ts:552–554`; options: unify raw fallback vs leave documented (proposal recommends leaving documented).
17. **Socket.IO CORS is wide open** — `routes.ts:100–102` initializes the Socket.IO server with `cors: { origin: "*" }`. Tighten to the known frontend origin(s) before/at commercial launch. (Logged during Phase 5B; not in 5B Deploy 1 scope.) → **Phase 7A-1 (PLANNED)** — env-driven allow-list, prod default `https://masqueradeimage.com`; ⚠️ smoke test = real upload w/ live progress from prod domain.
18. **Restart mid-extraction leaves a silent dead-end job** *(= PERF/UX backlog #3)* — surfaced by Round 2A (frame-0 unblock), **ACCEPTED AS-IS by operator decision 2026-08-30**, logged here rather than fixed. `temp_extracted/` is not purged at boot (only `uploads/` and `temp_processed/` are — `index.ts:125-126`), job status is durable in Postgres since 5C-2, and nothing reconciles stale `'extracting'` jobs at startup. So if the server restarts mid-extraction *after* at least one 15-frame batch landed (the common case), the Round 2A frames endpoint correctly serves `frame_000001.png` (`routes.ts:1623-1643`) — the hub tile is open, the canvas paints, the user can draw — but `status` never reaches `'ready'`, so Apply stays disabled forever behind "Extracting frames…" with no error. **Not a regression:** `uploads/` was purged at boot, so that job could never have applied either way; before 2A the hub tile was simply locked, so the user never got in. If the restart landed *before* the first batch, the spoke's 120 s poll cap fires and shows the existing error state — that sub-case is already handled. → **Future pass (not scheduled).** Two candidate fixes, both outside Round 2A's scope: (a) a startup reconciliation pass marking stale `'extracting'` jobs `'failed'` — touches status semantics, so A3-adjacent and needs its own gate; (b) a client-side staleness timeout in the spoke that surfaces "extraction stalled" when `status` hasn't moved for N minutes — client-only, cheaper, but cosmetic. See `docs/refactor/ROUND2A_REPORT.md` §3.

*Items 19–26 are the "Backlog opened by this round" list from the PERF / UX round (top of this file),
folded into this canonical list. Numbering is offset by one because slot 18 was already taken by that
round's own first entry — item 21 below is a pointer to it rather than a duplicate.*

19. **2B-3c — grayscale evaluation** — raw frames as 8-bit gray (`-pix_fmt gray`), gated on a frame-1 chroma check so colour Doppler stays RGB. ~3× less disk in `temp_extracted/` (raw frames are ~350 KB each, 123 MB for the 348-frame reference clip), and it would make a lossless PNG masked-output option roughly the size of today's JPEG. **Experiment + recommendation only, no default change.** → scoped in `docs/refactor/ROUND2B3_PROPOSAL.md` §2B-3c.
20. **"Review masked frames" in the template-mask spoke** — `FrameViewer` (Clean mode) already reads `?source=template_mask`; today the only way to check an apply result is to download the ZIP or open the AI spoke. Small UX gap, no backend work.
21. *(= item 18 above)* **Stale-`extracting` reconciliation at boot.** Listed as #3 in the PERF/UX round's backlog; the full analysis and the two candidate fixes are in item 18.
22. **Image-batch output mislabel** — `processImages` always encodes PNG (`videoProcessor.ts:1801`) but names the file from the *uploaded* file's extension (`templateMaskFolderManager.ts:84`), so a masked `photo.jpg` is PNG bytes in a `.jpg` file. Mirror of the video-path bug fixed in the 2B addendum (`docs/refactor/ROUND2B_REPORT.md` §A), on a different code path. Not fixed there because it changes output bytes for existing image jobs.
23. **Delete `maskWorker.ts`** — confirmed dead in Round 1 (nothing in `server/` or `client/` imports `MaskWorkerPool`), and it carries **7 of the 12** tsc errors. Deleting it alone takes the baseline 12 → 5. Separate pass, because it changes the tsc invariant — see item 12.
24. **Stack scheduling** — 58 stacks in flight against a 4-thread libuv pool inflates `apply.frame.decode_ms` into queue-wait. Maybe ~2× left in the ~8 s apply. Round 2C established that ~8 s is close to the decode+encode floor for 348 frames on one physical core, so this is the only remaining software lever; diminishing, and only worth it if apply time matters again. → `docs/refactor/ROUND2C_REPORT.md`.
25. **Small open items.** `ANTHROPIC_API_KEY` still unset on prod (7A-4). The orphan base64 `firstFrame` in the upload response has been dead since Phase 4b — nothing consumes it. `MemStorage` (rollback target only) doesn't mirror `totalFrames` to `jobsV2`, so the 2B-1 reuse guard would trip if anyone reverted the 5C-2 cutover — documented rather than fixed, since `storage.ts` is A3-frozen (`docs/refactor/ROUND2B3B_REPORT.md` §1.6).
26. **Product: usage/tier model** — keyed on frames × resolution × format, all three of which are already on the job record. Raised when the JPEG-vs-PNG disk question came up (2B addendum); no design yet.

### Raw frames live in-memory, not on disk (`global.extractedFrames`) — RESOLVED in Phase 4b-0

**Discovered:** Phase 4a deploy smoke testing, 2026-05-12.

**Original state:** `startBackgroundFrameExtraction` wrote extracted frames as `Buffer`s into `global.extractedFrames: Map<jobId, Map<frameNumber, Buffer>>`. Nothing wrote to `temp_extracted/<jobId>/` despite that directory existing, being defined as `TEMP_EXTRACTED_DIR` in the code, and being referenced in `UPLOAD_PROCESS_BEFORE_AND_AFTER.md` as the raw-frame target.

**Volatility class (historical):** Same as the pre-3b `maskArtifactStore`. PM2 restart wiped raw frames; jobs in `'ready'` state became un-maskable.

**Resolution (Phase 4b-0, 2026-06-12):**
- `startBackgroundFrameExtraction` now writes raw frames to `temp_extracted/<jobId>/frame_NNNNNN.png` (1-indexed, matching `extractAllFramesSequential`'s naming).
- `GET /api/jobs/:jobId/frames/:n` reads raw frames from disk (positional index into the sorted file list); returns 410 if the directory was swept.
- The AI inference raw-frame fallback reads from disk via `listRawFrameFiles`.
- `global.extractedFrames` and its in-memory `frameStore` Map are removed from live code. The remaining references are historical comments only.
- `processVideo`'s apply-time re-extraction is isolated into `temp_extracted/<jobId>/_apply/` so it never collides with the persistent raw frames (see Phase 4b-0 report for the collision-hazard analysis).

### Phase 4b-0 FIX V2 — `processVideo` re-entrancy post-mortem (2026-06-17)

**Re-entrancy lesson.** `processVideo` was implicitly single-shot: a prior run's
`finally` deleted the upload, so a second run for the same `jobId` crashed at
ffprobe before exercising directory logic. Moving raw frames to disk and
(correctly) preserving the upload for re-apply *unmasked* a latent re-entrancy
bug — the second run re-derived `temp_extracted/<jobId>/_apply/` and then
`readdir`'d it to size the frame set, reading back any frames a prior run had
left there. Lesson: any per-job stage that re-derives a working directory and
then `readdir`s it must **clear that dir first** (or use a per-run unique dir);
never let the cleanup that protects re-entrancy be *conditional* on a flag a
killed process can skip. Tests for re-entrancy MUST leave first-run residue
present before the second run — a test that cleans state between runs proves
nothing.

**Fix.** `prepareCleanApplyStaging(jobId)` (`applyPaths.ts`) runs
`cleanupApplyStaging` (clear `_apply`) then recreates it empty, called
immediately before `extractAllFramesSequential`. This makes `_apply` clean
**unconditionally**, not contingent on the gated `finally`. Persistent raw frames
in the parent dir are never touched (the delete is `_apply`-bounded).

**Tripwire.** Every mkdir site that joins a `jobId`/`runId`
(`videoProcessor` raw + `_apply`, `routes.ts` AI run dir) calls
`assertNoSegmentDoubling()` (throws on equal-adjacent path segments — the
`<jobId>/<jobId>` corruption class) AND logs the literal `path.resolve(...)`
mkdir path. Both the stale-readback fix and the tripwire itself are covered by
red-green tests in `server/services/__tests__/applyPaths.test.ts` (run:
`npx tsx server/services/__tests__/applyPaths.test.ts`).

**Scope caveat (honest).** The current `_apply`-isolated source does not produce
`<jobId>/<jobId>` nesting or persistent-frame deletion from any run-2 op — those
symptoms were the pre-`_apply` whole-dir variant, already replaced. The only
remaining in-code defect was stale-readback count inflation, and only when run 1
is **interrupted** before its `finally`. Because the original symptoms can't be
reproduced from current source, the **live redo loop run twice** is the required
post-deploy verification (see the deploy runbook), and the tripwire is the
standing safety net for the nesting class.

**Post-mortem lessons (carry forward).**
- Re-entrancy is invisible to static analysis; when removing a guard, test the
  newly-reachable second-entry path with first-run residue present.
- Every destructive fs op must log its `path.resolve(...)` target.
- Test persistence in isolation (write → restart/sweep → read) rather than
  inferring it from happy-path runs.
- Don't bake a hypothesis into a diagnostic command (the frame-delete "watch"
  presupposed an immediate delete that never existed).

### Phase 4b-0 landed + deploy-verified on main @ b734e6d (2026-06-17)

The Phase 4b-0 disk-frame relocation and the FIX V2 re-entrancy fix are landed
and verified on main at commit `b734e6d`.

### Phase 4b-i landed — template-mask spoke on canonical URLs (2026-06-17)

The template-mask spoke apply trigger + frame preview are migrated to canonical
URLs: `ProcessingControls.tsx` POSTs `POST /api/jobs/:jobId/template-mask/apply`
and `template-mask-spoke.tsx` reads `GET /api/jobs/:jobId/frames/0`.

### Phase 4b-ii landed — AI-spoke canonical URLs + masked-frame staleness (2026-06-18)

- AI spoke (`ai-spoke.tsx`) migrated off legacy flat label URLs to the canonical
  runs hierarchy:
  - Label SOURCE: `GET /api/ai/labels/:jobId` → `GET /api/jobs/:jobId/ai/runs`.
    Labels are flattened from `runs[*].labels[]` with each carrying its
    `runId` (Phase 3b 1:1 run↔label invariant makes this exact).
  - Approve/Delete: `PATCH|DELETE /api/ai/labels/:jobId/:labelId` →
    `PATCH|DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId`. runId comes
    from the runs-based source above (NOT derivable from the flat source — this
    is why source migration came first).
  - Status gate switched from the legacy 2s poll on `GET /api/videos/:jobId`
    (which gated on **mask completion** — a bug vs. optional-masking) to
    `useJob().job.status === 'ready'` (upload/extraction complete). Template
    masking is optional: AI runs on masked frames if a mask exists, else on raw
    frames via the inference handler's raw fallback (`routes.ts:920`).
- Masked-frame staleness fixed: the masked-frame canvas served a stale cached PNG
  after re-applying a new template mask. Root cause was twofold — the fetch
  effect depended only on `[jobId]` (no re-run on re-apply) and the masked URL
  was byte-identical under `Cache-Control: private, max-age=3600`. Fix appends a
  `&v=<templateMask.completedAt>` version param to the **masked source only** and
  adds it to the effect deps. Raw-frame caching is unchanged; the frames endpoint
  ignores the extra param (reads only `?source`). No backend change.
- Legacy URLs remain registered (removal is 4d). `CommandInput.tsx`'s
  `POST /api/ai/infer` is still legacy — it's a shared component also used by
  `home.tsx`; its migration is deferred to 4c/4d (out of 4b-ii scope).

### Phase 4d-1 landed — straggler migration + exhaustive audit (2026-06-18)

Reversible prep for the one-way 4d-2 teardown. **Removed nothing.** Three
remaining canonical-app callsites migrated off legacy URLs, plus one surgical
backend payload addition.

- **CommandInput infer:** `POST /api/ai/infer` → `POST /api/jobs/:jobId/ai/runs`
  (`CommandInput.tsx:480`). Same shared `aiInferHandler`; body unchanged (handler
  reads `jobId` from path-or-body). This removed the **last** `/api/ai/infer`
  constructor in `client/` (grep: 0 hits).
- **ProcessingStatus download:** `GET /api/videos/:jobId/download` →
  `GET /api/jobs/:jobId/template-mask/download` (`ProcessingStatus.tsx:88`).
  home.tsx's own copy (`home.tsx:175`, with the output-settings query string) is
  intentionally **left** — home.tsx dies in 4d-2.
- **FrameViewer overlay — backend runId-in-payload (per 4d-1 amendment Change 1),
  no frontend fallback:** the canonical overlay URL is runId-scoped
  (`/api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png`) but FrameViewer's
  payloads carried no runId. Rather than a frontend `labelId→runId` fetch+map
  with a legacy fallback (a silent dependency that would 404 in 4d-2), `runId` was
  added to the `inference.json` per-frame label objects, sourced from the owning
  `AIRun.id`. **Backend change is surgical:** in the `inference.json` handler
  (`routes.ts`), a `labelRunIdMap` is built in the existing `labelDirMap` loop
  (the run↔label association was already there) and `runId` is emitted on each
  per-frame object. FrameViewer builds the canonical overlay URL directly from
  the payload (`FrameViewer.tsx:230–233`, render `:390`, prefetch `:278`).
  **Zero** legacy labelId-only overlay constructors remain in `client/` (grep on
  `overlays/` → only the canonical runId-scoped form at `FrameViewer.tsx:232`).
- **Exhaustive audit (the 4d-2 gate):** see `PHASE_4D1_REPORT.md`. Result:
  `/api/ai/infer`, labelId-only `overlays/`, labelId-only `masks/`,
  `/internal/mask-processing/:jobId`, and bare `GET /api/videos/:jobId` have
  **zero** `client/` constructors → safe for 4d-2. The legacy upload URLs,
  `/api/videos/:jobId/download`, and `/api/ai/labels/*` survive **only** in the
  dying `home.tsx`/`FileUpload.tsx` (deleted in 4d-2) → safe. `upload.tsx` is
  confirmed canonical (`/api/uploads/video|images`).
- tsc stays at **17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`). Nothing
  removed; all legacy routes still registered.
- ⚠️ **Superseded by 4d-1b:** the audit bullet above claimed bare
  `GET /api/videos/:jobId` had **zero** `client/` constructors. That was WRONG —
  it missed two react-query **queryKey-array** polls (see 4d-1b below). The static
  grep used the literal-slash pattern `/api/videos/`; the live constructors are
  `['/api/videos', jobId]` arrays, slash-joined at runtime. A live `pm2 logs` check
  on a fresh job caught them firing every 2s. Lesson recorded below.

### Phase 4d-1b landed — migrate two queryKey-array status polls the 4d-1 audit missed (2026-06-19)

The 4d-1 static audit's literal-slash grep (`/api/videos/`) missed two **canonical-app**
components that build `GET /api/videos/:jobId` from a react-query queryKey **array**
(`['/api/videos', jobId]`), joined at runtime. A live `pm2 logs masquerade | grep "/api/videos/"`
on a fresh job caught the poll firing every 2s — a real 4d-2 blocker (every job-status poll would
404 once the alias is removed). Migrated both to the canonical V2 Job endpoint. **Removed nothing
on the backend.**

- **ProcessingStatus.tsx:24** — `queryKey: ['/api/videos', jobId]` →
  `queryKey: ['/api/jobs', jobId]` (`GET /api/jobs/:jobId`, V2 `Job` direct, no
  `{job,progress}` wrapper). Reads remapped to the **templateMask spoke**:
  `job.status==='completed'` → `tm.status==='complete'`; `job.completedAt` →
  `tm.completedAt`; status display → `tm.status`. `useJob()` was **rejected** here:
  ProcessingStatus is also rendered by `home.tsx:651`, which has **no** `<JobProvider>`,
  so `useJob()` would throw and break the legacy page before 4d-2 deletes it. The
  component keeps its own 2s `refetchInterval` (no Socket-driven Job refetch of its own).
- **template-mask-spoke.tsx:89** — the separate 2s poll was **fully removed**. It only
  cleared the local `isProcessing` banner; `JobContext` already refetches the V2 Job on
  the WebSocket `'progress'` event that fires at apply completion/failure
  (`videoProcessor.ts:403–458,1081`), so the banner now keys off
  `useJob().job.templateMask.status` (`complete`/`failed`). Unused `useQuery` import dropped.
- **FLAG (cosmetic, future polish — not a blocker):** ProcessingStatus lost its
  pre-first-WS-event **progress fallback** — the V2 `Job` record carries no granular
  `progress` (stage/currentFrame/%); that data is WebSocket-only. First paint may show 0%
  for a beat before the first `'progress'` event. If undesired later, add a **canonical
  progress source** on the `Job`/spoke; none exists today.
- **Re-audit (non-slash-aware, the gap-closing method):** `grep "queryKey:\s*\["` →
  only 3 `/api/videos` arrays existed (the two above + `home.tsx:57`, home-only/4d-2,
  left). No queryKey-array constructor exists for any **other** legacy URL. Non-slash
  greps for `api/ai/infer` (0), `api/ai/labels` (home-only), `/overlays/` (only the
  canonical `FrameViewer.tsx:232` runId form), `/masks/` (0) all re-confirmed clean.
  `/api/videos/upload` (`FileUpload.tsx:35`) is the upload endpoint, not the status poll —
  tracked separately. See `PHASE_4D1B_REPORT.md`.
- tsc stays at **17**. Frontend-only; backend untouched.
- **LESSON (binding for every future "is this URL still used" audit):** a literal-string
  grep for a URL **misses dynamically-constructed URLs** — react-query queryKey arrays
  (`['/api/videos', jobId]`), base-path concatenation, segment joins. Audits MUST grep the
  non-slash/array/concat forms too, AND be confirmed by a **live log / Network check on a
  fresh session** before any irreversible removal. The static audit is necessary but **not
  sufficient** for a one-way door; the live check is the authoritative gate for 4d-2.

### Phase 4d-2 landed — one-way legacy teardown; Phase 4 frontend migration COMPLETE (2026-06-20)

The final, irreversible step. After the 4d-1b live-log gate confirmed zero canonical-app
callers on any legacy URL, the legacy surface was removed. **`/app` now 404s by design.**

- **Backend — 11 legacy alias registrations deleted from `routes.ts`** (canonical URLs +
  shared handlers kept; only the legacy `app.<method>` line removed per alias):
  `POST /api/videos/upload`, `POST /api/images/upload`, `GET /api/videos/:jobId`,
  `GET /api/videos/:jobId/download`, `POST /api/ai/infer`,
  `PATCH /api/ai/labels/:jobId/:labelId`, `DELETE /api/ai/labels/:jobId/:labelId`,
  `GET /api/ai/labels/:jobId` (inline handler, not an alias — removed whole),
  `GET /api/jobs/:jobId/masks/:labelId/:n.png` (labelId-only),
  `GET /api/jobs/:jobId/overlays/:labelId/:n.png` (labelId-only). Every named handler
  (`videoUploadHandler`, `imageUploadHandler`, `templateMaskDownloadHandler`,
  `aiInferHandler`, `patchLabelHandler`, `deleteLabelHandler`, `getMaskHandler`,
  `getOverlayHandler`) still has its canonical registration → zero dangling refs.
- **`getLegacyJobHandler` definition deleted too** (not just its registration). Grep
  confirmed line 460 was its only code reference (the rest were docs); legacy-exclusive,
  so it became pure dead code once `GET /api/videos/:jobId` was removed. `getJobV2Handler`
  + `GET /api/jobs/:jobId` untouched.
- **`index.ts` wrapper removed** — `PATCH /internal/mask-processing/:jobId` thin wrapper +
  the now-dead `import { applyTemplateMask }`. The shared `templateMaskApply.ts` function +
  canonical `POST /api/jobs/:jobId/template-mask/apply` stay. Stale header comment in
  `templateMaskApply.ts` (which listed the removed wrapper as a second call site) corrected.
- **Frontend — two files deleted, import-graph verified:** `pages/home.tsx` (legacy SPA
  monolith) and `components/FileUpload.tsx` (home-only — imported solely at `home.tsx:3`).
  All of home's other imports (incl. `ProcessingStatus`) are shared with canonical spokes
  and stay. `App.tsx`: removed `import Home` + `<Route path="/app">`. `landing.tsx`: CTA
  `<Link href="/app">` → `href="/upload"`.
- **`/api/videos/:jobId/process` examined, left, flagged** — dead legacy (zero client
  callers; canonical processing is `template-mask/apply`). Not on the alias list; added to
  the cleanup backlog (item 16) as a removal candidate. No unexamined legacy survivor.
- **Verification:** post-removal route grep shows zero legacy alias registrations (only the
  flagged `/process` + two doc comments); masks/overlays greps show only canonical
  runId-scoped registrations; client dangling-import grep (`home`/`FileUpload`/`/app`) empty;
  `npx tsc --noEmit` = **17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`), unchanged from
  baseline — the deleted files carried none of the 17. See `PHASE_4D2_REPORT.md`.

### Post-4d AI-spoke canvas polish — FLAGGED, NOT fixed (2026-06-18)

Two AI-spoke canvas issues observed during 4d work. Diagnosis only — they belong
to the post-refactor canvas-polish backlog, **not** to phase 4.

1. **Template-mask rectangle drawing leaks into the AI spoke.** The shared
   `MaskingCanvas` exposes template-mask rectangle-drawing inside the AI spoke,
   where the interaction should be **bbox-only**. Likely needs a mode/context
   prop so the canvas scopes its drawing behavior per spoke (template vs. AI).
2. **AI bbox renders small and offset to the side.** Likely a coordinate-space /
   scaling mismatch between the displayed canvas dimensions and the native frame
   dimensions (the drawn box isn't mapped into source-video pixel space the way
   the FrameViewer SVG viewBox is). Needs the canvas draw coords scaled to the
   frame's natural dimensions.

### Frame-deletion "bug" was a PHANTOM (2026-06-18)

The "raw frames auto-deleted ~1s after upload" report was never reproduced under
controlled observation, and a full source/git/dist audit (see
`PHASE_4B0_FRAMEDELETE_PROPOSAL.md`) found **no current-source line** that deletes
`temp_extracted/<jobId>/` post-extraction. The post-download `cleanupJobArtifacts`
hook that once existed (commit f74692c) was removed (commit 36f684e) and is not
in HEAD (b734e6d). Do NOT chase this further. The `🗑️ template_mask cleanup on
AI-run delete` is **correct, intended** behavior (deleting a run removes its
`spokes/ai/<jobId>/<runId>/` artifacts) — not the phantom.

### `ANTHROPIC_API_KEY` invalid in production

**Discovered:** Phase 4a deploy smoke testing, 2026-05-12.

**State:** Server logs show repeated `401 invalid x-api-key` errors from `IntentParser.parseWithClaude`. NLP intent parser fallback non-functional in production. Keyword-rule path still works.

**Fix:** Rotate the key in `~/.env` on `3.136.48.97`. Out of scope for Phase 4 refactor.

### `temp_extracted/` documentation drift — RESOLVED in Phase 4b-0

**Discovered:** Phase 4a deploy smoke testing, 2026-05-12.

**Original state:** `UPLOAD_PROCESS_BEFORE_AND_AFTER.md` claimed raw frames extract to `temp_extracted/<jobId>/`. Code defined `TEMP_EXTRACTED_DIR` and the cleanup module included `temp_extracted/` in `SWEEP_TARGETS`, but nothing actually wrote to that directory — the docs described a disk pipeline that didn't exist.

**Resolution (Phase 4b-0):** Took option 2 (make code match docs). `startBackgroundFrameExtraction` now writes raw frames to `temp_extracted/<jobId>/`, so the directory, the `TEMP_EXTRACTED_DIR` constant, and its `SWEEP_TARGETS` membership all reflect reality. The 6-hour retention window for `temp_extracted/` is now load-bearing.

### Hub job-level download action (deferred)

**Discovered:** Phase 4a smoke testing surfaced that there's no download UI in the AI spoke (legacy `home.tsx` had download as a terminal step).

**Decision:** Per-run downloads land in 4c (AI spoke). Hub job-level "Download all" deferred to 4d or post-Phase-4 cleanup; it's a design call (per-run vs per-job vs both) that doesn't block other work.

### Three extraction paths exist

**Discovered:** Phase 4b reconnaissance pass, 2026-05-12.

**State:** The codebase has three independent frame-extraction implementations:
1. `extractFirstFrame` — pulls just frame 0 at upload time for the response preview
2. `startBackgroundFrameExtraction` → `temp_extracted/<jobId>/frame_NNNNNN.png` — batch-based, on disk (Phase 4b-0; was in-memory `global.extractedFrames`), populates after upload response
3. `processVideo` → `temp_extracted/<jobId>/_apply/` — runs at template-mask apply time, re-extracts from the upload, isolated in the `_apply` subdir so it never collides with path #2's persistent frames

**Implication:** The masking canvas (after 4b) reads frame 0 from path #2. The actual mask application uses path #3. These are independent re-extractions of the same source video. ffmpeg is *usually* deterministic on frame 0 across these paths, but edge cases (encoder quirks, GOP boundaries, seek inaccuracy) could produce different bytes. A user could draw a mask aligned to one frame and have it applied to a subtly different one.

**Severity:** Theoretical for typical ultrasound content. Paths #2 and #3 now share the `temp_extracted/<jobId>/` tree (persistent frames vs `_apply/` staging) but remain independent re-extractions. Full consolidation (single extraction, single source of truth) is still a backlog item — Phase 4b-0 only relocated path #2's storage from memory to disk.

**Future UX consideration:** A planned UX direction is showing the first frame on the upload page immediately while the rest of the video uploads/extracts in the background. Consolidating to a single extraction path supports this cleanly.

**Phase 3c landed (May 2026):** Endpoint URL hierarchy migrated. New `/api/jobs/:jobId/...` URLs added; old URLs preserved as aliases. Four net-new CRUD endpoints: `DELETE /api/jobs/:jobId`, `GET /api/jobs/:jobId/ai/runs`, `PATCH /api/jobs/:jobId/ai/runs/:runId`, `DELETE /api/jobs/:jobId/ai/runs/:runId`. Path C download: `GET /api/jobs/:jobId/ai/runs/:runId/download`. Template-mask apply alias: `POST /api/jobs/:jobId/template-mask/apply`. Frontend still uses old URLs; Phase 4 migrates.

**Phase 3b landed (May 2026):** AI inference now persists mask/overlay PNGs to disk under `spokes/ai/<jobId>/<runId>/`. Each `/api/ai/infer` call creates an `AIRun` record. `maskArtifactStore.ts` deleted — all mask/overlay reads come from disk. Dual-write: every `AiLabel` goes to both `AIRun.labels[]` and `job.aiLabels[]` for backward compat. Zero endpoint URL changes, zero frontend changes.

**Phase 3a landed (May 2026):** Processing writes migrated from `temp_processed/` to `spokes/template_mask/<jobId>/`. Two bypass callsites (download endpoint, AI inference endpoint) now use `frameAccess.ts` helpers. `temp_processed/` is no longer written to; retained as defensive sweep target.

**Phase 2 landed (May 2026):** Schema and storage plumbing for the hub-and-spoke refactor. New `Job`, `TemplateMaskState`, `AIState`, `AIRun` types in `shared/schema.ts`. New MemStorage methods. Spoke directories (`spokes/template_mask/`, `spokes/ai/`, `spokes/labeling/`) created on boot. `temp_processed/` purged on every startup. Generalized cleanup sweep targets.

Project-level notes for engineers and Claude when working on this codebase.

## Hub-and-spoke data model (Phase 2)

The codebase is mid-refactor from a 5-step linear pipeline to a hub-and-spoke
model. The target types live in `shared/schema.ts` (search for "Hub-and-spoke
types"):

- `Job` — the hub: upload metadata + optional per-spoke state
- `TemplateMaskState` — Path A (template mask + export)
- `AIState` / `AIRun` — Path C (AI segmentation, multiple runs per job)
- `LabelingState` — Path B (placeholder, shape TBD)

`MemStorage` in `server/storage.ts` has methods for these types (`getJobV2`,
`setTemplateMaskState`, `addAiRun`, etc.). Phase 3b wired AI run methods
into inference/label endpoints. Phase 3d wired `createJobV2` into upload
handlers — every job now has a `Job` record from the moment it's uploaded.
The `ensureJobV2` bridge is removed.

The existing `VideoJob`, `MaskData`, `OutputSettings`, and `AiLabel` types
remain the active runtime types alongside `Job` until Phase 4 completes
the frontend migration.

## URL hierarchy (Phase 3c + 3d)

New canonical URLs follow a resource hierarchy. Old URLs were preserved as
aliases (same handler, two registrations) through Phase 4. **Phase 4d-2
(2026-06-20) deleted every legacy alias below — only the canonical URLs are
registered now.** The "Legacy URL (alias)" column is retained for historical
reference; those routes 404 today.

| Legacy URL (alias) — **REMOVED 4d-2** | Canonical URL | Method | Notes |
|---|---|---|---|
| ~~`POST /api/videos/upload`~~ | `POST /api/uploads/video` | Video upload | |
| ~~`POST /api/images/upload`~~ | `POST /api/uploads/images` | Image batch upload | |
| ~~`GET /api/videos/:jobId`~~ | `GET /api/jobs/:jobId` | Legacy job state | Returned `VideoJob` + progress via `getLegacyJobHandler`. **4d-2:** alias + the `getLegacyJobHandler` definition deleted (legacy-exclusive dead code). |
| — | `GET /api/jobs/:jobId` | Job V2 state | Returns `Job` (hub-and-spoke shape). **Split from legacy in 4a** — separate handler (`getJobV2Handler`), unaffected by 4d-2. |
| ~~`GET /api/videos/:jobId/download`~~ | `GET /api/jobs/:jobId/template-mask/download` | Path A ZIP |
| ~~`PATCH /internal/mask-processing/:jobId`~~ | `POST /api/jobs/:jobId/template-mask/apply` | Path A trigger | Wrapper removed from `index.ts`; shared `applyTemplateMask` kept. |
| ~~`POST /api/ai/infer`~~ | `POST /api/jobs/:jobId/ai/runs` | Create AI run |
| ~~`PATCH /api/ai/labels/:jobId/:labelId`~~ | `PATCH /api/jobs/:jobId/ai/runs/:runId/labels/:labelId` | Approve label |
| ~~`DELETE /api/ai/labels/:jobId/:labelId`~~ | `DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId` | Delete label |
| ~~`GET /api/ai/labels/:jobId`~~ | `GET /api/jobs/:jobId/ai/runs` (run-scoped list) | List labels | Inline handler removed whole in 4d-2 (not a paired alias). |
| ~~`GET /api/jobs/:jobId/masks/:labelId/:n.png`~~ | `GET /api/jobs/:jobId/ai/runs/:runId/masks/:labelId/:n.png` | Mask PNG |
| ~~`GET /api/jobs/:jobId/overlays/:labelId/:n.png`~~ | `GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png` | Overlay PNG |

Net-new (no legacy alias):

| URL | Method | Purpose |
|---|---|---|
| `GET /api/jobs/:jobId/ai/runs` | GET | List all AI runs |
| `PATCH /api/jobs/:jobId/ai/runs/:runId` | PATCH | Rename/approve a run |
| `DELETE /api/jobs/:jobId/ai/runs/:runId` | DELETE | Delete a run + artifacts |
| `GET /api/jobs/:jobId/ai/runs/:runId/download` | GET | Download run as ZIP |
| `DELETE /api/jobs/:jobId` | DELETE | Delete job + all artifacts |

## Upload body shape (Phase 3d)

Both upload endpoints accept optional `phiStatus` and `attestationRecord`
fields in the request body (multipart form data). The frontend does not
send these yet — Phase 4 wires the attestation UI.

- `phiStatus`: `'raw'` (default) or `'user_attested'`. Defaults to `'raw'`
  when absent.
- `attestationRecord`: `{ attestedAt: string, choice: 'contains_phi' | 'no_phi' }`.
  Only meaningful when `phiStatus === 'user_attested'`. Updated in Phase 4a.
- `samplingFps`: Optional number. Recorded as `Job.extractionRate`. Defaults
  to the video's native frame rate (or 1 for image batches).

## Disk lifecycle

Transient directories live at the project root and hold short-lived data.
All of them are managed by `server/services/cleanup.ts`; nothing else
in the codebase should call `fs.rm` / `fs.unlink` against these paths
directly — go through `safeDelete`, `deleteUploadFile`, or
`cleanupJobArtifacts` instead so deletes stay bounded to their allowed root.

| Directory | Holds | Retention |
|-----------|-------|-----------|
| `uploads/` | Original user uploads (multer dest). Contains PHI. | **2 hours** |
| `temp_extracted/<jobId>/` | Raw frames pulled from a video before template-masking. | **6 hours** |
| `temp_processed/<jobId>/` | **(LEGACY — no longer written to post-3a.)** Retained as defensive sweep target. | **Purged on every boot** + 24h hourly sweep |
| `spokes/template_mask/<jobId>/` | Path A output — **active processing target post-3a.** `tempFolderManager.ts` and `frameAccess.ts` both resolve against this directory. | **24 hours** |
| `spokes/ai/<jobId>/<runId>/` | Path C output — **active post-3b.** One folder per AI run. Contains `mask_<n>.png` and `overlay_<n>.png` per frame. `routes.ts` mask/overlay serving endpoints read from here. | **24 hours** |
| `spokes/labeling/<jobId>/` | Path B reserved (placeholder). | **24 hours** |

`temp_processed/` is fully retired post-Phase 3a — no code writes to it
anymore. It remains as a defensive sweep target in `SWEEP_TARGETS` and is
purged on every server boot (`purgeTempProcessedOnStartup`). Remove from
`SWEEP_TARGETS` once confirmed quiet in production.

**Frame naming differs by directory, and consumers must not assume one convention.**
`temp_extracted/<jobId>/` holds **`.png`, 1-indexed** (`frame_000001.png` — ffmpeg's image2 muxer).
`spokes/template_mask/<jobId>/` holds **`.jpg` by default (`.png` only when the user selects PNG),
0-indexed** (`frame_000000.jpg` — the save loop pads `frameNumber`, which starts at 0).
`frameAccess.resolveFramePath` builds a masked-frame name straight from the index, so anything that
writes masked frames must keep the 0-indexed convention. Both listings match by **extension**, not by
a `frame_` prefix — a stray `.png`/`.jpg` in either directory is counted as a frame.

`spokes/template_mask/<jobId>/` is **not** deleted post-download. Folders persist
after download to allow the frame viewer to be reopened. Practical effect:
a user who downloads then comes back later sees their session intact for up
to 24h. The hourly retention sweep is the only path that reclaims this dir.

### When does cleanup happen?

- **On every server start**:
  - `purgeUploadsOnStartup()` deletes everything in `uploads/`. Storage is
    in-memory (`server/storage.ts`), so any upload from a previous process
    is orphaned by definition — no live request handler can reference it.
  - `purgeTempProcessedOnStartup()` deletes everything in `temp_processed/`.
    Same MemStorage rationale. (Added in Phase 2.)
  - `ensureSpokeDirectories()` creates `spokes/template_mask/`, `spokes/ai/`,
    `spokes/labeling/` if they don't exist. (Added in Phase 2.)
- **Hourly cron** (minute 0): `startCleanupScheduler()` sweeps all targets
  in the `SWEEP_TARGETS` list (uploads, temp_extracted, temp_processed, and
  all three spoke dirs) for entries older than their retention window.
  Adding a future spoke is a one-line addition to `SWEEP_TARGETS` in
  `cleanup.ts`. Wrapped in try/catch at every layer — cleanup must never
  crash the app.
- **Eager deletes** along the request lifecycle:
  - The video upload handler (`POST /api/videos/upload`) deletes the
    multer file on `req.on('aborted')` and on the catch path.
  - `videoProcessor.processImages` uses a `try/catch/finally` where
    `finally` calls `deleteUploadFile(...)` once a terminal status is
    reached (success **or** failure).
  - `videoProcessor.processVideo` uses a `try/catch/finally` where
    `finally` calls `safeDelete` on its apply-time staging dir
    `temp_extracted/<jobId>/_apply/` only. **Phase 4b-0:** it no longer
    deletes `deleteUploadFile(...)` nor the persistent raw frames at
    `temp_extracted/<jobId>/` — the upload and raw frames must survive so
    the user can redo (re-mask → re-apply) within the `uploads/` 2h window.
  - The setImmediate background **extraction** tasks (`startBackgroundFrameExtraction`)
    have a `.catch` that calls `deleteUploadFile(...)` on failure. An
    extraction failure means the job never becomes applyable, so reclaiming
    the upload there is safe and loses no redo loop.
  - **No post-download hook for `temp_processed/<jobId>/`**: the download
    endpoint deliberately does not delete the masked-frame folder when the
    response finishes. The frame viewer needs it readable after download
    so users can reopen the viewer or re-download. Reclamation happens
    exclusively via the hourly retention sweep (24h).
- **SIGTERM** sweeps all `SWEEP_TARGETS` directories (uploads, temp_extracted,
  temp_processed, and all spoke dirs) with `maxAgeMs = 0` (everything goes),
  then closes the HTTP server. Each step is individually try/wrapped so one
  failure cannot block shutdown.

### Manual cleanup

```sh
# Sweep all dirs (including spoke dirs) respecting retention windows
npm run cleanup

# Show what would be deleted, delete nothing
npm run cleanup -- --dry-run

# Limit to one directory
npm run cleanup -- --dir=uploads
npm run cleanup -- --dir=temp_extracted
npm run cleanup -- --dir=temp_processed
npm run cleanup -- --dir=template_mask
npm run cleanup -- --dir=ai
npm run cleanup -- --dir=labeling

# Delete all artifacts for a specific job (across all directories)
npm run cleanup -- --job=<jobId>

# Override the age threshold (delete everything regardless of age)
npm run cleanup -- --max-age-ms=0
```

`--dry-run` logs every target and the total bytes that *would* be freed
without touching the filesystem. Combine flags freely:
```sh
npm run cleanup -- --dir=temp_processed --dry-run
```

`--job` and `--dir` are mutually exclusive.

### Known limitation: disk pressure

With `temp_processed/` retained for 24h post-completion, expected disk
use scales with sessions/day at roughly ~1 GB per session. Revisit the
retention window or move to per-user expiry when auth lands (Phase 3).

### Future: when authentication lands

The 2h retention window on `uploads/` and the boot-time purge are both
predicated on the current model: **no auth, in-memory storage, anonymous
sessions**. Every restart wipes both the in-memory job index and the
disk. Once Phase 3 (Clerk auth + sessions table) lands:

- The boot-time purge of `uploads/` must be removed or scoped to
  uploads with no associated authenticated session.
- The 2h window will need to extend (probably hours-of-inactivity from
  the owner, not absolute upload age) so authenticated users can leave
  and return to in-progress work.
- `cleanupJobArtifacts` will need to consult the session/job ownership
  table before deleting; right now it deletes blindly because all data
  is anonymous.

The cleanup module is structured so this rework is local to that file
plus the call sites — nothing leaks the retention policy outward.

## Frame viewer

A read-only scrub viewer sits between Step 4 (AI Analysis) and Step 5
(Download) in the sidebar. It is opt-in: the user clicks **Open frame
viewer** in the "Review Frames" sidebar panel, the main canvas area swaps
from `MaskingCanvas` to `FrameViewer`, and the user can leave via either
**Continue to Download** or **Close viewer**. The direct path from Step 4
to Step 5 is preserved — skipping the viewer is allowed.

### Endpoints

All five endpoints are pure read. None write to disk. Every filesystem
path is bounded by `server/services/frameAccess.ts`'s `resolveFramePath`
(or its mask/overlay equivalents) against `TEMP_PROCESSED_DIR`, using
the same `path.resolve + startsWith` pattern the cleanup module uses.

| Method | Path | Cache | Purpose |
|---|---|---|---|
| `GET` | `/api/jobs/:jobId/viewer-info` | none | One-shot summary: `{totalFrames, status, labels, hasFrames, hasInference, hasArtifacts}`. 404 if job missing, 410 if `temp_processed/<jobId>/` swept. |
| `GET` | `/api/jobs/:jobId/frames/:n.png` | `private, max-age=3600` | n-th processed frame PNG (sorted-list position). 400 invalid n, 404 missing, 410 swept. |
| `GET` | `/api/jobs/:jobId/inference.json` | `no-store` | Frame-indexed pivot of `job.aiLabels`: `{imageWidth, imageHeight, outputSettings:{size,aspectRatioMode}, labels[], frames: {n: [{labelId, name, modality, confidence, bbox, hasMask}]}}`. `imageWidth/Height` are SOURCE-VIDEO dimensions (the coord system bbox is stored in), not the temp_processed frame's natural dimensions. No base64 blobs — mask URLs are constructed client-side from labelId. |
| `GET` | `/api/jobs/:jobId/masks/:labelId/:n.png` | `private, max-age=3600` | Reads `mask_<n>.png` from `spokes/ai/<jobId>/<runId>/` via `findRunByLabelId`. **410 with `{reason: "artifacts_lost_on_restart"}`** when no AIRun owns the label (shouldn't happen post-3b). |
| `GET` | `/api/jobs/:jobId/overlays/:labelId/:n.png` | `private, max-age=3600` | Same as masks but serves `overlay_<n>.png` — the GPU's pre-rendered RGBA overlay (green tint on mask region). Used by the viewer's "Overlay" mode. |

### Component

`client/src/components/FrameViewer.tsx`. Props:
```ts
{
  jobId: string;
  onContinueToDownload: () => void;
  onBackToInference?: () => void;
}
```
The viewer fetches `viewer-info` and `inference.json` in parallel on
mount and renders three view modes via a segmented control:

- **Clean** — just the frame PNG.
- **Overlay** — frame + GPU overlay PNG(s) stacked with `mix-blend-mode: lighten`.
  One overlay layer per visible label. We chose `lighten` over `screen`
  because medical imagery preserves contrast better — `lighten` only
  brightens the mask region (where the green tint is the brighter pixel)
  and leaves the rest of the frame identical. Disabled when
  `hasArtifacts === false` (post-restart case) — the toggle button stays
  visible but shows a tooltip explaining why and the user can still use
  Clean and Bbox modes.
- **Bbox** — frame + SVG `<rect>` per visible label. The SVG uses a
  `viewBox` set to `imageWidth × imageHeight` (source-video pixels) with
  `preserveAspectRatio="xMidYMid meet"`, so `<rect>` coords pass through
  as-is and the browser handles all display scaling. No manual measurement
  of the rendered img is needed. Each rect uses the label's deterministic
  color (`colorForLabelId`, FNV-1a → HSL hue with fixed S/L), matching
  the swatch shown in the AI Analysis panel's label list.

Keyboard: ←/→ (±1), Shift+←/→ (±10), Home/End, Space cycles modes
(skips Overlay when artifacts are unavailable).
Slider is the primary scrub control.

Prefetch window is mode-aware: ±10 frames around current, capped at 30
total `<img>` nodes. In Overlay mode the budget is split across the
visible labels' overlay PNGs. Clean and Bbox modes only prefetch frame
PNGs (bboxes already arrived in inference.json). The window is rebuilt
from scratch on every `currentFrame` / `mode` / `visibleLabels` change —
no accumulation.

The viewer is **read-only** in v1 — no per-frame editing, no saving back
to inference state. Per-frame label visibility is the only client-side
mutation, and it's purely UI state (not POSTed anywhere).

### Panel gating

The "Review Frames" sidebar panel is enabled when `jobCompleted` is true
(i.e. `temp_processed/<jobId>/` exists). It is **not** gated on AI labels
existing — a user with completed template-masking but no AI run yet can
still scrub their masked frames to verify quality. In that case the
viewer locks the mode toggle to Clean and shows
"No AI labels yet — run inference to enable overlays" in the labels panel.

### Known limitations

- **Frames remain available for 24 hours post-completion.** Beyond that
  the hourly sweep removes `temp_processed/<jobId>/`, and the viewer
  surfaces a session-expired message via 410 — the same response shape
  it uses on every endpoint when the folder is missing.
- **Large videos (>1000 frames)** may scrub sluggishly on slower laptops.
  Each frame is a separate HTTP fetch; browser cache keeps it manageable
  but the prefetch radius isn't tuned for high frame counts. Not yet
  optimized.
- **Artifacts survive restarts (post-3b)** but MemStorage job metadata
  does not. After `pm2 restart`, mask/overlay PNGs remain on disk under
  `spokes/ai/` but `job.aiLabels` and AIRun records are lost (MemStorage
  is volatile). The viewer detects this via `hasArtifacts: false` (no
  AIRuns in memory) and shows a banner with a re-run-inference shortcut.
- **Bbox display uses sorted-list position as the frame key**. This
  matches the inference loop and the manifest builder. If upstream
  processing changes the file naming convention again, both inference.json
  and the viewer need to be re-aligned.
- **Bbox overlay assumes letterbox or original output mode.** Bbox coords
  are stored in source-video pixel space (`job.width × job.height`), and
  inference.json now reports `imageWidth/imageHeight` in that space so the
  viewer's SVG `viewBox` aligns with the displayed frame for `outputSize=
  'original'` and for any non-original size with `aspectRatioMode='letterbox'`
  (the rendered frame's content area still has source-video aspect inside
  black bars). Crop and stretch modes warp frame geometry but the stored
  bbox doesn't get re-projected, so positions can drift. The viewer detects
  this via the `outputSettings` block in inference.json and shows an inline
  amber warning when bbox mode is active under those conditions. Full fix
  is bbox coordinate transformation at inference time — parked for future
  work.

### Future work parking lot

- Per-frame approval / disapproval (operator marks individual frames as
  "good" or "discard"). Would need a new POST endpoint + a flag on
  `frameResults[n]`.
- Side-by-side Clean + Overlay rendering at the same time, for direct
  visual comparison.
- In-viewer bbox correction with re-inference: drag a corner of a bbox
  to tighten it, click Re-run AI for that one label, replace its
  `frameResults` in place.
- Server-side frame-strip thumbnail for an MP4-style scrubber preview
  along the slider.
- Extracting `FrameViewer.tsx` into smaller pieces (`<ModeToggle>`,
  `<LabelsPanel>`, `<PrefetchLayer>`) once a second viewer-like component
  appears.

## AI Analysis

Step 4 in the linear workflow. The user draws a region of interest (bbox /
circle / polygon / brush) on the first processed frame, types an intent
("segment the pleural line"), and clicks Run. Inference runs on every
frame in `spokes/template_mask/<jobId>/`; results are stored as one `AiLabel`
per Run on `job.aiLabels` (lightweight metadata, dual-written to `AIRun.labels[]`)
plus per-frame mask/overlay PNGs on disk under `spokes/ai/<jobId>/<runId>/`.

### Drawing canvas controls

The drawing toolbar in the AI Analysis sidebar panel has four mode
buttons (Rectangle / Circle / Polygon / Brush) followed by a divider and
two action buttons:

- **Undo last** (Undo2 icon) — single-shape semantics with step-by-step
  revert:
  - **Polygon mid-drafting**: pops the most recently placed vertex.
    Pops the last vertex → discards the shape entirely.
  - **Polygon committed** (post double-click, before Run): discards the
    polygon. Does not revert to drafting; if you want to keep editing,
    don't double-click.
  - **Rect / Circle / Brush** (committed or in-progress): discards the shape.
  - **Nothing to undo**: silent no-op.
- **Clear all** (Eraser icon) — clears the current shape after a
  `window.confirm` if it's a meaningful shape (polygon with >2 vertices,
  brush stroke with >4 points, or any rect/circle). Trivial in-progress
  shapes clear without asking.

Keyboard shortcut: **Cmd/Ctrl+Z** runs Undo when the AI Analysis panel is
visible AND focus is on `<body>` or the canvas (not in the intent input
or any other text field — those keep native undo). Multi-step undo is
supported by the rules above; the shortcut is a silent no-op when there's
nothing to undo.

There is **no multi-bbox composition** — only one shape is ever sent to
the GPU per Run click. Drawing a new shape replaces the previous one.

### Approve vs. delete

Each label in the sidebar list has two distinct controls, deliberately
separated because they have different consequences:

- **Approve toggle** — reversible. Click flips `label.approved`. Visual
  state shows current value: filled green "Approved ✓" when true, gray
  outline "Not approved ✕" when false. Hits `PATCH /api/ai/labels/:jobId/:labelId`
  with `{approved: !current}`. Only approved labels are written into the
  download ZIP's manifest. **Use this when you're not sure yet** — you
  can flip it back later without re-running inference.
- **Delete** (Trash2 icon, red on hover) — permanent. Click prompts
  `window.confirm("Permanently delete label 'foo'? This cannot be undone.")`.
  Confirm hits `DELETE /api/ai/labels/:jobId/:labelId`, which splices the
  label out of `job.aiLabels` AND its `AIRun`, and deletes the run's
  output directory from disk. The mask/overlay artifacts cannot be
  recovered without re-running inference. **Use this when you definitely
  don't want this label.**

A small color swatch leads each row, computed via
`client/src/lib/labelColor.ts` (FNV-1a → HSL). It matches the bbox
stroke color the FrameViewer renders for the same label, so users can
mentally connect rows to overlay rectangles.

### Layout

```
[swatch] [name] [confidence]   [approve toggle] [delete]
```

On narrow widths the name truncates with `truncate`; the toggle and
delete button stay full-size since they're shrink-0.
