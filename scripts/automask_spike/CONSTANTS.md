# Auto-mask proposer — constants

**Status: FROZEN 2026-09-06** (after tuning pass 3, `AUTOMASK_PASS3.md` §4: "freeze at whatever the numbers are"). These are
the values `automask_spike.py` / `bench.py` run; the Round 2A TypeScript port (`shared/automask/`) targets exactly these
and nothing else. The bench fixtures (`sandbox/bench/<clip>/proposal.json`) were regenerated from this code on the
freeze date. Changing any value below is a new tuning pass with its own report, not an edit.

## The numbers at freeze (Andre's 51 absolute references; `ge_e9_6193094661` excluded pending his reference check)

| | tolerant (IoU ≥ 0.90 & leak_core6 ≤ 1 % with the *fitted* parameters) | controls-only fixable (pass-3 §2 estimator) |
|---|---|---|
| tune half (25) | 17 / 25 (68 %) | 17 / 25 |
| test half (25, scored once) | 17 / 25 (68 %) | 17 / 25 |
| **all 50** | **34 / 50 (68 %)** | **34 / 50** |
| negatives (3) | 3 / 3 withheld (`background_not_dark` ×2, `no_background`) | |
| families below 50 % | Butterfly fans 2 / 6, support failures 0 / 3 | |

**Numbers at the re-review of 2026-09-06 (`sandbox/results/2026-09-06_1041_bench.md`; rules unchanged, still frozen — the
references changed, not the code):** Andre judged 33 clips freshly against the frozen fits — right 22 · adjusted 8 ·
wrong 3 → **accept-or-controls 30/33 = 91 %**; tolerant with the fitted parameters **39/50 = 78 %** (his Accepts replaced
older references; `ge_e9_6193094661` still excluded); kickoff clips 4/7; negatives 3/3. The three "wrong": `bfly_z9`
(rect fitted, "not a box"), `sonosite_011_clip10` (trapezoid fitted to a fan) — model-type errors → 2B **B7 model
switch** — and `bfly_z7` (support). Reference snapshot for the 2A eval's `--bench` baseline: `sandbox/bench/reviews_freeze.json`
(51 entries, target 39/50 on row A12). Re-verified on the frozen code: `tune.py --half all` → 39/50, kickoff 4/7.

History of the same rule on the tune half: pass-1 fits 4/22 → pass 2 16/22 → pass 3 17/25 (the 10 formerly blocked clips
joined after the bench-v4 re-review). The §6 algorithm floor of pass 2 (≥ 70 %) is missed by one clip on each half;
frozen anyway per pass-3 §4. Reports: `docs/refactor/AUTOMASK_TUNING_PASS1_REPORT.md`, `AUTOMASK_PASS2_REPORT.md`,
`AUTOMASK_PASS3_REPORT.md`.

## Models

| model | parameters | fit | notes |
|---|---|---|---|
| `fan_sym` | `ax, ay, half_angle, r_in, r_out`; axis vertical through the apex; `th_l = −half_angle, th_r = +half_angle` | free side lines from the simplified hull (non-horizontal, not on the frame border) → apex y = their intersection, axis x = mean of the two sides' x at the support's vertical centroid, half-angle = mean(\|θ_L\|, \|θ_R\|); **`fan_axis_mid`**: the median midpoint of the clean rows just below the arc replaces the hull axis when they disagree by more than `AXIS_MID_MIN_SHIFT`, and the refinement then holds `ax`; **`rin_coverage`**: `r_in` = the radius at which ≥ `RIN_COVERAGE` of 24 angular bins are ≥ `TOP_FILL_MIN` not-background, sustained `RIN_SUSTAIN` radial bins (2 px at 4×), else the 0.3 polar percentile; **`fan_reseed_above_arc`**: if the crop above the arc removed > `RESEED_MIN_FRAC` of the support, the whole seed runs again on the cropped support (once); support inside `r_in` dropped; coordinate descent over the five parameters on `fit_score` (ax limited to ±2 % of width, frozen when the axis came from midpoints); `refine_fan_radii` extends `r_out` while the radial not-background profile stays > `R_PROFILE_MIN` | one side on the frame border → the other is mirrored about the top rows' midpoint. Diagnostics: `th_l_free_deg`, `th_r_free_deg`, `asym_deg`, `axis_tilt_deg` |
| `trap_sym` | `cx, y_top, y_bottom, w_top, w_bottom`, symmetric about `x = cx` | **top (`top60`)**: first support row ≥ `TOP_WIDE_FRAC` of the widest row **and** ≥ `TOP_FILL_MIN` not-background over its span, sustained `TOP_SUSTAIN` rows; rows above dropped. **Sides (clean near-field band)**: walking down from `y_top`, rows count while both edges are inside the frame *and* the T0 box and neither edge jumps > `SIDE_JUMP_PX` from the previous row; the band ends at the first violation and must start at the top; `cx` = median row midpoint, half-width = half the row width, Theil–Sen slope; the coordinate descent on `fit_score` sees only the band (`y_bottom` pinned to its end). **Depth (`TRAP_DEPTH = refine`)**: `y_bottom` alone refined on the full support along the fitted side lines (the pass-1 objective) | GE virtual convex. The far field (echo-free corners, greyscale bar merge, T0 clip) never touches the sides |
| `rect` | `trap_sym` with `w_top = w_bottom` | chosen when the trapezoid's implied side angle `< 3°`; width refined jointly (on the band when one exists); **`t0_depth_rect`**: on a T0 clip `y_bottom` = the DICOM region's bottom row | linear probes; GE Venue / Mindray full-screen captures |
| selection | `fan_sym` unless the trapezoid/rectangle beats it by more than `FAN_PREFERENCE` on `fit_score`, with the `TOP_FLAT_FRAC` tie-breaker (a flat top edge prefers the trapezoid) | | free models are internal only |

