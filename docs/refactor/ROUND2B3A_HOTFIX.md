# Round 2B-3a hotfix — libvips composite is slower than the JS loop on this box; mask by offset list

**Prod result of 2B-3a (job `4f0329a0`, same 348-frame clip):** `apply.mask_build` once, 117 ms ✅ ·
every stack `mask_source: prebuilt` ✅ · **`apply.done` 19.3 s — up from 13.4 s ✗.**

## Why

`apply.mask_build` reports **`masked_px: 1494` of `total_px: 1,222,656` — the mask covers 0.12 % of
the frame.** The old JS loop tested 1.2 M pixels and wrote 1.5 k of them: ~10 ms. The new
`composite([{input: fullFrameRgbaOverlay, blend:'over'}]).removeAlpha()` makes libvips premultiply,
blend and unpremultiply **the entire frame** — far more arithmetic than the loop it replaced — and on
a t3.large (one physical core) that lands at ~55 ms/frame end-to-end vs ~39 before. The laptop's 3×
came from spreading that heavier work over many cores; the box has one. `decode_ms` of 3–10 s per
stack is libuv-pool queue wait (all 58 stacks in flight against a 4-thread pool), not decode.

The prebuilt-mask half of 2B-3a is right and stays. The per-frame operation is wrong for this
workload: **the cost must scale with the masked pixels, not the frame.**

## Fix (one function, byte-identical output)

In `buildApplyMask` (already once per apply), derive from the binary mask alpha a flat
`maskedOffsets: Uint32Array` of byte offsets into the raw 3-channel frame (`(y*w + x) * 3` for every
pixel with alpha > 0). For this clip that is 1,494 entries; worst case (whole frame drawn) it is 1.2 M,
which equals the old loop's cost — never worse.

Per frame, revert to the raw path the old loop used — `sharp(frame).raw().toBuffer()` → mutate →
`sharp(raw, {raw:{width,height,channels:3}}).resize(...).jpeg()/.png()` — with the mutation being:

```ts
const b = rawBuf;                       // Uint8Array, 3 channels
for (let k = 0; k < offsets.length; k++) { const o = offsets[k]; b[o] = 0; b[o+1] = 0; b[o+2] = 0; }
```

That is exactly what the old loop did (`if (maskAlpha > 0) → RGB = 0`), restricted to the pixels
where it does anything. Keep the `channels === 3` guard from 3a; 4-channel frames take the old
full-loop fallback as today. Delete the black-overlay composite path (do not keep it as a mode —
it is slower everywhere this app runs).

Probes: `apply.frame.mask_mode` → `'offsets'`; `apply.mask_build` adds `offsets: n`. Keep everything
else.

**Equivalence proof, same as 3a:** 67/67 DICOM frames byte-identical vs the retained full-loop path,
and a second A/B at `sharp.concurrency(2)` reporting the mask-loop wall clock — expect the loop to
drop to roughly decode + encode (~6–8 ms/frame of libvips + orchestration), i.e. **13.4 s → ~3–5 s**
on the box. If the laptop A/B is not faster than the JS full loop, stop and report.

## Deploy
Same runbook; snapshot `pre-round2b3a-hotfix`; same clip; look for `mask_mode: "offsets"`, one
`apply.mask_build` with `offsets`, and `apply.done`. **Visually check frame 1 and frame N again** —
the offsets path writes exactly the old pixels, but the check costs nothing and the last change was
the one that could have inverted the mask.

## Kickoff for Claude Code

> Continuing Masquerade (bring CLAUDE.md). 2B-3a deployed: mask builds once (117 ms) but `apply.done`
> went 13.4 s → 19.3 s — the full-frame libvips composite is heavier than the JS loop on the 1-core
> t3.large, and `masked_px` is only 1,494 of 1.2 M. Apply `docs/refactor/ROUND2B3A_HOTFIX.md`: in
> `buildApplyMask` derive a `Uint32Array` of byte offsets for masked pixels; per frame go back to
> `raw()` → zero those offsets → encode, exactly the old loop's semantics restricted to masked pixels.
> Remove the composite path. Prove 67/67 byte-identical vs the full-loop fallback and report the
> mask-loop A/B at concurrency 2. tsc 12, A3 frozen, no extraction changes. Output
> `docs/refactor/ROUND2B3A_HOTFIX_REPORT.md` and stop before deploying.
