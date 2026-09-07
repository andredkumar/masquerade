# Auto-mask — pass 2 prep report (bench fix, top-width control, new vendors)

**Date:** 2026-09-05. **Governs:** `AUTOMASK_PASS2_PREP.md` (copied into this folder). **No fit or constant changes; no app code** (`tsc` untouched). `CONSTANTS.md` stays CANDIDATE.

## 1. The STALE bug — what it actually was

**Not caching.** Every one of Andre's 18 saves in `sandbox/bench/reviews.json` carries `reference: 'full-parametric'`, `shape_fit`, `shape_user` and `deltas` (checked key by key; timestamps 2026-09-06 00:17–00:25 Z, i.e. 17:17–17:25 local, the session that produced `results/2026-09-05_1726_bench.md`). The page he used was the controls bench, and he used the controls (Δ depth up to +79 px, Δ top up to +65 px, half-angle changes of 0.4–11°).

The report marked them STALE because `bench.py --report` compared `shape_fit` to the proposal with **JSON string equality**. The browser serialises `160.0` as `160`; Python reloads that as an `int` and dumps `160`, while the proposal's `160.0` dumps as `160.0` → unequal → STALE on every row. My bug, in the scorer, not in the page.

Fixed: `shapes_match()` compares shape parameters numerically (relative tolerance 1e-6; the same tolerance is used in `review.js` when it decides whether to reload a previous review). Re-running `--report` with no other change scores all 18 (§4).

The §1 hardening was still done, because the failure mode the prep describes is real and would have been silent:
- **Cache-busting:** every static asset is referenced as `?v=<newest mtime of shape.js / review.js / style.css>`; the bench server sends `Cache-Control: no-store, max-age=0` and `Pragma: no-cache` on every response (`end_headers` override).
- **Loud save validation:** `POST /review` refuses (400, JSON error) any payload without `reference: 'full-parametric'`, `shape_fit`, `shape_user`, `deltas` with the four keys, and `bench_version` (withheld verdicts are exempt from the shape fields); refusals are logged. The page also refuses to send if the controls are missing, and shows the server's error text instead of "Saved". A save from a page whose `bench_version` differs from the server's is accepted but logged.
- **Version stamp:** `bench v3 — controls (half-angle / top width / apex / depth), full-parametric saves` in the header of every review page and the index; `window.BENCH_VERSION` travels in each save.
- **Previous note:** shown under the note box and pre-filled, even when the fit has changed since (so nothing is retyped).
- Also fixed a `TypeError` in the server's request logger (`HTTPStatus` in `args`) that had been printing tracebacks into `_serve.log`.

