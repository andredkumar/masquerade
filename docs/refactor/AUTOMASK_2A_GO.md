# Auto-mask — Round 2A: GO (frozen constants 2026-09-06; re-review 2026-09-06_1041)

**Inputs:** `AUTOMASK_PASS3_REPORT.md`, `CONSTANTS.md` (FROZEN — rules unchanged), `AUTOMASK_ROUND2A_PROPOSAL.md` v2, `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md`, **`sandbox/results/2026-09-06_1041_bench.md`** (Andre's full re-review against the frozen fits).
**Decision:** 2A proposal v2 approved as written. Start the port. `tsc` 12 · A3 frozen · `AUTOMASK` default off · no UI · nothing in `client/` imports `shared/automask/`.

## 0. The numbers at freeze — updated by the re-review (constants did not change; references did)

| | value |
|---|---|
| Freshly judged against the frozen fits (33 clips) | **right 22 · adjusted 8 · wrong 3 → accept-or-controls 30/33 = 91 %** (Andre's target) |
| Tolerant with the fitted parameters, all 50 (`ge_e9_6193094661` still excluded) | **39/50 = 78 %** (was 34/50 at freeze — the difference is Andre's Accepts replacing older references) |
| Kickoff clips | 4/7 |
| Negatives | 3/3 withheld, same gates |
| The 3 "wrong" | `bfly_z9` (fit a **rect**, "not a box"), `sonosite_011_clip10` (fit a **trap** to a fan, "incorrect geometric shape"), `bfly_z7` (support failure) — two of three are **model-type** errors the controls cannot fix → B7 below |
| T2ext | 57 % / 56 % agreement — unchanged conclusion, not offered |

Actions from this: (a) `CONSTANTS.md` gets a dated "numbers at re-review" line under the freeze block — the rules stay frozen; (b) the 2A eval's `--bench` baseline is now **39/50** on the 2026-09-06_1041 references (snapshot `reviews.json` as `sandbox/bench/reviews_freeze.json` so row A12 has a fixed target); (c) the fixture `proposal.json`s are unchanged (same code).

## 1. Pre-step — item 5 error, reproduce before 2A code
Item 5 is implemented on `item5-rgb-dicom`, verified R1–R5 by harness, not deployed: Andre hit an error in a real session after a colour-Doppler upload whose extraction succeeded (`bg_extract.done 1/1 parity:true`), so the failure is downstream.
- Sandbox, on the branch, **through the real UI**: upload `ge_e9_6193094661.dcm` → Template Mask → header rectangle → Apply → download → open the ZIP. Same for the synthetic 3-frame RGB multiframe. Watch the browser console and server log for anything that is not `[PERF]`.
- Report what fails, the fix, `tsc` 12, R1 re-run (mono byte-identical). If nothing fails, say so and list the other paths Andre could have taken (AI spoke, image batch containing a `.dcm`).
- Item 5 ships on its own runbook (`ITEM5_DEPLOY_RUNBOOK.md`). Row A6 of 2A is conditional on it; nothing else is.

## 2. 2A — as proposed, plus these three lines
- **`shared/automask/constants.ts` is generated, not typed**: `automask_spike.py --dump-constants` (JSON) → script → `constants.ts`; a unit test compares them.
- **Known-limitations section in the 2A report carries, verbatim:** the Butterfly parametrisation caveat (pass-3 §2) and the two model-type misses above.
- **Grade thresholds exposed as tunables in the contract** (`info.grade_thresholds`) so 2B telemetry can set them without a contract change.

## 3. Addition to the 2B draft — **B7. Model switch**
The controls edit parameters; two of the three residual "wrong" verdicts are the wrong *shape family*. 2B adds a three-way switch **fan / trapezoid / rectangle** on the proposal bar. Switching re-seeds the new model from the current shape's geometry (fan → trap: top/bottom widths at `r_in`/`r_out` and the axis; trap → fan: apex from the side lines' intersection, radii from top/bottom; rect ↔ trap: equal widths), so the user lands close and adjusts, never starts from nothing. Telemetry logs the switch. Insert as B7 in `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md` §B; it is Andre's requirement from `2026-09-06_1041` (notes on `bfly_z9` and `sonosite_011_clip10`).

## 4. Sequence
1. Item 5 reproduction (§1) → report → Andre deploys via its runbook.
2. 2A port → fixture test (2 synthetic in git; 50 PHI fixtures behind `AUTOMASK_FIXTURES_DIR`) → service + route + PERF → eval → sandbox rows A1–A16 (A12 target: `--bench` = 39/50 on `reviews_freeze.json`) → `AUTOMASK_ROUND2A_REPORT.md` → runbook from me → deploy flag-off → prod row A2.
3. D5 in the sandbox with `AUTOMASK=1`: applied-mask eval on the seven kickoff clips.
4. 2B kickoff from the draft (§B + B7, verbatim) — not before 2A is green on prod.

## 5. Andre's two remaining to-dos
1. **`ge_e9_6193094661`** — still "wrong (fit changed since)", reference-check banner on its page. Confirm the wide cone or redo it; it re-enters the count either way.
2. **Item 5 error** — anything you recall (red toast, blank canvas, download failed) is one line for §1; otherwise the reproduction settles it.

The five-clip estimator spot check is done by this re-review: you accepted the fits on `Normal_Lung_sliding` and `mindray_079_clip06` as-is and adjusted `mindray_079_clip08` — the estimator's tolerances were too tight, and the 91 % on fresh judgements is the number that stands.

---
> Read `AUTOMASK_2A_GO.md` (updated). Record the re-review numbers in `CONSTANTS.md` (rules unchanged, still frozen) and snapshot `reviews.json` → `reviews_freeze.json` (39/50 baseline). Add **B7 model switch** to the 2B/2C draft §B verbatim from §3. **Pre-step first:** reproduce the item 5 error through the real UI in the sandbox on `item5-rgb-dicom` (§1), fix if anything fails, R1 re-run, `tsc` 12, stop for Andre's deploy. **Then Round 2A** per `AUTOMASK_ROUND2A_PROPOSAL.md` v2 with §2's three additions. Flag off, no UI, `tsc` 12, A3 frozen. Stop after `AUTOMASK_ROUND2A_REPORT.md` for the runbook.
