# Output Round 2 — report (built 2026-10-04, sandbox-verified, not deployed)

**Input:** `OUTPUT_ROUND2_SIGNOFF.md` (D1–D3 as the recon refined them, D4 = (a), D5 = guard the legacy route, D6 = client change in `ProcessingControls.tsx`). **Base:** `main` @ `51289ae`. **Output:** two commits, one deploy, one `git revert` each. **Stopped here for the runbook.** Written for a fresh agent: §0 is the result, §6 is what still has to be checked on the EC2 box.

All sandbox timings ran on Andre's Mac (Apple silicon, node 25, `UV_THREADPOOL_SIZE=1`, `sharp.concurrency(1)` where marked serial, median of 7). The recon's 343 → 21 ms was a Linux VM; these are this Mac's numbers and are smaller everywhere. Prod is a one-core t3.large: scale by the factor the recon used (~5–6×), do not quote these as prod.

## 0. Result

| | |
|---|---|
| Commit 1 `4f0c071` (`videoProcessor.ts:2417` + `maskBuildIdentity.test.ts`) | Keep 1080p `createMaskRgbaBuffer` **202 → 14 ms**, `buildApplyMask` **214 → 15 ms**; mask buffers **byte-identical** on 5 masks including a dpr-2 Keep export |
| Commit 2 (everything else) | server refuses `mask_blanks_nothing` / `mask_blanks_everything` / `unverifiable` with a 422 before anything is persisted, on **both** apply entry points; client toast shows the message; manifest `filename` = the ZIP entry |
| Sandbox gate `apply.validate ms` ≤ 100, serial | **14.5 ms** (1080p Keep), **69.2 ms** (dpr-2 Keep), **72.0 ms** (the 3840 × 2160 PNG the browser actually sent) ✅ |
| `tsc` | **12** (5 `frameExtractor`, 7 `maskWorker`) ✅ |
| Unit tests | 17 files green; new: `maskBuildIdentity` 1, `applyGuard` 5, `frameManifestNames` 3; `outputTransform` updated for the new core signature (5/5) |
| Geometry (`check.ts`, 24 rows) | **24/24, reference diff 0 / 0**, after commit 1 *and* after commit 2 |
| Both `dist/` files | `dist/index.js` 275 870 B, `dist/automaskWorker.js` 53 122 B ✅ |
| Backstop without the client (curl) | 3 crafted masks × 2 routes → all 422 with the right message; job row + GET byte-identical, no files ✅ |
| Backstop through the UI | the "whole frame" refusal reached the toast verbatim on a fresh job, no "Processing Started" card, Apply stayed enabled ✅; **two rows only partly run — see §4.3** |

## 1. Commit 1 — the diff and the proof

`server/services/videoProcessor.ts`, the whole edit:

```diff
-        if (i % sampleInterval === 0 || (isDrawn && isRed)) {
+        if (i % sampleInterval === 0) {
```

Nothing that reads `maskRaw` or writes `resultBuffer` changed. The `PIXEL ANALYSIS RESULTS` log keeps its shape; its `detectedSample` now draws from the interval samples only (usually empty).

**Proof, three layers (all run):**

1. `server/services/__tests__/maskBuildIdentity.test.ts`: 4 masks (Keep rectangle, small Remove rectangle, fully transparent, fully red) × 2 frame sizes (400 × 240, 1920 × 1080), canvas = frame dims, `scale: 1`; `createMaskRgbaBuffer` equals the predicate-computed buffer byte for byte. **Passes on the old code first (written before the edit) and on the new.**
2. One-off A/B, not committed. Old = `git show 51289ae:server/services/videoProcessor.ts` dropped into a scratch copy of `server/` + `shared/` outside the tree; new = a scratch copy of the edited tree; one script (`ab_bench.ts`, scratchpad) run in each, dumping each mask buffer to disk. `cmp` of the five dumps: **identical** for `keep_1080p_600x600_kept`, `keep_dpr2_3840x2160` (PNG 3840 × 2160 → 1920 × 1080, i.e. the resampled path), `remove_1080p_300x200`, `fully_transparent`, `fully_red`. `masked_px` equal in both trees on every row.
3. `outputF2` 3, `outputParity` 1, `outputTransform` 5 pass; `check.ts` 24 geometry rows reference diff 0 (fan MP4 1536 × 796, E9 DICOM 1164 × 873, image batch 632 × 1080 × letterbox/crop × original/256/512/640 × 480).

