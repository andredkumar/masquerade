# DICOM Template-Mask Regression — Fix Report (Option B implemented)

**Deliverable for:** `DICOM_REGRESSION_FIX_AMENDMENT.md` (Option B ratified).
**Diagnosis:** `docs/refactor/DICOM_REGRESSION_DIAGNOSIS.md` (accepted; root cause `280cb38`).
**Status:** implemented (code) — not yet deployed/verified on a running server. Smoke test owed at deploy.

---

## 1. TL;DR

Restored the DICOM interception the apply-path extractor lost at `280cb38`. Added a **single,
purely-additive `if (await this.isDicomFile(videoPath))` branch** at the top of
`extractAllFramesSequential` (`server/services/frameExtractor.ts`). DICOM now routes through the
existing pixel-extraction path (`extractDicomFrame`) — the same one `extractFrameBatch` already
uses — instead of being handed raw to `ffmpeg`. The `else` (ffmpeg / MP4) path is byte-for-byte
unchanged. `tsc` stays at exactly **12**. No A3 / storage change.

---

## 2. The exact change (file:lines)

**One file touched: `server/services/frameExtractor.ts`.** The branch was inserted immediately
after the method signature of `extractAllFramesSequential` (was `:186`), before the first
pre-existing statement (`const effectiveFps = …`).

Added block (now `frameExtractor.ts:193-218`):

```ts
// 🎞️ DICOM interception (restored — see docs/refactor/DICOM_REGRESSION_FIX_REPORT.md).
// ffmpeg cannot demux a DICOM container ("Invalid data found"), so route DICOM through
// the pixel-extraction path (extractDicomFrame) exactly as extractFrameBatch already
// does. Purely additive: MP4/regular video is not DICOM → falls through to the unchanged
// ffmpeg block below. Uncompressed DICOM only; samplingFps is intentionally ignored here
// (every frame is extracted), matching the pre-280cb38 behavior.
if (await this.isDicomFile(videoPath)) {
  const { totalFrames } = await this.extractVideoMetadata(videoPath);
  console.log('[dicom-extract]', path.basename(videoPath), 'frames:', totalFrames);
  await fs.mkdir(outputDir, { recursive: true });

  const dicomPaths: string[] = [];
  for (let i = 0; i < totalFrames; i++) {
    const frameBuffer = await this.extractDicomFrame(videoPath, i);
    // Match ffmpeg's image2 muxer naming: frame_%06d.png, 1-indexed (start_number=1),
    // so the sorted readback below (:224-229) and all downstream consumers are identical
    // to the video path. DICOM frameIndex i is 0-based → on-disk file number i + 1.
    const framePath = path.join(outputDir, `frame_${String(i + 1).padStart(6, '0')}.png`);
    await fs.writeFile(framePath, frameBuffer);
    dicomPaths.push(framePath);
  }

  console.log(`🎬 Extracted ${dicomPaths.length} DICOM frames into ${outputDir}`);
  return dicomPaths;
}
```

Nothing else in the method changed. **Deleting this `if` block reverts the fix exactly.**

**Reuse, not reinvention** — every callee already existed and is DICOM-aware:
- `isDicomFile` (`:149`) — DICM magic bytes @ offset 128, `.dcm`/`.dicom` fallback.
- `extractVideoMetadata` (`:40`) — DICOM branch (`:44`) returns `totalFrames` via
  `detectDicomFrameCount` (`NumberOfFrames`, else pixel-data-size estimate, else 1). Single-frame
  ⇒ `totalFrames = 1` ⇒ the loop runs once (`i = 0`).
- `extractDicomFrame` (`:299`, was `:273`) — the pixel path, **unchanged** (see §4).

This mirrors the guard `extractFrameBatch` carries at `:838-858` (loop `extractDicomFrame(videoPath,
frameIndex)`), differing only in output sink: `extractFrameBatch` returns `Buffer[]` in memory;
`extractAllFramesSequential` writes PNGs to `outputDir` and returns their paths (its contract).

---

## 3. Frame naming / indexing match against the readback (the critical correctness point)

The method's contract is a sorted list of `outputDir/frame_%06d.png` paths, produced by the
readback at (now) `frameExtractor.ts:249-254`:

```ts
const all = await fs.readdir(outputDir);
const created = all
  .filter(f => /^frame_\d+\.png$/.test(f))
  .sort()
  .map(f => path.join(outputDir, f));
```

The ffmpeg `else` branch writes `frame_%06d.png` via the image2 muxer, whose `start_number`
defaults to **1** → `frame_000001.png, frame_000002.png, …`.

The DICOM branch matches this **exactly**:
- **1-indexed on disk:** DICOM `frameIndex i` is 0-based (`extractDicomFrame` treats frame 0 as the
  first frame); the file is written as `frame_${String(i + 1).padStart(6, '0')}.png`. So `i = 0`
  → `frame_000001.png`, identical to ffmpeg's first output.
- **6-digit zero-pad:** `padStart(6, '0')` == `%06d`, so lexicographic `.sort()` equals numeric
  order (no `frame_10` sorting before `frame_2` hazard).
- **Same regex, same directory:** files match `/^frame_\d+\.png$/` and live in `outputDir`, so the
  shared readback treats DICOM and MP4 output identically. No downstream consumer can tell which
  branch produced the frames.

Because both branches funnel through the same naming convention, the DICOM branch `return`s its own
path list directly (the readback is only reached by the ffmpeg branch) — but the **on-disk artifact
is identical** to what the readback would have produced, so nothing downstream diverges.

---

## 4. Hard-constraint confirmations

