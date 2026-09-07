# Auto-mask — pass 3 (final): depth, the marker above the arc, contaminated bands — then freeze regardless

**Date:** 2026-09-06. **Input:** `AUTOMASK_PASS2_REPORT.md` (tune 16/22, test 11/19; misses concentrated in depth + Butterfly + 3 GE traps). **Same protocol:** tune half only, test half scored once at the end, regression rule, negatives withheld, no app code. **This is the last tuning pass**: after it, `CONSTANTS.md` freezes at whatever the numbers are and 2A starts.

## 1. Targets (shared causes from pass-2 §7), in priority order

**1a. Trapezoid depth (GE E9 ×16, Andre-deeper by a median 35 px on every one).** Pass 2's rejected `TRAP_DEPTH = deepest support row` got 7/8 closer but picked up a caption merged below the image on one clip. Fix that by mirroring the top rule downward: walking *up* from the deepest support row, a row is "the image" when it is ≥ 60 % of the widest row **and** fill ≥ `TOP_FILL_MIN` and sustained ≥ `TOP_SUSTAIN` rows; caption/label rows (thin, sparse) are rejected exactly as header rows are at the top. `y_bottom` = the first image row found, clipped to the T0 box. Rect keeps `t0_depth_rect`. Expected: the 3 test-half GE trap misses that fail on over-blank, and lower `over_core6` across the family. Guard: `ge_e9_7568291120` must not regain the caption (leak_core6 stays ≤ 1 %).

**1b. The marker above the arc (Butterfly `bfly_z3`, leak_core6 16 %).** `rin_coverage` did not clear it. Add: after `r_in` is set, drop any support component **above the arc** whose area is < 2 % of the main support and that does not touch the main support — the orientation marker is a small isolated blob. Then re-run `rin_coverage` once. Guard: curved fans unchanged (their arc is set from a continuous ring, no blobs above).

**1c. Contaminated clean band (GE `9829885245` gradual edge recession, `4351124429` merged vertical at top-left).** The 4 px/row jump rule misses slow drift and a straight merged edge. Add a consistency check on the band: fit each side with Theil–Sen, then drop rows whose edge residual exceeds `SIDE_RESID_PX 6`, refit once; if the two sides' implied half-widths at `y_top` disagree by > 10 % after that, take the *narrower* side as truth and mirror it (a merged structure only ever makes a side wider). Guard: the 13 GE traps that pass must not move by more than 2 px on any parameter.

**1d. Two near-misses on leak only.** `Normal_Lung_sliding` (1.8 %): the Venue image fades in over ~36 px; test `TOP_FILL_MIN` per-family is *not* allowed (no per-vendor constants) — instead test whether the top rule's fill should be measured on the density mask rather than the raw mask, which smooths a fade. `sonosite_011_clip08` (1.3 %): far-field completion runs 24 px past — test `R_PROFILE_MIN 0.12 → 0.15` and report every fan's Δ depth under it. Adopt either only if no clip falls.

**Not in this pass, stated so nobody tries:** Butterfly depth (no pixel evidence — Andre's bottom is beyond the last not-background pixel; this is the template library's job: a 632×1080 Butterfly export at a given depth setting has fixed geometry, one correction covers all of them), `sector_unknown_vendor` (n = 1), the three support failures (temporal support, later), `fan_wider_side` (rejected with numbers).

## 2. Product metric — an automatic estimator so Andre doesn't re-review 51 clips
Define **controls-only fixable** per clip: tolerant with the fitted parameters, **or** IoU ≥ 0.80 and leak_core6 ≤ 1 % and the reference differs from the fit in **one** parameter beyond tolerance (half ±1.5°, apex 8 px, top/arc 8 px, w_top 8 px, depth 12 px). Everything else is "needs redraw". Print it per clip and per family alongside the tolerant count; it approximates "Accept, possibly after one slider". Andre spot-checks five borderline clips in the bench to see if the estimator matches his judgement; if it does, it is the 90 % number going forward.

## 3. The blocked 10 and one doubtful reference
- Andre re-reviews the 10 blocked clips on bench v4 (joint control). They join the **test** half.
- `ge_e9_6193094661`: Andre's reference is 34–40 px outside the visible support on both sides. Flag on its page as "reference check"; if Andre re-saves it, re-score.

## 4. Report and freeze
Per-clip before → after on the tune half, test half once, attribution per rule, negatives, the §2 estimator per family. Then **freeze `CONSTANTS.md`** — mark it FROZEN with the date and the final numbers (tolerant and controls-only, both halves and all-51) — whatever they are. Open `AUTOMASK_ROUND2A_PROPOSAL.md` per `AUTOMASK_2A_DECISIONS.md` §3 with the frozen rules; the fixture `proposal.json`s are regenerated from the frozen code before the port begins. The known Butterfly-depth gap and the support failures go into the 2B/2C backlog as the first cases for the template library and temporal support.

---
> Read `AUTOMASK_PASS3.md`. Last tuning pass, same protocol. Targets in order: trapezoid depth by the mirrored image-row rule (1a), the isolated marker above the arc (1b), band consistency with narrower-side mirroring (1c), the two leak-only near-misses without per-vendor constants (1d). Not Butterfly depth, not the sector, not support failures. Add the controls-only estimator (§2). Then **freeze `CONSTANTS.md` at whatever the numbers are** and write the 2A proposal against the frozen rules. Andre re-reviews the 10 blocked clips and re-checks `ge_e9_6193094661` in parallel.
