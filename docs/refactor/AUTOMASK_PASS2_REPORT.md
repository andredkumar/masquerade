# Auto-mask — pass 2 report (tune half / test half; top, side and axis rules; joint fan control)

**Date:** 2026-09-06. **Governs:** `AUTOMASK_PASS2_REVISED.md` (copied into this folder). **No app code changed** (`git status` on the
app tree: only `scripts/automask_spike/` and `docs/refactor/`); `tsc` untouched at 12. `CONSTANTS.md` stays **CANDIDATE** — the §6
algorithm floor is **not met** (test half 58 %, floor 70 %); see §7.

## 0. Result in one table

| | before (pass-1 fits) | after (pass-2 rules) |
|---|---|---|
| tune half, tolerant with the fitted parameters (IoU ≥ 0.90 & leak_core6 ≤ 1 %) | 4 / 22 (18 %) | **16 / 22 (73 %)** |
| test half, same rule, scored once after tuning (no peeking) | 3 / 19 (16 %) | **11 / 19 (58 %)** |
| tune-half families at the top target (median \|Δ top\| ≤ 4 px) | 1 / 7 (curved fans, 0 px) | 4 / 7 — GE trap 2, Venue/Mindray rect 2, Butterfly arc 5 (Δ r_in 12), GE rect 8*; curved fans 8 (one radial bin), Venue fan 7 |
| tune-half clips with IoU ≥ 0.90 but leak_core6 > 1 % (target: none) | 11 | 2 (`bfly_frame_000089` 2.7 %, `Normal_Lung_sliding` 1.8 %) |
| regression rule (no tune-half clip that passed may fall) | — | **none fell** (checked against the pass-1 fits and the all-rules-off run) |
| negatives | 3 / 3 withheld | 3 / 3 withheld (same gates) |
| kickoff clips (`Normal_Lung_sliding`, `kidney_copy`, `bfly_z2b`, `sector_unknown_vendor`, `ge_e9_2124113685`, `ge_e9_4351124429`, `bfly_frame_000092`) | 2 / 7 | 2 / 7 (`kidney_copy`, `ge_e9_2124113685`; `bfly_frame_000092` blocked) |

\* `ge_e9_4515056095`: Andre's top is 8 px *above* the fit's — the fit follows the first bright row; his reference puts the top on the T0 box's row; IoU 0.996.

## 1. Protocol as run (§1)

