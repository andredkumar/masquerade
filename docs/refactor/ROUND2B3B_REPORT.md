# Round 2B-3b report — single-pass background extraction + upload-time metadata reuse

**Spec:** `docs/refactor/ROUND2B3_PROPOSAL.md` §2B-3b. **Deployed baseline:** 2B-1/2/3a + hotfix —
apply 7.9 s, background extraction still 45.4 s (131 ms/frame) against the apply-time single pass's
56 ms/frame on the same file.
**Landed:** 2026-08-30. **NOT deployed.**

**Gates:** `tsc` = **12**, same 12 · `npm run build` clean · `frameAccess.test.ts` **8/8** ·
`applyPaths.test.ts` **8/8** · A3 diff empty (no schema, status, or column changes) ·
`frameExtractor.ts` diff is **purely additive — zero deleted lines**, so
`extractAllFramesSequential` and its DICOM branch are provably untouched.

Files changed: `server/services/frameExtractor.ts` (+65, new method only),
`server/services/videoProcessor.ts`, `server/routes.ts` (+4/−4, two call sites).

---

## 1. What changed

### 1.1 New extractor method — `extractAllFramesSinglePass`

[frameExtractor.ts:297](server/services/frameExtractor.ts:297). A **new** method rather than a
modification of `extractAllFramesSequential`, because the two own different contracts: that one is the
apply-time fallback and owns the `_apply` staging semantics; this one fills the persistent raw-frame
dir and reports live progress. They share the ffmpeg invocation shape deliberately — same image2
muxer, same `frame_%06d.png` 1-indexed naming, same `-vsync 0` — so the frames this writes are
indistinguishable from what the apply path would have produced.

```
ffmpeg -i <upload> -vsync 0 -compression_level 1 temp_extracted/<jobId>/frame_%06d.png
```

**`-compression_level` fallback.** It is a PNG-encoder option; a build that rejects it fails the
command immediately and cheaply. Rather than let an encoder flag break every upload on a box I cannot
test here, a rejected first attempt retries once without it and logs
`⚠️ [single-pass] retrying without -compression_level`. If ffmpeg accepts the flag — it should — the
fallback never runs. **If you see that warning in the deploy log, the speed half of this change did
not land**, though extraction still works.

### 1.2 `startBackgroundFrameExtraction` — MP4 single pass, DICOM loop preserved

[videoProcessor.ts:1362](server/services/videoProcessor.ts:1362). The function now branches:

- **MP4** → one `extractAllFramesSinglePass` call.
- **DICOM** → the 15-frame `extractFrameBatch` loop, semantics unchanged (ffmpeg cannot demux a DICOM
  container). The loop's *shape* changed — the precomputed `batches[]` array became an inline
  `for (let start = 0; ...; start += 15)` — so it is verified byte-for-byte in §2.1 rather than assumed.

**DICOM detection costs nothing extra.** `startBackgroundFrameExtraction` takes a new optional
`isDicomHint`, and both upload call sites ([routes.ts:247](server/routes.ts:247),
[:323](server/routes.ts:323)) pass the answer they already computed. Omitted, it still detects — but
`isDicomFile` reads the *entire* file to inspect 4 bytes, so not re-paying that on a 268 MB `.dcm` is
worth the parameter.

### 1.3 Progress and probes

`bg_extract.first_frame_on_disk` now **polls for `frame_000001.png` every 100 ms**
([:1406](server/services/videoProcessor.ts:1406)) rather than firing when a batch's writes resolve.
This is deliberate: Round 2A's draw-while-extracting depends on the *file* existing, and ffmpeg's
internal `frames=` counter is not the same event. The probe measures what 2A actually needs.

`bg_extract.done` is unchanged in shape and gains `expected`, `parity`, and
`path: 'ffmpeg-single-pass' | 'dicom-batch'`.

Progress emits the **same socket payload** as before (`stage`/`currentFrame`/`totalFrames`/
`extractionProgress`/`status`), driven from fluent-ffmpeg's `.on('progress')` frame count
([:1431](server/services/videoProcessor.ts:1431)). It is throttled to one emit per 500 ms and skips
repeats: ffmpeg reports more often than the old 23-batches-per-clip, and every emit is a DB write plus
a socket send. Round 2A's Apply note and the hub panel read the same fields and need no change.

