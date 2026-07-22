# DICOM Template-Mask Regression — Diagnosis + Proposed Fix (NO CODE this round)

**Deliverable for:** `DICOM_REGRESSION_KICKOFF.md` (Phase 7 hotfix).
**Scope:** diagnosis proven against current source **and** git history; a proposed minimal fix.
**No production code changed this round.** Implementation is gated on operator sign-off.

---

## 0. TL;DR (root cause up front, but read §3 for the honest caveat)

- **The failing path is proven from source.** Template-mask apply on a DICOM calls
  `processVideo(jobId, job.filePath, …)` with `job.filePath = uploads/<hash>` (the raw
  multer-staged DICOM), which calls **`extractAllFramesSequential(videoPath, …)`** — a method that
  invokes **`ffmpeg(videoPath)` unconditionally, with no DICOM branch**. ffmpeg cannot demux a DICOM
  container → `code 183: Invalid data found`.
- **The regressing change is a single commit: `280cb38`** ("feat: native frame extraction with
  user-controlled sampling rate", 2026-04-28). It replaced the **DICOM-aware** per-batch extractor
  (`extractFrameBatch` → `isDicomFile()` → `extractDicomFrame`) in the apply path with the
  **DICOM-blind** single-pass `extractAllFramesSequential`, and never carried the `isDicomFile()`
  interception into the new method.
- **Honest correction to the kickoff's window hypothesis:** the break is **NOT** in the
  hub-and-spoke refactor (Phases 3–4) or the Postgres cutover (Phase 5). `280cb38` **predates
  Phase 2** (2026-05-08). I diffed the apply path across Phase 4-tip → HEAD and the DICOM-relevant
  extraction is **unchanged** — the bug was already live at the Phase 4 tip. See §3 for how this
  reconciles with "worked in Phases 2–4."
- **Fix:** restore the DICOM interception in the apply extraction path (two options in §4).
  Video (MP4) path untouched; `tsc` stays at 12; A3 layer untouched.

**SHAs compared:** working reference `280cb38~1` (`cd01bd5`-era, pre-rewrite) vs. the rewrite
`280cb38`; plus Phase-2 `710020e`, Phase-4-tip `44cdb83`, and HEAD `ff1713a`.

---

## 1. End-to-end trace in CURRENT source (HEAD `ff1713a`)

### 1a. Upload — DICOM detected, raw path stored, background extraction fired (this part WORKS)
`server/routes.ts` (`videoUploadHandler`):
- `routes.ts:152` — `const isDicom = await frameExtractor.isDicomFile(req.file.path);`
- `routes.ts:154` — `if (isDicom) { … }` enters the "optimized DICOM workflow".
- `routes.ts:166` — `filePath: req.file.path` → **the job's `filePath` is the raw `uploads/<hash>`
  DICOM** (no conversion, no pixel-extracted substitute).
- `routes.ts:196` — `type: 'video'` in `createJobV2(...)` — a DICOM is registered as a `video`
  facet; there is **no `jobType: 'dicom'`** anywhere (the only special `jobType` is `'images'`).
- `routes.ts:222-223` — `setImmediate(() => videoProcessor.startBackgroundFrameExtraction(job.id,
  dicomFilePath, quickMetadata.totalFrames))`.

`startBackgroundFrameExtraction` (`videoProcessor.ts:1097`) is the DICOM-**aware** extractor:
- `videoProcessor.ts:1141` — `const batchFrames = await this.frameExtractor.extractFrameBatch(videoPath, batch.start, batch.end);`
- `extractFrameBatch` (`frameExtractor.ts:830`) **has the DICOM guard**:
  `frameExtractor.ts:836` `const isDicom = await this.isDicomFile(videoPath);` →
  `:838 if (isDicom)` → `:845 extractDicomFrame(...)` (pixel extraction, **never** ffmpeg on the raw
  DICOM).
- Frames are written to `temp_extracted/<jobId>/frame_%06d.png` (`videoProcessor.ts:1155`,
  `rawFramesDir(jobId)`). **So after upload, correct DICOM frames already exist on disk.**

### 1b. Trigger — template-mask apply (this part FAILS)
- Canonical route: `routes.ts:1611` — `app.post("/api/jobs/:jobId/template-mask/apply", …)` →
  `routes.ts:1614` `await applyTemplateMask(...)`.
- `server/handlers/templateMaskApply.ts:31` `applyTemplateMask(...)`:
  - `:48` `const job = await storage.getVideoJob(jobId);`
  - `:76` `if (job.jobType === 'images') { … processImages … }`
  - `:85-88` **`else` → `videoProcessor.processVideo(jobId, job.filePath, maskData, outputSettings,
    samplingFps)`**. DICOM has no `jobType`, so it takes this `else` branch. **`videoPath =
    job.filePath = uploads/<hash>` (raw DICOM).**

### 1c. Extraction — the DICOM-blind method that throws
`processVideo` (`videoProcessor.ts:281`):
- `:312` `const metadata = await this.frameExtractor.extractVideoMetadata(videoPath);`
- `:328` `await prepareCleanApplyStaging(jobId);` (clears the `_apply` staging subdir)
- `:329-336` **`const extractedPaths = await this.frameExtractor.extractAllFramesSequential(
  videoPath, extractedFramesDir, metadata.duration, path.basename(videoPath), samplingFps,
  metadata.frameRate);`**

`extractAllFramesSequential` (`frameExtractor.ts:186`) — **no DICOM branch anywhere in the method**:
```ts
// frameExtractor.ts:215-222
await new Promise<void>((resolve, reject) => {
  ffmpeg(videoPath)                       // ← raw uploads/<hash> DICOM handed straight to ffmpeg
    .outputOptions(outputOpts)
    .output(outputPattern)
    .on('end', () => resolve())
    .on('error', (err) => reject(new Error(`Sequential frame extraction failed: ${err.message}`)))
    .run();
});
```
`ffmpeg` cannot demux DICOM → **`ffmpeg exited with code 183: … Invalid data found when processing
input`**, wrapped as **`Sequential frame extraction failed:`** — the exact operator-reported error.
Control never reaches the downstream buffer pipeline (`processFrameBuffersInParallel`,
`videoProcessor.ts:379`).

### 1d. Why the already-extracted disk frames don't save it
`processVideo` **re-extracts** from `job.filePath` at apply time into an isolated `_apply` staging
dir (`videoProcessor.ts:288-296, 329`) and **does not read** the correct DICOM frames that
`startBackgroundFrameExtraction` already wrote to `temp_extracted/<jobId>/`. The re-extraction is
DICOM-blind, so it dies before the disk frames are ever consulted.

**Detection is fine; routing/method is the fault.** `isDicomFile()` still returns true (it's used at
`routes.ts:152` and `frameExtractor.ts:836` on the same raw path). This is the kickoff's **candidate
#2 (routing/branch)**, precisely: the apply path was switched to a method that lacks the DICOM
branch. It is **not** #1 (detection) and **not** #3 (wrong input path — `job.filePath` is the same
raw DICOM the working code also received).

