# Auto-mask — pass 3 report (final tuning pass) and the freeze

**Date:** 2026-09-06. **Governs:** `AUTOMASK_PASS3.md` + `AUTOMASK_POST_REREVIEW_NOTES.md` §A (both copied into this folder). **Same protocol as pass 2:** tune half only, test half scored once at the end, regression rule, negatives withheld, **no app code** (`git status` on the app tree: only `scripts/automask_spike/` and `docs/refactor/`; `tsc` untouched at 12). **`CONSTANTS.md` is FROZEN** as of this report (§7). The Round 2A proposal is rewritten against the frozen rules (`AUTOMASK_ROUND2A_PROPOSAL.md` v2); Andre's 2B/2C requirements are carried verbatim into `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md`.

## 0. Result in one table

| | pass-2 fits | pass-3 rules (frozen) |
|---|---|---|
| tune half (25), tolerant with the fitted parameters (IoU ≥ 0.90 & leak_core6 ≤ 1 %) | 16 / 25 | **17 / 25 (68 %)** |
| test half (25), same rule, scored **once** after the last tune-half change | 15 / 25 | **17 / 25 (68 %)** |
| all 50 scored references (51 minus `ge_e9_6193094661`, reference check) | 31 / 50 | **34 / 50 (68 %)** |
| controls-only fixable (§2 estimator) | 31 / 50 | 34 / 50 — the estimator never adds a clip beyond the tolerant ones (§5) |
| regression rule (no tune-half clip that passed may fall) | — | **none fell** (checked against the pass-2 fits and the all-rules-off run) |
| negatives | 3 / 3 withheld | 3 / 3 withheld, same gates |
| families below 50 % (all 50) | Butterfly 1/6, sector 3/4, support 0/3 | Butterfly 2/6, support failures 0/3 |
| kickoff clips (7) | 2 / 7 | 3 / 7 (`kidney_copy`, `ge_e9_2124113685`, `bfly_frame_000092`) |

The pass-2 §6 algorithm floor (≥ 70 % on the test half, no family < 50 %) is missed by **one clip** on each half and by the Butterfly and support-failure families. Frozen anyway, per pass-3 §4.

## 1. Protocol as run

- **Split** (`sandbox/split.json`): the 10 formerly blocked clips joined after Andre's bench-v4 re-review — Mindray 079 `clip04/06/08` → tune, `clip07/09` → test, `bfly_frame_000092`, Sonosite `clip05/12/13/14` → test (notes §A). Tune 25 / test 25. `ge_e9_6193094661` is flagged **reference check** (banner on its bench page, `split.json → reference_check`) and excluded from every count until Andre confirms or redoes it: his saved shape is 34–40 px outside the visible support on both sides and was not re-saved. `sonosite_011_clip05` came back as "wrong" with IoU 0.984 / leak_core6 0.02 % — read by its numbers (the note was the pre-filled one).
- **Before** = the pass-2 fits, archived in `sandbox/bench/_before_pass3/`, scored against the same references. **After** = the frozen code. Attribution = `tune.py --ablate` (each `RULES` toggle alone vs all off).
- **Δ columns are Andre − fit.** For fans Δ arc is the absolute move of the arc's lowest point (the visible top); Δ top is Δ r_in. The test half was run exactly once (`/tmp/p3_final_test.json` → §3).

## 2. The targets, in the doc's order — what was tried, what held

**1a. Trapezoid depth (GE E9, Andre-deeper by a median 32 px).** The row evidence at the bottom of every tune-half GE trapezoid (support width, raw fill between the fitted side lines, per 16 px) says: Andre's `y_bottom` sits **~15 px below the deepest support row** on 7/8 (`0099279841` 740 → 754, `0929223627` 672 → 675, `2124113685` 736 → 754, `4792415724` 668 → 675, `8467618784` 740 → 755, `8627400845` 732 → 747, `9033982512` 668 → 680) where the raw fill between the sides is 0.00–0.02, and **30–40 px above the last texture** on `7568291120` (support runs to 644, Andre 604; the right corner and the depth ruler continue below his line). No pixel rule satisfies both, and the guard on `7568291120` (leak_core6 ≤ 1 %) is explicit. Three variants measured on the tune half:

| `TRAP_DEPTH` | GE trap tolerant | Δ depth median | `ge_e9_7568291120` | verdict |
|---|---|---|---|---|
| `refine` (pass-1 objective along the fitted sides — **kept**) | 8 / 8 | +32 px (Andre deeper = over-blank) | Δ +8, leak_core6 0.02 % | frozen |
| `image_rows` — §1a exactly as written (top rule mirrored, walking up from the deepest row: width ≥ 60 % of the widest **and** fill ≥ 0.5, sustained 8) | **0 / 8** | +120…+179 px; 5 clips flip to the fan model | — | rejected: GE far fields are half echo-free, so no bottom row is ≥ 60 % of the widest row; the rule cuts 120–180 px above Andre |
| `profile` — `refine_fan_radii`'s walk for the trapezoid (down from the band end while the raw fill between the sides > `R_PROFILE_MIN`) | 7 / 8 | +26 px | Δ **−28**, leak_core6 **6.6 %** | rejected by the guard |
| `deepest` (pass 2) | 7 / 8 | +13 px | Δ −40, leak_core6 10 % | rejected (pass 2) |

Depth stays where pass 2 left it. The miss is one slider in the safe direction on all 16 GE trapezoids (over-blank, never leak).

