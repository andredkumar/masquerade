# Auto-mask Round 2A — Proposal v2 (against the frozen rules): proposer + endpoint + eval, flag off, no UI

**Date:** 2026-09-06 (v1 2026-09-04). **Governs:** `AUTOMASK_ROUND1_AMENDMENT.md` §2/§4 as amended by
`AUTOMASK_2A_DECISIONS.md` §3, and `AUTOMASK_PASS3.md` §4 ("open the 2A proposal with the frozen rules").
**Inputs:** `scripts/automask_spike/CONSTANTS.md` (**FROZEN 2026-09-06**), `automask_spike.py` (the reference
implementation), `bench.py` / `bench_static/shape.js` (renderer and controls), `AUTOMASK_PASS3_REPORT.md` (the numbers and
the residual misses). **Status:** ready to start. **No 2A code has been written.** Nothing under `server/`, `client/`,
`shared/` changes until Andre says go.

What changed since v1: the spike no longer fits a free fan / free quad — it fits **symmetric** models (`fan_sym`,
`trap_sym`, `rect`) with the pass-2/3 rules; the contract, the port plan and the fixture assertions below follow the frozen
code. The three open decisions of v1 are closed by `AUTOMASK_2A_DECISIONS.md` §3 (synthetic fixtures in git: yes; inline,
no worker; item 5 first: done on branch `item5-rgb-dicom`).

## 0. Entry condition (`AUTOMASK_2A_DECISIONS.md` §3.5) — met

| condition | state |
|---|---|
| Track 0 review done | 51 full-parametric references from Andre (`sandbox/bench/reviews.json`), all valid after the bench-v4 re-review |
| tuning passes reported | passes 1–3: `AUTOMASK_TUNING_PASS1_REPORT.md`, `AUTOMASK_PASS2_REPORT.md`, `AUTOMASK_PASS3_REPORT.md` |
| `CONSTANTS.md` frozen | yes — 34/50 tolerant (68 %) with the fitted parameters, both halves 17/25; negatives 3/3 withheld |
| fixture `proposal.json`s regenerated from the frozen code | yes — `bench.py --recompute` on the freeze date; the eval's D5 baseline is `sandbox/results/<freeze date>_bench.md` |
| item 5 (RGB multiframe DICOM) | fixed and verified on branch `item5-rgb-dicom` (`ITEM5_REPORT.md`); merges before 2A |

## 1. What 2A delivers (and what it does not)

Delivers: the proposer as a pure-TS core (`shared/automask/`) that reproduces the frozen Python step for step; a server
service that runs it **inline** on first request and caches the result on disk; one read-only endpoint; `[PERF]
automask.*` lines; the `AUTOMASK` flag (default off); two synthetic fixtures in git plus the 51 PHI fixtures behind
`AUTOMASK_FIXTURES_DIR`; `scripts/automask_eval/` that scores every sandbox job's proposal against the mask Andre applied
*and* against the Track 0 references. **The spoke is untouched**: no layer, no controls, no Accept — all 2B
(`AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md` §B). `tsc` stays 12. A3 frozen.

## 2. Design

### 2.1 Files — the port mirrors `automask_spike.py` function for function

