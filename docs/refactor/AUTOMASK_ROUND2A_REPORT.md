# Auto-mask Round 2A — report: proposer + endpoint + eval, flag off, no UI

**Date:** 2026-09-06. **Governs:** `AUTOMASK_2A_GO.md` (decision: proposal v2 approved as written + §2's three additions). **Branch:** the work sits in the working tree on top of `item5-rgb-dicom` (`5a7526a`); item 5 itself is unchanged and ships on its own runbook (`ITEM5_DEPLOY_RUNBOOK.md`; reproduction `ITEM5_UI_REPRODUCTION.md` — nothing failed). **Invariants held:** `tsc --noEmit` = **12** (the same 5 `frameExtractor.ts` + 7 `maskWorker.ts`); A3 frozen (no schema, status, column or migration change); `AUTOMASK` default off; **no UI** and nothing under `client/` imports `shared/automask/` (the client bundle is byte-for-byte free of it, §6 A15). Runbook rows are in §6; Andre writes the deploy runbook from them.

## 0. What shipped

| piece | where | proof |
|---|---|---|
| the proposer as a pure-TS core (no DOM, no Node) | `shared/automask/` — `constants.ts` (generated), `types.ts`, `geometry.ts`, `support.ts`, `fan.ts`, `trap.ts`, `core.ts`, `render.ts`, `shape.ts` | **54 / 54 sandbox fixtures reproduce the frozen Python** (§2): IoU exactly 1.0000 on 49 of 51 shapes, ≥ 0.9943 on the other two; depth within 2 px everywhere; conf within 0.002; every negative withheld with the same gate |
| constants generated, not typed (GO §2) | `automask_spike.py --dump-constants` → `scripts/automask_eval/gen-constants.ts` → `constants.ts`; the dump is committed as `constants.frozen.json` | unit test compares the two key for key |
| server service, inline, cached on disk | `server/services/automask.ts` — `getOrComputeProposal(jobId)`; `temp_extracted/<jobId>/automask.json`; never regenerated; `no-store` | endpoint test with mocked storage (7 cases) + rows A1–A10, A16 |
| the route | `GET /api/jobs/:jobId/template-mask/proposal` (`server/routes.ts`, next to the job endpoint) | rows |
| `[PERF] automask.*` lines | `automask.start / done / served / skipped / t0_unavailable` | rows A2, A3, A9 |
| fixtures + tests | 2 synthetic non-PHI fixtures **in git** (`server/services/__tests__/fixtures/automask/`), 51 + 3 PHI fixtures behind `AUTOMASK_FIXTURES_DIR`; `automask.fixture.test.ts`, `automask.endpoint.test.ts` | both green (§3) |
| the eval | `scripts/automask_eval/run.ts` (+ `README.md`, `lib.ts`, `compare-fixtures.ts`, `make-synthetic.ts`) | `--bench` = **39 / 50** on `reviews_freeze.json` (row A12 target); `--db --server` scores the sandbox jobs against the masks applied; `--prev` detector proven (A14) |
| GO §2 additions | grade thresholds in the contract as `info.grade_thresholds`; known-limitations §5 verbatim; constants generated | this document |

## 1. The port — how the TypeScript reproduces OpenCV / numpy exactly

The Python spike is the reference; the port mirrors it step for step (`CONSTANTS.md` "Support pipeline"). The places where a port silently drifts, and what was done about each (all verified against cv2 on random inputs before the fixtures were run):

| operation | OpenCV / numpy behaviour reproduced | verified |
|---|---|---|
| `cv2.resize INTER_AREA` 4× | area average of the (fractional, when the size is not a multiple of 4: 873/218 = 4.0046) source box, **rounded half to even** | 0 diffs on a 400×600 random image (half-up rounding gave 472) |
| `cv2.boxFilter` density | integral image over **BORDER_REFLECT_101** padding; exact integer counts | max diff 0.0 |
| `MORPH_ELLIPSE` kernels 5 / 7 / 9 / 13 / 15 | footprints copied bit for bit; erode treats outside as 1, dilate as 0 | — |
| `cv2.floodFill` (fill_holes) | **4-connected**, seeded exactly as the spike does (corner + every w//32 / h//32 border pixel) | — |
| `cv2.convexHull` order | starts at max x (ties max y), same direction — `approxPolyDP` depends on `pt[0]` | 44 / 44 hulls in the same order |
| `cv2.approxPolyDP(closed)` | OpenCV's algorithm: 3 farthest-point rounds, stack order, the `|cross| ≤ eps·|chord|` test, the closed-curve clean-up with the ½·eps² factor | **44 / 44 identical vertex lists**, incl. the real supports |
| `cv2.fillPoly` (trapezoid raster) | FillEdgeCollection + the LINE_8 outline: 16-bit fixed-point edges from the upper vertex, **sampled half a row above the scanline**, spans `[ceil(xl), floor(xr)]`; the outline is `cv::Line`, i.e. **`cv::clipLine` first, then the LineIterator DDA** (its own tie-breaking) | outline: 400 / 400 segments = `cv2.line`; fill: **60 / 60** trapezoids identical (vertices leaving the frame horizontally included); 99 / 106 on a harsher set with vertices outside the frame vertically — single-pixel cases the fitter never produces |
| `np.percentile` / `np.median` / Theil–Sen subsample / `np.convolve('valid')` | linear interpolation; median of pairwise slopes over `dy > 0`; `linspace(0, n−1, 60).astype(int)`; first / last sustained window | — |
| BGR→GRAY | cv2's fixed-point `(R·4899 + G·9617 + B·1868 + 2¹³) >> 14` — the server decodes with `sharp(...).raw()` and applies this itself, so the grey the proposer sees is the spike's grey, not libvips' | — |

The rasteriser was the one that mattered: before the `clipLine` + half-row details, 46/54 fixtures passed and every miss was a GE trapezoid whose depth refinement had taken a different half-step (Δ y_bottom 2–6 px) or `bfly_z9`'s rectangle; with the exact fill all 54 pass and 49 shapes are pixel-identical.

## 2. Fixture comparison (`scripts/automask_eval/compare-fixtures.ts --dir ../sandbox/bench`)

Assertions per fixture (proposal v2 §3): same `model`, same `withheld`/`flag`, IoU ≥ 0.98 between the two full-resolution keep masks (both rendered by the TS renderer from their parameters, T0 box and 2-px margin applied), `|Δ r_out| ≤ 2` (fan) / `|Δ y_bottom| ≤ 2` (trap, rect), `|Δ conf| ≤ 0.02`; negatives withhold with the same reason.

| | result |
|---|---|
| fixtures | 54 (51 positives + 3 negatives; the sandbox `bench/<clip>/{frame1.png, proposal.json}` written by the frozen code) |
| within tolerance | **54 / 54** |
| IoU exactly 1.0000 | 49 / 51 shapes; the other two 0.9943 (`ge_e9_8467618784`) and 0.9962 (`ge_e9_4515056095`) |
| max \|Δ depth\| | 2 px (two GE rects, the T0 box bottom vs the 4×-grid rounding) |
| max \|Δ conf\| | 0.0019 |
| negatives | `screenrec_app_ui` → `background_not_dark`, `stock_demo_480p` → `no_background`, `synthetic_slide_white` → `background_not_dark` — same as Python |
| rules fired | identical where recorded (`axis`, `rin_rule`, `reseeded`, `trap_depth`, `t0_depth`, `union`) |
| time per frame (M4 Pro, cold JIT, decode excluded) | median 90 ms; 30–35 ms Venue rects (1044×696), 45–56 ms Mindray (720×540), 80–125 ms GE E9 (1164×873), 140–172 ms Sonosite 1400×1050 and the 1536×796 reference clip |

## 3. Tests

- `npx tsx server/services/__tests__/automask.fixture.test.ts` — constants.ts == constants.frozen.json (key for key, RULES included); the two synthetic fixtures; with `AUTOMASK_FIXTURES_DIR=../sandbox/bench` the 54 PHI fixtures (7.1 s). **3 / 3 pass**; without the variable the PHI test skips with a loud diagnostic.
- `npx tsx server/services/__tests__/automask.endpoint.test.ts` — flag off → `none/disabled` with no disk access and no log line; unknown job → `null` (route 404); frame not on disk → `pending`, nothing cached; happy path on the synthetic fan → `ready`, cache written, second call `automask.served`, corrupt cache replaced; image batch → frame 0 is `fileList[0]` from `uploads/`; white slide → `none/withheld: background_not_dark`, cached. **7 / 7 pass**; no database, no ffmpeg.
- Synthetic fixtures (`make-synthetic.ts`, deterministic LCG speckle): a 30° fan with two header lines above the arc, a glyph beside it and a depth ruler (the frozen code: `fan_sym`, conf 0.98, `rin_coverage` + `fan_reseed_above_arc` fire — at 24°/r_in 320 the trapezoid had won, so the geometry was chosen where the fan does); a trapezoid inside a T0 box with a label above the top, a greyscale bar merging at the left, echo-free corners and a caption below the box (`trap_sym`, conf 0.93, `T0T1`). Their expected `proposal.json` came from `automask_spike.py --propose-png`, i.e. from Python, never from the port.

## 4. Contract as shipped (§2.3 of the proposal, with the GO §2 additions)

`version: 2`; `status: ready | none | pending`; `reason: disabled | withheld | error | no_frame | null`; `withheld` (gate name, or `low_confidence` when conf < 0.70 with no gate); `keep` = `{kind:'fan', ax, ay, half_angle, r_in, r_out, th_l, th_r}` or `{kind:'trap'|'rect', cx, y_top, y_bottom, w_top, w_bottom}` in full-resolution pixels; `bound` + **`bound_source: dicom | unavailable | not_dicom`**; `tier: T1 | T0T1`; `model`; `confidence`; `grade: proposed | check_depth`; **`rules`** (the frozen toggles); **`info`** with the fit diagnostics, `constants_frozen: "2026-09-06"` and **`grade_thresholds`** = `{conf_min: 0.70, far_field_stop_frac: 0.70, masked_frac_fan: 0.55, masked_frac_trap: 0.50}` — the tunables 2B's telemetry will move without a contract change; `ms: {decode, propose, total}`; `createdAt`. `Cache-Control: no-store` on every response; HTTP 200 for `ready|none|pending`, 404 for an unknown job in both flag states (the lookup is a database read, not disk access). Only `ready` and withheld `none` results are cached; `pending`, `disabled` and `error` are not.

## 5. Known limitations (carried verbatim, GO §2)

**Butterfly parametrisation caveat (pass-3 report §2).** `bfly_frame_000089` and `bfly_frame_000092` pass the tolerant rule with the re-seeded fan, but the *parametrisation* is far from Andre's: apex 237 / 31 px lower, half-angle 30° / 28° vs his 21° / 28°, r_out +232 / +15. The re-seeded cone hugs the visible speckle (the lateral near field is dark on Butterfly, so the true cone is wider than what is visible); the **mask** overlaps Andre's at IoU 0.915 / 0.941 with leak_core6 < 1 % — fail-closed — while the **controls** in 2B would need a 200-px apex move to reach his cone. `bfly_z2b` / `bfly_z2` / `bfly_z3` / `bfly_z7` fail. This is exactly B4's territory: one saved cone per Butterfly export geometry covers the family.

**The two model-type misses (GO §0).** The 3 "wrong" verdicts of the 2026-09-06_1041 re-review: `bfly_z9` (fit a **rect**, "not a box"), `sonosite_011_clip10` (fit a **trap** to a fan, "incorrect geometric shape"), `bfly_z7` (support failure) — two of three are **model-type** errors the controls cannot fix → B7 (the fan / trapezoid / rectangle switch in the 2B draft).

Also inherited unchanged from the freeze: GE E9 trapezoid depth ~30 px shallower than Andre's (over-blank, one slider); a header line directly above a sparse Butterfly near field is kept (`bfly_z3`); the sector clip; the three support failures (B6).

## 6. Runbook rows (sandbox, this session)

All rows ran against the sandbox server (`PORT=5001 zsh scripts/sandbox/up.sh`, M4 Pro, Postgres 5433) on 2026-09-06; the six jobs are listed under the table. `ms_*` are the service's own numbers (`ms.propose` excludes the PNG decode).

| # | case | expected | observed |
|---|---|---|---|
| A1 | `AUTOMASK` unset (the sandbox env file's `AUTOMASK=1` commented out for this run), `GET …/proposal` on a ready DICOM job | `200 {status:'none', reason:'disabled'}`; no `automask.*` line; no file written | ✅ exactly that; `Cache-Control: no-store`; no `automask.json`; 0 `automask` lines in the server log |
| A1′ | unknown job id, flag on and off | 404 | ✅ 404 (the job lookup precedes the flag check — a DB read, not disk access) |
| A2 | `AUTOMASK=1`, the reference clip (`Normal_Lung _sliding.mp4`, 1536×796, 348 f), first `GET` on the ready job | `automask.done`, `ms_total` ≤ 250; `bg_extract.done` / `apply.done` unchanged | ✅ `automask.done tier:T1 model:fan_sym conf:0.8566 grade:check_depth` — **`ms_decode 6.7, ms_propose 182.9, ms_total 191.9`** on the M4 Pro (cold JIT; a recompute on the same job took 167.7). Under the 250 ms row budget here, but the decisions' **100 ms `ms_propose` gate is for the t3.large and will not be met there** (expect ~2–3× the M4 → the worker question returns as its own item, decisions §3.2). Extraction and apply are untouched by construction (the service runs only on request). |
| A3 | second `GET` | `automask.served {cached:true}`; no second `done` | ✅ `automask.served status:ready cached:true`; same body; still `no-store` |
| A4 | `GET` right after the upload, before frame 1 exists | `200 pending`, not cached; later `ready` | ✅ `status:'pending'` on the reference clip and on the 67-frame DICOM (A7), nothing written; `ready` after `bg_extract.done` |
| A5 | DICOM single-frame (the colour-Doppler still `ge_e9_6193094661.dcm`) | `tier:'T0T1'`, `bound` = (0018,6011) box, `bound_source:'dicom'` | ✅ `T0T1`, `bound {2,109,1057,805}`, `bound_source dicom`, `trap_sym` conf 0.81 (`axis midpoints`, `rin_rule coverage` in the fan candidate, `trap_depth refined_along_sides`), `ms_propose 133.6` |
| A6 | DICOM colour-Doppler still (item 5 on this branch) | as A5; PDI panel excluded by the bound | ✅ same job as A5 — the frame decodes in colour (item 5), the proposer sees the spike's grey, the box excludes the right-hand panel. **Conditional on the item 5 deploy for prod.** |
| A7 | DICOM multiframe (`ge_e9_4351124429.dcm`, 67 f) during `extracting` | proposal once `frame_000001.png` is IEND-complete | ✅ immediate `GET` → `pending`; after ready → `T0T1 trap_sym conf 0.76 grade proposed`, bound `{0,40,1053,736}` |
| A8 | image batch (a PNG still uploaded through `/api/uploads/images`) | `source:'image_batch'`; proposal on image 0 | ✅ `automask.start source:image_batch`; `frame: uploads/45707fa8…`; `fan_sym` conf 0.98 (Sonosite abdomen), 1400×1050, `ms_propose 182.4` |
| A9 | stock video / white slide | `none/withheld` with the gate | ✅ white slide (image batch) → `withheld: background_not_dark`, `ms_propose 7`; `stock_demo_480p.mov` (1706 f) → `withheld: no_background`, `automask.skipped reason:withheld`, `ms_propose 1.2`; both cached as withheld |
| A10 | corrupt cache file | `none/error` never 5xx; corrupt file replaced on next request | ✅ `{corrupt` written into `automask.json` → next `GET` recomputed (`ready`, 167.7 ms) and rewrote the file |
| A11 | fixture test | 2 synthetic always; 51 + 3 PHI within tolerance with `AUTOMASK_FIXTURES_DIR`; negatives withhold | ✅ §3 — 3/3 tests, 54 PHI fixtures, 7.1 s |
| A12 | eval on the sandbox after applies; `--bench` reproduces 39/50 | table produced; regression list empty on the first run | ✅ `run.ts --db $DATABASE_URL --server … --manifest … --log … --bench …` → `sandbox/results/2026-09-06_2a_eval1.md` (+ `.json`). **`--bench`: 39 / 50 tolerant** on `reviews_freeze.json` (reference-check clip excluded) — the exact `tune.py --half all` number, so the TS proposer and the Python spike are on one scale. **`--db`:** 12 sandbox jobs listed, manifest joined on filename (one join fell back to `(w, h, frames)` with the warning); the one job with an *applied* mask (the reference clip, header + right panel drawn through the API as a stand-in for a real correction) scored IoU 0.52 / leak_core6 6.6 % / over_core6 46 % against that mask — the expected result of comparing a fan proposal with a header-only mask, and the proof that `mask_data.canvasDataUrl` decodes and scores; the 11 other jobs read `status pending` (their frames were swept by the earlier server restarts) or `no_frame` (image-batch uploads purged at boot). D5 supplies the real applied masks. `[PERF] automask.done` timings joined from the server logs (202.7 ms on the reference clip in this run). |
| A13 | `tsc --noEmit` | 12 | ✅ 12 (5 `frameExtractor.ts` + 7 `maskWorker.ts`) — unchanged through the whole round |
| A14 | `--prev` regression detector | empty on an unchanged re-run; non-empty after a deliberate constant change | ✅ **A14a:** unchanged re-run with `--prev 2026-09-06_2a_eval1.md` → `regressions: _none_` (`…_2a_eval2.md`). **A14b:** `TOP_SUSTAIN` 8 → 3 in `constants.ts` (the pass-2 header bug, deliberately) → **8 regressions listed** — all seven Venue/Mindray rectangles fall (IoU 1.0 → 0.60–0.97, leak_core6 0 → 1.1–22 %) plus `bfly_z9`; the bench count drops 39 → 31 (`…_2a_eval3_deliberate.md`). `constants.ts` then regenerated from `constants.frozen.json` (`TOP_SUSTAIN: 8` again, `tsc` 12). A first attempt with `R_PROFILE_MIN` 0.15 → 0.6 tripped nothing — the far-field walk only ever *extends* `r_out`, so a higher gate barely moves any shape; that is worth knowing about the detector's sensitivity, not a defect. |
| A15 | `npm run build` chunk summary | unchanged; nothing in `client/` imports `shared/automask/` | ✅ `dist/public/assets/index-*.js` 664.00 kB (the pre-2A bundle on this branch, with item 22/28 and the PostHog guard already in it); `grep -c fan_reseed_above_arc` on the client bundle = **0**, on `dist/index.js` = 2 |
| A16 | DICOM job whose upload is gone before the first request | `bound_source:'unavailable'` only when no cache existed; cached result unaffected | ✅ upload file moved away + cache deleted → `T1`, `bound_source unavailable`, and the model **changed to `rect`** (conf 0.77) without the box — the T0 box is load-bearing on GE E9 frames; file restored + cache deleted → `T0T1 trap_sym` again |

Jobs: reference `fdf7b2be…`, DICOM still `2a31a7bd…`, DICOM multiframe `b7536367…`, image batch `fbeac655…`, white slide `7ddde079…`, stock footage `ee5617af…`.

Two things the rows surfaced for the report rather than the code: **(1)** the grade bands from proposal §2.4 (`masked_frac` > 0.55 fan / 0.50 trap → `check_depth`) were set on n = 26 in Round 1 and flag the reference clip (0.5526) and most GE E9 trapezoids (0.53) as `check_depth` — they are exposed as `info.grade_thresholds` precisely so 2B's `automask.outcome` telemetry can widen them; nothing in 2A acts on the grade. **(2)** the `pkill` of a dev server sends SIGTERM, and the SIGTERM handler sweeps every working directory with `maxAgeMs = 0` (CLAUDE.md, disk lifecycle) — the frames of every earlier job vanish, so a restarted sandbox answers `pending` for old `ready` jobs. That is the existing behaviour, not 2A's, but it is why the rows above used fresh uploads.

## 7. Files

- `shared/automask/` — `constants.ts` (generated), `constants.frozen.json`, `types.ts`, `geometry.ts`, `support.ts`, `fan.ts`, `trap.ts`, `core.ts`, `render.ts`, `shape.ts`.
- `server/services/automask.ts` (service), `server/routes.ts` (+1 route, +1 import).
- `server/services/__tests__/automask.fixture.test.ts`, `automask.endpoint.test.ts`, `fixtures/automask/{synthetic_fan,synthetic_trap}/{frame.png, proposal.json}`.
- `scripts/automask_eval/` — `run.ts`, `lib.ts`, `compare-fixtures.ts`, `make-synthetic.ts`, `gen-constants.ts`, `README.md`.
- `scripts/automask_spike/automask_spike.py` — `--dump-constants`, `--propose-png` (the Python side of the generated constants and the synthetic expecteds); `CONSTANTS.md` (re-review numbers line); `bench.py` (CORS header for the local bench, used by the UI reproduction).
- `sandbox/bench/reviews_freeze.json` (the A12 baseline), `sandbox/results/2026-09-06_2a_eval_bench.md`, `…_2a_eval1.md`, `…_2a_eval2.md`, `…_2a_eval3_deliberate.md`.
- Docs: this report, `AUTOMASK_2A_GO.md` (copied), `ITEM5_UI_REPRODUCTION.md`, `ITEM5_DEPLOY_RUNBOOK.md`, `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md` (+B7).

Not touched: `buildApplyMask`, the apply loop, the reuse guard, extraction, `frameExtractor.ts`, `storage.ts`, `pgStorage.ts`, `schema.ts`, `migrations/`, `MaskingCanvas.tsx`, `template-mask-spoke.tsx`, `cleanup.ts`.

## 8. Next (per `AUTOMASK_2A_GO.md` §4)

Andre writes the deploy runbook from §6; deploy flag-off; prod row A2 (`ms_propose` on the t3.large — the M4 numbers above put the reference clip at ~170 ms cold, so the 100 ms gate on the t3.large is at risk and the worker question comes back as its own item if it misses); then D5 in the sandbox with `AUTOMASK=1` (applied-mask eval on the seven kickoff clips), then the 2B kickoff from the draft (§B + B7 verbatim).