`fit_score = cover − EXTRA_PENALTY·extra` (cover = |S∩F|/|S|, extra = |F∖S|/|F|), not IoU: the visible support is a
*subset* of the cone (echo-free corners, dim far field). IoU vs support is still reported (`fit_iou`).

## Support pipeline (order matters; the port mirrors it step for step)

`gray` (full res, T0 box applied as black outside) → 4× box downscale → background = histogram mode (`BG_TOL`),
gates `BG_MAX_LEVEL` / `BG_MIN_FRAC` → not-background = gray > mode + `T_LOW` → density `K_DENS` box filter > `D_MIN` →
open `K_OPEN` → **`drop_small_blobs`**: components < `BLOB_FRAC` of the largest removed (and removed from the
not-background mask the rules read) → close `K_CLOSE_SMALL` → largest component → close `K_CLOSE` → fill → open `K_CUT`
→ largest → fill (+ union candidate `UNION_*`) → model fits → selection → `finish_fit` (confidence) → full-res render →
erode `MARGIN_PX` → T0 box.

## Rules (toggles in `RULES`, all attributable with `tune.py --ablate`)

| rule | status | pass | what it fixed (tune half) |
|---|---|---|---|
| `top60` | **on** | 2 | Venue/Mindray rect top +45 px → ±3 (header PHI lines rejected); GE trap top +10 → +2 |
| `rin_coverage` | **on** | 2 | Butterfly arc +57…+69 px → +1…+12 |
| `fan_axis_mid` | **on** | 2 | Butterfly apex 25 px → 0 on the wide fans; gated so curved fans are bit-identical |
| `t0_depth_rect` | **on** | 2 | GE E9 rect depth +75 → 0 (rects 2/2; trapezoids 0/16, so rect-only) |
| `conf_bbox` | **on** | 2 | `kidney_copy` conf 0.42 → 0.98; no IoU effect |
| `drop_small_blobs` | **on** | 3 | Mindray 079 clip08 0.810 → 0.948 (left-panel text no longer pulls the hull); `ge_venue_027_clip35` +0.09; `bfly_z2b` −0.010 (a header line had been anchoring the hull by luck) |
| `fan_reseed_above_arc` | **on** | 3 | Mindray 079 clip06 apex 124 px → 1 px, half 24.4° → 28.8° (Andre 29.8°), 0.827 → 0.934; `bfly_frame_000089` passes (the re-seeded cone hugs the visible speckle: mask right, parametrisation steep — see the Butterfly caveat in the pass-3 report) |
| `fan_wider_side` | **off — rejected (pass 2)** | | alone: `mindray_079_clip05` 1.000 → 0.935, −0.005…−0.065 on every fan |
| `band_consistency` | **off — rejected (pass 3 §1c)** | | violated its own guard: passing GE traps moved up to 63 px (limit 2), two tune-half passes fell; did not move the two target clips toward the reference |

## Constants