| file | new/changed | port of | what |
|---|---|---|---|
| `shared/automask/types.ts` | new | — | `Proposal`, `KeepShape` (`fan` \| `trap` \| `rect`), `Bound`, `Components`, `Rules` — the JSON contract (§2.3); imported by 2B and the eval |
| `shared/automask/constants.ts` | new | `CONSTANTS.md` | every frozen value, one exported object; a unit test asserts it matches a JSON dump of the Python module's constants (`python3 automask_spike.py --dump-constants`, to add) |
| `shared/automask/geometry.ts` | new | cv2 / numpy calls | integer-grid ops on `Uint8Array`: box downscale, histogram mode, box-filter density via integral image, binary open/close with an ellipse kernel (same footprints as `cv2.getStructuringElement(MORPH_ELLIPSE, k)`), 8-connected components with stats, hole fill, convex hull (monotone chain), Douglas–Peucker, Theil–Sen slope (median of pairwise slopes, 60-row subsample as in Python), percentiles with numpy's linear interpolation |
| `shared/automask/support.ts` | new | `background_stats`, `clean_support` | the pipeline in `CONSTANTS.md` "Support pipeline", including `drop_small_blobs` and the `removed` mask handed to the rules, the union candidate, the bright-blobs mask |
| `shared/automask/fan.ts` | new | `hull_side_edges`, `fit_fan_sym`, `refine_fan_radii`, `render_fan` | seed → `fan_axis_mid` → `rin_coverage` → `fan_reseed_above_arc` (one recursion) → coordinate descent (`ax` frozen when the axis came from midpoints) → far-field completion |
| `shared/automask/trap.ts` | new | `fit_trap_sym`, `render_trap`, `trap_side_angle_deg` | `top60` with the fill test, the clean near-field band (frame *and* T0 box clipping, `SIDE_JUMP_PX`), band-only refinement, depth refined along the sides, rect fallback (< 3°) |
| `shared/automask/core.ts` | new | `fit_support`, `fit_fan` (selection), `confidence`, `finish_fit`, `tier_t1`, `scale_params`, `keep_fullres` | `propose(gray, w, h, {bound}) → Proposal`; selection with `FAN_PREFERENCE` and the `TOP_FLAT_FRAC` tie-breaker; `t0_depth_rect`; `conf_bbox`; gates in the frozen order |
| `shared/automask/shape.ts` | new | `bench_static/shape.js` | `toPageShape` (full-res params), `deltas` (incl. `d_arc_px`), `polyPathFor`, `drawMaskRaster` — the 2B controls come later, the shape math lands now so the contract is one file |
| `shared/automask/render.ts` | new | `keep_fullres`, `score` | `renderKeepMask(shape, w, h, bound, marginPx) → Uint8Array` (scanline fill + erosion), `score(keep, ref)` with the ±6 px core band — used by the fixture test and the eval |
| `server/services/automask.ts` | new | — | `getOrComputeProposal(jobId)`: frame 1 resolved as the frames endpoint does (image batch → `uploads/<fileList[0]>`, else first IEND-complete `temp_extracted/<jobId>/frame_*.png`); T0 box via `dcmjs` when the upload is DICOM and still present (`bound_source: 'dicom' | 'unavailable' | 'not_dicom'`); `sharp(...).greyscale().raw()`; `propose(...)` **inline** (§3.2 of the decisions — bounded work on a 4× grid, `sharp` already off-thread); writes `temp_extracted/<jobId>/automask.json`; in-memory `pending` map so concurrent GETs compute once; try/catch → `none/error` |
| `server/routes.ts` | +1 route | — | `GET /api/jobs/:jobId/template-mask/proposal` (§2.3), next to the frames endpoint |
| `server/services/__tests__/automask.fixture.test.ts` | new | — | §3 |
| `server/services/__tests__/automask.endpoint.test.ts` | new | — | flag off → `none/disabled`, no disk access; unknown job → 404; frame missing → `pending`; happy path on a synthetic fixture (mock storage) |
| `scripts/automask_eval/run.ts` (+ `README.md`) | new, shipped | `tune.py`, `bench.py --report` | §4 |
| `docs/refactor/AUTOMASK_ROUND2A_REPORT.md`, `…_DEPLOY_RUNBOOK.md` | new | — | report + runbook (§6 rows) |

Not touched: `buildApplyMask`, the apply loop, the reuse guard, extraction, `frameExtractor.ts` (item 5's fix is a separate
merge), `storage.ts`, `pgStorage.ts`, `schema.ts`, `migrations/`, `MaskingCanvas.tsx`, `template-mask-spoke.tsx`,
`cleanup.ts`. **Nothing under `client/` imports `shared/automask/` in 2A** — the Vite chunk summary must read the same
(row A15).