---

## 2. The SAME path in the pre-regression source, and the diff that is the root cause

### 2a. Working reference: `280cb38~1` (before the rewrite, 2026-04-28)
`processVideo` extracted **per-batch through the DICOM-aware `extractFrameBatch`**:
```ts
// videoProcessor.ts @ 280cb38~1  (processVideo body)
const metadata = await this.frameExtractor.extractVideoMetadata(videoPath);   // DICOM-aware metadata
…
const batches = this.createFrameBatches(metadata.totalFrames, batchSize);
const processedFrames = await this.processBatchesInParallel(jobId, videoPath, batches, …);
```
```ts
// videoProcessor.ts @ 280cb38~1  (processBatchesInParallel, per batch)
const frameBuffers = await this.frameExtractor.extractFrameBatch(videoPath, batch.start, batch.end);
```
`extractFrameBatch` already had (and still has) the DICOM guard → `extractDicomFrame` pixel
extraction. **No ffmpeg is ever run on a raw DICOM.** DICOM apply worked because the extractor it
routed through was DICOM-aware.

### 2b. The regressing commit: `280cb38` ("native frame extraction …")
The rewrite swapped the per-batch DICOM-aware extractor for a single upfront **DICOM-blind** pass.
From `git show 280cb38 -- server/services/videoProcessor.ts`:
```diff
-      // Create frame batches
-      const batches = this.createFrameBatches(metadata.totalFrames, batchSize);
+      // ── SINGLE-PASS SEQUENTIAL FRAME EXTRACTION ────────────────────
+      // … We now extract ALL frames in one ffmpeg pass … ffmpeg is invoked exactly once.
+      const extractedFramesDir = path.join(process.cwd(), 'temp_extracted', jobId);
+      const extractedPaths = await this.frameExtractor.extractAllFramesSequential(
+        videoPath, extractedFramesDir, … );
+      const extractedBuffers: Buffer[] = await Promise.all(extractedPaths.map(p => fs.readFile(p)));
…
-      // Process batches in parallel
-      const processedFrames = await this.processBatchesInParallel(jobId, videoPath, batches, …);
+      // Process batches in parallel — each batch gets a SLICE of the already
+      // extracted frame buffers, so ffmpeg is never re-invoked here.
+      const processedFrames = await this.processFrameBuffersInParallel(jobId, extractedBuffers, batches, …);
```
**Concrete before/after (the root cause):**

