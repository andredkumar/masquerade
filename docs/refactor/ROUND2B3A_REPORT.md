# Round 2B-3a report — mask built once per apply + masking moved into libvips

**Spec:** `docs/refactor/ROUND2B3_PROPOSAL.md` §1 (confirm from source) and §2B-3a. **2B-3a only** —
background extraction (3b) and grayscale (3c) are deliberately untouched.
**Landed:** 2026-08-30. **NOT deployed.**

**Gates:** `tsc` = **12**, same 12 · `npm run build` clean · `frameAccess.test.ts` **8/8** ·
`applyPaths.test.ts` **8/8** · A3 diff empty · `frameExtractor.ts` diff **empty** (DICOM branch and
`extractAllFramesSequential` untouched) · `startBackgroundFrameExtraction` untouched. One file
changed: `server/services/videoProcessor.ts`.

**Headline:** both §1 hypotheses **confirmed**, and the fix is byte-exact — **67/67 masked frames
identical** to the old path, mask loop **3.03× faster** locally. The proposal's suggested composite
(`dest-in`) is **not** the right operation; it inverts the mask. The correct form is below.

---

## 1. Source confirmation (§1) — both hypotheses CONFIRMED

### Q1. Where is the mask raster built? Per stack. And it contains its own JS pixel loop.

`processFrameBatch` Step 2 called `createMaskRgbaBuffer(firstTask.maskData, volumeWidth, volumeHeight)`
on **every stack** — 58 times for the prod clip. That call reaches
[`createMaskFromBase64`](server/services/videoProcessor.ts:1889) whenever the mask carries a
`canvasDataUrl`, which is what the real UI always sends. It is **two sharp resizes followed by a
synchronous JS loop over every pixel**, doing red-dominance detection:

```ts
for (let i = 0; i < pixelCount; i++) {
  const maskR = maskRaw[maskPixelIndex] || 0; ...
  const isDrawn = maskA > alphaThreshold;
  const isRed = maskR > redMinimum && maskR > maskG * 1.5 && maskR > maskB * 1.5;
  if (isDrawn && isRed) { resultBuffer[i*4 ... ] = 255; }
}
```

At 1536×796 that is **~1.22 M iterations of main-thread JavaScript per stack, × 58 stacks ≈ 71 M
iterations**, all serialized on the event loop. That is precisely the linear `mask_build_ms` climb the
proposal spotted — and the A/B run below **reproduces it on demand**: forcing the old path locally
gives 45.5 → 79.2 → 119.5 → 150 → 181.4 → 216.1 ms across consecutive stacks, each stack's build
waiting on the previous one. Diagnosis confirmed empirically, not just by reading.

### Q2. Is Step 3 a synchronous JS pixel loop on the main thread? Yes.

[videoProcessor.ts:1559-1570 (pre-change)](server/services/videoProcessor.ts:1559) — a plain `for`
over `pixelsPerFrame` inside an `async` map callback with no `await` in the body, so it runs to
completion on the main thread: **~1.22 M iterations × 348 frames ≈ 425 M iterations**. `sharp.concurrency`
cannot touch any of it, which is exactly why 2B-2 measured zero.

### Q3. Anything else per-stack that is really per-apply?

**No.** Output size is already resolved once in `processFrameBuffersInParallel`
([:1122-1136](server/services/videoProcessor.ts:1122)); resize options are derived per frame but are a
tiny object literal; there is no feather kernel or bbox-union on this path (`MaskData.feather` exists
only in the dead `maskWorker.ts`). The mask raster was the only genuine per-apply value being
recomputed per stack.

---

## 2. Changes

### 2.1 Mask built once per apply

New `ApplyMask` type ([:30](server/services/videoProcessor.ts:30)) and
`buildApplyMask(jobId, firstFrame, maskData)` ([:597](server/services/videoProcessor.ts:597)), called
once from `processVideo` right after the frame buffers are in hand
([:445](server/services/videoProcessor.ts:445)) and threaded through
`processFrameBuffersInParallel` into every `processFrameBatch` call.

It emits `[PERF] apply.mask_build` **once** with `{ms, w, h, masked_px, total_px}`.
`apply.stack` no longer carries `mask_build_ms`; it carries `mask_source: 'prebuilt' | 'per_stack'`
instead, and only adds `mask_build_ms` when the fallback fired — so a regression is visible in the log
rather than hidden in an average.