- **Split** fixed in `sandbox/split.json` before any rule was touched: 51 references, 10 blocked (bench bug, §4) → 41 scored, stratified by family, tune 22 / test 19 (the single `sector` reference goes to test; the three known support failures are split 2 / 1 and reported, not tuned to). `synthetic_noise` removed from `manifest.csv`, `bench/`, the corpus (Andre's request); the other three negatives stay.
- **Harness:** `scripts/automask_spike/tune.py` runs the proposer on frame 1 of every reviewed clip with a chosen rule set and scores it against Andre's saved shape (`reviews.json` → `shape_user`, rasterised through the same `render_*` code as the bench). `--ablate` runs all-rules-off, each rule alone and all rules, and attributes Δ IoU per clip. The test half was run **once**, after the last tune-half change (`/tmp/tune_final_test.json`, table in §3).
- Pass-1 proposals are archived in `sandbox/bench/_before_pass2/<clip>/proposal.json`; the "before" columns below are those fits scored against the same references.
- **Δ columns are Andre − fit.** A positive Δ top means Andre put the top *lower* than the fit. For fans, Δ top is Δ r_in (the page's control) and **Δ arc** is the absolute move of the arc's lowest point (ay + r_in) — the visible top edge. A fan whose apex Andre nudged 8 px down with the arc left in place reads Δ top −8, Δ arc 0 (the three curved fans in the tune half).

Split:
- **butterfly_fan** (6): tune `bfly_frame_000089`, `bfly_z2b`, `bfly_z7`; test `bfly_z2`, `bfly_z3`
- **curved_fan** (11): tune `mindray_079_clip05_copy`, `sonosite_011_clip07_copy`, `sonosite_011_clip09_copy`; test `sonosite_011_clip06_copy`, `sonosite_011_clip08_copy`
- **ge_e9_rect** (2): tune `ge_e9_4515056095`; test `ge_e9_8038110422`
- **ge_e9_trap** (16): tune `ge_e9_0099279841`, `ge_e9_0929223627`, `ge_e9_2124113685`, `ge_e9_4792415724`, `ge_e9_7568291120`, `ge_e9_8467618784`, `ge_e9_8627400845`, `ge_e9_9033982512`; test `ge_e9_0830106210`, `ge_e9_1657500391`, `ge_e9_4351124429`, `ge_e9_6193094661`, `ge_e9_8314945226`, `ge_e9_8606662546`, `ge_e9_8889956621`, `ge_e9_9829885245`
- **sector** (4): tune —; test `sector_unknown_vendor`
- **support_failure** (3): tune `bfly_z9`, `sonosite_011_clip11_copy`; test `sonosite_011_clip10_copy`
- **venue_fan** (2): tune `Normal_Lung_sliding`; test `kidney_copy`
- **venue_mindray_rect** (7): tune `ge_venue_027_clip31_copy`, `ge_venue_027_clip33_copy`, `ge_venue_027_clip35_copy`, `mindray_027_clip30_copy`; test `ge_venue_027_clip32_copy`, `ge_venue_027_clip34_copy`, `ge_venue_027_clip36_copy`

## 2. What was wrong, family by family, and the rules that fix it (§2)

Every rule is a toggle in `RULES` (`automask_spike.py`) so the attribution table (§3) can switch it alone. Values in `CONSTANTS.md` (old values struck through).

**Venue / Mindray rectangles — Δ top +45…+47 on 4/4.** The pass-1 top was the first support row ≥ 30 % of the widest; the pass-2 prep's "60 % + sustained 3 rows" did not move it either (`+0.000` on every clip in the first ablation). Cause, from the row profile of `ge_venue_027_clip33`: GE Venue puts **two header lines — the patient / study name and the date-time, i.e. PHI — directly above the image**, each 4 rows tall at 4×, 66–97 % as wide as the image and *dense* at 4× (fill 0.66–0.91), separated by 1–2 empty rows; a 3-row sustain accepted them and the fit kept the PHI. Rule adopted: a row is "the image" when it is ≥ 60 % of the widest row **and** ≥ 50 % of its span is not-background on the raw mask (`TOP_FILL_MIN 0.50`), **sustained 8 rows** (`TOP_SUSTAIN 3 → 8`; text lines are ≤ 6 rows at every width in the corpus, an image top holds for hundreds). Rows above are dropped from the support before the refinement. Result: Δ top +45 → −3…+1 on all four; `ge_venue_027_clip35` also lost its +130 px right-side overshoot (the header text had been setting the rectangle's width).

**GE E9 trapezoids — Δ top +8…+12 on 14/14, w_top −67…−92 on 5, depth +19…+69 on 11.** The top: same rule, Δ top → 0…+2 on 8/8 (the "LOGIQ E9" label sits above the first image row and is now cropped). The width was the real finding: the pass-1 sides were a **compromise across a contaminated far field** — on `ge_e9_8467618784` the support's edges match Andre's lines within 10 px over the upper 200 rows, then the left greyscale bar merges (edge jumps to x = 0), the T0 box clips the right side, and the echo-free bottom-left corner is missing; the straight symmetric sides that best cover all of that land 44 px/side too wide at the top with the bottom width right. Rule adopted: **sides from the clean near-field band** — walking down from `y_top`, a row counts while both edges are inside the frame *and* the T0 box and neither edge jumps more than `SIDE_JUMP_PX 4` from the previous row; the band ends at the first violation and must start at the top (a clean far-field *tail* is not a band — that variant put `ge_e9_4515056095`'s centre 340 px off before it was caught); `cx` = median row midpoint, half-width = half the row width, Theil–Sen slope. The coordinate descent sees only the band (`y_bottom` pinned to its end), then **`y_bottom` alone is refined on the full support along the fitted side lines** — the pass-1 depth objective, so depth is *not* tuned by a new rule (§2: depth only via T0). Result: Δ w_top −17…−89 → −13…+3, Δ half within ±2° on 7/8 (`ge_e9_7568291120` +5°), leak_core6 1.4–3.9 % → ≤ 0.7 % on all eight, **8/8 tolerant** (was 1/8). Depth stays Andre-deeper by a median 32 px (see T0 and T2ext).

**T0 hypothesis (Andre's `y_bottom` ≈ DICOM box bottom within 6 px on ≥ 80 %?) — tested per clip, both halves:**

| clip | half | Andre model | Andre y_bottom | T0 box bottom | Andre − box | within 6 px |
|---|---|---|---|---|---|---|
| ge_e9_4515056095 | tune | rect | 805 | 805 | +0 | ✅ |
| ge_e9_0099279841 | tune | trap | 754 | 805 | -51 | ✗ |
| ge_e9_0929223627 | tune | trap | 675 | 736 | -61 | ✗ |
| ge_e9_2124113685 | tune | trap | 754 | 805 | -51 | ✗ |
| ge_e9_4792415724 | tune | trap | 675 | 736 | -61 | ✗ |
| ge_e9_7568291120 | tune | trap | 604 | 736 | -132 | ✗ |
| ge_e9_8467618784 | tune | trap | 755 | 805 | -50 | ✗ |
| ge_e9_8627400845 | tune | trap | 747 | 805 | -58 | ✗ |
| ge_e9_9033982512 | tune | trap | 680 | 736 | -56 | ✗ |
| ge_e9_8038110422 | test | rect | 805 | 805 | +0 | ✅ |
| ge_e9_0830106210 | test | trap | 737 | 805 | -68 | ✗ |
| ge_e9_1657500391 | test | trap | 688 | 736 | -48 | ✗ |
| ge_e9_4351124429 | test | trap | 636 | 736 | -100 | ✗ |
| ge_e9_6193094661 | test | trap | 741 | 805 | -64 | ✗ |
| ge_e9_8314945226 | test | trap | 760 | 805 | -45 | ✗ |
| ge_e9_8606662546 | test | trap | 681 | 736 | -55 | ✗ |
| ge_e9_8889956621 | test | trap | 677 | 736 | -59 | ✗ |
| ge_e9_9829885245 | test | trap | 756 | 805 | -49 | ✗ |

(The hypothesis was tested on the pass-1 references before any depth rule was adopted; the test-half rows are listed because the rule is about Andre's saved `y_bottom`, not about any fit — nothing was tuned to them.)

→ **rects 2/2, trapezoids 0/16** (Andre's bottom is 45–132 px *above* the box bottom on every trapezoid: the box includes the caption zone). Adopted **rect-only** (`t0_depth_rect`): `ge_e9_4515056095` 0.892 → 0.996 (Δ depth +75 → 0). Rejected for trapezoids.

**Butterfly fans — r_in +35…+65 on 6/6, apex 20–60 px on 4, half +0.6…+3.9 on 5.** `r_in` by angular coverage (`rin_coverage`: the radius at which ≥ 80 % of 24 angular bins are ≥ 50 % not-background on the raw mask, sustained 3 radial bins; support inside `r_in` dropped before the refinement): Δ arc +57 / +60 / +69 → **+1 / +12 / +5** on the tune half; the pass-1 arc had been sitting on the orientation marker / label above the image. The **wider-side seed was evaluated and rejected**: alone it dropped `mindray_079_clip05` 1.000 → 0.935 and cost 0.005–0.025 on every other fan (attribution table) — it violates the regression rule, so `fan_wider_side` stays off. **Apex deltas did not collapse** after those two (`bfly_frame_000089` still 25 px, `bfly_z2b` 27 px): the hull-intersection axis is 16–25 px right of centre on the two 632-px-wide fans because their far-field sides are frame-clipped, echo-free on one side and merged with the depth ruler on the other, while the rows just below the arc are symmetric about x = 312 (= Andre's axis, = the frame centre). Rule adopted: **`fan_axis_mid`** — the median midpoint of the clean rows in the first quarter of the depth below the arc replaces the hull axis **only when the two disagree by more than `AXIS_MID_MIN_SHIFT 4` (16 px full)**; the refinement then holds `ax`. Below the threshold the pass-1 fit is bit-identical — on the three curved fans the two axes agree within 3.4 px, on the wide Butterfly fans they disagree by 6.3–8.5 px. Result: `bfly_frame_000089` apex 25 → 0 px, IoU 0.914 → 0.961. Butterfly still **0/3**: `bfly_z2b` fails on depth (Andre +79 px — T2ext territory), `bfly_z7` on half-angle (+1.0°) and depth (+30), `bfly_frame_000089` on leak_core6 2.7 % (Δ arc +12, half −1.1°). On the half-angle: Andre's side lies **beyond the last not-background pixel** by 0.3° (`z7`) and 0.8° (`z2b`) and *inside* it by 0.3° (`frame_000089`) — the lateral angular profile (fraction of not-background per 0.1° bin between the arcs) is 0.00 at his angle on two of three; there is no pixel evidence to fit to, so no lateral-completion rule was added.

**Curved fans (Sonosite / Mindray) — the regression guard.** Only the `r_in` rule touches them, as required, and `fan_axis_mid` is gated so it does not: 3/3 tolerant before and after (0.992 / 0.971 / 0.996). The rule moved `r_in` one radial bin (2 px at 4× = 8 px full) deeper than Andre's on two of them — that is the rule's resolution, and the reason the curved-fan median |Δ arc| reads 8 px rather than 0.

**Sector** — no change (test half only; fails as before: apex 41 px, half +2.4°, leak_core6 3.6 %; Andre's note "top angle too narrow, but better").

**Support failures** (`bfly_z9`, `sonosite_011_clip10/11`) — not tuned to; `bfly_z9` now fits a rectangle (0.223 → 0.193), `clip11` improved as a side effect of the top rule (0.619 → 0.790), `clip10` unchanged (0.297).

**`kidney_copy` conf** — `conf_bbox`: only bright blobs intersecting the shape's bounding box (expanded 5 %) count as `outside_blob_frac`. conf **0.42 → 0.98** (test half, fit unchanged: IoU 0.955, leak_core6 0.05 %). No IoU effect anywhere (attribution table `+0.000`); the negatives are still caught upstream by the background gates.

**Evaluated and rejected, with numbers (tune half):** `fan_wider_side` (above); `TOP_FILL_MIN` 0.70 / 0.80 — `Normal_Lung_sliding` unchanged at +7, `bfly_frame_000089` arc 12 → 60 px, the two support failures worse; `TRAP_DEPTH = deepest support row` — 7/8 GE traps 15–20 px closer to Andre's depth but `ge_e9_7568291120` picks up the caption merged below the image (Δ depth 0 → −40, leak_core6 10 %) → 15/22 vs 16/22, and it is a new depth rule, which §2 forbids.

**Known misses left in the tune half (6):** `bfly_z2b`, `bfly_z7`, `bfly_frame_000089` (above); `Normal_Lung_sliding` (IoU 0.958, leak_core6 1.8 %: the Venue image fades in over its top 36 px — fill 0.04 → 0.97 across rows 0–9 at 4× — and Andre's top is at the end of the fade, the rule's at fill ≥ 0.5, Δ arc +7); `bfly_z9`, `sonosite_011_clip11` (support).

## 3. Tables (§5)

### Tune half — before (pass-1 fit, archived `bench/_before_pass2/`) → after (pass-2 rules), scored against Andre's saved shape

| clip | family | model | Δ half ° | Δ apex px | Δ top px | Δ arc px | Δ w_top px | Δ depth px | IoU | leak | leak_core6 | over_core6 | tolerant | which rule moved it (Δ IoU vs all-rules-off) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bfly_frame_000089 | butterfly_fan | fan_sym → fan_sym | +0.0 → **-1.1** | 22 → **0** | +60 → **+12** | +60 → **+12** | +43 → **-4** | +0 → **+0** | 0.914 → **0.961** | 0.076 → **0.053** | 0.060 → **0.027** | 0.021 → **0.000** | ✗ → ✗ | rin_coverage +0.012, fan_axis_mid +0.057, fan_wider_side -0.025 |
| bfly_z2b | butterfly_fan | fan_sym → fan_sym | +2.3 → **+2.1** | 27 → **23** | +35 → **-21** | +57 → **+1** | +50 → **+5** | +79 → **+79** | 0.821 → **0.848** | 0.063 → **0.002** | 0.053 → **0.000** | 0.148 → **0.137** | ✗ → ✗ | rin_coverage +0.021, fan_axis_mid +0.006, fan_wider_side -0.014 |
| bfly_z7 | butterfly_fan | fan_sym → fan_sym | +1.0 → **+1.0** | 4 → **4** | +65 → **+1** | +69 → **+5** | +68 → **+59** | +30 → **+30** | 0.741 → **0.764** | 0.024 → **0.003** | 0.021 → **0.000** | 0.199 → **0.199** | ✗ → ✗ | rin_coverage +0.023, fan_wider_side -0.005 |
| mindray_079_clip05_copy | curved_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 0 → **0** | +0 → **-8** | +0 → **-8** | +0 → **-8** | +0 → **+0** | 1.000 → **0.992** | 0.000 → **0.000** | 0.000 → **0.000** | 0.000 → **0.002** | ✅ → ✅ | rin_coverage -0.008, fan_wider_side -0.065 |
| sonosite_011_clip07_copy | curved_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 10 → **10** | -1 → **-9** | +7 → **-1** | -1 → **-8** | +0 → **+0** | 0.968 → **0.971** | 0.011 → **0.009** | 0.003 → **0.003** | 0.004 → **0.004** | ✅ → ✅ | fan_wider_side +0.008 |
| sonosite_011_clip09_copy | curved_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 0 → **0** | +0 → **-8** | +0 → **-8** | +0 → **-7** | +0 → **+0** | 1.000 → **0.996** | 0.000 → **0.000** | 0.000 → **0.000** | 0.000 → **0.001** | ✅ → ✅ | fan_wider_side -0.005 |
| ge_e9_4515056095 | ge_e9_rect | rect → rect | +0.0 → **+0.0** | 0 → **8** | +0 → **-8** | +0 → **-8** | +0 → **-4** | +75 → **+0** | 0.892 → **0.996** | 0.000 → **0.011** | 0.000 → **0.000** | 0.101 → **0.000** | ✗ → ✅ | t0_depth_rect +0.107 |
| ge_e9_0099279841 | ge_e9_trap | trap_sym → trap_sym | +0.8 → **+2.0** | 12 → **2** | +10 → **+2** | +10 → **+2** | -10 → **-13** | +40 → **+36** | 0.905 → **0.924** | 0.026 → **0.008** | 0.011 → **0.000** | 0.066 → **0.058** | ✗ → ✅ | top60 +0.012 |
| ge_e9_0929223627 | ge_e9_trap | trap_sym → trap_sym | -1.8 → **-0.0** | 17 → **4** | +10 → **+2** | +10 → **+2** | -10 → **+3** | +19 → **+11** | 0.932 → **0.972** | 0.060 → **0.008** | 0.036 → **0.000** | 0.026 → **0.010** | ✗ → ✅ | top60 +0.022 |
| ge_e9_2124113685 | ge_e9_trap | trap_sym → trap_sym | +0.4 → **+0.4** | 8 → **0** | +8 → **+0** | +8 → **+0** | -8 → **-12** | +40 → **+42** | 0.908 → **0.914** | 0.022 → **0.009** | 0.005 → **0.000** | 0.066 → **0.069** | ✅ → ✅ | top60 +0.016 |
| ge_e9_4792415724 | ge_e9_trap | trap_sym → trap_sym | -2.5 → **-1.0** | 13 → **5** | +8 → **+0** | +8 → **+0** | -8 → **-2** | +23 → **+27** | 0.926 → **0.940** | 0.057 → **0.013** | 0.030 → **0.004** | 0.034 → **0.042** | ✗ → ✅ | top60 +0.017 |
| ge_e9_7568291120 | ge_e9_trap | trap_sym → trap_sym | +1.0 → **+5.0** | 17 → **4** | +10 → **+2** | +10 → **+2** | -11 → **-12** | +0 → **+8** | 0.969 → **0.963** | 0.037 → **0.006** | 0.020 → **0.000** | 0.000 → **0.014** | ✗ → ✅ | — |
| ge_e9_8467618784 | ge_e9_trap | trap_sym → trap_sym | +3.4 → **-1.7** | 17 → **3** | +10 → **+2** | +10 → **+2** | -67 → **-6** | +32 → **+32** | 0.896 → **0.922** | 0.056 → **0.021** | 0.038 → **0.006** | 0.051 → **0.051** | ✗ → ✅ | top60 +0.022 |
| ge_e9_8627400845 | ge_e9_trap | trap_sym → trap_sym | +7.6 → **+0.9** | 24 → **3** | +10 → **+2** | +10 → **+2** | -84 → **-5** | +32 → **+37** | 0.894 → **0.922** | 0.050 → **0.007** | 0.035 → **0.000** | 0.054 → **0.061** | ✗ → ✅ | top60 +0.010 |
| ge_e9_9033982512 | ge_e9_trap | trap_sym → trap_sym | -2.5 → **-0.3** | 13 → **3** | +10 → **+2** | +10 → **+2** | -11 → **-9** | +36 → **+32** | 0.898 → **0.928** | 0.067 → **0.019** | 0.039 → **0.003** | 0.059 → **0.052** | ✗ → ✅ | top60 +0.031 |
| bfly_z9 | support_failure | trap_sym → rect | +11.4 → **—** | 0 → **—** | +0 → **—** | +0 → **—** | +0 → **-15** | +413 → **—** | 0.286 → **0.193** | 0.000 → **0.000** | 0.000 → **0.000** | 0.707 → **0.802** | ✗ → ✗ | top60 -0.030 |
| sonosite_011_clip11_copy | support_failure | trap_sym → trap_sym | +16.4 → **+3.2** | 52 → **58** | -16 → **-52** | -16 → **-52** | -144 → **+0** | +41 → **+41** | 0.756 → **0.790** | 0.026 → **0.000** | 0.023 → **0.000** | 0.203 → **0.186** | ✗ → ✗ | top60 +0.171 |
| Normal_Lung_sliding | venue_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 0 → **2** | +39 → **+7** | +39 → **+7** | +32 → **+6** | -21 → **-21** | 0.951 → **0.958** | 0.038 → **0.031** | 0.028 → **0.018** | 0.000 → **0.000** | ✗ → ✗ | rin_coverage +0.007 |
| ge_venue_027_clip31_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 49 → **1** | +49 → **+1** | +49 → **+1** | -3 → **-4** | +0 → **+0** | 0.908 → **0.987** | 0.035 → **0.005** | 0.029 → **0.000** | 0.000 → **0.000** | ✗ → ✅ | top60 +0.278 |
| ge_venue_027_clip33_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 45 → **4** | +45 → **-3** | +45 → **-3** | +0 → **+4** | +0 → **+0** | 0.923 → **0.983** | 0.030 → **0.000** | 0.027 → **0.000** | 0.000 → **0.000** | ✗ → ✅ | top60 +0.259 |
| ge_venue_027_clip35_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 78 → **4** | +45 → **-3** | +45 → **-3** | -134 → **-2** | +0 → **+0** | 0.689 → **0.985** | 0.198 → **0.003** | 0.187 → **0.000** | 0.000 → **0.000** | ✗ → ✅ | top60 +0.245 |
| mindray_027_clip30_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 47 → **2** | +47 → **-1** | +47 → **-1** | +0 → **+4** | +0 → **+0** | 0.920 → **0.987** | 0.032 → **0.000** | 0.028 → **0.000** | 0.000 → **0.000** | ✗ → ✅ | top60 +0.260 |

#### Tune half — family summary BEFORE (pass-1 fits)

| family | n | tolerant | IoU median | median \|Δ top\| px | median \|Δ arc\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 3 | 0/3 | 0.8 | 60.0 | 60.0 | 50.1 | 1.0 | 30.0 | 3 |
| curved_fan | 3 | 3/3 | 1.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0 |
| ge_e9_rect | 1 | 0/1 | 0.9 | 0.0 | 0.0 | 0.0 | 0.0 | 75.5 | 0 |
| ge_e9_trap | 8 | 1/8 | 0.9 | 10.0 | 10.0 | 10.7 | 2.2 | 32.4 | 7 |
| support_failure | 2 | 0/2 | 0.5 | 8.0 | 8.0 | 72.0 | 13.9 | 227.1 | 1 |
| venue_fan | 1 | 0/1 | 1.0 | 39.0 | 39.0 | 31.7 | 0.0 | -21.0 | 1 |
| venue_mindray_rect | 4 | 0/4 | 0.9 | 46.0 | 46.0 | 1.4 | 0.0 | 0.0 | 4 |

**tolerant with the fitted parameters: 4/22 = 18 %**  ·  families below 50 %: butterfly_fan, ge_e9_rect, ge_e9_trap, support_failure, venue_fan, venue_mindray_rect

#### Tune half — family summary AFTER (pass-2 rules)

| family | n | tolerant | IoU median | median \|Δ top\| px | median \|Δ arc\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 3 | 0/3 | 0.8 | 12.0 | 5.0 | 4.6 | 1.1 | 30.0 | 1 |
| curved_fan | 3 | 3/3 | 1.0 | 8.0 | 8.0 | 7.8 | 0.0 | 0.0 | 0 |
| ge_e9_rect | 1 | 1/1 | 1.0 | 8.0 | 8.0 | 4.1 | 0.0 | 0.0 | 0 |
| ge_e9_trap | 8 | 8/8 | 0.9 | 2.0 | 2.0 | 7.2 | 1.0 | 32.2 | 0 |
| support_failure | 2 | 0/2 | 0.5 | 52.0 | 52.0 | 7.7 | 3.2 | 41.5 | 0 |
| venue_fan | 1 | 0/1 | 1.0 | 7.0 | 7.0 | 5.7 | 0.0 | -21.0 | 1 |
| venue_mindray_rect | 4 | 4/4 | 1.0 | 2.0 | 2.0 | 4.0 | 0.0 | 0.0 | 0 |

**tolerant with the fitted parameters: 16/22 = 73 %**  ·  families below 50 %: butterfly_fan, support_failure, venue_fan

### Test half — after only (scored once, no peeking; before = pass-1 fit shown for reference in the tolerant column)

| clip | family | model | conf | Δ half ° | Δ apex px | Δ top px | Δ arc px | Δ w_top px | Δ depth px | IoU | leak | over | leak_core6 | over_core6 | tolerant (before → after) | rules that fired |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bfly_z2 | butterfly_fan | fan_sym | 0.82 | +1.9 | 54 | -45 | +9 | -14 | +34 | 0.863 | 0.021 | 0.127 | 0.004 | 0.119 | ✗ → ✗ | rin_rule |
| bfly_z3 | butterfly_fan | fan_sym | 0.97 | +0.1 | 2 | +32 | +32 | +28 | -57 | 0.960 | 0.194 | 0.002 | 0.160 | 0.000 | ✗ → ✗ | rin_rule |
| sonosite_011_clip06_copy | curved_fan | fan_sym | 0.99 | +0.0 | 0 | -8 | -8 | -7 | +0 | 0.996 | 0.000 | 0.004 | 0.000 | 0.001 | ✅ → ✅ | rin_rule |
| sonosite_011_clip08_copy | curved_fan | fan_sym | 0.99 | +0.0 | 13 | -8 | +4 | -7 | -24 | 0.961 | 0.027 | 0.000 | 0.013 | 0.000 | ✗ → ✗ | rin_rule |
| ge_e9_8038110422 | ge_e9_rect | rect | 0.93 | +0.0 | 13 | -8 | -8 | +27 | +0 | 0.996 | 0.011 | 0.000 | 0.000 | 0.000 | ✅ → ✅ | t0_depth |
| ge_e9_0830106210 | ge_e9_trap | trap_sym | 0.88 | +2.0 | 2 | +2 | +2 | -13 | +23 | 0.947 | 0.007 | 0.047 | 0.000 | 0.034 | ✗ → ✅ | rin_rule |
| ge_e9_1657500391 | ge_e9_trap | trap_sym | 0.90 | +2.1 | 4 | +2 | +2 | -16 | +36 | 0.924 | 0.013 | 0.070 | 0.001 | 0.058 | ✗ → ✅ | rin_rule |
| ge_e9_4351124429 | ge_e9_trap | trap_sym | 0.76 | +12.1 | 11 | +2 | +2 | -78 | -12 | 0.900 | 0.058 | 0.063 | 0.033 | 0.055 | ✗ → ✗ | rin_rule |
| ge_e9_6193094661 | ge_e9_trap | trap_sym | 0.81 | -2.4 | 4 | +3 | +3 | +60 | +77 | 0.826 | 0.006 | 0.170 | 0.000 | 0.153 | ✗ → ✗ | rin_rule |
| ge_e9_8314945226 | ge_e9_trap | trap_sym | 0.85 | +3.8 | 4 | +4 | +4 | -25 | +42 | 0.903 | 0.013 | 0.087 | 0.002 | 0.072 | ✗ → ✅ | rin_rule |
| ge_e9_8606662546 | ge_e9_trap | trap_sym | 0.89 | -0.3 | 3 | +2 | +2 | +1 | +37 | 0.923 | 0.011 | 0.072 | 0.000 | 0.061 | ✗ → ✅ | rin_rule |
| ge_e9_8889956621 | ge_e9_trap | trap_sym | 0.89 | -0.7 | 5 | +0 | +0 | -6 | +29 | 0.937 | 0.014 | 0.056 | 0.005 | 0.046 | ✗ → ✅ | rin_rule |
| ge_e9_9829885245 | ge_e9_trap | trap_sym | 0.77 | +8.0 | 11 | -2 | -2 | -40 | +68 | 0.843 | 0.007 | 0.152 | 0.004 | 0.134 | ✗ → ✗ | rin_rule |
| sector_unknown_vendor | sector | fan_sym | 0.98 | +2.4 | 41 | -16 | +10 | +1 | +0 | 0.892 | 0.055 | 0.085 | 0.036 | 0.072 | ✗ → ✗ | rin_rule |
| sonosite_011_clip10_copy | support_failure | trap_sym | 0.85 | +20.2 | 64 | -50 | -50 | -46 | +394 | 0.297 | 0.003 | 0.702 | 0.002 | 0.694 | ✗ → ✗ |  |
| kidney_copy | venue_fan | fan_sym | 0.98 | +0.0 | 8 | +0 | +8 | +0 | -14 | 0.955 | 0.006 | 0.000 | 0.001 | 0.000 | ✅ → ✅ | rin_rule |
| ge_venue_027_clip32_copy | venue_mindray_rect | rect | 0.92 | +0.0 | 2 | -2 | -2 | -1 | +0 | 0.991 | 0.002 | 0.004 | 0.000 | 0.000 | ✗ → ✅ |  |
| ge_venue_027_clip34_copy | venue_mindray_rect | rect | 0.80 | +0.0 | 2 | -2 | -2 | +7 | -21 | 0.920 | 0.012 | 0.028 | 0.009 | 0.000 | ✗ → ✅ |  |
| ge_venue_027_clip36_copy | venue_mindray_rect | rect | 0.93 | +0.0 | 2 | -2 | -2 | -10 | +0 | 0.971 | 0.011 | 0.004 | 0.000 | 0.000 | ✗ → ✅ |  |

#### Test half — family summary (after)

| family | n | tolerant | IoU median | median \|Δ top\| px | median \|Δ arc\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 2 | 0/2 | 0.9 | 38.5 | 20.5 | 21.3 | 1.0 | -11.5 | 1 |
| curved_fan | 2 | 1/2 | 1.0 | 8.0 | 6.0 | 7.3 | 0.0 | -12.0 | 1 |
| ge_e9_rect | 1 | 1/1 | 1.0 | 8.0 | 8.0 | 26.8 | 0.0 | 0.0 | 0 |
| ge_e9_trap | 8 | 5/8 | 0.9 | 2.0 | 2.0 | 20.5 | 2.2 | 36.5 | 1 |
| sector | 1 | 0/1 | 0.9 | 16.0 | 10.0 | 0.5 | 2.4 | 0.0 | 1 |
| support_failure | 1 | 0/1 | 0.3 | 50.0 | 50.0 | 45.8 | 20.2 | 393.9 | 0 |
| venue_fan | 1 | 1/1 | 1.0 | 0.0 | 8.0 | 0.0 | 0.0 | -14.0 | 0 |
| venue_mindray_rect | 3 | 3/3 | 1.0 | 2.0 | 2.0 | 6.8 | 0.0 | 0.0 | 0 |

**tolerant with the fitted parameters: 11/19 = 58 %**  ·  families below 50 %: butterfly_fan, sector, support_failure

Test half before (pass-1 fits): 3/19 tolerant.

### Attribution (tune half): Δ IoU of each rule alone vs all rules off

| clip | all-off IoU | top60 | rin_coverage | fan_axis_mid | fan_wider_side | t0_depth_rect | conf_bbox | all rules | tolerant all-off → all rules |
|---|---|---|---|---|---|---|---|---|---|
| bfly_frame_000089 | 0.914 | +0.000 | +0.012 | +0.057 | -0.025 | +0.000 | +0.000 | 0.961 | ✗ → ✗ |
| bfly_z2b | 0.821 | +0.000 | +0.021 | +0.006 | -0.014 | +0.000 | +0.000 | 0.848 | ✗ → ✗ |
| bfly_z7 | 0.741 | +0.000 | +0.023 | +0.000 | -0.005 | +0.000 | +0.000 | 0.764 | ✗ → ✗ |
| mindray_079_clip05_copy | 1.000 | +0.000 | -0.008 | +0.000 | -0.065 | +0.000 | +0.000 | 0.992 | ✅ → ✅ |
| sonosite_011_clip07_copy | 0.968 | +0.000 | +0.003 | +0.000 | +0.008 | +0.000 | +0.000 | 0.971 | ✅ → ✅ |
| sonosite_011_clip09_copy | 1.000 | +0.000 | -0.004 | +0.000 | -0.005 | +0.000 | +0.000 | 0.996 | ✅ → ✅ |
| ge_e9_4515056095 | 0.885 | +0.003 | +0.000 | +0.000 | +0.000 | +0.107 | +0.000 | 0.996 | ✗ → ✅ |
| ge_e9_0099279841 | 0.912 | +0.012 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.924 | ✗ → ✅ |
| ge_e9_0929223627 | 0.950 | +0.022 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.972 | ✗ → ✅ |
| ge_e9_2124113685 | 0.898 | +0.016 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.914 | ✗ → ✅ |
| ge_e9_4792415724 | 0.923 | +0.017 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.940 | ✗ → ✅ |
| ge_e9_7568291120 | 0.963 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.963 | ✗ → ✅ |
| ge_e9_8467618784 | 0.900 | +0.022 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.922 | ✗ → ✅ |
| ge_e9_8627400845 | 0.912 | +0.010 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.922 | ✗ → ✅ |
| ge_e9_9033982512 | 0.898 | +0.031 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.928 | ✗ → ✅ |
| bfly_z9 | 0.223 | -0.030 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.193 | ✗ → ✗ |
| sonosite_011_clip11_copy | 0.619 | +0.171 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.790 | ✗ → ✗ |
| Normal_Lung_sliding | 0.951 | +0.000 | +0.007 | +0.000 | -0.005 | +0.000 | +0.000 | 0.958 | ✗ → ✗ |
| ge_venue_027_clip31_copy | 0.708 | +0.278 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.987 | ✗ → ✅ |
| ge_venue_027_clip33_copy | 0.724 | +0.259 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.983 | ✗ → ✅ |
| ge_venue_027_clip35_copy | 0.740 | +0.245 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.985 | ✗ → ✅ |
| mindray_027_clip30_copy | 0.726 | +0.260 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.987 | ✗ → ✅ |

**Regression rule (no tune-half clip that passed may fall):** none fell — checked against both the pass-1 fits and the all-rules-off run.

### Blocked clips (excluded from both halves; references invalid until re-reviewed with the joint control)

| clip | pass-1 verdict | note |
|---|---|---|
| bfly_frame_000092 | wrong | can't adjust top width here; miscoded? |
| mindray_079_clip04_copy | adjusted | can't adjust top width, mislabeled.  |
| mindray_079_clip06_copy | wrong | can't adjust top width |
| mindray_079_clip07_copy | wrong | can't adjust top width |
| mindray_079_clip08_copy | wrong | can't adjust top width |
| mindray_079_clip09_copy | adjusted | can't adjust top width |
| sonosite_011_clip05_copy | wrong | can't adjust top width |
| sonosite_011_clip12_copy | wrong | can't adjust width on top |
| sonosite_011_clip13_copy | adjusted | can't adjust top width here.  |
| sonosite_011_clip14_copy | wrong | can't adjust width on top |


## 4. Bench: the fan top-width control (§3)

**What Andre saw on `sonosite_011_clip14` (reproduced from the saved data, not the page):** fit `ax 822, ay 3, half 33.2°, r_in 96, r_out 912`. The pass-1 "top width" control was the `r_in` slider with a width readout `2·r_in·sin(half)` — for this fit 105 px, changing ~1 px per px of `r_in`. Moving it did not hit a limit and did not fail; it moved the **small inner arc's height** (the arc went deeper) while the **cone's width at the top of the image stayed put**, because that width is set by the apex and the half-angle, not by `r_in`. His note "can't adjust top width" is exactly that. `mindray_079_clip06` shows the same attempt: `r_in` pushed 184 → 249 (arc 65 px deeper) with the cone unchanged. The 10 references saved this way are excluded from both halves (`split.json → blocked`) and get re-reviewed.

**Joint control "top width (arc stays)"** (`bench_static/shape.js`, `withParam('top_width_arc')`): keeps the arc's lowest point `y_arc = ay + r_in` and the bottom `y_out = ay + r_out` and bottom width `W_bot = 2·r_out·sin(half)` fixed and solves for the apex and half-angle that give the requested top width: with `ρ = W_top / W_bot`, `ay' = (ρ·y_out − y_arc)/(ρ − 1)`, `r_out' = y_out − ay'`, `r_in' = y_arc − ay'`, `sin half' = W_bot / (2·r_out')`. Range 0 < W_top < 0.98·W_bot. The old `r_in` slider stays, relabelled **"top arc height (r_in, apex fixed)"**. Unit-checked in Node (arc y and bottom width preserved to 1e-9 across the slider range) and in the browser after `bench.py --pages`: on `sonosite_011_clip14`'s page (stamp `bench v4`, assets `shape.js?v=…` / `review.js?v=…`) the joint slider moved 114 → 174 px and the other readouts followed as the closed form says: half-angle 33.2° → 30.7°, `r_in` 104 → 170 px with **the arc still at y 107**, `r_out` 912 → 978 px (the apex rose 66 px, so the bottom stays at y 915 and the bottom width at 999 px). The check caught one bug: the `r_in` readout computed "arc at y" from the *fitted* apex, so after a joint move it reported the arc 66 px deeper while the drawing had not moved; fixed (`shape.js` `display(v, cur)`, `review.js` passes the current shape), pages regenerated, re-verified: `arc at y 107 → arc at y 107`.

Bench version stamp: `bench v4 — pass 2: top width (arc stays) joint control; references absolute`. Saves still carry `bench_version`, `shape_fit`, `shape_user`, the five deltas (`d_top_width_px` included).

## 5. Depth and T2ext (§4)

Depth was not tuned by a new rule: rects take the T0 box bottom (2/2), trapezoids keep the pass-1 depth objective (refined along the fitted sides), fans keep `refine_fan_radii`. GE trapezoid depth is therefore still Andre-deeper by a median **+32 px (tune) / +37 px (test)** — over-blanking, not leak — and Butterfly by +30…+79. T2ext agreement after `bench.py --recompute` / `--report` (results file in `sandbox/results/`):

| half | clips qualifying (T2ext suggestion > 2 px, small angle/apex deltas) | Andre's depth within 10 px of T2ext | per clip (\|Δ user − Δ T2ext\|) |
|---|---|---|---|
| tune | 10 | **6 / 10 (60 %)** | Venue/Mindray rects 3, 3, 4, 4 px · curved fans 8, 8 px · GE traps 16, 26, 27 px · `Normal_Lung_sliding` 29 px |
| test | 6 | **3 / 6 (50 %)** | `ge_venue_027_clip32/36` 4, 4 px · `sonosite_011_clip06` 8 px · `ge_e9_8606662546` 21 px · `bfly_z3` 65 px · `ge_venue_027_clip34` 83 px |
| blocked (informational) | 4 | 3 / 4 | `mindray_079_clip06/07`, `sonosite_011_clip14` 8 px · `mindray_079_clip04` 24 px |
| all reviewed | 20 | 12 / 20 (60 %) | |

**Below the ≥ 70 % bar on both halves → the 2C extend-only offer is *not* approved by this pass.** Reading: T2ext agrees where the fitted depth is already right (rects, curved fans: the max projection adds ≤ 8 px) and disagrees exactly where depth is the miss — GE trapezoids (T2ext extends 16–27 px, Andre 32–37 px more) and Butterfly (`bfly_z3` 65 px). More clips qualify now (20 vs 10) because the angle/apex deltas shrank; the agreement rate did not improve (70 % → 60 %). T2ext stays evaluation-only; the trapezoid depth miss is the case for the next pass, and the max projection is one of its candidate inputs, not the answer by itself.

Bench verdict counts in `sandbox/results/2026-09-06_0837_bench.md` (right 0 / adjusted 1 / wrong 1) are moot: every fit changed since the review, so the page marks them "(fit changed since)"; the tolerant count there — **33 / 51 reviewed positives** with the fitted pass-2 parameters (tune 16 + test 11 + blocked 6) — is the meaningful number, and the blocked six are against references that were themselves not adjustable.

## 6. Negatives (§1)

| clip | gate | background mode | background fraction | result |
|---|---|---|---|---|
| `screenrec_app_ui` | `background_not_dark` (`BG_MAX_LEVEL 48`) | 244 | 0.51 | withheld |
| `stock_demo_480p` | `no_background` (`BG_MIN_FRAC 0.10`) | 42 | 0.086 | withheld |
| `synthetic_slide_white` | `background_not_dark` | 255 | 0.85 | withheld |

Unchanged from pass 1; `synthetic_noise` removed.

## 7. Freeze condition (§6) — not met; what the remaining misses share

- **Algorithm floor: ≥ 70 % of test-half positives tolerant, no family < 50 %, negatives withheld.** Test half **11/19 = 58 %**; families below 50 %: Butterfly 0/2, sector 0/1, support failure 0/1 (GE trap 5/8, curved fan 1/2, everything else 100 %). Negatives 3/3. **Not met.**
- **Product metric: ≥ 90 % accept-or-controls-only after Andre's re-review of the blocked clips.** Pending — 34/51 (67 %) on the pass-1 review with 10 verdicts blocked. Andre re-reviews **only** the 10 blocked clips on bench v4 (their pages now show the pass-2 fit; the joint control is the top-width control).

What the 8 test-half misses share (diagnosed from the fitter's own state, no rule changed):
- **GE trapezoids (3 of 8):** the clean band is contaminated by what the 4 px/row jump rule does *not* catch — a *gradual* edge loss (`ge_e9_9829885245`: the right edge recedes from y ≈ 256 inside the band → side angle 19° vs Andre 29°, `cx` 11 px off, IoU 0.843) and a vertical structure merged at the top-left (`ge_e9_4351124429`: left edge fixed at x = 164 for the first 24 rows, Andre's line starts at 199 → half-angle +12°, w_top −78, leak_core6 3.3 %). `ge_e9_6193094661` is different: Andre's shape is 34–40 px *outside* the visible support on both sides at every row (w_top 788 vs support 712) with depth +77 and the note "to too wide" — the reference itself is doubtful; the fit follows the pixels. Depth is Andre-deeper on all 8 (median +37 px).
- **Butterfly (2):** `bfly_z3` — the orientation marker above the arc was **not** cleared by the `r_in` rule (Δ arc +32, leak_core6 16 %); `bfly_z2` — apex 54 px too high, half +1.9°, depth +34. As in the tune half, Andre's lateral edge lies beyond the last not-background pixel.
- `sonosite_011_clip08` — far-field completion runs 24 px past Andre's depth (leak_core6 1.3 %; `R_PROFILE_MIN 0.12`); `sector_unknown_vendor` — untouched by design; `sonosite_011_clip10` — support failure.

Per §6: miss → **one more pass targeted at the shared causes above** (GE-trap band: detect gradual edge loss and merged verticals; GE-trap depth; Butterfly marker above the arc), then port behind the flag regardless. The pass-2 tune-half gain (18 → 73 %) came from the top rule, the clean band, the T0 rect depth and the axis rule — the test half confirms the rect and trap families generalise (rects 4/4, traps 5/8) and that the remaining misses are the fan families and depth.

## 8. Files

- `scripts/automask_spike/automask_spike.py` — `RULES`, `TOP_FILL_MIN`, `TOP_SUSTAIN 8`, `SIDE_JUMP_PX`, `AXIS_MID_MIN_SHIFT`, `TRAP_DEPTH`; `fit_trap_sym` (clean band, T0-aware clipping, band refinement, depth along sides), `fit_fan_sym` (`rin_coverage` on the raw mask, `fan_axis_mid`), `tier_t1` (not-background mask and x-limits threaded through), `confidence` (`conf_bbox`).
- `scripts/automask_spike/tune.py` — new: the harness (`--half tune|test|all|blocked`, `--baseline`, `--ablate`, `--json`); Δ arc column.
- `scripts/automask_spike/bench.py` — bench v4 stamp; per-half T2ext agreement in `--report` (reads `split.json`); `bench_static/shape.js` / `review.js` — joint control, `top arc height` relabel, readouts computed from the current shape (the "arc at y" bug above).
- `scripts/automask_spike/CONSTANTS.md` — pass-2 rows, old values struck through; still CANDIDATE.
- `sandbox/split.json` (new), `sandbox/manifest.csv` (−`synthetic_noise`), `sandbox/bench/_before_pass2/` (pass-1 proposals), `sandbox/results/<date>_bench.md` (pass-2 fits scored against all 51 references, T2ext by half).
- `docs/refactor/AUTOMASK_PASS2_REVISED.md` (copied), this report.

```bash
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --serve      # bench v4 — Andre re-reviews the 10 blocked clips only
```
```bash
python3 masquerade-aws-latest/scripts/automask_spike/tune.py --half test    # the one-shot test-half score (do not iterate on it)
```