| | Extraction call in `processVideo` | DICOM handling |
|---|---|---|
| **`280cb38~1` (works)** | `processBatchesInParallel` → `extractFrameBatch(videoPath, …)` | `isDicomFile()` → `extractDicomFrame` (pixel path) |
| **`280cb38` → HEAD (broken)** | `extractAllFramesSequential(videoPath, …)` | **none** — `ffmpeg(videoPath)` unconditionally |

`extractAllFramesSequential` itself was **born without** a DICOM branch (verified at `280cb38`:
`frameExtractor.ts:186` method, `:216` `ffmpeg(videoPath)`, no `isDicom` between them) and has never
gained one. `extractFrameBatch` kept its guard, but the apply path stopped calling it.

### 2c. Nothing after `280cb38` restored it (git-proven)
- `git log -S 'extractAllFramesSequential' -- server/services/videoProcessor.ts` →
  only `280cb38` (introduced) and the **Phase 4b-0** commits `7bb7f8f` / `7ad2e77` (revert) /
  `b734e6d` (re-entrancy: `_apply` staging). None added a DICOM branch or a reuse-from-disk path.
- `git diff 44cdb83 ff1713a -- server/services/videoProcessor.ts` → the only changes to this region
  are a folder-manager **rename** (`tempFolderManager` → `templateMaskFolderManager`), comment
  edits (`temp_processed` → `spokes/template_mask`), and socket **room-scoping**
  (`io.emit` → `io.to(jobId).emit`). **The extraction call is byte-for-byte unchanged.**
- Phase-4-tip `44cdb83` upload+apply is identical in the ways that matter: `routes.ts@44cdb83:167`
  `filePath: req.file.path` (raw DICOM), `:197` `type: 'video'`, `:224`
  `startBackgroundFrameExtraction`, `:499 if (job.jobType === 'images')` else `:523 processVideo(…)`.
  → **DICOM apply at the Phase 4 tip fails with the identical ffmpeg error.**

---

## 3. Root cause statement + does it explain every confirmed fact?

**Root cause:** In the template-mask **apply** path, `processVideo` extracts frames via
`extractAllFramesSequential` (`frameExtractor.ts:186`), which hands `job.filePath` (the raw
`uploads/<hash>` DICOM) straight to `ffmpeg` with **no `isDicomFile()` interception**. Commit
**`280cb38`** introduced this method and rewired `processVideo` to it, dropping the DICOM-aware
`extractFrameBatch` → `extractDicomFrame` route that the apply path previously used. The DICOM
pixel-extraction branch therefore never fires on apply, and ffmpeg fails to demux the DICOM
container (`code 183`, "Invalid data found").

Checking against the operator's ground-truth facts:

1. **ffmpeg receives the raw `uploads/<hash>`** — ✔ `applyTemplateMask` passes `job.filePath`
   (`templateMaskApply.ts:87`), and `extractAllFramesSequential` passes it verbatim to
   `ffmpeg(videoPath)` (`frameExtractor.ts:216`).
2. **DICOM-specific; MP4 works** — ✔ MP4 is a container ffmpeg demuxes; the DICOM-blind method is
   fine for MP4 and only fails on the DICOM container. Same method, different input.
3. **Single-frame and multiframe `.dcm` fail identically** — ✔ the failure is at ffmpeg's
   *open-input/demux* step, **before** any frame-count logic. Frame count is irrelevant because the
   DICOM branch that would read `NumberOfFrames` (`extractDicomFrame` / `getDicomFrameCount`) is
   never reached. Both `.dcm` files are just "invalid data" to ffmpeg.
4. **Regressed from a known-good** — ✔ pre-`280cb38` routed apply through
   `extractFrameBatch`→`extractDicomFrame`.