Verified with curl: depth-only payload → 400 `refused: missing [...]`; full payload without `bench_version` → 400; `withheld_ok` without shapes → 200. `review.js` served with `Cache-Control: no-store`. Verified in the browser after `bench.py --pages` (new; rewrites every page — the cached clips' pages had been generated before the stamp existed): stamp shown, assets load as `shape.js?v=…`/`review.js?v=…`, a trapezoid page offers `top width (bottom stays)` and moving it re-renders (723 → 674 px), a fan page shows `212 px wide (r_in 280)`, Andre's previous review and note load onto the page, and a UI save on an unreviewed clip carries `bench_version`, `shape_user` and all five deltas (then removed).

## 2. Top-width control (prep §2)

- **Trapezoid:** new slider **top width (bottom stays)** = `w_top` about `cx`, `y_top` unchanged, `w_bottom` unchanged (so the side angle follows). `y_top` keeps its own slider. Rectangle keeps its single width slider.
- **Fan:** the `r_in` slider is labelled **top width (moves r_in, apex fixed)** and its readout shows `NNN px wide (r_in …)`, i.e. `2·r_in·sin(half)`, the width Andre sees.
- Every control reads `fitted → now (Δ)`; saves carry `d_top_width_px` (fans derived); the report has a **`Δ w_top px`** column (fans derived).

## 3. New clips (prep §3) — 23 files ingested, none withheld

`bench.py --ingest` (new) adds a manifest row for any file under `sandbox/clips/**` without one: `vendor` from the folder, `format`, `frames`, `w`, `h` from the file, `expected=propose` (`withhold` under `negative/`), `notes` marks the row as ingested; `probe`, `mode`, `depth_cm`, `furniture`, `phi_location` left for Andre. Existing rows untouched. 23 rows added (the 3 Sonosite PNGs on the first run, the 20 videos after a path bug in the ffprobe lookup was fixed). Corpus: **55 rows** — 51 positives, 4 negatives.

First sight (before any review; sheet `sandbox/bench/_first_sight_new_vendors.png`):

| vendor / layout | clips | model | half / side angle | asym ° | tilt ° | conf | gates |
|---|---|---|---|---|---|---|---|
| GE Venue `027_*` 1044×696 (12L, linear) | 6 | **rect** ×6 | 0° (−3.6…0) | −3.8…+1.7 | −2.4…+0.9 | 0.86–0.97 | none |
| Mindray `027_clip30` 1044×696 (linear) | 1 | rect | 0° | −0.9 | −0.4 | 0.97 | none |
| Mindray `079_*` 720×540 (curved) | 6 | fan_sym ×6 | 24.4–32.2° | −9.2…+3.6 | −1.8…+4.6 | 0.90–0.97 | none |
| Sonosite `011_*` 1400×1050 abdomen (curved) | 6 (incl. 2 PNG) | fan_sym ×6 | 26.4–27.1° | −3.0…−1.9 | +0.9…+1.5 | 0.98–0.99 | none |
| Sonosite `011_*` cardiac (sector) | 3 (incl. 1 PNG) | fan_sym ×3 | 33.2° | −2.6 | +1.3 | 0.97 | none |
| Sonosite `011_clip10/11` (short-depth, 8.7 cm) | 2 | trap_sym | 21.6° / 11.1° | **−10.7 / −25.0** | **+21.6 / −34.7** | 0.84 / 0.76 | none — but the asym/tilt say the support is poor; first candidates for "wrong" |

Reading: the background gates and the support step generalised to three unseen layouts without a change — every positive proposed, the two linear layouts came out as rectangles with |asym| < 4°, and the Sonosite/Mindray curved probes give consistent half-angles within a series (27° and 33° on Sonosite, 24–32° on Mindray). The two Sonosite short-depth clips are the ones to watch.

## 4. The 18 reviews, scored (`results/2026-09-05_1743_bench.md`, reference: full-parametric)

| | count |
|---|---|
| right / adjusted / wrong | 0 / 10 / 8 |
| tolerant rule with the **fitted** parameters (IoU ≥ 0.90 & leak_core6 ≤ 1 %) | **3 / 18** (`kidney_copy` 0.955, `ge_e9_2124113685` 0.908, `ge_e9_8038110422` 0.903) |
| kickoff clips | 2 / 7 |
| IoU fit vs Andre's shape ≥ 0.90 (any leak) | 12 / 18 — most misses fail on `leak_core6` 1–6 %, not IoU |

What the corrections say (this is the input to pass 2 proper, not acted on here):
- **GE E9 trapezoids (9 reviewed):** Andre lowered the top edge by 8–11 px on every one (`Δ top +8…+11`, `Δ w_top −8…−11`, sides kept), and extended depth +19 to +75 px. The half-angle was left within ±1° on 7 of 9. The fitted top edge sits on the `LOGIQ E9` label zone / near-field artefact; that 10 px is exactly the `leak_core6` 1–3 % that fails the tolerant rule.
- **Butterfly fans (5 reviewed):** `Δ top +35…+65` (he moved the inner arc deeper, i.e. wider top width +40…+68 px), half-angle +0.6…+3.9°, depth −25…+79. Notes say "top too wide / apex needs to be narrower", which reads as a request for a smaller *half-angle near the apex* — the control that shows width in px now exists, so the next review will say which.
- **`bfly_z9`:** IoU 0.29 — the symmetric trapezoid over the slanted echo band; Andre extended depth +413 px. Support problem, as flagged before.
- **`kidney_copy`, `Normal_Lung_sliding`:** "pretty close" — deltas within 14–39 px; `Normal_Lung_sliding` fails only on `leak_core6` 2.8 % (top +39 px).
- T2ext agreement: only 2 clips qualify (small angle/apex deltas); neither within 10 px. Too few to read.

## 5. Stop point

Bench fixed and stamped, the 18 reviews scored as valid, 23 new clips built with first-sight fits, `CONSTANTS.md` unchanged. **Now Andre's re-review:** all 55 (the 18 need re-saving only where he wants to use the new top-width control; the 33 unreviewed and the 23 new vendors are the real work). Freeze condition unchanged (addendum §5.5: ≥ 5/7 kickoff and ≥ 70 % of positives pass with the fitted parameters; negatives withheld).

```bash
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --serve     # look for the yellow "bench v3" stamp
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --report
```

Files: `bench.py` (numeric stale check, no-store, cache-bust, validation, stamp, `Δ w_top`, `--ingest`, ffprobe path), `bench_static/shape.js` (`w_top` control, fan top-width readout, `d_top_width_px`), `bench_static/review.js` (stamp, loud validation, previous note, `bench_version`), `bench_static/style.css`; sandbox `manifest.csv` (+23 rows), `bench/<new clips>/`, `bench/_first_sight_new_vendors.png`, `results/2026-09-05_1743_bench.md`.