### 1.4 `samplingFps` — native rate, and why that IS "exactly as the batch path does"

`startBackgroundFrameExtraction` has never received a `samplingFps`; it is not in its signature and no
caller passes one. The batch extractor it replaces selects frames **by index**
(`select='between(n,a,b)'`) at native rate and ignores sampling entirely. So the single pass runs with
**no `-vf fps=` filter** — native rate, every frame.

This is not an omission, it is the requirement: down-sampling here would change the on-disk frame
count, and the Round 2B-1 reuse guard (`files.length === totalFrames`) would then fail on **every**
apply, silently costing back the 19.5 s that 2B-1 bought. Apply-time sampling is unaffected — a
sampled apply already re-extracts by design (2B-1 guard 1, `reason: 'sampling_fps'`).

### 1.5 Metadata reuse (the ROUND2B_REPORT §1 residual cost)

[videoProcessor.ts:376-397](server/services/videoProcessor.ts:376). `extractVideoMetadata` used to run
unconditionally at the top of `processVideo`, before we knew whether it was needed. On the **reuse**
path its only consumer is the `updateVideoJob` write, and the Job V2 record already holds those four
values from upload time — so the probe was pure waste, and for DICOM it was an entire file read plus a
`dcmjs` parse of a file the reuse path never opens.

`tryReuseRawFrames` now returns the V2 `source` it had already fetched (no extra query), and the
metadata is taken from it when `duration`/`width`/`height`/`frameRate` are all present and positive.
**No new columns** — these are A3 columns that already exist. The **re-extract path still probes**: it
needs `duration`/`frameRate` for `extractAllFramesSequential` and `isDicom` to label the probe.

New probe `apply.metadata` with `mode: 'cached' | 'probe'`, so the split is visible per apply.

### 1.6 Parity tripwire + reconciliation (operator addition, 2026-08-30)

If the single pass decodes a different count than the upload-time estimate
(`floor(duration × frameRate)` — wrong for VFR, and for any clip whose real frame count isn't that
product), the 2B-1 reuse guard trips and **every** apply on that job falls back to re-extraction,
forever. So on mismatch the count is reconciled to what is actually on disk
([:1512-1546](server/services/videoProcessor.ts:1512)), exactly as `processVideo` already does after
its own extraction (`totalFrames: extractedCount`).

**One write updates both records.** `totalFrames` is a **single shared column** in PgStorage, read by
both `rowToVideoJob` ([pgStorage.ts:469](server/pgStorage.ts:469)) and `rowToJob`'s
`source.totalFrames` ([:498](server/pgStorage.ts:498)) — the A3 design note calls these "shared facts…
ONE column each, read by both derivations". So the existing `storage.updateVideoJob` path reconciles
the VideoJob facet and the Job V2 facet the reuse guard actually reads. No schema change, no new
column, no edit to `storage.ts` or `pgStorage.ts`.

**The warning and `parity: false` stay** — reconciling the count must not make the divergence
invisible. `bg_extract.done` gains `corrected: true|false` so the log distinguishes "counts agreed"
from "counts disagreed and we fixed it".

**Ordering:** the reconcile lands *before* status flips to `ready`, so an apply fired the instant the
hub tile unlocks already reads the corrected count.

#### Scoped to MP4 — DICOM is deliberately NOT reconciled

The operator's rationale is the VFR / estimated-count clip, which is the MP4 case: ffmpeg's single
pass either succeeds and writes every frame, or throws.

DICOM is different and reconciling it would be unsafe. Its `totalFrames` comes from
`detectDicomFrameCount`, which is **exact**, and its batch loop catches per-batch errors and continues
by design. So a DICOM mismatch does not mean "the estimate was off" — it means a batch genuinely
failed and **frames are missing**. Rewriting the count there would make the reuse guard accept a short
frame set, and the user would silently mask and download fewer frames than the source contains. A
short DICOM set must keep failing the guard; it logs
`⚠️ [parity] DICOM count NOT reconciled` instead. Say the word if you want it reconciled anyway.

