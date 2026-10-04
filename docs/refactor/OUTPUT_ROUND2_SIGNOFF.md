# Output Round 2 — sign-off on the recon (2026-10-04)

**Input:** `OUTPUT_ROUND2_RECON.md` (against `main` @ `51289ae`). **Decision:** D1–D3 approved as the recon refined them; **D4 = (a)**, **D5 = guard the legacy route**, **D6 = client change in `ProcessingControls.tsx`**, all three accepted by Andre. Step 2 = **two commits, one deploy** (one `git revert` each). Build, `tsc` 12, A3 frozen; stop after `OUTPUT_ROUND2_REPORT.md` for the runbook.

## 1. What the recon corrected in the kickoff

Four things in the kickoff were mine and wrong:

- **"`createMaskRgbaBuffer` … called, not edited" and "≤ 500 ms" cannot both hold.** `createMaskFromBase64` allocates a debug object for every detected pixel (`videoProcessor.ts:2417`); a 1080p Keep build is 343 ms with it and 21 ms without, buffers identical. The kickoff and the 1b docs blamed the 2 M offsets for Keep's `apply.mask_build`; the offsets scan is ~24 ms. Queue item 3 ("emit only in-crop offsets") was aimed at the wrong cost and is closed by commit 1.
- **"Server only" is wrong.** A refused first apply leaves the spoke stuck in "Processing Started" with Apply disabled, and the toast shows raw JSON.
- **`applyTemplateMask` is one of two apply entry points.** `POST /api/videos/:jobId/process` (`routes.ts:537`) starts processing with a body-supplied mask.
- **`createTransformedMask` is not in the live path.** It and `convertToRgbaBuffer` have no callers. The live chain is `createMaskRgbaBuffer` → `createMaskFromBase64`.

## 2. Commit 1 — stop allocating a debug object per masked pixel

**The whole edit:** `server/services/videoProcessor.ts:2417`

```ts
if (i % sampleInterval === 0 || (isDrawn && isRed)) {   // before
if (i % sampleInterval === 0) {                         // after
```

Nothing else in `createMaskFromBase64` changes. No line that reads `maskRaw` or writes `resultBuffer` is touched. The `PIXEL ANALYSIS RESULTS` log keeps its shape (its `detectedSample` now draws from the interval samples only).

**Proof, three layers:**
1. `server/services/__tests__/maskBuildIdentity.test.ts`: four masks (Keep rectangle, small Remove rectangle, fully transparent, fully red) × two frame sizes (400 × 240, 1920 × 1080), canvas = frame dims and `scale: 1`, so the expected RGBA buffer is computable from the mask predicate with no resampling. `createMaskRgbaBuffer` output must equal it byte for byte.
2. A one-off A/B for the resampled case, reported and not committed: `git show 51289ae:server/services/videoProcessor.ts` into a temp path outside the tree, then old vs new `createMaskRgbaBuffer` in one process on a dpr-2 Keep export (3840 × 2160 PNG → 1920 × 1080). `Buffer.equals` must be true.
3. `outputF2`, `outputParity`, and `check.ts` 24 geometry rows, reference diff 0.

**Report:** serial `createMaskRgbaBuffer` and `buildApplyMask` on the 1080p Keep mask, before and after. Recon measured 343 → 21 ms and 367 ms total before, in a Linux VM; report your own.

Commit message: `mask build: sample the debug array at the interval only (Keep 1080p build 343 → ~21 ms, output identical)`.

## 3. Commit 2 — Output Round 2

### 3.1 R1 — the guard

**`VideoProcessor.countMaskedPixels(maskData, w, h): Promise<{ masked: number; total: number }>`** (public). Calls `this.createMaskRgbaBuffer`, counts `alpha > 0`, the same test `buildApplyMask` uses at `:653`. No second threshold anywhere.

**`server/services/applyGuard.ts`** (new):
- `decideApply(masked, total)` → `null | 'mask_blanks_nothing' | 'mask_blanks_everything'`. Pure.
- `checkApplyMask(vp, jobId, job, maskData)` → `{ ok: true } | { ok: false; status: 422; reason; error }`. Resolves dims, counts, emits the perf lines. **Both entry points call this one function.**

**Dims (D1a, D3), in this order:**

| job | first choice | fallback |
|---|---|---|
| video / DICOM | raw frame 0 on disk: `listRawFrameFiles(jobId)` → `Sharp(path).metadata()` (header read) | `job.width` / `job.height` |
| image batch | `getImageDimensions('uploads/' + fileList[0].filename)`, the call `processImages` makes at `:794` | `job.width` / `job.height` when that returns 0 × 0 |

A mixed-dimension batch (backlog 29) is accepted or refused as a whole on image 0's count.

**Fail closed (D1b).** If no source gives `w > 0 && h > 0`, or the count throws: refuse, reason `unverifiable`.

**Perf lines:**
- every apply where a count was made: `[PERF] apply.validate {ms, masked_px, total_px, w, h, dims_source: 'frame0' | 'image0' | 'job'}`. `ms` spans the count only.
- every refusal: `[PERF] apply.refused {reason, masked_px, total_px, w, h}` (`unverifiable` carries `detail` in place of the counts).