**Serial before / after (ms):**

| mask (1920 × 1080 unless noted) | masked_px | `createMaskRgbaBuffer` before → after | `buildApplyMask` before → after |
|---|---|---|---|
| Keep, 600 × 600 kept | 1 713 600 | 201.9 → **13.9** | 214.4 → **15.1** |
| Keep, dpr-2 canvas export (3840 × 2160 PNG) | 1 713 600 | 253.1 → **64.1** | 264.7 → **71.1** |
| Remove 300 × 200 | 60 000 | 19.1 → 13.3 | 20.8 → 14.9 |
| fully transparent | 0 | 9.0 → 13.7 | 10.3 → 15.2 |
| fully red | 2 073 600 | 236.3 → 12.3 | 243.4 → 15.1 |

The two small rows going *up* a few ms is run-to-run noise on a ~10 ms floor (both trees ran the same code path for those masks; the buffers are identical). The recon's attribution holds: the cost was the per-pixel debug object, not the offsets scan (`buildApplyMask` − `createMaskRgbaBuffer` ≈ 1 ms here).

## 2. Commit 2 — what was built

**New:** `server/services/applyGuard.ts` (113 lines): `decideApply(masked, total)` (pure), `checkApplyMask(vp, jobId, job, maskData)`, `REFUSAL_MESSAGES`. `VideoProcessor.countMaskedPixels(maskData, w, h)` (`videoProcessor.ts`, public, ~10 lines: `createMaskRgbaBuffer` then count alpha > 0, the `buildApplyMask` test).

**Edited:**
- `server/handlers/templateMaskApply.ts`: order is now 400 → `getVideoJob` / 404 → **`io` 500 (moved up)** → `new VideoProcessor(io)` (moved up) → **`checkApplyMask`** → persist → `setTemplateMaskState` → dispatch with the same instance. A refusal returns `{ ok:false, status:422, error }`; the route maps it to `{ success:false, error }` as before.
- `server/routes.ts`: legacy `POST /api/videos/:jobId/process` calls `checkApplyMask(videoProcessor, …)` after the status check and before the dispatch, 422 `{ error }`; `[DEADROUTE-HIT]` untouched. Manifest wrappers as §2.2.
- `client/src/components/ProcessingControls.tsx` (the only client file): `serverMessageOrSame` unwraps `"<status>: {json}"` into the body's `error` string; `onStartProcessing(settings)` and the `mask_processing_started` capture moved into `onSuccess`. `queryClient.ts` untouched.
- `server/handlers/frameManifest.ts`, `server/services/__tests__/outputTransform.test.ts` (two call sites moved to `filenames`).

**Dims (D1a/D3), as signed off:** video / DICOM = raw frame 0 on disk (`listRawFrameFiles` → `Sharp(path).metadata()`), else `job.width/height`; image batch = `getImageDimensions('uploads/' + fileList[0].filename)`, else the job record when that is 0 × 0. Neither resolves, or the count throws → refuse `unverifiable` (`apply.refused` carries `detail`). `dims_source` is `frame0 | image0 | job` on every `apply.validate`.

**Messages (422 body `error`):** exactly the three strings of sign-off §3.1.

### 2.1 Unit tests

`applyGuard.test.ts` (5): `decideApply` on 0 / 1 / total − 1 / total; `countMaskedPixels` == `buildApplyMask().maskedPixels` on 4 masks × 2 sizes (400 × 240, 1920 × 1080); **the bad shapes of recon §4.2 each land on the table's bound** at 1920 × 1080 — no PNG + `rectangle` + `coordinates: []` → nothing; no PNG + `freeform` + opacity 75 → **everything** (2 073 600); no PNG + `freeform` + no opacity → nothing; malformed PNG → nothing; non-data-URL → nothing; black shapes on transparent (the 1a shape) → nothing; `checkApplyMask` reads `frame0` over a wrong job record, `image0`, falls to `job` when image 0 is gone or no frames exist; fail-closed on no dims and on a throwing count (`apply.validate` absent, one `apply.refused` with `detail`).
`frameManifestNames.test.ts` (3): `imageEntryName`; the core passes `filenames` through to `frames[]` and the CSV unchanged, one per frame, in order; empty list → header only.