`buildApplyMask` returns `null` rather than throwing on any failure, and a stack whose frames don't
match frame 0's dimensions rebuilds its own mask exactly as before. **The old per-stack path is intact
as the fallback**, which is also what the A/B below uses as its baseline.

### 2.2 Per-frame masking moved into libvips

The JS loop is replaced by a composite when the frame is 3-channel
([:1569-1613](server/services/videoProcessor.ts:1569)):

```ts
processedImage
  .composite([{ input: blackOverlay, raw: { width, height, channels: 4 }, blend: 'over' }])
  .removeAlpha()
```

where `blackOverlay` is pure black RGB carrying the mask's alpha, built once alongside the mask.
`apply.frame` now records `mask_mode: 'vips' | 'js'`, and `mask_ms` collapses to ~0 on the vips path
because the work has left the main thread.

### The proposal's composite is wrong — corrected

> §2B-3a.2: `sharp(frameBuf).composite([{ input: maskRgba, blend: 'dest-in' }]).flatten({background:'#000'})`

Two problems, both caught by the equivalence experiment before any code changed:

1. **`dest-in` is inverted.** It keeps the destination *where the mask is opaque*. But this mask marks
   the region to **redact**, not to keep — the old loop reads `if (maskAlpha > 0) → set RGB to black`.
   `dest-in` would have blacked out the entire frame *except* the drawn shape: a total inversion of
   the product, and one that still "works" end to end, so it would have shipped.
2. **It returns 4 channels, not 3.** Both `dest-in + flatten` and `dest-out + flatten` came back
   1164×873×**4**ch against a 3ch source; `.flatten()` did not drop the alpha in this pipeline.

Measured, masking one real 1164×873 frame with a realistic canvas mask (16.5 % of pixels drawn):

| candidate | result |
|---|---|
| `dest-in` + `flatten` — **as proposed** | shape mismatch (4ch vs 3ch); semantics inverted |
| `dest-out` + `flatten` | shape mismatch (4ch vs 3ch) |
| **black overlay + `over` + `removeAlpha`** | **max abs diff 0, 0 differing bytes / 3,048,516 — EXACT** |

There is no feathered band to tolerate ±1 on: `createMaskFromBase64` emits binary alpha (0 or 255) and
the old loop tested `> 0`, so the equivalence is exact everywhere, not approximate anywhere.

---

## 3. Verification

**A/B inside one build**, on the 67-frame multiframe DICOM at `sharp.concurrency(2)` (matching prod),
comparing the new path against the retained fallback — i.e. genuinely old-vs-new semantics:

```
AB prebuilt mask: 1054x802 masked=138968      apply.mask_build: 49.9 ms (once)
AB byte-identical: 67/67 — ALL MATCH
AB mask-loop wall clock:  js=413 ms   vips=137 ms   speedup=3.03x
```

Every masked frame is byte-identical, and the old path's per-stack `mask_build_ms` climb
(45.5 → 216.1 ms) is visible in the same run while the new path builds once.

**Caveat:** this laptop has more cores than the t3.large, so 3.03× is directional. It lands inside the
proposal's predicted 13 s → 3–5 s, but the box decides.

---

## 4. What needs eyes on the box

1. `[PERF] apply.mask_build` appears **exactly once** per apply; `apply.stack` lines all carry
   `mask_source: 'prebuilt'` and **no** `mask_build_ms`.
2. `apply.frame` shows `mask_mode: 'vips'` and `mask_ms` ≈ 0.
3. `apply.done` on the 348-frame clip: **13.4 s → ~4–6 s** expected.
4. **Masked frames look right** — the drawn region black, the rest of the image intact. This is the
   check that would have caught the `dest-in` inversion, so do it deliberately on frame 1 and frame N
   rather than glancing at a thumbnail.
5. MP4 + single-frame `.dcm` + multiframe `.dcm` apply and download; AI run on the masked frames.
6. Any `mask_source: 'per_stack'` line — it means the prebuild failed or a stack's dimensions differed;
   correct, but worth reading the `apply.mask_build` line's `reason`.

**Not in this diff:** 2B-3b (single-pass background extraction, `extractVideoMetadata` caching) and
2B-3c (grayscale), per the proposal's sequencing. Background extraction still takes 45 s and is
untouched.