| constant | value | stage | meaning / why |
|---|---|---|---|
| `DOWN` | 4 | grid | analysis downscale; every "4× px" below is on this grid |
| `BG_TOL` | 3 | background | ± window around the histogram mode that counts as background |
| `BG_MIN_FRAC` | 0.10 | gate | flat background ≥ this fraction of the frame, else withhold `no_background` (stock footage 0.086) |
| `BG_MAX_LEVEL` | 48 | gate | that background is dark; mode above → withhold `background_not_dark` (screen recording 244, white slide 255) |
| `T_LOW` | 3 | support | not-background = gray > mode + T_LOW |
| `K_DENS` / `D_MIN` | 11 / 0.35 | support | density window and gate |
| `K_OPEN` / `K_CLOSE_SMALL` / `K_CLOSE` / `K_CUT` | 5 / 7 / 15 / 9 | support | clean / pre-component close / in-component close / appendage cut |
| `BLOB_FRAC` | 0.02 | support | `drop_small_blobs` threshold (fraction of the largest density component) |
| `UNION_FRAC` / `UNION_COVER` / `UNION_MAX_RATIO` | 0.10 / 0.95 / 4.0 | union | cone split by an echo-free band |
| side-edge rule | `\|dy\| ≥ 0.35·\|dx\|`, not on the frame border | fan seed | |
| `sides_parallel` | spread < 3° | fan seed | → no fan |
| apex rule | `ay < y_min + 0.25·h` | fan seed | |
| polar percentile | 99.7 (r_out seed); 0.3 for `r_in` only when `rin_coverage` finds no sustained run | fan seed | numpy linear interpolation |
| `RIN_COVERAGE` / `RIN_SUSTAIN` | 0.80 / 3 | fan `r_in` | fraction of the 24 angular bins filled; radial bins 2 px (4×) |
| `AXIS_MID_MIN_SHIFT` | 4 | fan axis | (4× px) midpoint axis replaces the hull axis only above this disagreement |
| `RESEED_MIN_FRAC` | 0.005 | fan | re-seed only if the crop above the arc removed more than this fraction of the support |
| `TOP_WIDE_FRAC` / `TOP_FILL_MIN` / `TOP_SUSTAIN` | 0.60 / 0.50 / 8 | trap/rect top | width vs widest row / raw-mask fill / rows (4×). `TOP_FILL_SRC = raw` (the density mask was evaluated in pass 3 and rejected: 10/25) |
| `SIDE_JUMP_PX` | 4 | trap sides, fan axis | (4× px) edge jump that ends the clean band |
| `TRAP_DEPTH` | `refine` | trap depth | `deepest` (pass 2), `image_rows` (pass 3 §1a as specified: 0/8 GE traps, sides collapse) and `profile` (pass 3: 7/8, fails the `ge_e9_7568291120` guard) evaluated and rejected |
| refinement | 5 rounds; steps 0.5 % w (ax, cx), 2 % r_out (ay), 0.01 rad (half-angle), 1 % (radii / y / widths); halve when stuck | fit | |
| `FAN_PREFERENCE` / `TOP_FLAT_FRAC` | 0.03 / 0.50 | selection | on `fit_score`; flat-top tie-breaker |
| `EXTRA_PENALTY` | 0.5 | fit | see `fit_score` |
| `approxPolyDP` ε | 0.006 (hull for sides), 0.012 (free quad, diagnostic) | | |
| `R_PROFILE_MIN` | 0.15 ~~0.12~~ | far field | radial-profile gate for `r_out` completion, measured above background; pass 3 §1d — no tune-half fan moved under 0.15 |
| `MARGIN_PX` | 2 | output | fail-closed erosion (full-res px) |
| `T_BRIGHT` | 18 | confidence | above background |
| `MIN_MASK_FRAC` | 0.05 | gate | withhold `masks_too_little` only when the interior is borderline (mean > 120 or std < 25) *or* the support reaches < 2 frame edges; otherwise propose with `flag: nothing_much_to_mask` |
| interior gate | mean > 150 or std < 15 | gate | `interior_not_ultrasound` |
| `conf` | `fit_score − 0.5·outside_blob_frac`, blobs restricted to the shape's bounding box expanded 5 % (`conf_bbox`) | grade signal | grade thresholds are set from 2B telemetry, not here |
| T2 / T2ext | `T2_N 20`, `T2_STD 6`, `T2_MEAN 60`; T2ext = max projection may only increase depth | evaluation only | agreement 60 % / 50 % (tune / test) in pass 2 → not offered as 2C |

## Evaluated and rejected, with numbers (so nobody tries them again without new data)

fan wider-side seed (pass 2) · `TOP_FILL_MIN` 0.70 / 0.80 (pass 2: `bfly_frame_000089` arc 12 → 60 px) · `TRAP_DEPTH`
deepest / image_rows / profile (passes 2–3, above) · `band_consistency` (pass 3) · fill on the density mask (pass 3:
10/25) · a flat-vs-arc test for header text on the ring the arc rule lands on (pass 3: never fired; the only clip it was
for, `bfly_z3`, has that ring clipped by the frame top) · a "mirrored top rule" for depth (pass 3 §1a as written).

**Corpus rules:** nothing enters `sandbox/clips/` unless Andre put it there; synthetic negatives are labelled
`vendor=synthetic`; references are Andre's saved shapes (`reviews.json`, absolute); tune on `split.json → tune` only,
score `test` once per pass; no tune-half clip that passed may fall.