### 2.2 When it runs, and the CPU story
Lazily on the first `GET …/proposal` for a job; once per job; cached on disk; never regenerated by the server (delete the
file to re-propose — the eval's `--fresh` does that). Inline on the main thread: the grid is 4× downscaled (158×270 on a
Butterfly export, 480×270 on 1080p), so there is no input that makes it run long; the Python reference does the whole
pipeline in 100–200 ms including the fan re-seed, and the TS version is expected to land under the 100 ms gate from
`AUTOMASK_2A_DECISIONS.md` §3.2 (row A2; over it → a worker becomes its own item). Not in the extraction path; cannot
delay `ready`.

### 2.3 Contract — `automask.json` == endpoint body
```jsonc
{ "version": 2,
  "status": "ready" | "none" | "pending",
  "reason": "disabled" | "withheld" | "error" | "no_frame" | null,
  "withheld": "background_not_dark" | "no_background" | "interior_not_ultrasound" | "masks_too_little" | "support_too_small" | "no_side_edges" | "sides_parallel" | "apex_not_above" | null,
  "flag": "nothing_much_to_mask" | null,
  "jobId": "…", "frame": "frame_000001.png" | "uploads/<file>", "width": 632, "height": 1080,
  "tier": "T1" | "T0T1", "model": "fan_sym" | "trap_sym" | "rect",
  "keep": { "kind": "fan",  "sym": true, "ax":…, "ay":…, "half_angle":…, "r_in":…, "r_out":… }
        | { "kind": "trap", "sym": true, "cx":…, "y_top":…, "y_bottom":…, "w_top":…, "w_bottom":… }
        | { "kind": "rect", "sym": true, "cx":…, "y_top":…, "y_bottom":…, "w_top":…, "w_bottom":… },   // w_top == w_bottom
  "bound": { "x0","y0","x1","y1" } | null, "bound_source": "dicom" | "unavailable" | "not_dicom",
  "margin_px": 2,
  "confidence": 0.86, "grade": "proposed" | "check_depth",
  "rules": { "top60": true, "rin_coverage": true, "fan_axis_mid": true, "fan_reseed_above_arc": true, "drop_small_blobs": true, "t0_depth_rect": true, "conf_bbox": true },
  "info": { "fit_score", "fit_iou", "outside_blob_frac", "interior_mean", "interior_std", "bg_level", "bg_frac",
            "th_l_free_deg", "th_r_free_deg", "asym_deg", "axis_tilt_deg", "axis", "rin_rule", "reseeded", "trap_band_end", "trap_depth", "t0_depth", "union", "r_out_delta" },
  "ms": { "decode": 6, "propose": 41, "total": 52 }, "createdAt": "…" }
```
Full-resolution pixels (the spike's `params_small` × `DOWN`, exactly `to_page_shape`); fan angles in radians (0 = down,
+ = right) — identical to `shape.js`. HTTP `200` for `ready|none|pending`, `404` unknown job. **`Cache-Control: no-store`
on every response** (decisions §3.4). With `AUTOMASK` unset/`0`: `{status:'none', reason:'disabled'}` and no disk access.
`bound_source: 'unavailable'` means the upload was already swept (2 h) or reclaimed — a late `curl`, never the spoke flow,
since the result is cached on the first request.

### 2.4 Confidence and the grade (amendment §5)
`conf = fit_score − 0.5·outside_blob_frac` with `conf_bbox` (frozen). Gates in the frozen order: background → interior →
`masks_too_little` rule. Words, never "High": `grade: 'proposed'` when `conf ≥ 0.70` and no check-depth signal;
`grade: 'check_depth'` when `conf ≥ 0.70` and (a) the far-field completion stopped before 70 % of the way from the top to
the frame/bound edge, or (b) `masked_frac` above the model's band (fan > 0.55, trap/rect > 0.50). Below 0.70 →
`none/withheld` with the reason. **Declared tunables**: the corpus says GE trapezoids sit at conf 0.76–0.91 and the
Mindray/Sonosite fans at 0.93–0.99, so 0.70 keeps every positive; 2B's `automask.outcome` telemetry sets the real
thresholds.

