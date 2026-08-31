# Round 2B — fix the measured bottlenecks (apply + background extraction)

**Status:** proposed 2026-08-30. Based on `PERF_ROUND1_RESULTS.md` (prod numbers, job `467975f7`).
**Depends on:** Round 2A deployed (Apply gated on `status === 'ready'`) — 2B-1 relies on it.

## 0. The numbers driving this

| stage | today | cause |
|---|---|---|
| background extraction | 45.6 s (131 ms/frame) | 15-frame batch extractor: seek + spawn per batch |
| apply: re-extract | 19.5 s (56 ms/frame) | decodes the upload again although frames are on disk |
| apply: mask loop | 13.4 s (39 ms/frame) | sharp on **1** libvips thread; PNG encode dominates; mask ≈ 10 ms |
| **upload-complete → masked** | **~81 s** | |

Box: 2 vCPU, `sharp.concurrency() = 1`.

## 1. Changes, in order of payoff ÷ risk

### 2B-1 — Reuse `temp_extracted/` at apply time (kills the 19.5 s)   ← do this first, alone

`processVideo` currently: `prepareCleanApplyStaging` → `extractAllFramesSequential(upload → _apply/)`
→ read `_apply/` → mask. New:

```
const raw = await listRawFrameFiles(jobId)            // frameAccess.ts, already exists (sorted frame_%06d.png)
const expected = job.totalFrames                       // VideoJob / Job.source.totalFrames
if (job.status === 'ready' && raw.files.length === expected && raw.files.length > 0
    && every file passes isCompletePngBuffer on read):
    perfMark(jobId, 'apply.source', { mode: 'reuse', frames: raw.files.length })
    buffers = read raw.files                           // replaces apply.extract_all + apply.read_all
else:
    perfMark(jobId, 'apply.source', { mode: 'reextract', reason, have: raw.files.length, expected })
    <existing path, byte-for-byte: prepareCleanApplyStaging → extractAllFramesSequential → read _apply/>
```

- **Race is gone by construction.** Apply is only reachable at `ready`, and `ready` is written after
  the last batch. The `raw.files.length === expected` check is the belt-and-braces; the IEND check
  (from 2A) catches a torn file. Any doubt → fall through to the old path. The old path is not deleted.
- **Co-indexing gets stronger, not weaker.** Masked frame *i* is now derived from the exact
  `listRawFrameFiles()[i]` the AI raw-fallback and the run download already index by. The Phase-4b
  "three extraction paths / canvas frame ≠ applied frame" concern disappears: the user masks the
  frame they drew on.
- **DICOM:** background extraction writes DICOM frames to `temp_extracted/` too (per-frame loop), so
  the reuse branch covers DICOM automatically — and skips the 67× re-read/re-parse of the `.dcm` that
  Round 1 flagged, without touching `extractDicomFrame`. Still verify with the multiframe `.dcm`.
- **Image batch:** already `ready`, frames already in `temp_extracted/` — reuse applies unchanged.
- **Regression guard:** MP4 + single `.dcm` + multiframe `.dcm` apply + download; frame count equals
  `totalFrames`; masked frame 1 and frame N visually correct; AI run on the masked frames still works.
- **Expected:** apply 33 s → **~14 s** on this clip.

### 2B-2 — Unshackle sharp and cheapen PNG encode (mask loop 13.4 s → ~4–6 s)

Two lines plus one option object:

1. At boot (`index.ts`, once): `sharp.concurrency(os.cpus().length)` — takes libvips from 1 thread
   to 2 on this box, N on a bigger one. Log the value in `apply.env` (already there).
2. Output encode: `.png({ compressionLevel: 1, adaptiveFiltering: false })` on the masked-frame
   encode in `processFrameBatch` Step 4. PNG is lossless at every level — **pixels are identical**,
   files are ~15–25% larger, encode is ~2–3× faster. The AI spoke and the download ZIP see the same
   pixels. (If anything downstream compares PNG *bytes* rather than pixels, it will notice; nothing
   in the codebase does — the D1 gate compares manifests, not frame bytes. State this in the report.)
3. Optional, if decode shows up after 1–2: sharp `{ sequentialRead: true }` on the input.

Batch/stack sizes: **leave alone.** With concurrency 2 they still don't matter; revisit only on a
bigger instance.

**Expected (with 2B-1):** apply **~6–8 s**.

### 2B-3 — Background extraction: single ffmpeg pass into `temp_extracted/` (45 s → ~15–20 s)

The apply-time extractor already proves the single-pass number: 56 ms/frame vs 131. Replace the
15-frame `extractFrameBatch` loop in `startBackgroundFrameExtraction` with one ffmpeg invocation
writing `frame_%06d.png` straight into `temp_extracted/<jobId>/` (the same image2 muxer/naming the
apply path uses, so nothing downstream changes), plus `-compression_level 1` on the PNG encoder for
the same lossless speedup as 2B-2.