**1e. Mindray 079 curved fans (720×540) — the real cause.** Contact sheet + hull diagnostics: the fitted apex was 38–124 px too high with sides 24–25° instead of ~30° because the **hull side edges ran from the far field up to the frame top through the header text** (patient name / date lines at y 8–36, bridged into the support by the density filter — a 3-px gap at 4×), and on `clip08` the **left-panel text block** ("B FH6.0 DR150 FR16 D18.0 G40") pulled the left edge. Not the isolated-blob-above-the-arc case of §1b — zero isolated components above the fitted arc on any Mindray clip. Two rules, both adopted:
- **`drop_small_blobs`** (§1b generalised): density components < `BLOB_FRAC 2 %` of the largest are dropped *before* the closing, and their pixels are removed from the not-background mask the rules read. `clip08` 0.810 → 0.948 (apex 54 → 21 px), `ge_venue_027_clip35` +0.09; Sonosite and every GE clip bit-identical; `bfly_z2b` −0.010 (its header line had been anchoring the hull by luck — see the Butterfly caveat).
- **`fan_reseed_above_arc`** (§1e): once `rin_coverage` has placed the arc, everything above it is cropped from the support and the fan is seeded again on what is left (once; `RESEED_MIN_FRAC 0.5 %`). `clip06`: apex 124 → 1 px, half 24.4° → 28.8° (Andre 29.8°), 0.827 → 0.934; `clip07` (test) passes at 0.974. Sonosite fans (the guard): 0 change on every parameter on `clip07/09` (tune) and `clip06/08` (test); `mindray_079_clip05` moved 8 px in apex (Andre's reference for it *is* the pass-1 fit) and stays tolerant at 0.986.

Result on the Mindray family: `clip05/07` pass, `clip06` 0.934 (leak_core6 1.9 %), `clip08` 0.948 (1.8 %), `clip04` 0.916 (4.8 %, unchanged — its hull was not anchored on text; the leak is the two top corners), `clip09` (test) 0.869. All six now have the apex within 1–46 px and the half-angle within 1.5° (was 124 px / 5.4°). Andre's bottom arc on these sits 15–22 px *above* the fit's: the 720×540 frame clips the fan flat at the bottom, the model bulges below the frame, Andre stops at the frame — no image pixels are involved either way.

**1b. The marker above the arc (`bfly_z3`, test half).** Diagnosed, not fixed. The coverage rule does not fire on `bfly_z3` at all: the near field is sparse (per-ring fill 0.54–0.78, coverage 0.54–0.71 below the header line), so no radius reaches ≥ 80 % of the bins sustained, and `r_in` falls back to the 0.3 polar percentile — the frame top, with the "TIS / MI / Lung" line inside the kept region. The line is as dense as the image at 4× and is *connected* to it in the density map, so neither §1b's isolated-blob rule nor `drop_small_blobs` can see it. A geometric test (a horizontal band vs an arc: per-angular-bin mean y flat vs varying by `r_in·(1 − cos half)`) was implemented and removed again — on the only clip it was for, the ring the rule lands on is clipped by the frame top and the test cannot run. After the re-seed `bfly_z3` reads 0.921 / leak_core6 8 % (was 0.960 / 16 %): the leak halved, the IoU fell. **This is the top residual PHI-adjacent miss: a header line directly above a sparse Butterfly near field is kept.** It is the case for 2C's template library (B4), and for 2B showing the proposal for review rather than applying it.

**1c. Band consistency (GE `9829885245`, `4351124429`).** Implemented as specified (per-side Theil–Sen on the clean band, rows with residual > `SIDE_RESID_PX` dropped, one refit, narrower-side mirroring at > 10 % disagreement) and **rejected by its own guard**: passing GE traps moved up to 63 px (`7568291120` w_bottom +63, `8467618784` +39, `4792415724` +18; limit 2 px), two tune-half passes fell (`7568291120` leak_core6 5.4 %, `8467618784` 1.3 %), the mirroring never triggered, and the two target clips barely moved (`9829885245` 19.0° → 21.7°, Andre 29°; `4351124429` unchanged at 9.7°). Toggle left in the code as `band_consistency: False`.

**1d. Two leak-only near-misses.** `Normal_Lung_sliding` (leak_core6 1.8 %, the Venue image fades in over 36 px): the fill measured on the **density mask** instead of the raw mask — rejected, it shifts every GE and Venue top by 8–10 px (tune 17 → 10). `sonosite_011_clip08` (far-field completion 24 px past Andre): **`R_PROFILE_MIN 0.12 → 0.15` adopted** — no tune-half fan moved under it (every Δ depth identical, table in §3), so "no clip falls" holds trivially; on the test half `clip08` still reads Δ depth −24 / leak_core6 1.3 % — the threshold change did not reach its profile either. Neutral, kept for the reason stated in the doc.

**Not in this pass, as stated:** Butterfly depth (`bfly_z2b` +79, `bfly_z7` +30/+134 — no pixel evidence), `sector_unknown_vendor` (still the one sector miss; the three Sonosite cardiac clips pass at 0.978–0.987 after the re-review), the three support failures, `fan_wider_side`.

**Butterfly caveat (read before quoting the Butterfly numbers).** `bfly_frame_000089` and `bfly_frame_000092` pass the tolerant rule with the re-seeded fan, but the *parametrisation* is far from Andre's: apex 237 / 31 px lower, half-angle 30° / 28° vs his 21° / 28°, r_out +232 / +15. The re-seeded cone hugs the visible speckle (the lateral near field is dark on Butterfly, so the true cone is wider than what is visible); the **mask** overlaps Andre's at IoU 0.915 / 0.941 with leak_core6 < 1 % — fail-closed — while the **controls** in 2B would need a 200-px apex move to reach his cone. `bfly_z2b` / `bfly_z2` / `bfly_z3` / `bfly_z7` fail. This is exactly B4's territory: one saved cone per Butterfly export geometry covers the family.

## 3. Tables (per clip, tune before → after; test once; attribution)

### Tune half (25 clips) — before (pass-2 fits, archived `bench/_before_pass3/`) → after (pass-3 rules), scored against Andre's saved shape

| clip | family | model | Δ half ° | Δ apex px | Δ arc px | Δ w_top px | Δ depth px | IoU | leak_core6 | over_core6 | tolerant | controls-only | which rule moved it (Δ IoU vs all-rules-off) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bfly_frame_000089 | butterfly_fan | fan_sym → fan_sym | -1.1 → **-9.1** | 0 → **237** | +12 → **+8** | -4 → **+142** | +0 → **+232** | 0.961 → **0.915** | 0.027 → **0.009** | 0.000 → **0.056** | ✗ → ✅ | ✗ → ✅ (half, apex, w_top, depth) | rin_coverage +0.012, fan_axis_mid +0.044, fan_wider_side -0.025 |
| bfly_z2b | butterfly_fan | fan_sym → fan_sym | +2.1 → **-10.8** | 23 → **221** | +1 → **-2** | +5 → **+151** | +79 → **+319** | 0.848 → **0.815** | 0.000 → **0.002** | 0.137 → **0.168** | ✗ → ✗ | ✗ → ✗ (half, apex, w_top, depth) | rin_coverage +0.021, fan_axis_mid +0.006, drop_small_blobs -0.010, fan_wider_side -0.014 |
| bfly_z7 | butterfly_fan | fan_sym → fan_sym | +1.0 → **+0.8** | 4 → **93** | +5 → **-4** | +59 → **+60** | +30 → **+134** | 0.764 → **0.754** | 0.000 → **0.000** | 0.199 → **0.209** | ✗ → ✗ | ✗ → ✗ (apex, w_top, depth) | rin_coverage +0.024, fan_wider_side -0.005 |
| mindray_079_clip05_copy | curved_fan | fan_sym → fan_sym | +0.0 → **-0.3** | 0 → **8** | -8 → **-8** | -8 → **-2** | +0 → **+8** | 0.992 → **0.986** | 0.000 → **0.000** | 0.002 → **0.001** | ✅ → ✅ | ✅ → ✅ | rin_coverage -0.008, fan_wider_side -0.065 |
| sonosite_011_clip07_copy | curved_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 10 → **10** | -1 → **-1** | -8 → **-8** | +0 → **+0** | 0.971 → **0.971** | 0.003 → **0.003** | 0.004 → **0.004** | ✅ → ✅ | ✅ → ✅ (apex, w_top) | fan_wider_side +0.008 |
| sonosite_011_clip09_copy | curved_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 0 → **0** | -8 → **-8** | -7 → **-7** | +0 → **+0** | 0.996 → **0.996** | 0.000 → **0.000** | 0.001 → **0.001** | ✅ → ✅ | ✅ → ✅ | fan_wider_side -0.005 |
| ge_e9_4515056095 | ge_e9_rect | rect → rect | +0.0 → **+0.0** | 9 → **8** | -8 → **-8** | -0 → **-4** | +2 → **+0** | 0.994 → **0.996** | 0.000 → **0.000** | 0.000 → **0.000** | ✅ → ✅ | ✅ → ✅ (apex) | t0_depth_rect +0.107 |
| ge_e9_0099279841 | ge_e9_trap | trap_sym → trap_sym | +2.0 → **+2.0** | 2 → **2** | +2 → **+2** | -13 → **-13** | +36 → **+36** | 0.925 → **0.924** | 0.000 → **0.000** | 0.058 → **0.058** | ✅ → ✅ | ✅ → ✅ (half, w_top, depth) | top60 +0.012 |
| ge_e9_0929223627 | ge_e9_trap | trap_sym → trap_sym | -0.0 → **-0.0** | 4 → **4** | +2 → **+2** | +3 → **+3** | +11 → **+11** | 0.972 → **0.972** | 0.000 → **0.000** | 0.010 → **0.010** | ✅ → ✅ | ✅ → ✅ | top60 +0.022, band_consistency -0.006 |
| ge_e9_2124113685 | ge_e9_trap | trap_sym → trap_sym | +0.4 → **+0.4** | 0 → **0** | +0 → **+0** | -12 → **-12** | +42 → **+42** | 0.916 → **0.914** | 0.000 → **0.000** | 0.069 → **0.069** | ✅ → ✅ | ✅ → ✅ (w_top, depth) | top60 +0.016, band_consistency +0.008 |
| ge_e9_4792415724 | ge_e9_trap | trap_sym → trap_sym | -1.0 → **-1.0** | 5 → **5** | +0 → **+0** | -2 → **-2** | +27 → **+27** | 0.940 → **0.940** | 0.004 → **0.004** | 0.042 → **0.042** | ✅ → ✅ | ✅ → ✅ (depth) | top60 +0.017 |
| ge_e9_7568291120 | ge_e9_trap | trap_sym → trap_sym | +5.0 → **+5.0** | 4 → **4** | +2 → **+2** | -12 → **-12** | +8 → **+8** | 0.963 → **0.963** | 0.000 → **0.000** | 0.014 → **0.014** | ✅ → ✅ | ✅ → ✅ (half, w_top) | — |
| ge_e9_8467618784 | ge_e9_trap | trap_sym → trap_sym | -1.7 → **-1.7** | 3 → **3** | +2 → **+2** | -6 → **-6** | +32 → **+32** | 0.923 → **0.922** | 0.006 → **0.006** | 0.051 → **0.051** | ✅ → ✅ | ✅ → ✅ (half, depth) | top60 +0.022 |
| ge_e9_8627400845 | ge_e9_trap | trap_sym → trap_sym | +0.9 → **+0.9** | 3 → **3** | +2 → **+2** | -5 → **-5** | +37 → **+37** | 0.924 → **0.922** | 0.000 → **0.000** | 0.061 → **0.061** | ✅ → ✅ | ✅ → ✅ (depth) | top60 +0.010 |
| ge_e9_9033982512 | ge_e9_trap | trap_sym → trap_sym | -0.3 → **-0.3** | 3 → **3** | +2 → **+2** | -9 → **-9** | +32 → **+32** | 0.928 → **0.928** | 0.003 → **0.003** | 0.052 → **0.052** | ✅ → ✅ | ✅ → ✅ (w_top, depth) | top60 +0.031 |
| bfly_z9 | support_failure | rect → rect | — → **—** | — → **—** | — → **—** | -15 → **-15** | — → **—** | 0.193 → **0.193** | 0.000 → **0.000** | 0.802 → **0.802** | ✗ → ✗ | ✗ → ✗ (model, w_top) | top60 -0.030, band_consistency +0.069 |
| sonosite_011_clip11_copy | support_failure | trap_sym → trap_sym | +3.2 → **+3.2** | 58 → **58** | -52 → **-52** | +0 → **+0** | +41 → **+41** | 0.790 → **0.790** | 0.000 → **0.000** | 0.186 → **0.186** | ✗ → ✗ | ✗ → ✗ (half, apex, top, depth) | top60 +0.171 |
| Normal_Lung_sliding | venue_fan | fan_sym → fan_sym | +0.0 → **+0.0** | 2 → **2** | +7 → **+7** | +6 → **+6** | -21 → **-21** | 0.958 → **0.958** | 0.018 → **0.018** | 0.000 → **0.000** | ✗ → ✗ | ✗ → ✗ (depth) | rin_coverage +0.007 |
| ge_venue_027_clip31_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 1 → **1** | +1 → **+1** | -4 → **-4** | +0 → **+0** | 0.987 → **0.987** | 0.000 → **0.000** | 0.000 → **0.000** | ✅ → ✅ | ✅ → ✅ | top60 +0.278 |
| ge_venue_027_clip33_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 4 → **4** | -3 → **-3** | +4 → **+4** | +0 → **+0** | 0.983 → **0.983** | 0.000 → **0.000** | 0.000 → **0.000** | ✅ → ✅ | ✅ → ✅ | top60 +0.259 |
| ge_venue_027_clip35_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 4 → **4** | -3 → **-3** | -2 → **-2** | +0 → **+0** | 0.985 → **0.985** | 0.000 → **0.000** | 0.000 → **0.000** | ✅ → ✅ | ✅ → ✅ | top60 +0.245, band_consistency +0.015, drop_small_blobs +0.092 |
| mindray_027_clip30_copy | venue_mindray_rect | rect → rect | +0.0 → **+0.0** | 2 → **2** | -1 → **-1** | +4 → **+4** | +0 → **+0** | 0.987 → **0.987** | 0.000 → **0.000** | 0.000 → **0.000** | ✅ → ✅ | ✅ → ✅ | top60 +0.260 |
| mindray_079_clip04_copy | curved_fan | fan_sym → fan_sym | +1.5 → **+1.5** | 38 → **38** | +6 → **+6** | -23 → **-23** | -54 → **-54** | 0.916 → **0.916** | 0.048 → **0.048** | 0.000 → **0.000** | ✗ → ✗ | ✗ → ✗ (apex, w_top, depth) | fan_wider_side -0.062 |
| mindray_079_clip06_copy | curved_fan | fan_sym → fan_sym | +5.3 → **-1.0** | 124 → **1** | +9 → **+4** | -73 → **+1** | -139 → **-11** | 0.867 → **0.934** | 0.090 → **0.019** | 0.000 → **0.000** | ✗ → ✗ | ✗ → ✗ | rin_coverage +0.045, drop_small_blobs +0.037 |
| mindray_079_clip08_copy | curved_fan | fan_sym → fan_sym | -2.2 → **-1.2** | 54 → **21** | +13 → **+5** | -17 → **+22** | -41 → **+7** | 0.810 → **0.948** | 0.169 → **0.018** | 0.025 → **0.002** | ✗ → ✗ | ✗ → ✗ (apex, w_top) | rin_coverage +0.040, fan_axis_mid -0.127, drop_small_blobs +0.034, fan_wider_side +0.014 |

#### Tune half — family summary BEFORE (pass-2 fits)

| family | n | tolerant | controls-only | IoU median | median \|Δ arc/top\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 3 | 0/3 | 0/3 | 0.8 | 5.0 | 4.6 | 1.1 | 30.0 | 1 |
| curved_fan | 6 | 3/6 | 3/6 | 0.9 | 8.0 | 12.5 | 0.7 | -20.5 | 3 |
| ge_e9_rect | 1 | 1/1 | 1/1 | 1.0 | 8.0 | 0.1 | 0.0 | 2.0 | 0 |
| ge_e9_trap | 8 | 8/8 | 8/8 | 0.9 | 2.0 | 7.2 | 1.0 | 32.2 | 0 |
| support_failure | 2 | 0/2 | 0/2 | 0.5 | 52.0 | 7.7 | 3.2 | 41.5 | 0 |
| venue_fan | 1 | 0/1 | 0/1 | 1.0 | 7.0 | 5.7 | 0.0 | -21.0 | 1 |
| venue_mindray_rect | 4 | 4/4 | 4/4 | 1.0 | 2.0 | 4.0 | 0.0 | 0.0 | 0 |

**tolerant 16/25 = 64 % · controls-only 16/25 = 64 %** · families below 50 %: butterfly_fan, support_failure, venue_fan

#### Tune half — family summary AFTER (pass-3 rules)

| family | n | tolerant | controls-only | IoU median | median \|Δ arc/top\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 3 | 1/3 | 1/3 | 0.8 | 4.5 | 142.0 | 9.1 | 232.0 | 0 |
| curved_fan | 6 | 3/6 | 3/6 | 1.0 | 5.5 | 7.6 | 0.6 | 0.0 | 3 |
| ge_e9_rect | 1 | 1/1 | 1/1 | 1.0 | 8.0 | 4.1 | 0.0 | 0.0 | 0 |
| ge_e9_trap | 8 | 8/8 | 8/8 | 0.9 | 2.0 | 7.2 | 1.0 | 32.2 | 0 |
| support_failure | 2 | 0/2 | 0/2 | 0.5 | 52.0 | 7.7 | 3.2 | 41.5 | 0 |
| venue_fan | 1 | 0/1 | 0/1 | 1.0 | 7.0 | 5.7 | 0.0 | -21.0 | 1 |
| venue_mindray_rect | 4 | 4/4 | 4/4 | 1.0 | 2.0 | 4.0 | 0.0 | 0.0 | 0 |

**tolerant 17/25 = 68 % · controls-only 17/25 = 68 %** · families below 50 %: butterfly_fan, support_failure, venue_fan

### Test half (25 clips) — scored once after the last tune-half change; before = pass-2 fit, shown only in the two status columns

| clip | family | model | conf | Δ half ° | Δ apex px | Δ arc px | Δ w_top px | Δ depth px | IoU | leak | over | leak_core6 | over_core6 | tolerant (before → after) | controls-only (before → after; beyond) | rules |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bfly_z2 | butterfly_fan | fan_sym | 0.84 | -4.9 | 163 | +8 | +117 | +242 | 0.812 | 0.007 | 0.185 | 0.004 | 0.167 | ✗ → ✗ | ✗ → ✗ (half, apex, top, w_top, depth) | rin_rule |
| bfly_z3 | butterfly_fan | fan_sym | 0.97 | -10.9 | 239 | +33 | +222 | +215 | 0.921 | 0.115 | 0.057 | 0.080 | 0.048 | ✗ → ✗ | ✗ → ✗ (half, apex, top, w_top, depth) | rin_rule |
| sonosite_011_clip06_copy | curved_fan | fan_sym | 0.99 | +0.0 | 0 | -8 | -7 | +0 | 0.996 | 0.000 | 0.004 | 0.000 | 0.001 | ✅ → ✅ | ✅ → ✅ | rin_rule |
| sonosite_011_clip08_copy | curved_fan | fan_sym | 0.99 | +0.0 | 13 | +4 | -7 | -24 | 0.961 | 0.027 | 0.000 | 0.013 | 0.000 | ✗ → ✗ | ✗ → ✗ (apex, depth) | rin_rule |
| ge_e9_8038110422 | ge_e9_rect | rect | 0.93 | +0.0 | 13 | -8 | +27 | +0 | 0.996 | 0.011 | 0.000 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ (apex, w_top) | t0_depth |
| ge_e9_0830106210 | ge_e9_trap | trap_sym | 0.88 | +2.0 | 2 | +2 | -13 | +23 | 0.947 | 0.007 | 0.047 | 0.000 | 0.034 | ✅ → ✅ | ✅ → ✅ (half, w_top, depth) | rin_rule |
| ge_e9_1657500391 | ge_e9_trap | trap_sym | 0.90 | +2.1 | 4 | +2 | -16 | +36 | 0.924 | 0.013 | 0.070 | 0.001 | 0.058 | ✅ → ✅ | ✅ → ✅ (half, w_top, depth) | rin_rule |
| ge_e9_4351124429 | ge_e9_trap | trap_sym | 0.76 | +12.1 | 11 | +2 | -78 | -12 | 0.900 | 0.058 | 0.063 | 0.033 | 0.055 | ✗ → ✗ | ✗ → ✗ (half, apex, w_top) | rin_rule |
| ge_e9_8314945226 | ge_e9_trap | trap_sym | 0.85 | +3.8 | 4 | +4 | -25 | +42 | 0.903 | 0.013 | 0.087 | 0.002 | 0.072 | ✅ → ✅ | ✅ → ✅ (half, w_top, depth) | rin_rule |
| ge_e9_8606662546 | ge_e9_trap | trap_sym | 0.89 | -0.3 | 3 | +2 | +1 | +37 | 0.923 | 0.011 | 0.072 | 0.000 | 0.061 | ✅ → ✅ | ✅ → ✅ (depth) | rin_rule |
| ge_e9_8889956621 | ge_e9_trap | trap_sym | 0.89 | -0.7 | 5 | +0 | -6 | +29 | 0.937 | 0.014 | 0.056 | 0.005 | 0.046 | ✅ → ✅ | ✅ → ✅ (depth) | rin_rule |
| ge_e9_9829885245 | ge_e9_trap | trap_sym | 0.77 | +8.0 | 11 | -2 | -40 | +68 | 0.843 | 0.007 | 0.152 | 0.004 | 0.134 | ✗ → ✗ | ✗ → ✗ (half, apex, w_top, depth) | rin_rule |
| sector_unknown_vendor | sector | fan_sym | 0.98 | +2.6 | 45 | +9 | -6 | -8 | 0.895 | 0.058 | 0.081 | 0.039 | 0.069 | ✗ → ✗ | ✗ → ✗ (half, apex, top) | rin_rule |
| sonosite_011_clip10_copy | support_failure | trap_sym | 0.85 | +20.2 | 64 | -50 | -46 | +394 | 0.297 | 0.003 | 0.702 | 0.002 | 0.694 | ✗ → ✗ | ✗ → ✗ (half, apex, top, w_top, depth) |  |
| kidney_copy | venue_fan | fan_sym | 0.99 | -1.2 | 6 | +10 | +20 | +2 | 0.972 | 0.004 | 0.002 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ (top, w_top) | rin_rule |
| ge_venue_027_clip32_copy | venue_mindray_rect | rect | 0.92 | +0.0 | 2 | -2 | -1 | +0 | 0.991 | 0.002 | 0.004 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ |  |
| ge_venue_027_clip34_copy | venue_mindray_rect | rect | 0.80 | +0.0 | 2 | -2 | +7 | -21 | 0.920 | 0.012 | 0.028 | 0.009 | 0.000 | ✅ → ✅ | ✅ → ✅ (depth) |  |
| ge_venue_027_clip36_copy | venue_mindray_rect | rect | 0.94 | +0.0 | 2 | -2 | -10 | +0 | 0.971 | 0.011 | 0.004 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ (w_top) |  |
| mindray_079_clip07_copy | curved_fan | fan_sym | 0.98 | +0.2 | 8 | +7 | -0 | -5 | 0.974 | 0.019 | 0.006 | 0.001 | 0.000 | ✗ → ✅ | ✗ → ✅ (apex) | rin_rule |
| mindray_079_clip09_copy | curved_fan | fan_sym | 0.89 | -0.3 | 46 | +3 | +39 | +20 | 0.869 | 0.059 | 0.088 | 0.027 | 0.075 | ✗ → ✗ | ✗ → ✗ (apex, w_top, depth) | rin_rule |
| bfly_frame_000092 | butterfly_fan | fan_sym | 0.87 | +0.1 | 31 | -2 | +22 | +15 | 0.941 | 0.025 | 0.040 | 0.008 | 0.032 | ✗ → ✅ | ✗ → ✅ (apex, w_top, depth) | rin_rule |
| sonosite_011_clip05_copy | curved_fan | fan_sym | 0.98 | +1.1 | 31 | -2 | -18 | -31 | 0.984 | 0.005 | 0.009 | 0.000 | 0.001 | ✅ → ✅ | ✅ → ✅ (apex, w_top, depth) | rin_rule |
| sonosite_011_clip12_copy | sector | fan_sym | 0.98 | +0.5 | 7 | -2 | -10 | -9 | 0.987 | 0.004 | 0.003 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ (w_top) | rin_rule |
| sonosite_011_clip13_copy | sector | fan_sym | 0.99 | +0.1 | 6 | -2 | -10 | -1 | 0.978 | 0.004 | 0.013 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ (w_top) | rin_rule |
| sonosite_011_clip14_copy | sector | fan_sym | 0.99 | +0.2 | 7 | -2 | -11 | -2 | 0.978 | 0.005 | 0.012 | 0.000 | 0.000 | ✅ → ✅ | ✅ → ✅ (w_top) | rin_rule |

#### Test half — family summary BEFORE (pass-2 fits)

| family | n | tolerant | controls-only | IoU median | median \|Δ arc/top\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 3 | 0/3 | 0/3 | 0.9 | 9.0 | 28.5 | 1.9 | -57.0 | 2 |
| curved_fan | 5 | 2/5 | 2/5 | 1.0 | 4.0 | 18.1 | 0.4 | -24.0 | 3 |
| ge_e9_rect | 1 | 1/1 | 1/1 | 1.0 | 8.0 | 30.8 | 0.0 | 2.0 | 0 |
| ge_e9_trap | 7 | 5/7 | 5/7 | 0.9 | 2.0 | 16.0 | 2.1 | 36.0 | 1 |
| sector | 4 | 3/4 | 3/4 | 1.0 | 0.0 | 49.9 | 2.3 | -48.8 | 1 |
| support_failure | 1 | 0/1 | 0/1 | 0.3 | 50.0 | 45.8 | 20.2 | 393.9 | 0 |
| venue_fan | 1 | 1/1 | 1/1 | 1.0 | 8.0 | 0.0 | 0.0 | -14.0 | 0 |
| venue_mindray_rect | 3 | 3/3 | 3/3 | 1.0 | 2.0 | 6.8 | 0.0 | 0.0 | 0 |

**tolerant 15/25 = 60 % · controls-only 15/25 = 60 %** · families below 50 %: butterfly_fan, curved_fan, support_failure

#### Test half — family summary AFTER (pass-3 rules, scored once)

| family | n | tolerant | controls-only | IoU median | median \|Δ arc/top\| px | median \|Δ w_top\| px | median \|Δ half\| ° | median Δ depth px | leak_core6 > 1 % |
|---|---|---|---|---|---|---|---|---|---|
| butterfly_fan | 3 | 1/3 | 1/3 | 0.9 | 8.5 | 116.7 | 4.9 | 215.0 | 1 |
| curved_fan | 5 | 3/5 | 3/5 | 1.0 | 4.0 | 7.3 | 0.2 | -4.9 | 2 |
| ge_e9_rect | 1 | 1/1 | 1/1 | 1.0 | 8.0 | 26.8 | 0.0 | 0.0 | 0 |
| ge_e9_trap | 7 | 5/7 | 5/7 | 0.9 | 2.0 | 16.0 | 2.1 | 36.0 | 1 |
| sector | 4 | 3/4 | 3/4 | 1.0 | 2.4 | 9.7 | 0.3 | -4.8 | 1 |
| support_failure | 1 | 0/1 | 0/1 | 0.3 | 50.0 | 45.8 | 20.2 | 393.9 | 0 |
| venue_fan | 1 | 1/1 | 1/1 | 1.0 | 10.3 | 19.8 | 1.2 | 2.0 | 0 |
| venue_mindray_rect | 3 | 3/3 | 3/3 | 1.0 | 2.0 | 6.8 | 0.0 | 0.0 | 0 |

**tolerant 17/25 = 68 % · controls-only 17/25 = 68 %** · families below 50 %: butterfly_fan, support_failure

### Attribution (tune half): Δ IoU of each rule alone vs all rules off (baseline = every RULES toggle off; the trapezoid band seed and the fill test are not toggles and stay on)

| clip | all-off IoU | top60 | rin_coverage | fan_axis_mid | fan_reseed_above_arc | band_consistency | drop_small_blobs | fan_wider_side | t0_depth_rect | conf_bbox | all rules | tolerant all-off → all rules |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bfly_frame_000089 | 0.914 | +0.000 | +0.012 | +0.044 | +0.000 | +0.000 | +0.000 | -0.025 | +0.000 | +0.000 | 0.915 | ✗ → ✅ |
| bfly_z2b | 0.821 | +0.000 | +0.021 | +0.006 | +0.000 | +0.000 | -0.010 | -0.014 | +0.000 | +0.000 | 0.815 | ✗ → ✗ |
| bfly_z7 | 0.741 | +0.000 | +0.024 | +0.000 | +0.000 | +0.000 | +0.000 | -0.005 | +0.000 | +0.000 | 0.754 | ✗ → ✗ |
| mindray_079_clip05_copy | 1.000 | +0.000 | -0.008 | +0.000 | +0.000 | +0.000 | +0.000 | -0.065 | +0.000 | +0.000 | 0.986 | ✅ → ✅ |
| sonosite_011_clip07_copy | 0.968 | +0.000 | +0.003 | +0.000 | +0.000 | +0.000 | +0.000 | +0.008 | +0.000 | +0.000 | 0.971 | ✅ → ✅ |
| sonosite_011_clip09_copy | 1.000 | +0.000 | -0.004 | +0.000 | +0.000 | +0.000 | +0.000 | -0.005 | +0.000 | +0.000 | 0.996 | ✅ → ✅ |
| ge_e9_4515056095 | 0.885 | +0.003 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.107 | +0.000 | 0.996 | ✗ → ✅ |
| ge_e9_0099279841 | 0.912 | +0.012 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.924 | ✗ → ✅ |
| ge_e9_0929223627 | 0.950 | +0.022 | +0.000 | +0.000 | +0.000 | -0.006 | +0.000 | +0.000 | +0.000 | +0.000 | 0.972 | ✗ → ✅ |
| ge_e9_2124113685 | 0.898 | +0.016 | +0.000 | +0.000 | +0.000 | +0.008 | +0.000 | +0.000 | +0.000 | +0.000 | 0.914 | ✗ → ✅ |
| ge_e9_4792415724 | 0.923 | +0.017 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.940 | ✗ → ✅ |
| ge_e9_7568291120 | 0.963 | +0.000 | +0.000 | +0.000 | +0.000 | -0.001 | +0.000 | +0.000 | +0.000 | +0.000 | 0.963 | ✗ → ✅ |
| ge_e9_8467618784 | 0.900 | +0.022 | +0.000 | +0.000 | +0.000 | -0.001 | +0.000 | +0.000 | +0.000 | +0.000 | 0.922 | ✗ → ✅ |
| ge_e9_8627400845 | 0.912 | +0.010 | +0.000 | +0.000 | +0.000 | -0.005 | +0.000 | +0.000 | +0.000 | +0.000 | 0.922 | ✗ → ✅ |
| ge_e9_9033982512 | 0.898 | +0.031 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.928 | ✗ → ✅ |
| bfly_z9 | 0.223 | -0.030 | +0.000 | +0.000 | +0.000 | +0.069 | +0.000 | +0.000 | +0.000 | +0.000 | 0.193 | ✗ → ✗ |
| sonosite_011_clip11_copy | 0.619 | +0.171 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.790 | ✗ → ✗ |
| Normal_Lung_sliding | 0.951 | +0.000 | +0.007 | +0.000 | +0.000 | +0.000 | +0.000 | -0.005 | +0.000 | +0.000 | 0.958 | ✗ → ✗ |
| ge_venue_027_clip31_copy | 0.708 | +0.278 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.987 | ✗ → ✅ |
| ge_venue_027_clip33_copy | 0.724 | +0.259 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.983 | ✗ → ✅ |
| ge_venue_027_clip35_copy | 0.740 | +0.245 | +0.000 | +0.000 | +0.000 | +0.015 | +0.092 | +0.000 | +0.000 | +0.000 | 0.985 | ✗ → ✅ |
| mindray_027_clip30_copy | 0.726 | +0.260 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | 0.987 | ✗ → ✅ |
| mindray_079_clip04_copy | 0.916 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | +0.000 | -0.062 | +0.000 | +0.000 | 0.916 | ✗ → ✗ |
| mindray_079_clip06_copy | 0.827 | +0.000 | +0.045 | +0.000 | +0.000 | +0.000 | +0.037 | +0.002 | +0.000 | +0.000 | 0.934 | ✗ → ✗ |
| mindray_079_clip08_copy | 0.908 | +0.000 | +0.040 | -0.127 | +0.000 | +0.000 | +0.034 | +0.014 | +0.000 | +0.000 | 0.948 | ✗ → ✗ |

**Regression rule (no tune-half clip that passed may fall):** none fell — checked against the pass-2 fits and the all-rules-off run.

### All 50 scored references (51 minus `ge_e9_6193094661`, reference check)

| | tolerant | controls-only |
|---|---|---|
| tune (25) | 17/25 | 17/25 |
| test (25) | 17/25 | 17/25 |
| all 50 | **34/50 = 68 %** | **34/50** |
| pass-2 fits, same 50 | 31/50 | 31/50 |

Estimator: clips that are controls-only but NOT tolerant (i.e. the estimator adds them): none. Clips with exactly one parameter beyond tolerance but failing IoU ≥ 0.80 / leak: [('Normal_Lung_sliding', ['depth'])].


**1d table — every tune-half fan's Δ depth under `R_PROFILE_MIN` 0.12 vs 0.15:** identical on all 11 fans (`bfly_frame_000089` 0/0, `bfly_z2b` 79/79, `bfly_z7` 30/30, `mindray_079_clip04/05/06/08` −54/0/−11/+7 unchanged, `sonosite_011_clip07/09` 0/0, `Normal_Lung_sliding` −21/−21). The 0.15 gate did not move any far-field stop on the tune half.

**1c guard table — fit-parameter movement of every GE trapezoid/rect under `band_consistency` (full px, no references used):** `4515056095` 0, `0099279841` 4.4, `0929223627` 12.7, `2124113685` 5.4, `4792415724` 18.2, `7568291120` **63.0**, `8467618784` **38.9**, `8627400845` 14.5, `9033982512` 0 (tune); `8038110422` 0, `0830106210` 2.2, `1657500391` 0, `4351124429` 4.0, `6193094661` 26.0, `8314945226` 76.6, `8606662546` 0, `8889956621` 0, `9829885245` 62.5 (test). Guard: ≤ 2 px on passing traps → violated on 6 of 13.

## 4. Negatives

| clip | gate | background mode | background fraction | result |
|---|---|---|---|---|
| `screenrec_app_ui` | `background_not_dark` (`BG_MAX_LEVEL 48`) | 244 | 0.51 | withheld |
| `stock_demo_480p` | `no_background` (`BG_MIN_FRAC 0.10`) | 42 | 0.086 | withheld |
| `synthetic_slide_white` | `background_not_dark` | 255 | 0.85 | withheld |

Unchanged through all three passes (the background gates run before any support or rule); re-verified on the frozen code (`sandbox/results/2026-09-06_0931_bench.md`).

## 5. The controls-only estimator (§2)

Implemented in `tune.py`: a clip is *controls-only fixable* when it is tolerant, **or** IoU ≥ 0.80 and leak_core6 ≤ 1 % and exactly **one** parameter lies beyond tolerance (half ±1.5°, apex 8 px, top/arc 8 px, w_top 8 px, depth 12 px); the `beyond` list is printed per clip. On the frozen fits it adds **no clip** on either half: every failing clip has two or more parameters beyond tolerance (Andre's corrections typically move depth *and* width, or apex *and* arc), and the one clip with a single parameter beyond (`Normal_Lung_sliding`, depth) fails on leak_core6, not IoU. So controls-only = tolerant = 34/50 today. The five borderline clips for Andre's spot check, in the bench: `mindray_079_clip06` (0.934, leak 1.9 %), `mindray_079_clip08` (0.948, 1.8 %), `Normal_Lung_sliding` (0.958, 1.8 %), `sonosite_011_clip08` (0.961, 1.3 %), `ge_e9_9829885245` (0.843, over-blank). If he would click Accept-after-one-slider on them, the estimator's tolerances are too tight and the 90 % number should count them.

## 6. Residual misses at freeze (16 of 50), by cause

| cause | clips | what it is |
|---|---|---|
| Butterfly geometry beyond the visible speckle | `bfly_z2b`, `bfly_z2`, `bfly_z7`, `bfly_z3` (+ the parametrisation caveat on `000089`/`000092`) | depth and lateral edges Andre draws past the last not-background pixel; a header line inside a sparse near field on `z3` | 
| GE trapezoid side contamination the band cannot see | `ge_e9_4351124429` (merged vertical at top-left, half +12°), `ge_e9_9829885245` (gradual right-edge recession, half +8°, depth +68) | §1c as specified did not fix them and broke others |
| Mindray far-field/top corners | `mindray_079_clip04` (leak 4.8 % at the arc's ends), `clip06` (1.9 %), `clip08` (1.8 %), `clip09` (apex 46 px) | the re-seed fixed the sides; the arc ends and one apex remain |
| leak-only near-misses | `Normal_Lung_sliding` (1.8 %, fade-in top), `sonosite_011_clip08` (1.3 %, far field) | one slider each in 2B |
| sector | `sector_unknown_vendor` (apex 45 px) | n = 1 layout |
| support failures | `bfly_z9`, `sonosite_011_clip10`, `sonosite_011_clip11` | frame 1 does not show the cone — B6 temporal support |

T2ext for the record (frozen code): 50 % / 60 % agreement (tune / test) — unchanged conclusion, not offered.

## 7. Freeze

`scripts/automask_spike/CONSTANTS.md` is marked **FROZEN 2026-09-06** with the numbers above (tolerant and controls-only, both halves and all 50), the frozen `RULES` (`top60`, `rin_coverage`, `fan_axis_mid`, `fan_reseed_above_arc`, `drop_small_blobs`, `t0_depth_rect`, `conf_bbox` on; `fan_wider_side`, `band_consistency` off), the support pipeline in order, every constant, and the evaluated-and-rejected list with numbers. The bench fixtures were regenerated from the frozen code (`bench.py --recompute`, 54 clips, `sandbox/results/2026-09-06_0931_bench.md`); the pages carry the reference-check banner on `ge_e9_6193094661`. Pass-2 proposals are archived in `sandbox/bench/_before_pass3/`.

Next, per `AUTOMASK_PASS3.md` §4: **Round 2A** against `AUTOMASK_ROUND2A_PROPOSAL.md` v2 (this session; entry condition met; item 5 merges first). The Butterfly-depth gap and the support failures are the first cases for the 2C template library (B4) and temporal support (B6) — `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md`.

## 8. Files

- `scripts/automask_spike/automask_spike.py` — `drop_small_blobs` (`clean_support`, `BLOB_FRAC`, `last_removed` / `last_region` / `last_blobs`), `fan_reseed_above_arc` (`fit_fan_sym`, `RESEED_MIN_FRAC`), `band_consistency` (off), `TRAP_DEPTH` variants `image_rows` / `profile` (evaluated), `TOP_FILL_SRC`, `R_PROFILE_MIN 0.15`.
- `scripts/automask_spike/tune.py` — `--half reference_check`, exclusion of `split.json → reference_check`, the §2 controls-only estimator (`beyond`, `controls_only`) per clip and per family.
- `scripts/automask_spike/bench.py` — reference-check banner on the page and exclusion + line in `--report`.
- `scripts/automask_spike/CONSTANTS.md` — **FROZEN**.
- `sandbox/split.json` (formerly blocked clips placed; `reference_check`), `sandbox/bench/_before_pass3/`, `sandbox/results/2026-09-06_0931_bench.md`.
- `docs/refactor/AUTOMASK_PASS3.md`, `AUTOMASK_POST_REREVIEW_NOTES.md` (copied), `AUTOMASK_ROUND2A_PROPOSAL.md` (v2), `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md`, this report.

```bash
python3 masquerade-aws-latest/scripts/automask_spike/tune.py --half all      # 34/50 on the frozen code (reference check excluded)
```
```bash
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --serve        # bench v4 — ge_e9_6193094661 shows the reference-check banner
```