**Messages** (the `error` string of the 422 body):

| reason | message |
|---|---|
| `mask_blanks_nothing` | This mask doesn't remove anything. Draw over what should be removed, or switch to Keep and draw what should be kept. |
| `mask_blanks_everything` | This mask removes the whole frame. Nothing would be left in the output. |
| `unverifiable` | Couldn't check this mask. Reload the page and try again. |

**`templateMaskApply.ts`, new order:** 400 (`:44`) → `getVideoJob` / 404 (`:54-57`) → the `io` 500 check, moved up from `:76` → `new VideoProcessor(io)`, moved up from `:80` → **`checkApplyMask`** → persist (`:60`) → `setTemplateMaskState` → dispatch with the same `VideoProcessor` instance. A refusal writes nothing: no job update, no `templateMask` state, no files.

**Legacy route (D5).** In `POST /api/videos/:jobId/process`, after the status check (`routes.ts:585-589`) and before the dispatch: `checkApplyMask(videoProcessor, …)` with the instance already in scope (`routes.ts:136`); on refusal `res.status(422).json({ error })`. The `[DEADROUTE-HIT]` line stays. Deleting the route remains 7B-1, gated on the prod log.

### 3.2 Client (D6) — `client/src/components/ProcessingControls.tsx` only

1. **Toast shows the server's message.** In `mutationFn`, catch the `apiRequest` error; its message is `"<status>: <body text>"` (`queryClient.ts:3-8`). If the body parses as JSON with a string `error`, throw `new Error(body.error)`; otherwise rethrow unchanged. `queryClient.ts` is shared and stays untouched.
2. **The job is marked processing only when the server accepted.** Move `onStartProcessing(outputSettings)` (`:131`) and the `posthog.capture('mask_processing_started', …)` block (`:133-139`) into the mutation's `onSuccess` (`onSuccess: (_data, settings) => …`). An apply the server refused did not start.

Consequence, accepted: the 2B-2 `automask.outcome` post and `lastProcessedSettings` are recorded only for accepted applies, one round trip later than today.

If this needs any file beyond `ProcessingControls.tsx`, stop and report.

### 3.3 R2 — manifest filenames (D2)