### The one fact that does NOT cleanly fit — flagged honestly (per kickoff §38, §63)
The kickoff states DICOM "worked **end-to-end** in Phases 2–4" and names the refactor (3–4) /
Postgres cutover (5) as the likely window. **The source disagrees:** `280cb38` is **2026-04-28**,
which is **before Phase 2** (`710020e`, 2026-05-08), and the apply-path extraction is unchanged from
Phase-2 through HEAD. So the regression **cannot** have been introduced by Phases 3–5. The most
likely reconciliations (operator can confirm which):

- **(a) Phase attribution is imprecise, and what "worked" was the DICOM *upload/preview* flow.** The
  DICOM-aware code that genuinely works — and worked throughout Phases 2–4 — is the **upload** path:
  detect (`isDicomFile`) → `extractFirstFrame` first-frame preview → `startBackgroundFrameExtraction`
  → `extractFrameBatch` → `extractDicomFrame` → frames on disk + the frame viewer. If the operator's
  "it worked" memory is the upload → first-frame → draw-mask → *view frames* loop, that is all still
  DICOM-aware and would have looked end-to-end. The **apply → extract-all → download** step is the
  only DICOM-blind hop, and it has been broken since `280cb38`.
- **(b) The last actually-working DICOM *apply* build predates `280cb38`** (i.e. the true known-good
  is the pre-2026-04-28 line, not Phase 4).

Either way, the mechanical root cause and its fix are unchanged. I am **not** asserting a
refactor-era cause I could not find in the diff; the binding Phase-4 lesson (a confidently-stated
`storage.ts:129` diagnosis that tracing proved false) is exactly why this section refuses to
back-fit the bug onto Phases 3–5.

**Runtime evidence that would fully close the (a)/(b) gap — see §6.**

---

## 4. Proposed minimal fix (gated on sign-off — NO code written this round)

Goal per kickoff: **restore the DICOM interception that regressed; do not redesign.** Two viable
options; **Option B is recommended** (smallest blast radius, most faithful to the pre-`280cb38`
behavior).

### Option B (recommended) — give `extractAllFramesSequential` the DICOM branch it never had
Mirror the guard that `extractFrameBatch` already carries (`frameExtractor.ts:836-858`). At the top
of `extractAllFramesSequential` (`frameExtractor.ts:186`, before the ffmpeg block at `:215`):
- `if (await this.isDicomFile(videoPath))` → extract frames via the **existing** DICOM pixel path
  (loop `extractDicomFrame(videoPath, i)` for `i` in `0..totalFrames-1`, exactly as
  `extractFrameBatch` does), write each buffer to `outputDir/frame_%06d.png` (1-indexed, matching
  the ffmpeg naming the readback at `:224-229` expects), then `return` the created paths.
- `else` → the current `ffmpeg(videoPath)` block, **unchanged**.

- **Files/lines:** `server/services/frameExtractor.ts` — one new branch at the head of
  `extractAllFramesSequential` (~`:207-214`). No other file changes. `processVideo` untouched;
  the downstream buffer pipeline is unchanged because the branch produces the same
  `frame_%06d.png` set + returned paths.
- **Why it addresses the proven root cause:** it re-inserts the `isDicomFile()` interception into
  the exact method that lost it in `280cb38`, so DICOM apply once again uses `extractDicomFrame`
  pixel extraction instead of ffmpeg.
- **Sampling note:** the DICOM branch extracts every frame (as `extractFrameBatch`/the pre-`280cb38`
  path did) and ignores `samplingFps` — DICOM frame-sampling never mapped to an ffmpeg `fps` filter,
  and matching the prior behavior keeps scope minimal. Call this out for the operator; DICOM
  down-sampling, if ever wanted, is a separate feature, not part of this hotfix.

### Option A (alternative) — reuse the frames already on disk
For DICOM, `startBackgroundFrameExtraction` already wrote correct frames to
`temp_extracted/<jobId>/` (`rawFramesDir`, `applyPaths.ts:58`; readable via `listRawFrameFiles`,
`frameAccess.ts:160`). `processVideo` could, when `isDicomFile(job.filePath)` is true, **skip**
`extractAllFramesSequential` and load buffers from those files instead.
- **Smaller CPU** (no double extraction) but **larger blast radius / more risk:** introduces a
  completion-timing dependency (background extraction must have finished before apply — not currently
  guaranteed), needs a fallback when the dir was swept, and edits `processVideo` (the apply
  orchestrator) rather than the leaf extractor. **Not recommended for a hotfix.** Listed for
  completeness / future de-duplication.

