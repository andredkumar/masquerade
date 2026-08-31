# Round 2B report — 2B-1 (reuse `temp_extracted/`) + 2B-2 (unshackle sharp)

**Spec:** `docs/refactor/ROUND2B_PROPOSAL.md` §4 kickoff (2B-1 + 2B-2 together; 2B-3 after these verify)
**Numbers:** `docs/refactor/PERF_ROUND1_RESULTS.md` (prod job `467975f7`)
**Landed:** 2026-08-30. **NOT deployed.**

**Gates:** `tsc` = **12**, same 12 · `npm run build` clean · `frameAccess.test.ts` **8/8** ·
A3 diff empty. Only two files changed: `server/services/videoProcessor.ts` (+134/−43) and
`server/index.ts` (+15).

**Headline:** 2B-1 landed as specced, with one guard added that the proposal missed. **2B-2 landed
half:** the `sharp.concurrency` change is in; **the PNG encode change is NOT, because the code it
describes does not exist** — the masked-frame encoder is JPEG, not PNG. Measured numbers and the
decision are in §3. That is the one thing in here needing your call.

---

## 1. 2B-1 — reuse `temp_extracted/` at apply time

`processVideo` now asks `tryReuseRawFrames(jobId, samplingFps)`
([videoProcessor.ts:587](server/services/videoProcessor.ts:587)) before deciding how to source frames
([:350](server/services/videoProcessor.ts:350)). On success it masks the buffers already on disk; on
any doubt it returns `null` and the **existing re-extract path runs byte-for-byte unchanged** —
`prepareCleanApplyStaging` → `extractAllFramesSequential` → read `_apply/`. Nothing was deleted.

### Guards, in the order they can fail

| # | Guard | Rejection `reason` | Why |
|---|---|---|---|
| 1 | `samplingFps == null` | `sampling_fps` | **Not in the proposal — added.** See below. |
| 2 | `jobV2.status === 'ready'` | `status_not_ready` | Extraction finished |
| 3 | `files.length > 0` and `=== source.totalFrames` | `no_raw_frames` / `unknown_expected` / `count_mismatch` | Never mask a short or swept set |
| 4 | every buffer passes `isCompletePngBuffer` | `torn_png` (+ index and filename) | Round 2A's IEND guard |

Plus `no_job_v2` and `error` — the whole helper is wrapped, because reuse is an optimization and must
never be the reason an apply *fails*.

### The guard the proposal missed

**`samplingFps` must force re-extraction.** Background extraction always runs at the native rate
(`extractFrameBatch`, no fps filter). The proposal's pseudo-code checks status, count and IEND but
not the sampling rate — so an apply with `samplingFps: 15` on a 43 fps clip would have silently
masked all 348 native frames instead of the ~120 the user asked for. Wrong frame set, no error, and
`totalFrames` would then be overwritten with the wrong number. Today the UI always sends `null`
(`template-mask-spoke.tsx` passes `samplingFps={null}`), so this is latent rather than live — but the
API accepts the field and the cost of the guard is one condition.

### Status source: V2, not the legacy `VideoJob`

The proposal says `job.status === 'ready'` without saying which record. I used **`jobV2.status`**,
because `mapVideoJobStatusToJobStatus` folds `ready`/`masking`/`processing`/`completed` into `ready` —
so a **redo apply** on a job the first apply left `completed` still qualifies. Reading the legacy
`VideoJob.status` would have failed guard 2 on every redo, which is precisely the case the 2B test
matrix re-runs (case B, "Apply twice").

### Known non-reuse case, by design

The first apply overwrites `totalFrames` with its own extracted count
([:404](server/services/videoProcessor.ts:404)). If ffmpeg's single pass and the batch extractor
disagree on the count for a clip, every *subsequent* apply then fails guard 3 (`count_mismatch`) and
re-extracts. Correct, just not optimized, and visible in the log as an `apply.source` line rather
than a silent regression. On the Round 1 clip both paths produced 348, so this should not fire.