### 2.2 Manifest filenames (R2)

- **Core:** `PerFrameManifestInput` takes `filenames: string[]` in place of `frameCount` + `outputFormat`; synthesizes nothing. New `imageEntryName(i, ext)` = `images/frame_%06d.<ext>`, the one place the name is built.
- **Whole-job (`templateMaskDownloadHandler`):** `entryNames = frameFiles.map((f,i) => imageEntryName(i, fileExt(f)))` built once, used for the core **and** `archive.file`. `masquerade_version` `'1.0'` → `'1.1'`; top-level `output_format` unchanged; README gains the sentence "filename in manifest.json and metadata.csv is the path of that frame inside this ZIP."
- **Run download:** base files are listed whether or not they are included (the listing moved above the manifest). `ext` from `baseFiles[i]` when it exists, else `png` for `run.inputSource === 'raw'`, else the job's output format. Manifest gains top-level `masquerade_version: '1.1'` and `images_included: includeBaseFrames && baseFiles.length > 0`. One `console.warn` when base frames were requested and `baseFiles.length !== maskFiles.length`.
- The two comments that lied (`frameManifest.ts` contract, `routes.ts` D1) are rewritten.
- **Phase 6's D1 byte-identity guarantee ends here, on purpose.** `output_transform` and its ten CSV columns are unchanged; `check.ts` (which reads only those) stays green.

## 3. Test matrix, row by row

Evidence files are in `../sandbox/results/2026-10-04_output_round2_*` (outside the repo, gitignored with the sandbox).

### 3.1 Unit — see §2.1. ✅

### 3.2 Backstop without the client (`scripts/output_eval/round2_check.ts --sections backstop`, job on Kidney 1920 × 1080)

For each of {fully transparent PNG, fully red PNG, `canvasDataUrl: 'not-a-data-url'`} × {canonical `POST /api/jobs/:id/template-mask/apply`, legacy `POST /api/videos/:id/process`}: **all 24 sub-rows ✅**.

| crafted mask | status | body `error` | `apply.refused` |
|---|---|---|---|
| fully transparent PNG | 422 | "This mask doesn't remove anything. …" | `reason: mask_blanks_nothing, masked_px 0, total_px 2073600, 1920×1080` |
| fully red PNG | 422 | "This mask removes the whole frame. …" | `reason: mask_blanks_everything, masked_px 2073600, total_px 2073600` |
| malformed data URL | 422 | "This mask doesn't remove anything. …" | `reason: mask_blanks_nothing, masked_px 0` |

For every one, both routes: (a) `GET /api/jobs/:id` **and** the `jobs` row (`psql row_to_json`, 667 chars) byte-identical before and after; (b) `spokes/template_mask/<job>/` has 0 entries before and after; (c) exactly the expected `apply.refused` line. The canonical body is `{success:false,error}`, the legacy body `{error}`. Afterwards a corrected Remove mask applies on the **same** job (200, completes).

### 3.3 Backstop through the UI (Browser pane, 1400 × 950 emulated, then desktop; Kidney 1920 × 1080)

