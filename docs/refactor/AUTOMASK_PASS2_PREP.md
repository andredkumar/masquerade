# Auto-mask — pass 2 prep (bench fix + top-width control + new clips). No algorithm change yet.

**Date:** 2026-09-05. **Input:** `sandbox/results/2026-09-05_1726_bench.md` — 18 verdicts, **all STALE**, Δ columns empty. Andre re-reviewed but the saves went out in the old depth-only format.

## 1. The STALE bug — find it, fix it, prove it
Most likely: Andre's browser served the cached first-session `review.js`/`shape.js`, so the page had only the depth slider and Save posted the old shape. Confirm by reading `reviews.json` (which keys are present per entry, and `updated_at`).
- Cache-bust every static asset (`?v=<mtime>` or a hash in the filename) and send `Cache-Control: no-store` from the bench server.
- Save must fail loudly if the payload lacks `shape_user` + the four deltas; the page must show a version stamp ("bench v3 — controls") at the top so a stale page is obvious at a glance.
- Keep the 18 notes: attach them to the clip pages as "previous note" so Andre doesn't retype them.
- `--report` stays labelled `full-parametric`; STALE rows stay excluded.

## 2. Top-width control (Andre's ask; the notes say the top is now the main complaint)
- **Trapezoid:** add `w_top` as its own slider (top edge width about `cx`, `y_top` unchanged, side angle recomputed so the bottom stays where it is). Keep `y_top`.
- **Fan:** the top width is `2·r_in·sin(half)`; label the existing `r_in` slider "top width" and show the width in px next to it, so the control matches what Andre sees. Apex stays fixed while it moves.
- Both: `fitted → now (Δ)` readout, and `Δ w_top px` in the report (fans: derived).

## 3. New clips
Andre added GE Venue, Mindray and Sonosite clips under `sandbox/clips/`. Add manifest rows with `vendor`, `format`, `frames`, `w`, `h`, `expected=propose` filled from the files (leave `probe`/`mode`/`depth_cm` for Andre); `bench.py` builds the new ones only. In the report, print the new vendors' fits (model, half-angle, asym, tilt, conf, gates hit) **before** Andre reviews — first sight of unseen layouts is the honest test of the support step and the background gates. Any withheld positive → components printed.

## 4. Not in this pass
No constant or fit changes. The fan half-angle seed (mean vs wider-side) and the top-edge estimate are pass 2 proper, decided by the full-parametric references this re-review produces. `CONSTANTS.md` stays CANDIDATE. No app code.

## 5. Stop point
Bench fixed and stamped, new clips built, first-sight table for the new vendors, then stop for Andre's re-review (all clips, including the new vendors). Freeze condition unchanged (addendum §5.5).

---
> Read `AUTOMASK_PASS2_PREP.md`. Andre's re-review saved as STALE — the page he had was the cached depth-only bench. Fix cache-busting + loud save validation + a visible version stamp (§1), add a real top-width control for trapezoids and relabel `r_in` as top width for fans (§2), ingest the new GE Venue / Mindray / Sonosite clips and report their first-sight fits (§3). No fit or constant changes. Stop for the re-review.