### New probe

`[PERF] apply.source` — `{mode:'reuse', frames}` or `{mode:'reextract', reason, ...}`. In reuse mode
`apply.extract_all` is absent and `apply.read_all` carries `source:'reuse'`, so the pivot stays
comparable across modes. Grep the mode split for a run with:

```bash
grep '"stage":"apply.source"' perf_*.jsonl
```

### Correctness verification done here

`temp_extracted/` frames and `_apply/` frames must be the same pixels, or reuse changes what gets
masked. **For DICOM this is now proven**, not argued: on the 67-frame multiframe `.dcm`, the
background path (`extractFrameBatch`, batches of 15) and the apply path (`extractAllFramesSequential`)
produced **67/67 byte-identical frames** (sha256 per frame). Both funnel into the same
`extractDicomFrame(file, i)`, so this is structural, not luck.

**For MP4 it is not verified and cannot be here** (no ffmpeg on this box). The two paths use
genuinely different ffmpeg invocations — `select='between(n,a,b)' -vsync vfr` seek-based batches
versus one `-vsync 0` sequential pass — and the proposal itself flags GOP-boundary divergence as a
risk for 2B-3. **So expect masked MP4 output to differ from pre-2B-1 output at the byte level.** That
is the intended direction (the user now masks the frame the canvas actually showed them, which is the
co-indexing win the proposal claims), but it means "compare against the old ZIP" is not a valid check
— frame 1 and frame N have to be eyeballed.

### Residual cost not removed

`extractVideoMetadata(videoPath)` still runs before the branch, because the `updateVideoJob` write
needs duration/dims/frameRate. For DICOM that is one full file read plus a `dcmjs` parse — down from
68 (1 + 67 in `extractDicomFrame`), but not zero. Out of scope here; worth a line in 2B-3.

---

## 2. 2B-2 part 1 — `sharp.concurrency(os.cpus().length)` at boot

Landed in [`server/index.ts:117-125`](server/index.ts:117), before `TempFolderManager.initialize()`
and well before any sharp work. Logs the effective value at boot; `apply.env` already reports it per
apply, so the next `[PERF]` collection will show `sharp_concurrency: 2` instead of `1` and the
before/after is in the same log.

This is the change Round 1's single most important number pointed at, and it needed no argument.

---

## 3. 2B-2 part 2 — PNG encode: **NOT APPLIED**, and why

> Proposal: "`.png({ compressionLevel: 1, adaptiveFiltering: false })` on the masked-frame encode in
> `processFrameBatch` Step 4. PNG is lossless at every level — **pixels are identical**, files are
> ~15–25% larger, encode is ~2–3× faster."

Step 4 does not encode PNG. It has encoded **JPEG** since before this round:

```ts
const outputBuffer = await processedImage.jpeg({ quality: 90 }).toBuffer();
```
[videoProcessor.ts:1429](server/services/videoProcessor.ts:1429)

The proposal's baseline (PNG at libvips' default level 6) is not what runs, so neither its speedup nor
its "pixels are identical" claim transfers. Measured on a real 1164×873 ultrasound frame with
`sharp.concurrency(1)` (matching prod), 12 iterations after a warm-up, decode-to-raw excluded:

| encoder | time | output |
|---|---|---|
| **`jpeg({quality:90})` — what runs today** | **3.8 ms** | **115 KB** |
| `png()` — the proposal's assumed baseline | 13.9 ms | 311 KB |
| `png({compressionLevel:1, adaptiveFiltering:false})` — the proposal's change | 3.6 ms | **531 KB** |
| `png({compressionLevel:3, adaptiveFiltering:false})` | 7.1 ms | 332 KB |

*(For scale, decoding the source PNG to raw — Step 1 — is 2.4 ms on the same frame.)*