| row | result |
|---|---|
| Keep + a rectangle dragged over the whole frame, fresh job | the drag started one screen pixel inside the canvas at 25 % zoom, so an 8-px strip stayed uncovered → `masked_px 8640` of 2 073 600, **a normal apply** (`apply.validate` 83 ms, `dims_source frame0`, no refusal, "Processing Started" toast, job completes). This is the recon's "UI row may not trip" note, confirmed: a hand-drawn "whole frame" misses the bound by the edge pixels. The `curl` rows are the proof of the bounds. |
| a mask that blanks the whole frame, fresh job (a Keep rectangle dragged off the canvas, so no object remains) | **toast "Processing Failed — This mask removes the whole frame. Nothing would be left in the output."** (no status prefix, no JSON); **no "Processing Started" card** (the status card still read "Connecting to processing updates…"); **Apply still enabled and not "Starting…"**; server: `apply.validate masked_px 2073600` → `apply.refused mask_blanks_everything` → 422; a second refusal on the same job behaved the same |
| corrected mask then applies (same job, reloaded): Accept the auto-mask cone → Apply | **"Processing Started" toast**, `apply.validate 93.8 ms masked_px 1 821 097 frame0`, no `apply.refused`, `apply.done 427 ms`, and **`automask.outcome` fired once (`accept`) 31 ms after `apply.request`** (the one-round-trip-later effect of moving `onStartProcessing` into `onSuccess`) |
| **not run:** Remove + a rectangle over the whole frame, through the UI | by the same strip effect it would land at `total − k` and proceed (recon risk note); the pane's layout had become too cramped to draw reliably. `decideApply(total − 1)` and the bound shapes are unit- and `curl`-proven. **Record this row on prod / a real browser.** |
| **not run cleanly:** the "Keep + whole-frame rectangle → `mask_blanks_nothing` toast" row | same reason (a 1-px-short drag leaves a strip, so it applies). The `mask_blanks_nothing` message reached the toast path identically to the "everything" one (same code); proof of the 422 and its text is §3.2. |

### 3.4 Normal applies (sandbox; `check.ts` + `round2_check.ts --sections normal`)

- Hand-drawn **Remove** 300 × 200: 200, `apply.validate {ms 24.6, masked_px 60000, total_px 2073600, dims_source frame0}`, no `apply.refused`. Hand-drawn **Keep** (600 × 500 kept): 200, `{ms 25.1, masked_px 1773600, frame0}`, no refusal.
- Accepted cone on the **fan MP4** (1536 × 796): 8 applies in `check.ts`, 8 `apply.validate` with `dims_source frame0`. **E9 DICOM** (1164 × 873): 8 / `frame0`. **Image batch** (632 × 1080, uniform, 2 stills): 8 / **`image0`**. Server log over the whole session: 30 `apply.request` = 24 `check.ts` + 3 canonical refusals + 1 corrected + 2 normal; 0 `apply.refused` outside the 6 deliberate ones.
- **`check.ts` 24 geometry rows, reference diff 0 / 0**, exact dims, sidecar == manifest, run at commit 1 and again at commit 2 (fan, E9, images). Rows in `…c1_geometry_*.md`, `…c2_geometry_*.md`.
- `automask.outcome` still fires exactly once on an accepted-cone apply (§3.3).

### 3.5 Cost (serial; `scripts/output_eval/guard_bench.ts`)

`apply.validate ms` = what `checkApplyMask` reports (the count only). Gate: **≤ 100 ms each, serial**.

| mask | frame | masked_px | dims_source | **apply.validate ms** |
|---|---|---|---|---|
| Keep, canvas = frame (600 × 600 kept) | 1920 × 1080 | 1 701 525 (82.1 %) | job | **14.5** ✅ |
| Keep, dpr-2 canvas export | 1920 × 1080 | 1 701 530 | job | **69.2** ✅ |
| **the PNG the browser sent** (3840 × 2160, 182 KB, from `jobs.mask_data`) | 1920 × 1080 | 1 821 097 (87.8 %) | frame0 | **72.0** ✅ |
| Remove 300 × 200 | 1920 × 1080 | 60 000 (2.9 %) | job | 15.2 |
| fan MP4 accepted cone | 1536 × 796 | 680 420 (55.7 %) | frame0 | 13.0 |
| E9 DICOM accepted cone | 1164 × 873 | 501 106 (49.3 %) | frame0 | 7.0 |

With the builder's logging left on (`--logs`, output to a file) the numbers are the same within noise (14.6 / 67.1). The live server (parallel, not serial) logged 24.6 / 25.1 ms for the two API-driven 1080p applies and **82–94 ms** for the browser's dpr-2 exports: the browser pane ran at **dpr 2**, so the real Keep export is the 3840 × 2160 row, ≈ 5× the plain 1080p cost. Those live figures are not serial and are not the gate; the gate row is 72 ms.

### 3.6 Manifest (`round2_check.ts --sections manifest`; the AI service is unreachable in the sandbox, so the **AI runs are synthetic**: `storage.addAiRun` into the sandbox DB + 8 × 8 white PNGs under `spokes/ai/…`; non-PHI) — all ✅