- **Core** (`frameManifest.ts`): `PerFrameManifestInput` takes `filenames: string[]` (one per frame, in order) in place of `frameCount` + `outputFormat`. `frames[i].filename` and the CSV `filename` column are `filenames[i]`. The core synthesizes no names.
- **Whole-job** (`routes.ts:641`): build `entryNames[i] = images/frame_%06d.<ext>` once, `ext` from the file on disk (today's `fileExt`), and use that one list for the core and for `archive.file` (`:861`). `masquerade_version` `'1.0'` → `'1.1'`. The top-level `output_format` field is unchanged.
- **Run download** (`routes.ts:1891`): list the base files whether or not they are included (move the `:1987-2000` listing above the manifest). `entryNames[i]`: `ext` from `baseFiles[i]` when it exists; otherwise `png` for `run.inputSource === 'raw'`, else the job's output format. Add top-level `masquerade_version: '1.1'` and `images_included: includeBaseFrames && baseFiles.length > 0` (what was written, whatever was asked). If base frames were requested and `baseFiles.length !== maskFiles.length`, one `console.warn`.
- **README** (whole-job only; the run ZIP has none), one sentence under `manifest.json`: `filename` in manifest.json and metadata.csv is the path of that frame inside this ZIP.
- Fix the two comments that now lie: `frameManifest.ts:21-22`, `routes.ts:733-735`.
- Manifest bytes change on purpose. Phase 6's D1 byte-identity guarantee ends here; say so in the report. `output_transform` and its ten CSV columns are unchanged.

## 4. Test matrix (kickoff §5, amended)

| axis | rows |
|---|---|
| unit | `decideApply` on 0, 1, total − 1, total. `countMaskedPixels` equals `buildApplyMask`'s `maskedPixels` on 4 masks × 2 sizes. The five bad shapes of recon §4.2 each land on the bound the table says. Core passes `filenames` through to `frames[]` and the CSV. |
| backstop without the client (sandbox, `curl`) | fully transparent PNG → 422 `mask_blanks_nothing`; fully red PNG → 422 `mask_blanks_everything`; malformed data URL → 422 `mask_blanks_nothing`. For each: one `apply.refused` line, job record byte-identical before and after (GET the job), nothing under `spokes/template_mask/<job>/`. **The same three against the legacy route.** |
| backstop through the UI | first apply on a fresh job, Keep + a rectangle over the whole frame → toast with the plain message (no status prefix, no JSON), no "Processing Started" card, Apply still enabled, a corrected mask then applies. Remove + whole-frame rectangle → the "whole frame" toast **or** a normal apply at `total − k`; record `masked_px` either way (recon risk note). |
| normal applies | Remove, Keep, accepted cone on the fan MP4, the E9 DICOM, an image batch → proceed; one `apply.validate` each with the expected `dims_source`, no `apply.refused`; `automask.outcome` still fires once on the accepted-cone apply; `check.ts` 24 rows, reference diff 0. |
| cost (serial) | `apply.validate ms` on the 1920 × 1080 Keep mask and on the dpr-2 Keep export: **sandbox gate ≤ 100 ms each** (the box is ~5–6× slower, so this is the sandbox reading that implies ≤ 500 ms on prod). Over → stop and report. Fan MP4 and E9 numbers alongside. |
| manifest | whole-job ZIP: every `frames[].filename` is in `unzip -l`, CSV column equals the manifest's. Run ZIP with and without base frames: same names, `images_included` correct, entries present iff included. A raw-input run names `.png`. `masquerade_version` `'1.1'` in both. |
| invariants | §6. |

## 5. Expectations on prod (estimates for the runbook to confirm)

- Keep, 1080p: `apply.mask_build` ~1.8 s → ~0.3 s; `apply.validate` ~0.3–0.4 s; the apply ends ~1.1 s faster than today.
- Remove, 1080p: `apply.mask_build` unchanged (~0.26 s); `apply.validate` adds about the same again. **Remove applies get ~0.25 s slower.** That is the price of the backstop.
- Runbook gate: `apply.validate ms` ≤ 500 on the 1080p Keep job.

## 6. Invariants

`tsc` 12 · A3 frozen (a refusal persists nothing; no column for reasons) · `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, extraction, the reuse guard, `automask*.ts`, `outputTransform.ts` untouched · `createMaskFromBase64` changed at `:2417` only · `queryClient.ts` untouched · no new dependencies · no flag · nothing PHI-bearing committed · both `dist/` files build · Node tooling runs in the macOS Terminal only.

**Stop and report, do not work around:** the identity test or the A/B fails; a bad shape misses its bound; the sandbox cost gate fails; the client change needs a second file.

## 7. Close-out

- **Commits, by explicit path.** Commit 1: `videoProcessor.ts` + `maskBuildIdentity.test.ts`. Commit 2: everything else, including the docs: `CLAUDE.md`, `docs/refactor/ITEM22_REPORT.md` (both already modified in the tree), `OUTPUT_ROUND2_{KICKOFF,RECON,SIGNOFF,REPORT}.md`, `UI_SIMPLIFICATION_NOTE.md`. Leave `.DS_Store`, `.idea/`, `scripts/sandbox/`, `scripts/automask_spike/dicoms.json` out.
- **`CLAUDE.md`:** status block "Output Round 2 BUILT (uncommitted — awaiting the runbook)"; backlog 27 DONE; queue item 3 closed by commit 1, with the corrected attribution (debug array, not offsets); `createTransformedMask` / `convertToRgbaBuffer` added to the dead-code item; the legacy route noted as guarded and still awaiting 7B-1; a re-apply on an already-`complete` job clears `isProcessing` at once (`template-mask-spoke.tsx:214-219`), noted as a known wart for the UI round.
- **Report:** `OUTPUT_ROUND2_REPORT.md` with every matrix row, the before/after timings, the A/B result, the exact diff of `:2417`, and the list of files touched. Then stop.

---
> Continuing Masquerade (bring `CLAUDE.md`). `OUTPUT_ROUND2_SIGNOFF.md`: recon approved, D1–D3 as the recon refined them, D4 (a), D5 guard the legacy route, D6 client change. Build **two commits, one deploy**. **Commit 1:** `videoProcessor.ts:2417` only, `if (i % sampleInterval === 0)`; prove the mask buffer is unchanged (`maskBuildIdentity.test.ts`, 4 masks × 2 sizes against a predicate-computed reference; a one-off old-vs-new A/B on a dpr-2 Keep export; `check.ts` 24 rows diff 0) and report the serial before/after. **Commit 2:** `countMaskedPixels` (public, calls `createMaskRgbaBuffer`, counts alpha > 0) + `server/services/applyGuard.ts` (`decideApply`, `checkApplyMask`), called from `applyTemplateMask` before anything is persisted **and** from the legacy `POST /api/videos/:jobId/process`; dims from raw frame 0 / image 0, else the job record; unresolvable or throwing → refuse `unverifiable`; `apply.validate` / `apply.refused` PERF lines; 422 with the three messages in §3.1. Client, `ProcessingControls.tsx` only: toast the body's `error`, and move `onStartProcessing` + the posthog capture into `onSuccess`. Manifest: wrappers build the ZIP entry names once and hand them to the core (`filenames`), run manifest gets `masquerade_version: '1.1'` and `images_included` (what was written), raw-input runs name `.png`. Matrix per §4, sandbox cost gate ≤ 100 ms serial on the 1080p Keep mask and the dpr-2 export. `tsc` 12, A3 frozen, masking arithmetic untouched apart from `:2417`, `queryClient.ts` untouched. Stop conditions in §6. Stop after `OUTPUT_ROUND2_REPORT.md` for the runbook.