- **Progress:** parse ffmpeg's `frame=` stderr lines (fluent-ffmpeg exposes `.on('progress')`) or
  `readdir` every 500 ms; emit the same `progress` socket payload the batch loop emits today so
  Round 2A's Apply note and the hub panel keep working. `first_frame_on_disk` will get *earlier*.
- **Partial-file race:** already handled — the 2A frames endpoint checks IEND before serving.
- **`samplingFps`:** must be honored exactly as the batch path honors it (`-vf fps=` or `-r`);
  verify frame count parity on the same clip before/after (348 → 348).
- **DICOM branch:** untouched (its own loop). MP4 only.
- **Regression guard:** as 2B-1, plus: frame count parity, frame 1 byte-compare old vs new extractor
  on one clip (the seek-based batch extractor and a sequential decode can differ at GOP boundaries —
  if bytes differ, eyeball; if content differs, stop and report).
- **Expected:** upload-complete → ready **45 s → ~15–20 s**.

### 2B-4 — Instance size (operator decision, no code)

After 2B-1..3 the pipeline is still CPU-bound: ffmpeg decode/encode + sharp on 2 vCPUs. A 4-vCPU
compute-optimized instance (`c6i.xlarge` / `c7i.xlarge`) roughly halves everything above again, and
if the current box is a burstable `t3.*`, moving off it also removes CPU-credit throttling on
sustained work. Check the type first (`curl -s http://169.254.169.254/latest/meta-data/instance-type`)
and price it against how often you run this. Not needed for the testing period; worth it before
anyone else uses the site.

### Not in 2B
- ffmpeg-side masking (overlay filter). Superseded: the expensive step was decoding the video, not
  masking, and 2B-1 removes that decode entirely.
- Lower default `samplingFps` (43 fps → e.g. 15). Product question, not perf: fewer frames is linear
  savings everywhere but changes what the dataset *is*. Your call; the plumbing already exists.
- `maskWorker.ts` deletion (7 tsc errors) — still a separate tsc-baseline pass.

## 2. Predicted end state on this clip (348 frames, 1536×796, 2 vCPU)

| | today | after 2B-1 | after 2B-1+2 | after 2B-1+2+3 |
|---|---|---|---|---|
| upload-complete → ready | 45.6 s | 45.6 s | 45.6 s | ~15–20 s |
| Apply → masked | 33.3 s | ~14 s | ~6–8 s | ~6–8 s |
| **total** | **~81 s** | ~60 s | ~52 s | **~22–28 s** |

And with 2A the user is drawing at second 2 either way.

## 3. Sequencing and constraints

- **Three separate deploys, in order 2B-1 → 2B-2 → 2B-3**, each with the `[PERF]` numbers re-collected
  on the same clip so the table above gets real values. 2B-1 and 2B-2 are small and reversible; 2B-3
  touches the extractor and gets its own snapshot.
- tsc stays at 12 (same 12). A3 frozen — none of this touches storage/status/schema.
- Round 1 probes stay; add `apply.source`. Keep the naming invariant (`frame_%06d.png`, 1-indexed,
  positional index) — 2B-1 depends on it and 2B-3 must reproduce it.
- DICOM additive branch in `extractAllFramesSequential`: untouched (it becomes the fallback path).

## 4. Kickoff message for Claude Code (2B-1 + 2B-2 together; 2B-3 after those are verified)

> Continuing Masquerade (bring CLAUDE.md). Round 2A is deployed and verified; Round 1 perf numbers
> are in `docs/refactor/PERF_ROUND1_RESULTS.md` — apply re-extracts frames it already has (19.5 s of
> 33 s) and sharp runs on one thread. Implement **2B-1 and 2B-2** from
> `docs/refactor/ROUND2B_PROPOSAL.md`: (1) in `processVideo`, reuse `temp_extracted/<jobId>/` via
> `listRawFrameFiles` when `status === 'ready'` and the count equals `totalFrames` and every file
> passes `isCompletePngBuffer`, logging `[PERF] apply.source {mode}`; otherwise fall through to the
> existing re-extract path unchanged. (2) `sharp.concurrency(os.cpus().length)` at boot and
> `.png({ compressionLevel: 1, adaptiveFiltering: false })` on the masked-frame encode. No change to
> `extractAllFramesSequential`, the DICOM branch, batch/stack sizes, or storage. tsc stays at the
> same 12. Regression guard: MP4 + single + multiframe DICOM apply and download, frame counts equal
> `totalFrames`, AI run on masked frames works. Output `docs/refactor/ROUND2B_REPORT.md` and stop
> before deploying.
