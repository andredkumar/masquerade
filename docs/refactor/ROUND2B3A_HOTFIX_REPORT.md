# Round 2B-3a hotfix report — mask by offset list; libvips composite removed

**Spec:** `docs/refactor/ROUND2B3A_HOTFIX.md` · **Prod result being fixed:** job `4f0329a0`,
`apply.done` 13.4 s → **19.3 s** after 2B-3a.
**Landed:** 2026-08-30. **NOT deployed.**

**Gates:** `tsc` = **12**, same 12 · `npm run build` clean · `frameAccess.test.ts` **8/8** ·
`applyPaths.test.ts` **8/8** · A3 diff empty · `frameExtractor.ts` diff **empty** ·
`startBackgroundFrameExtraction` untouched. One file changed: `server/services/videoProcessor.ts`.

**Result: 67/67 byte-identical at every mask size tested, and faster in all three regimes —
including the worst case the hotfix expected only to break even on.**

---

## 1. What changed

**`buildApplyMask`** ([videoProcessor.ts:597](server/services/videoProcessor.ts:597)) now derives a
`Uint32Array` of byte offsets `(y*w + x) * 3` for every pixel with mask alpha > 0, replacing the
`blackOverlay` RGBA raster. The scan that produces it is paid **once per apply**, not per frame.
`apply.mask_build` gains `offsets: n`.

**Per frame** ([:1577-1600](server/services/videoProcessor.ts:1577)) the composite is gone; the write
is the old loop's, restricted to the pixels where it did anything:

```ts
for (let k = 0; k < maskedOffsets.length; k++) {
  const o = maskedOffsets[k];
  framePixels[o] = 0; framePixels[o + 1] = 0; framePixels[o + 2] = 0;
}
```

`apply.frame.mask_mode` is now `'offsets'` (or `'js'` on the fallback). The
`composite(...).removeAlpha()` path is **deleted, not kept as a mode** — the only reference left is
the comment explaining why it went. The `channels === 3` guard stays; a 4-channel frame still takes
the full-scan loop, because the old loop zeroed RGB while leaving alpha untouched and 3-channel
offsets would not line up.

The prebuilt-mask half of 2B-3a is unchanged and still correct: one `apply.mask_build`, every
`apply.stack` reporting `mask_source: 'prebuilt'`.

## 2. Why 2B-3a regressed — confirmed, not assumed

The hotfix's diagnosis holds up. `composite(blend:'over') + removeAlpha()` makes libvips premultiply,
blend and unpremultiply **the entire frame** — 1,222,656 pixels of arithmetic — to change **1,494** of
them. The old loop's cost was the *scan*, and the composite replaced a cheap scan with expensive
full-frame work. On a t3.large (two vCPUs, one physical core) there is nowhere to hide that.

My 2B-3a laptop A/B measured 3.03× and did not catch it, for a reason worth recording: **it used a
mask covering 16.5 % of the frame, not 0.12 %**, on a machine with many more cores. Both errors
pushed the same way. The A/B below therefore measures the prod-like mask size first, and the report
states the mask coverage for every number.

## 3. Verification

### 3.1 End-to-end A/B — 67-frame multiframe DICOM, `sharp.concurrency(2)`

Baseline is the retained fallback path (per-stack mask rebuild + full scan) = **pre-2B-3a behavior**.

| mask coverage | byte-identical | pre-2B-3a | hotfix | |
|---|---|---|---|---|
| **0.12 % (1,040 px) — matches prod** | **67/67** | 203 ms | **101 ms** | **2.01×** |
| 16.4 % (138,968 px) — the 3a test mask | **67/67** | 396 ms | **112 ms** | 3.52× |
| 100 % (845,308 px) — whole frame drawn | **67/67** | 1348 ms | **147 ms** | 9.16× |

These speedups include the once-per-apply mask hoisting, since the baseline rebuilds per stack. That
is the honest before/after, but it is not an isolated measure of the loop change — so:

### 3.2 The two loops in isolation — no sharp, no mask build

Directly tests the hotfix's "worst case equals the old loop's cost — never worse" claim, on a real
1164×873 frame, 40 iterations each:

| mask coverage | full scan | offsets | |
|---|---|---|---|
| 0.12 % | 0.80 ms/frame | **0.14 ms/frame** | 5.8× |
| 16.4 % | 1.17 ms/frame | **0.21 ms/frame** | 5.6× |
| 100 % | 1.47 ms/frame | **0.95 ms/frame** | **1.5×** |

**The claim is conservative: offsets is strictly faster at every coverage, including 100 %.** It drops
the per-pixel alpha read and branch, and at full coverage the remaining cost is dominated by the frame
copy both paths pay. There is no crossover point where the old loop wins.

Absolute numbers are laptop numbers and smaller than prod's ~10 ms/frame — directional only. The
*ratios* and the byte-equality are what transfer.

## 4. What needs eyes on the box

1. `[PERF] apply.mask_build` once, now carrying `offsets: 1494`; every `apply.stack` still
   `mask_source: 'prebuilt'`.
2. `apply.frame` shows `mask_mode: "offsets"`.
3. `apply.done` on the 348-frame clip: **19.3 s → ~3–5 s** hoped; anything at or under the pre-3a
   13.4 s is already a win, and the number to compare against is 13.4, not 19.3.
4. **Look at frame 1 and frame N again.** The offsets path writes exactly the old pixels, but this is
   the second change in a row to the masking arithmetic and the check is free.
5. MP4 + single-frame `.dcm` + multiframe `.dcm` apply and download; AI run on the masked frames.
6. Any `mask_mode: "js"` line — means a 4-channel frame or a failed prebuild; correct, but read the
   `apply.mask_build` line's `reason`.

If `apply.done` still exceeds 13.4 s, the remaining cost is not the mask: `decode_ms` of 3–10 s per
stack is libuv-pool queue wait with all 58 stacks in flight against a 4-thread pool, which is a
concurrency-shape question (stack scheduling), not a pixel-arithmetic one — and a separate round.

**Not in this diff:** 2B-3b (single-pass background extraction, still 45 s) and 2B-3c (grayscale).