Applying it as written would buy **0.2 ms per frame (~5%)** and make every masked frame **4.6×
larger** — a 348-frame job goes from ~40 MB to ~185 MB on disk and in the download ZIP — while also
changing the pixels, from lossy JPEG to lossless, which is the one thing the proposal promised
wouldn't happen. That inverts the intent ("cheapen the encode"), so I did not apply it.

I also did not apply the optional `sequentialRead: true` (proposal item 3), which is explicitly gated
on "if decode shows up after 1–2" — that is a measurement 2B-2's own deploy should make.

**Your call.** Three options, in my order of preference:

1. **Leave the encoder alone.** The encode is ~4 ms/frame; after `sharp.concurrency(2)` it is not
   plausibly the mask-loop bottleneck. Re-measure `apply.frame.encode_ms` on the 2B deploy — with
   concurrency 2 those spans stop being queue-inflated for the first time, so the numbers will finally
   mean what they say.
2. **Switch to real PNG anyway** because you want lossless masked frames for the dataset. That is a
   *product* decision, not a perf one — it costs 4.6× disk and ~0 time. Say the word and it's a
   one-line change.
3. Nothing else here is worth doing on encode.

### Related finding: masked frames are JPEG bytes in `.png` files

The save loop names files from `outputSettings.format || 'png'`
([:404](server/services/videoProcessor.ts:404) region) while the encoder is unconditionally JPEG. With
the default settings every masked frame is written as `frame_000001.png` containing JPEG data, and the
frames endpoint serves it as `Content-Type: image/png`. Browsers and libvips both sniff content, so
nothing is visibly broken today and no code in the repo compares frame bytes — but the extension, the
content type, and the user's format choice all disagree with reality. **Pre-existing, not touched
here** (fixing it changes output bytes for every existing user, which is not a perf-round change).
It is also the likely origin of the proposal's assumption. Option 2 above would fix it as a side
effect.

---

## 4. Also found: `applyPaths.test.ts` has been red since before this round

`npx tsx server/services/__tests__/applyPaths.test.ts` → **7 pass, 1 fail**. Confirmed identical on a
clean worktree of `HEAD` (`a441067`), and my diff touches neither `applyPaths.ts` nor `cleanup.ts`.

The assertion is stale, not the code: the test expects `/jobId must be a non-empty string/`, but
Phase 5B's shared `resolveWithinRoot` validator now throws `resolveWithinRoot: empty or non-string
path segment`. The empty jobId is still rejected — only the message moved. A one-line regex fix,
deliberately left out of this round's diff. Flagging it because a red test in the runbook's pre-flight
will otherwise look like it came from here.

---

## 5. What needs eyes on the box

The reuse branch cannot be exercised here — it reads `storage.getJobV2`, and this box has no
Postgres and no ffmpeg. Verified by reading, by `tsc`, by the DICOM byte-equality run, and by the 2A
completeness test. On deploy:

1. **MP4 apply** → log shows `apply.source {mode:'reuse', frames:348}`, `apply.extract_all` is
   **absent**, `apply.done` drops from ~33 s toward ~14 s (and lower with concurrency 2).
2. `apply.env` now reports `sharp_concurrency: 2`.
3. **Frame count parity:** masked frame count == `totalFrames` == 348. Frame 1 and frame N eyeballed —
   byte-comparing against the old output is *not* a valid check for MP4 (§1).
4. **Redo apply** on the same job → still `mode:'reuse'` (this is what the V2-status choice buys).
5. **Single-frame + multiframe `.dcm`** apply and download. Multiframe should also show `mode:'reuse'`
   and skip the 67× `.dcm` re-read Round 1 flagged.
6. **AI run on the masked frames** still works (co-indexing).
7. Any `apply.source {mode:'reextract'}` line — read the `reason`; it names exactly which guard fired.

2B-3 (single-pass background extraction, 45 s → ~15–20 s) is deliberately not in this diff, per the
proposal's sequencing.

---

# 2B-addendum — output format decision + two small folds

**Spec:** `docs/refactor/ROUND2B_ADDENDUM.md` (operator decision 2026-08-30: masked output **defaults
to JPEG**, PNG selectable). Supersedes §3 above — the "your call" is now answered, and the answer is
neither of the two options I offered: **honor the user's format choice**, which fixes the JPEG-in-`.png`
mislabel as a side effect.

**Gates after the addendum:** `tsc` = **12**, same 12 · `npm run build` clean ·
`frameAccess.test.ts` **8/8** · `applyPaths.test.ts` **8/8** (was 7/8 — §B) · A3 diff empty.

## A. `outputSettings.format` is now honored end to end

### A.1 Encoder follows the format

[videoProcessor.ts:1527-1534](server/services/videoProcessor.ts:1527) — `processFrameBatch` Step 4:

```ts
const outFormat: 'png' | 'jpeg' = outputSettings.format === 'png' ? 'png' : 'jpeg';
const outputBuffer = outFormat === 'png'
  ? await processedImage.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer()
  : await processedImage.jpeg({ quality: 90 }).toBuffer();