### Blast radius on the working **video** path — confirmed nil
- Option B: MP4/MOV/AVI are not DICOM, so `isDicomFile()` is false and they take the **unchanged**
  `else` ffmpeg block. The video branch is not edited. MP4 apply is byte-for-byte identical.
- The change is additive (a new `if` above existing code); deleting the branch reverts exactly.

### `tsc` — stays at **12** (with a required flag)
- **⚠️ Overlap flag (kickoff §46):** the DICOM pixel path this fix routes into —
  `extractDicomFrame` (`frameExtractor.ts:273`) — **contains the 5 deferred `pixelBuffer`
  possibly-undefined errors** (`:326, :365, :378, :402, :408`). The fix **calls** that method (which
  already compiles today with those 5 errors) but **must not modify** those lines. So it introduces
  **no new** narrowings and clears **none** → the count stays exactly **12**. Do **not** pull the
  deferred `pixelBuffer` pass into this hotfix. If, during implementation, the DICOM branch cannot be
  written without touching `:326-408`, **stop and flag it** rather than silently expanding scope.
- New code (an `if`, a `for` loop over `extractDicomFrame`, `fs.writeFile`) uses already-typed APIs
  and adds no fresh strict-null sites.

### A3 storage/schema/status/shim/migrations — untouched
This is purely an extraction-path fix in `frameExtractor.ts`. No `shared/schema.ts`,
`server/storage.ts`, `pgStorage.ts`, `migrations/`, or `conformance-storage.ts` change. `job.filePath`
and `jobType` semantics are unchanged. **The diagnosis does not require any storage change** — the
frozen layer stays frozen.

---

## 5. Post-fix smoke test (specify; run at deploy)
1. **Single-frame `.dcm`** → upload (first-frame preview appears) → draw template mask → apply →
   frames extract with **no** "Sequential frame extraction failed" → mask applies → download ZIP
   opens with masked frames + `manifest.json`/`metadata.csv`.
2. **Multiframe `.dcm`** → same, and confirm the frame count equals `NumberOfFrames` (exercises
   `extractDicomFrame`'s multi-frame offset path, not just the first-frame fallback).
3. **Regular MP4 (regression guard)** → upload → apply → download still works unchanged (proves the
   video `else` branch is intact).
4. **Transfer-syntax sensitivity (important):** the `extractDicomFrame` pixel handling is fragile
   (the 5 deferred `pixelBuffer` sites + multiple raw-access fallbacks at `:396-410`). Test at least
   an **uncompressed little-endian** DICOM (baseline) **and** note behavior on a **compressed**
   transfer syntax (e.g. JPEG/JPEG2000-encapsulated) — encapsulated pixel data may hit the
   `extractDicomImage` fallback (`:426, :439`) rather than true per-frame extraction. Capture which
   path each test file takes from the `✅/⚠️` console logs.

---

## 6. Runtime evidence still worth capturing
The static trace fully explains the *mechanical* failure, so none is needed to justify the fix. Two
cheap checks would (a) close the phase-attribution gap and (b) de-risk Option A if it's ever chosen:
- **One log line at the top of `processVideo`:** `console.log('[dicom-check]', videoPath, await
  this.frameExtractor.isDicomFile(videoPath))` on the failing upload — expected `true`, confirming
  the raw DICOM reaches the DICOM-blind extractor.
- **`ls temp_extracted/<jobId>/` at apply time** — if it already holds `frame_*.png`, that both
  confirms the upload-time DICOM extraction succeeded (supporting reconciliation (a) in §3) and
  proves Option A is feasible.
- **Operator confirmation** of which build/date DICOM apply→download last succeeded — distinguishes
  §3(a) vs §3(b). This is a memory/observation question, not a source question.

---

## Appendix — commands used (reproducible)
- `git log --oneline -S 'extractAllFramesSequential' -- server/services/videoProcessor.ts`
- `git show 280cb38~1:server/services/videoProcessor.ts` (working reference)
- `git show 280cb38 -- server/services/videoProcessor.ts` (the regressing diff)
- `git diff 44cdb83 ff1713a -- server/services/videoProcessor.ts` (Phase-4-tip → HEAD: unchanged)
- `git show 44cdb83:server/routes.ts` (Phase-4-tip DICOM upload/apply)
- Commit dates: `280cb38` 2026-04-28 · `710020e` (Phase 2) 2026-05-08 · `44cdb83` (Phase 4d-1)
  2026-06-20 · `ff1713a` (HEAD, Phase 7A) 2026-07-22.