### 4a. MP4 / video path untouched (regression guard)
An MP4 is not DICOM → `isDicomFile()` returns false → the new `if` is skipped and execution reaches
the **original** code with zero changes: `effectiveFps`, the fps logging, `mkdir`, `outputOpts`, the
`ffmpeg(videoPath)` promise, and the readback are all byte-for-byte as before. Confirmed by
inspection: the edit only *prepended* a self-contained early-return block; it deleted/edited no line
of the ffmpeg path. MP4 apply is therefore identical.

### 4b. `extractDicomFrame` and the 5 deferred `pixelBuffer` lines untouched — tsc stays 12
The fix **calls** `extractDicomFrame` but does **not** edit it, and does not touch the deferred
`pixelBuffer` narrowing sites. `npx tsc --noEmit` = **12 before and 12 after**, same error set:
- Before: `frameExtractor.ts` pixelBuffer errors at `326, 365, 378, 402, 408`; `maskWorker.ts` at
  `164, 174, 185, 186(×2), 207, 209`.
- After: the 5 `frameExtractor.ts` errors moved to `352, 391, 404, 428, 434` — a pure line-number
  shift (+26 lines inserted above them); **the code at those sites is unchanged**. The 7
  `maskWorker.ts` errors are byte-identical (unaffected file). No error added, none cleared.

Option B was writable without touching `:326-408`, so no STOP/flag was needed.

### 4c. No new transfer-syntax support
No JPEG / JPEG2000 / RLE decode logic added or modified. The branch only calls the existing
`extractDicomFrame`, whose uncompressed (Explicit VR LE, `1.2.840.10008.1.2.1`) raw-pixel-buffer
handling is exactly the confirmed test file's path. Any encapsulated-syntax handling already latent
in `extractDicomFrame` was neither added nor altered.

### 4d. No DICOM down-sampling — `samplingFps` intentionally ignored
The DICOM branch runs before `effectiveFps`/`samplingFps` are consulted and extracts **all**
`totalFrames` frames, matching the pre-`280cb38` behavior (which never mapped `samplingFps` onto
DICOM). `samplingFps` still governs the MP4 path unchanged (`-vf fps=<n>`). Adding DICOM sampling is
a separate future feature, out of scope here.

### 4e. A3 layer FROZEN
No change to `shared/schema.ts`, `server/storage.ts`, the `PgStorage` shim, `migrations/`, or
`scripts/conformance-storage.ts`. This is a leaf-extractor fix; `job.filePath` / `jobType` semantics
are untouched. The DICOM job still carries `type: 'video'`, `filePath = uploads/<hash>` — the branch
just handles that raw path correctly now.

### 4f. No other cleanup
No 7B items, backlog items, or adjacent code touched. Single-branch hotfix only.

---

## 5. Diagnostic log
Included the one-line `console.log('[dicom-extract]', path.basename(videoPath), 'frames:',
totalFrames)` at the top of the branch (per amendment §"Optional diagnostic log"), plus the existing
`✅`/`⚠️` logs inside `extractDicomFrame` fire per frame. This confirms the DICOM path fired and aids
the smoke test. Remove with the branch.

---

## 6. Files changed this session

Code:
- `server/services/frameExtractor.ts` — added the additive DICOM branch at the head of
  `extractAllFramesSequential`. **Only file changed.**

Docs:
- `docs/refactor/DICOM_REGRESSION_FIX_REPORT.md` — this report.

No A3 / frozen-layer file touched. No 7A/7B artifact touched.

---

## 7. Smoke test (operator runs on deploy)

Pre/post note: this was an agent-environment code change — **nothing below was exercised on a running
server**. All owed at deploy.

1. **Confirmed test file `testdicom.dcm` (uncompressed, Explicit VR LE `1.2.840.10008.1.2.1`)** →
   upload (first-frame preview appears) → draw template mask → apply → **frames extract with NO
   "Sequential frame extraction failed"** → mask applies → download ZIP opens with masked frames +
   `manifest.json` + `metadata.csv`. Capture the `[dicom-extract]` + `✅` console lines proving the
   DICOM path fired. Note whether this file is single- or multi-frame.
2. **Multiframe uncompressed `.dcm`** (if available) → same, and confirm the extracted frame count
   equals the DICOM's `NumberOfFrames`. (If `testdicom.dcm` is single-frame, this covers the
   multi-frame loop; `totalFrames = 1` already covers single-frame via step 1.)
3. **Regular MP4 (REQUIRED regression guard)** → upload → apply → download still works unchanged.
   Proves the `else` ffmpeg branch is intact.

**Known boundary (do NOT fix here):** a *compressed* DICOM (JPEG / JPEG2000 / RLE transfer syntax)
is **unverified** by this hotfix. If the operator later uploads one, behavior depends on whatever
`extractDicomFrame` already does with encapsulated pixel data (unchanged by this fix) — treat any
issue there as a separate, scoped item, not a regression of this fix.

---

## 8. Boundary / residual notes

- **Frame count source:** the loop bound comes from `extractVideoMetadata` →
  `detectDicomFrameCount`. For an uncompressed multi-frame DICOM this is `NumberOfFrames` (exact) or
  a pixel-data-size estimate; single-frame ⇒ 1. If a pathological file misreports `NumberOfFrames`,
  `extractDicomFrame` already self-guards (`frameIndex >= totalFrames` → clamps; extraction failure
  → falls back to `extractDicomImage`). No new failure mode introduced by the branch itself.
- **Performance:** DICOM extraction is per-frame synchronous (`await` in a loop), matching
  `extractFrameBatch`'s existing behavior — acceptable for the solo testing period; not a
  parallelism change.
- **Reversibility:** delete the `if` block (frameExtractor.ts:193-218) to restore the exact
  pre-fix method.
