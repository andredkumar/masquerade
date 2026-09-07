# Auto-mask — pass 2 (revised): tune on half of 51, auto-score the other half

**Date:** 2026-09-06. **Supersedes** `AUTOMASK_PASS2.md` §1 (the 18/56 split): Andre reviewed all 55 on the pass-1 fits, so there are now **51 full-parametric references** (`sandbox/results/2026-09-06_0753_bench.md`). No app code; `CONSTANTS.md` CANDIDATE until §6.

## 1. Protocol
- **Split** the 51 positives into tune/test halves, stratified by family (GE E9 trap, GE E9 rect, Venue/Mindray rect, Butterfly fan, Sonosite/Mindray curved fan, sector, support-failures). Fix the split in `sandbox/split.json` before tuning; report it.
- Tune on the tune half only. **Score the test half automatically** against Andre's saved shapes after each change — no re-review needed; references are absolute.
- **Exclude from both halves** the 9 references blocked by the bench bug (§3): `bfly_frame_000092`, `mindray_079_clip04/06/07/08/09`, `sonosite_011_clip05/12/13/14` (10 with `clip13`; check each note). They are re-reviewed after §3 and then join the test half.
- Rule: no tune-half clip that passed may fall; the test half is reported as-is, no peeking.
- Remove `synthetic_noise` from corpus, manifest, bench (Andre's request). Keep the other three negatives; all must still withhold after every change.

## 2. Targets, by family (the corrections are unanimous within each)

| family | reference says | fix to evaluate |
|---|---|---|
| **rect** (Venue ×6, Mindray ×1, GE E9 ×2) | top too high by 45–47 px (Venue/Mindray), depth +67/+75 (E9 rects) | top = first row whose support width ≥ 60 % of max width **and** sustained ≥ 3 rows; a single wide label row above the image must not count. E9 rect depth: see T0 rule below. |
| **trap_sym** (GE E9 ×14) | top +8…+12 on 14/14; `w_top` −67…−92 on 5 (merged `LOGIQ` label); depth +19…+69 on 11 | same top rule; label merge → the top seed uses rows ≥ 60 % (not 30 %) of the widest row; **T0 rule:** when `bound` exists, test the hypothesis that Andre's `y_bottom` ≈ bound bottom (print both per clip); if within 6 px on ≥ 80 % of them, set depth = bound bottom for trapezoids/rects on T0 clips. |
| **fan_sym Butterfly** (×6) | `r_in` +35…+65 on 6/6; apex 20–60 px on 4; half +0.6…+3.9 on 5 | `r_in` = radius at which the support's angular coverage first reaches ≥ 80 % of the half-angle span (not the 0.3 polar percentile); fan seed → **wider side**; after those two, re-check whether the apex deltas collapse (they should if the arc and angle were the cause). `bfly_z3`'s 15 % leak is the orientation marker above the arc — the `r_in` rule must clear it. |
| **fan_sym curved** (Sonosite ×6, Mindray ×6) | IoU 0.92–1.00, fail only on `leak_core6` 1–5 % at the top | expect the `r_in` rule to fix; no other change. These are the regression guard. |
| **sector** (`sector_unknown_vendor`, Sonosite cardiac ×3) | apex/half small deltas; Andre: "top angle too narrow" | no change until the §3 control gives a valid reference. |
| **support failures** (`bfly_z9`, `sonosite_011_clip10/11`) | IoU 0.29–0.76; depth +396/+413 | known misses; components printed; not tuned to. |
| **`kidney_copy`** | fit right (IoU 0.955, leak_core6 0.1 %), conf 0.42 | fix `outside_blob_frac` as in `AUTOMASK_PASS2.md` §4; negatives stay at 0. |

Target on the tune half: median `|Δ top|` ≤ 4 px per family; `leak_core6` ≤ 1 % on every clip with IoU ≥ 0.90. Depth is tuned only via the T0 rule; everything else stays for T2ext (§5).

## 3. Bench: the fan top-width control is wrong for what Andre needs
`r_in` alone raises the arc as it narrows it. Add a joint control **"top width (arc stays)"**: solve for `(ay, half_angle)` such that the arc's lowest point `y_arc = ay + r_in` stays fixed and the bottom width `2·r_out·sin(half)` stays fixed, while the top width changes. (Two equations, two unknowns; `r_in`, `r_out` recomputed from the new apex so the arcs stay put.) Keep the existing `r_in` control, relabelled "top arc height". Reproduce Andre's "can't adjust" on `sonosite_011_clip14` first and state what he saw (slider at its limit? no visible effect?). Then Andre re-reviews the 9–10 blocked clips only.

## 4. Depth and T2ext
T2ext is within 10 px of Andre's depth on 7/10 qualifying clips. After §2 lands (more clips qualify), report the agreement again on both halves. If ≥ 70 % agree, extend-only T2ext at `ready` is approved as a 2C *offer* (never auto-applied) and the 2A contract gains an optional `t2ext` block. Do not apply it to the fitted depth in this pass.

## 5. Report
Per clip, tune half: before → after (all deltas, IoU, leak, `_core6`, tolerant pass/fail, which rule moved it). Test half: after only, same columns, plus the family summary. `split.json`. Negatives' gates. Updated `CONSTANTS.md` (CANDIDATE) with the new rows and the old values struck through.

## 6. Freeze condition
Two numbers, both required:
- **Product metric (Andre's target): ≥ 90 % accept-or-controls-only** on the full positive set after Andre's re-review of the blocked clips — i.e. he would have clicked Accept, possibly after a slider. Today 34/51 (67 %) with ~10 verdicts blocked by the §3 bug; those alone should bring it to ~86 %.
- **Algorithm floor: ≥ 70 % of test-half positives pass the tolerant rule with the fitted parameters** (auto-scored, no peeking), no family below 50 %; negatives withheld.

Pass both → freeze → 2A. Miss the 90 % → one more pass targeted at whatever the remaining misses share (report that first), then port behind the flag regardless. The known support failures (`bfly_z9`, `sonosite_011_clip10/11`) count as misses; they are the case for the later temporal support, not for holding 2A.

---
> Read `AUTOMASK_PASS2_REVISED.md`. 51 references exist now, so: fixed stratified tune/test split (§1), exclude the 9–10 blocked references, remove `synthetic_noise`. Tune the top edge per family (§2: rect 60 %/3-row top; trap label-merge seed; fan `r_in` by angular coverage; fan seed wider side; T0 bottom-as-depth hypothesis tested before adoption). Fix `kidney_copy` conf. Add the joint "top width (arc stays)" control (§3) after reproducing the failure on `sonosite_011_clip14`. Score the test half automatically; no peeking. Report per §5 and stop; Andre re-reviews only the blocked clips.