- Whole-job ZIP (Kidney, 46 frames): `masquerade_version "1.1"`; **every `frames[].filename` is a ZIP entry** (first `images/frame_000000.jpg`); the CSV `filename` column == the manifest's (46 rows); `images/` entry count == `frames[]`; README sentence present.
- Run ZIP, `inputSource: template_mask`, with and without `includeBaseFrames=true`: `masquerade_version "1.1"` both; **identical names** (`images/frame_%06d.jpg`) both, CSV == manifest; without → `images_included false`, 0 `images/` entries; with → `images_included true`, every filename is a ZIP entry (46).
- Run ZIP, `inputSource: raw`: same checks, names end **`.png`** (raw frames are PNG; the job's output format is jpg, so this is the extra defect the recon found, now fixed).
- **Swept** (both frame dirs deleted), base frames requested: `images_included false`, 0 `images/` entries, names fall back to `.png` (raw run) / `.jpg` (template-mask run).

### 3.7 Invariants (§6 of the sign-off)

| invariant | status |
|---|---|
| `tsc` 12 | ✅ 12 |
| A3 frozen (a refusal persists nothing; no column) | ✅ no `shared/schema.ts`, `storage.ts`, `pgStorage.ts`, migration change; §3.2 proves the row is untouched |
| `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, extraction, reuse guard, `automask*.ts`, `outputTransform.ts` untouched | ✅ (`git diff --stat`: none of them) |
| `createMaskFromBase64` changed at `:2417` only | ✅ |
| `queryClient.ts` untouched | ✅ |
| no new dependencies, no flag | ✅ |
| nothing PHI-bearing committed | ✅ (clips, results, DB stay under `../sandbox/`; the synthetic PNGs are 8 × 8) |
| both `dist/` files build | ✅ |
| Node tooling in the macOS Terminal only | ✅ (everything ran on the Mac; the Linux VM was not used) |

## 4. Findings and things a verifier might mistake for a regression

1. **`apply.validate` doubles the mask decode on every apply.** Keep 1080p dpr-2: +72 ms here (expect ~+0.3–0.4 s on prod); Remove +15 ms (~+0.25 s on prod). The sign-off priced this in (§5). Commit 1 more than pays it back on Keep.
2. **The UI "whole frame" rows do not reliably trip.** A hand-dragged rectangle leaves an edge strip (§3.3: 8 px at 25 % zoom → `masked_px 8640`), so it applies. That is correct behaviour, not a missed refusal.
3. **Browser-pane input stall, unexplained.** On the fresh job, after the first refused apply (and a toast), real mouse input (clicks on Apply and Clear Mask, a drag) stopped reaching the page, while `element.click()` from JS on the same button ran the mutation normally (and `elementFromPoint` returned the button, `disabled: false`, no overlay). A reload cleared it; real clicks and Accept → Apply then worked, including the "corrected mask applies" row. I could not show it is the app and not the pane (the drag that preceded it ended outside the canvas, which can wedge synthetic input). **Please repeat "refused apply → click Apply again / draw again" once in a normal browser** (§6 row P6) before declaring it nothing.
4. **`io` 500 now precedes persistence** (sign-off §3.1 moved it up). A server without Socket.IO used to persist the mask and then 500; it now 500s with nothing persisted. Intended.
5. **`automask.outcome` and `lastProcessedSettings` land one round trip later**, and only for accepted applies (D6 consequence). Also: `handleStartProcessing` in `template-mask-spoke.tsx` returns early if `maskData` was cleared during that round trip, so a Clear Mask clicked in the ~100 ms between the click and the 200 skips `setIsProcessing`. Cosmetic; noted, not fixed (spoke file out of scope).
6. **Pre-existing, unchanged:** the "no-resample row" shows "57 / 54 bytes differ" on the E9 and image rows (same as the 1b report); a re-apply on an already-`complete` job clears `isProcessing` at once (`template-mask-spoke.tsx:214-219`, the known wart, noted in `CLAUDE.md` for the UI round).
7. **The legacy route emits no `apply.request` mark** (it never did); its refusals still emit `apply.validate` / `apply.refused`.
8. **Mixed-dimension image batches (backlog 29):** accepted or refused as a whole on image 0's count, as signed off; the blanking itself is still wrong for images 1…n, not touched.

No new `CLAUDE.md` backlog item was needed: nothing found mid-task falls outside one of the sign-off's own lines.

## 5. Files touched

**Commit 1 `4f0c071`:** `server/services/videoProcessor.ts` (the one line), `server/services/__tests__/maskBuildIdentity.test.ts` (new).

**Commit 2:**
- server: `server/services/applyGuard.ts` (new), `server/services/videoProcessor.ts` (+`countMaskedPixels`), `server/handlers/templateMaskApply.ts`, `server/handlers/frameManifest.ts`, `server/routes.ts`
- client: `client/src/components/ProcessingControls.tsx`
- tests: `server/services/__tests__/{applyGuard,frameManifestNames}.test.ts` (new), `outputTransform.test.ts` (2 call sites)
- tools: `scripts/output_eval/round2_check.ts`, `scripts/output_eval/guard_bench.ts` (new)
- docs: `CLAUDE.md`, `docs/refactor/ITEM22_REPORT.md` (already modified in the tree), `OUTPUT_ROUND2_{KICKOFF,RECON,SIGNOFF,REPORT}.md`, `UI_SIMPLIFICATION_NOTE.md`

Left out by explicit path: `.DS_Store`, `.idea/`, `scripts/sandbox/`, `scripts/automask_spike/dicoms.json`.

## 6. Handoff — what still has to happen on the EC2 box (for the runbook)

Prod is `51289ae`. Snapshot first (`pre-output-round2`), as every round. After `git pull`, build **inside `~/template-masking-app`** and confirm `ls dist/` shows both `index.js` and `automaskWorker.js`.

| # | row | expect |
|---|---|---|
| P1 | the three crafted masks with `curl` against the prod apply endpoint on a throw-away job (transparent PNG, fully red PNG, `canvasDataUrl: "x"`), and the legacy route | 422 + the sign-off messages; `pm2 logs … --nostream \| grep apply.refused` shows one line each; the job record unchanged (`GET /api/jobs/<id>`); nothing under `spokes/template_mask/<job>/` |
| P2 | `apply.validate ms` on the 1080p Keep job (Kidney 1920 × 1080) and the fan MP4 | **gate ≤ 500 ms** (est. ~300–400 ms for 1080p Keep; sandbox serial was 72 ms for the browser's dpr-2 export, the box is ~5–6× slower) |
| P3 | Keep 1080p `apply.mask_build` and `apply.done` against `51289ae`'s ~1.8 s / ~4.3–4.5 s | `mask_build` ~0.3 s; the apply ~1.1 s faster; Remove applies ~0.25 s slower (the backstop's price) |
| P4 | normal applies: Remove, Keep, accepted cone, E9 DICOM, an image batch | each proceeds, one `apply.validate` each (`dims_source` `frame0` for video / DICOM, `image0` for the batch), no `apply.refused`; `automask.outcome` once on the cone |
| P5 | audit grep: `grep '"masked_px":0,'` over the log since this deploy | only the deliberate P1 refusals (as `apply.refused`), no `apply.validate` with `masked_px 0` followed by an applied job |
| P6 | in a real browser: a hand-drawn mask that blanks the whole frame (the shape of §3.3) → plain toast, no "Processing Started" card, Apply enabled, then a corrected mask applies; and Keep / Remove with a rectangle over the frame, recording `masked_px` either way (§3.3 "not run" rows) | as §3.3; if real input stops after the toast, that is finding 3 — capture the console |
| P7 | manifest: download a whole-job ZIP and a run ZIP with and without base frames on a **raw** run and a template-mask run | every `frames[].filename` is in `unzip -l`; CSV == manifest; `masquerade_version "1.1"` in both; `images_included` correct; the raw-run names end `.png` |
| P8 | the 7B-1 probe: `grep DEADROUTE-HIT` | still the gate for deleting the legacy route; a hit now returns the same 422s on a bad mask |

**Rollback:** `git revert` the round commit and/or `4f0c071` (independent; commit 2 does not depend on commit 1's speed-up for correctness, only for its cost gate). No schema, storage or migration change.