### 2.5 `[PERF]` lines
- `automask.start {jobId, source: 'raw'|'image_batch', dicom: bool}`
- `automask.done {jobId, tier, model, conf, grade, masked_frac, w, h, ms_decode, ms_propose, ms_total, cached: false, reseeded, rules_fired: [...]}`
- `automask.skipped {jobId, reason: 'disabled'|'withheld'|'no_frame'|'error', detail?}`
- `automask.served {jobId, status, cached: true}`

## 3. Fixture test — the TS core reproduces the frozen Python
- **In git (always run):** two synthetic frames at 632×1080 rendered by a script (`scripts/automask_eval/make-synthetic.ts`,
  numbers fixed): (1) a fan with known apex/radii/half-angle on black, a "header" rectangle and three thin text-like lines
  above the arc, a small isolated glyph beside the arc (exercises `top60`-free path, `rin_coverage`, `drop_small_blobs`,
  `fan_reseed_above_arc`); (2) a trapezoid with a bound, a wide label above the top edge, a greyscale bar merging at the
  left, echo-free bottom corners (exercises `top60`, the clean band, `t0_depth_rect` off, `TRAP_DEPTH refine`). Their
  expected `proposal.json` comes from the Python spike run on the same PNGs.
- **Behind `AUTOMASK_FIXTURES_DIR` (PHI, sandbox only):** the 51 clips' `frame1.png` + `proposal.json` from
  `sandbox/bench/<clip>/` (frozen code), copied by `scripts/automask_eval/make-fixtures.ts`. The test skips with a loud
  message when the variable is unset.
- **Assertions per fixture:** same `tier`, same `model`, same `withheld`/`flag`; `renderKeepMask(ts) ∩∪ renderKeepMask(py)`
  IoU ≥ 0.98; **`|r_out_ts − r_out_py| ≤ 2 px` (fan) / `|y_bottom_ts − y_bottom_py| ≤ 2 px` (trap/rect)** — the
  radial-profile walk and the depth refinement are the steps a port drifts by a bin and still passes IoU (decisions §3.4);
  `|conf_ts − conf_py| ≤ 0.02`; `rules_fired` identical (`axis`, `rin_rule`, `reseeded`, `trap_depth`, `t0_depth`).
  Negatives must withhold with the same reason.
- **Numeric contract:** integer grid ops identical (box filter as integral image, same ellipse footprints, same
  connectivity), floats in double, percentiles with numpy's linear interpolation, Theil–Sen on the same 60-row subsample
  rule, `np.convolve(..., 'valid')` sustain semantics reproduced literally. `cv2.fillPoly` rasterisation is the one place
  the two will differ by edge pixels — hence IoU 0.98, not equality.

## 4. `scripts/automask_eval/` (shipped) — the D5 harness and the permanent tuning loop
```
npx tsx scripts/automask_eval/run.ts --manifest ../sandbox/manifest.csv --out ../sandbox/results/<date>_run1.md \
   [--db $DATABASE_URL] [--server http://localhost:5001 --fresh] [--log ../sandbox/results/server_*.log] \
   [--bench ../sandbox/bench] [--prev ../sandbox/results/<date>_run0.md]
```
- Inputs: local `jobs`, `temp_extracted/<jobId>/automask.json` (or a fresh `GET` with `--fresh`, which deletes the cache
  file first — the stated invalidation rule), `[PERF] automask.*` lines, `manifest.csv`. **Join on the original filename
  the job stores**, falling back to `(width, height, frames)` with a warning, never a silent drop (decisions §3.4).
- Per job: reference = `mask_data.canvasDataUrl` red > 128 = blanked → keep_ref (what Apply did). Proposal →
  `renderKeepMask` with `margin_px`. Scores: IoU, leak, over_blank, leak_core6, over_core6 (identical semantics to the
  spike's `score()`), tolerant rule, the pass-3 controls-only estimator (one parameter beyond half ±1.5° / apex 8 /
  top 8 / w_top 8 / depth 12 px).