#### Rollback caveat

On **MemStorage** — retained only as the 5C-2 rollback target, not live — the two facets are separate
maps and `updateVideoJob` mirrors only `status`, so `totalFrames` would not reach `jobsV2` there and
the reuse guard would still trip. Fixing that means editing `storage.ts`, which is A3-frozen, so it is
noted rather than done. Irrelevant unless someone reverts to MemStorage.

---

## 2. Verification

### 2.1 The restructured DICOM loop — byte-identical ✅

The DICOM branch's loop shape changed, so it was tested rather than eyeballed. Reference is
`extractAllFramesSequential`'s DICOM output, already proven byte-identical to the **pre-2B-3b** batch
loop in `ROUND2B_REPORT.md` §1 — so this is transitively a comparison against the old code:

```
V3B frames=67
V3B counts ref=67 new=67 extracted=67 expected=67   PARITY OK
V3B names IDENTICAL   first=frame_000001.png last=frame_000067.png
V3B byte-identical 67/67 — ALL MATCH
```

Same count, same 1-indexed filenames, same bytes.

### 2.2 The MP4 single pass — NOT verifiable here ⚠️

**This box has no ffmpeg binary.** Every MP4 claim in this round is unverified by me:

| gate | status |
|---|---|
| frame-count parity 348 → 348 | ⚠️ **box only** |
| frame 1 byte-diff vs the batch extractor | ⚠️ **box only** — GOP-boundary divergence is the known risk |
| first frame on disk within ~2 s | ⚠️ **box only** |
| `-compression_level 1` accepted by this ffmpeg build | ⚠️ **box only** (fallback exists, §1.1) |
| 45.4 s → ~15–20 s | ⚠️ **box only** |

The code paths are verified by `tsc` and by reading; the *behavior* is not. Treat §3 as the real test.

**On the byte-diff specifically:** the old path decoded with `select='between(n,a,b)' -vsync vfr` per
batch — a seek-based decode — while this one decodes sequentially in a single pass. Sequential decode
is the more trustworthy of the two at GOP boundaries, so if frame 1 differs, the likely reading is
that the *new* frames are right and the old ones were subtly wrong, not the reverse. Either way:
**eyeball it and report rather than assuming**, exactly as the kickoff asks.

### 2.3 Round 2A interaction — unchanged by construction

The frames endpoint's IEND completeness check still covers partial files: ffmpeg writes each PNG
whole, but a read can still land mid-write, and nothing about that path changed. `first_frame_on_disk`
should get *earlier*, not later — a single pass starts writing frame 1 almost immediately, where the
batch loop had to finish a 15-frame batch first.

---

## 3. What needs eyes on the box

1. `bg_extract.done` → `path: "ffmpeg-single-pass"`, `frames: 348`, **`parity: true`**,
   `corrected: false`. If `parity: false` with `corrected: true`, extraction is fine and the
   upload-time estimate was simply wrong for that clip — reuse still applies; report the two numbers
   so we learn which clips diverge. `parity: false` with `corrected: false` on a **DICOM** job means
   frames are genuinely missing — that one is a real failure.
2. `bg_extract.first_frame_on_disk` — **≤ ~2 s**, and ideally lower than today's 1.9 s. This is the
   number Round 2A's draw-while-extracting rides on.
3. `bg_extract.done` total: **45.4 s → ~15–20 s** expected.
4. **Frame 1 byte-compare** old extractor vs new on the same clip. If bytes differ, look at both
   images before drawing any conclusion (§2.2).
5. No `⚠️ [single-pass] retrying without -compression_level` in the log.
6. Upload → hub → Template Mask tile opens mid-extraction, canvas paints, Apply gates then enables —
   the whole 2A flow, since this changed what writes those frames.
7. Apply on that job shows `apply.source {mode:'reuse'}` **and** `apply.metadata {mode:'cached'}`.
8. **DICOM regression:** single-frame and multiframe `.dcm` upload → extract → apply → download.
   `bg_extract.done` should read `path: "dicom-batch"` for both.

**Not in this diff:** 2B-3c (grayscale evaluation), per the proposal's sequencing.