```

The `apply.frame` probe now carries `fmt`, so which encoder ran is visible in the `[PERF]` log.

**Verified locally against `HEAD` (`a441067`)**, masking a real 1164×873 DICOM frame:

| | new code | `HEAD` |
|---|---|---|
| `format:'jpg'` | `ffd8ffdb`, 110,682 B, sha `10f71c4a75344a85` | **identical** — `ffd8ffdb`, 110,682 B, sha `10f71c4a75344a85` |
| `format:'png'` | `89504e47` (real PNG), 336,810 B | `ffd8ffdb` — **JPEG bytes in a `.png` file** |

So the default path is **byte-identical** to before, and the PNG path is the bug being fixed,
reproduced on the old code and gone on the new. PNG/JPEG size ratio measures **3.04×**, which is
exactly the "About 3× larger files" the UI copy promises.

### A.2 Extension and Content-Type follow the encoder

| site | change |
|---|---|
| [videoProcessor.ts:453](server/services/videoProcessor.ts:453) | save loop: `ext = format === 'png' ? 'png' : 'jpg'` (default was `'png'`) |
| [routes.ts:1610](server/routes.ts:1610) | `/frames/:n?source=template_mask` → `mimeForFrameFile(...)` |
| [routes.ts:1329](server/routes.ts:1329) | `/frames/:n.png` → `mimeForFrameFile(absPath)` |
| [frameAccess.ts:167](server/services/frameAccess.ts:167) | new `mimeForFrameFile()`; `.jpg`/`.jpeg` → `image/jpeg`, else `image/png` |
| [routes.ts:679](server/routes.ts:679), [:1812](server/routes.ts:1812) | manifest `outputFormat` fallback `'png'` → `'jpg'` |
| [aiInferenceClient.ts:11](server/services/aiInferenceClient.ts:11) | comment only — the client base64s raw bytes and sends **no MIME**, so there was nothing to make follow the extension |

The `/frames/:n.png` **route path keeps its `.png`** — that is the route's name, not a claim about the
payload, and renaming it would break clients for no gain.

Both ZIP builders already derived the extension from the filename
([routes.ts:797](server/routes.ts:797), [:1894](server/routes.ts:1894)) — no change needed.

### A.3 UI

[ProcessingControls.tsx:47](client/src/components/ProcessingControls.tsx:47) defaults to `'jpg'`;
JPG is listed first, and selecting PNG reveals *"Lossless. About 3× larger files."* No other
output-settings UI was added.

### A.4 Every `.png` literal on a masked-frame path — the full grep

Required by the addendum. After the change, the surviving literals are:

| site | verdict |
|---|---|
| `videoProcessor.ts:1312` (`frame_%06d.png` into `temp_extracted/`) | ✅ correct — **raw** frames are always PNG |
| `routes.ts:1639`, `:1667` (raw branch `Content-Type`) | ✅ correct — same reason |
| `routes.ts:812`, `:821`, `:1515`, `:1565`, `:1524`, `:1574` (AI `mask_`/`overlay_`) | ✅ correct — AI artifacts are genuinely PNG |
| `videoProcessor.ts:1605`, `:1818` (`debug_frame_*`) | ✅ debug-only writes |
| `routes.ts:85` (upload MIME allow-list) | ✅ unrelated |
| `frameAccess.ts:179` | ✅ the deliberate fallback in `mimeForFrameFile` |
| `videoProcessor.ts:751`, `:817`, `:1801`; `templateMaskFolderManager.ts:84` | ⚠️ **image-batch path — pre-existing, left alone.** See below. |

**Sorted-position indexing is unaffected.** Nothing keys on extension: `listFrameFiles` filters
`/\.(png|jpe?g)$/i` and sorts by name, so frame *i* is still `sortedFiles[i]`. Mixed extensions can't
occur inside one job dir anyway — `processVideo` calls `cleanupJobTempFolder` →
`createJobTempFolder` before every save ([:450](server/services/videoProcessor.ts:450)). The Phase 6
co-indexing invariant holds.

### Deviation: listing stays extension-based, NOT `frame_*`-prefix-based

The addendum says to match masked frames "by sorted `frame_*` prefix, not by extension". **Doing that
would break image-batch jobs.** `TempFolderManager.saveProcessedImage` names their output
`image_NNN_<original>.<ext>` ([templateMaskFolderManager.ts:84](server/services/templateMaskFolderManager.ts:84)) —
no `frame_` prefix — and the whole-job ZIP enumerates them through the same `listFrameFiles`
([routes.ts:613](server/routes.ts:613)). A prefix filter would silently return zero files and every
image-job download would 404.

The existing extension filter already accepts `png|jpg|jpeg`, which is all the addendum actually
needs, so no change was required there. **Legacy jobs are covered for free:** `.png`-named JPEGs
written before this deploy still list, still serve (as `image/png`, which browsers sniff past, exactly
as today), and still zip for the rest of their retention window.

### Pre-existing mislabel NOT fixed: the image-batch path

Image-batch jobs encode unconditional `.png()` ([videoProcessor.ts:1801](server/services/videoProcessor.ts:1801))
and name the file from the **uploaded original's** extension, ignoring `outputSettings.format`
entirely. So a masked `photo.jpg` is written as `image_001_photo.jpg` containing PNG bytes — the same
class of bug as the one just fixed, in the opposite direction, on a different code path. Out of scope
here (the addendum scopes §A to `processFrameBatch` Step 4), untouched, and flagged for a follow-up.

## B. `applyPaths.test.ts` regex — fixed

[applyPaths.test.ts:174](server/services/__tests__/applyPaths.test.ts:174) now expects
`/empty or non-string path segment/`. **8/8 pass.** The behavior under test is unchanged — an empty
jobId still never resolves to a deletable path; only Phase 5B's wording moved.

⚠️ A background session was already started for this same fix before the addendum arrived. It works in
its own worktree, so it will not collide with this diff, but it is now **redundant** — close it, or
discard its result.

## C. Grayscale — not touched, per §C. Queued for 2B-3.

## Regression guard status

Same split as §5 above: the DICOM extraction and mask-loop paths run here and were exercised; MP4,
HTTP, and downloads need the box. Added to the on-deploy list in §5:

8. **MP4 apply with the default** → files on disk are `frame_%06d.jpg`, the viewer serves
   `Content-Type: image/jpeg`, the AI spoke renders, the ZIP contains `images/frame_%06d.jpg`.
9. **MP4 apply with PNG selected** → `.png`, `image/png`, and one frame decodes to the same pixels as
   the raw frame outside the mask region.
10. **A job applied before this deploy** (`.png`-named JPEGs) still lists, views and downloads.
11. `manifest.json` `output_format` matches the actual extension on disk; the schema is unchanged (D1).