- **`--bench`**: scores the same proposals against `reviews.json`'s `shape_user` (absolute references) with the same
  `score()`, so the first D5 signal and every later sandbox session are on one scale with `tune.py`.
- Output: Markdown + JSON; summary block (tolerant, controls-only, worst leak, worst over-blank, negatives withheld,
  positives withheld = misses with reason); **regressions vs `--prev`** (tolerant pass → fail, or leak_core6 up > 0.5 pt).
  Row A14 proves the detector: empty on an unchanged re-run, non-empty after a deliberate constant change.

**D5 (Andre, sandbox, `AUTOMASK=1`):** upload the seven kickoff clips, draw/correct, Apply, run the eval. Pass = the
freeze numbers hold on the applied masks within the tolerant rule's noise (the port is the variable here, not the rules);
`--bench` must reproduce `AUTOMASK_PASS3_REPORT.md`'s 34/50.

## 5. Estimate and order
1. `shared/automask/*` port + synthetic fixtures + fixture test (the bulk; 2 days — the frozen pipeline is larger than v1's).
2. `server/services/automask.ts` + route + PERF (½ day). 3. `scripts/automask_eval` (1 day). 4. Sandbox run A1–A15.
5. Report + runbook; deploy flag-off; prod perf row.

## 6. Test matrix (runbook rows)
| # | case | expected |
|---|---|---|
| A1 | `AUTOMASK` unset, `GET …/proposal` on a ready MP4 job | `200 {status:'none', reason:'disabled'}`; no `automask.*` line; no file written |
| A2 | `AUTOMASK=1`, reference clip on prod after deploy, `curl` once at ~3 s | `automask.done` with `ms_propose` ≤ 100 and `ms_total` ≤ 250; `bg_extract.done` / `apply.done` unchanged vs 8.0 s / 8.7 s |
| A3 | second `GET` | `automask.served {cached:true}`; no second `done`; still `no-store` |
| A4 | `GET` before frame 1 exists | `200 pending`; later `ready` |
| A5 | DICOM single-frame (mono) | `tier:'T0T1'`, `bound` = (0018,6011) box, `bound_source:'dicom'` |
| A6 | DICOM colour-Doppler still (item 5 merged) | as A5; PDI panel excluded by the bound |
| A7 | DICOM multiframe during `extracting` | proposal once `frame_000001.png` is IEND-complete |
| A8 | image batch (JPEG originals) | `source:'image_batch'`; proposal on image 0 |
| A9 | stock video / white slide / screen recording | `none/withheld` with `background_not_dark` / `no_background` |
| A10 | thrown error / corrupt cache file | `none/error` logged; endpoint never 5xx; corrupt file replaced on next request |
| A11 | fixture test | 2 synthetic always; 51 PHI fixtures within tolerance with `AUTOMASK_FIXTURES_DIR`; negatives withhold |
| A12 | eval on the sandbox after applies | table produced; `--bench` reproduces 34/50; regression list empty on the first run |
| A13 | `tsc --noEmit` | 12 |
| A14 | `--prev` regression detector | empty on an unchanged re-run; non-empty after a deliberate constant change |
| A15 | `npm run build` chunk summary | unchanged (nothing in `client/` imports `shared/automask/`) |
| A16 | `GET` after the upload was swept (DICOM) | `bound_source:'unavailable'` only when no cache file existed yet; cached result unaffected |

## 7. Decisions closed (from `AUTOMASK_2A_DECISIONS.md` §3) and what stays open
Closed: synthetic fixtures in git (yes, two); inline not worker (gate 100 ms); item 5 first (done); `no-store` everywhere;
`bound_source`; cache invalidation by deletion + `--fresh`; `shared/automask/` out of the client bundle; the 2-px
far-field assertion; robust eval join; `--bench`; rows A14/A15.

Open for Andre: none required to start. Noted for 2B/2C (not 2A): the Butterfly parametrisation caveat and the residual
misses in `AUTOMASK_PASS3_REPORT.md` §6; the reference check on `ge_e9_6193094661`.
