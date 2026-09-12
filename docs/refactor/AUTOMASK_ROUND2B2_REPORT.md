# Auto-mask Round 2B-2 — report: the spoke behind `AUTOMASK_UI`

**Status:** built 2026-09-11 on `main` @ `74ed76b` per `AUTOMASK_ROUND2B2_PLAN.md` + `AUTOMASK_ROUND2B2_SIGNOFF.md` (§1.1–1.3 and the §2 I amendment folded in). **Uncommitted** — Andre writes the runbook, commits, deploys behind `AUTOMASK_UI`. `tsc` 12 (the same 12) · A3 frozen · export path untouched · one flag · no new dependencies · nothing PHI-bearing in the tree that belongs in the commit (§7).

## 0. Headline

**Accept untouched → Apply reproduces the proposer's `keep` on every family** (sandbox, `run.ts --db --server` scoring the applied mask decoded from `mask_data.canvasDataUrl` against `renderKeepMask(proposal)`):

| family | clip | tier · grade | IoU | leak | over | leak_core6 | over_core6 |
|---|---|---|---|---|---|---|---|
| fan | `Normal_Lung_sliding` (1536 × 796, 348 fr) | T1 · check_depth | **0.9951** | 0.0039 | 0.0000 | 0.0000 | 0.0000 |
| trapezoid, T0 box | `ge_e9_2124113685` (1164 × 873 DICOM) | T0T1 · proposed | **0.9944** | 0.0057 | 0.0000 | 0.0000 | 0.0000 |
| rectangle, T0 box | `ge_e9_4515056095` (1164 × 873 DICOM) | T0T1 · proposed | **0.9952** | 0.0120 | 0.0000 | 0.0000 | 0.0000 |

All three ≥ 0.99 with nothing kept outside the proposer's keep: in `run.ts --db` the columns are `score(proposalKeep, appliedMask)`, so `leak` here is proposal-kept ∧ applied-**blanked** and `over` is applied-kept ∧ proposal-blanked — `over 0` means the applied mask keeps no pixel the eroded keep blanks, and the `leak` residual is a uniform **1 px ring the applied mask blanks inside the eroded keep** (fail-closed; measured both ways at margin 2 and margin 0 in §0.1, where the fail-open count is 0 on all three against the raw keep). The exported PNG is red outside the keep polygon, black inside, through the **existing** `updateMaskFromCanvas` `path` case.

### 0.1 Addendum (2026-09-11, before commit) — the boundary residual, measured in both directions

Re-scored from the stored `mask_data.canvasDataUrl` against `renderKeepMask(shape, w, h, bound, margin)` at the eroded keep (margin 2) and the raw keep (margin 0), with the two directions named explicitly (script output: `sandbox/results/2026-09-11_2b2_addendum_rescore.txt`):

| job | margin | IoU | **fail-open** = applied-kept ∧ proposal-blanked | fail-closed = proposal-kept ∧ applied-blanked | ring (px per boundary px) |
|---|---|---|---|---|---|
| fan `478fbcb9` | 2 | 0.9951 | **2 px** (0.0000) | 2633 px (0.49 % of kept) | 1.13 |
| | 0 | 0.9855 | **0** | 7913 px | 3.40 |
| trap + T0 `b4cc93bb` | 2 | 0.9944 | **0** | 2896 px (0.56 %) | 1.02 |
| | 0 | 0.9828 | **0** | 8949 px | 3.12 |
| rect + T0 `636d55b8` | 2 | 0.9952 | **0** | 3486 px (0.48 %) | 1.00 |
| | 0 | 0.9858 | **0** | 10482 px | 2.99 |

Rectangle probe (row 457 / column 526): eroded keep x 4..1055 → applied 5..1054, y 111..803 → 112..802 — **1 px on each of the four sides**; raw keep x 2..1057 / y 109..805 → 3 px each side = the 2 px margin + 1 px. Symmetric, so a shrink, not a half-pixel shift. **Margin-0 fail-open is 0.0000 on all three** (the fan's two margin-2 pixels are corner pixels of the sampled arc against the 5 × 5 ellipse erosion and vanish against the raw keep). **No code change.**

**Mechanism — the retina hypothesis is corrected, not confirmed.** The three exports were made at `devicePixelRatio` 1 (recorded in `mask_data`; the Browser pane is not a Retina surface), the stored PNGs are frame-sized (1536 × 796, 1164 × 873), and `createTransformedMask`'s two lanczos3 resizes (`videoProcessor.ts:223-245`) are identities at equal dimensions. The 1 px ring is the red stroke the export forces on every path — `MaskingCanvas.tsx:937` `strokeWidth: obj.strokeWidth || 36`, hence 1 (sign-off §10-G) — centred on the polygon edge, together with the `r > 150` threshold on the antialiased stroke/fill boundary (`videoProcessor.ts:285`; the eval's `> 128` agrees), which turns the inner half of the stroke's boundary pixels red. On a Retina display the export PNG is 2× and does go through the lanczos3 downsample — that path was not exercised in the sandbox and is part of Andre's display row (§8).

**One `[PERF] automask.outcome` line per job per spoke session, proven on nine jobs:**

| job | what happened | lines | outcome |
|---|---|---|---|
| `478fbcb9` Normal_Lung | Accept untouched → Apply | 1 | `accept`, all Δ 0, `controls_used []`, `ms_to_decision 74847` |
| `c92f879e` bfly_z2b | half-angle key, depth key, position ×3 → Accept → Apply | 1 | `edit`, `['position','half_angle','depth']`, Δ half 0.57°, apex 3 px, depth 1 px, top width 1.56 px |
| `cb41cf36` sonosite_011_clip10 | trap → fan → rect → trap → fan → Accept → Apply | 1 | `edit`, `model_switch {trap_sym → fan_sym}`, `deltas null`, final = the 30° re-seeded fan |
| `19d62edd` ge_e9_4515056095 | drags + hold → Accept → **Adjust → Accept** → Apply | **1** | `edit`, `['position']`, Δ apex 84.7 px |
| `383ea481` ge_e9_2124113685, three spoke sessions | button · first rectangle stroke · Clear Mask | 3 (one each) | `draw_from_scratch`, `final_keep null`, `ms_to_decision` 20972 / 5145 / 4133 |
| `b4cc93bb`, `636d55b8` | Accept untouched → Apply (headline rows) | 1 each | `accept`, all Δ 0 |
| `172fddab` screenrec_app_ui (withheld) | spoke opened | 0 | — |
| flag off (either flag) | spoke opened, POST curled | 0 | server answers the disabled shape |

## 1. What shipped

| file | change |
|---|---|
| `shared/automask/shape.ts` (+299) | `controlSpecs`, `readouts`, `withControl` (bench `withParam` ported key by key; the joint control verbatim), `reseed` (six transitions + the two compositions + the range guard, §5.1), `keepPolygon` / `keepPathData` (clip to frame ∩ T0 box, margin inset on shape and bound edges only, a second clip + collinear cleanup for the corner degeneracy), `shapeDeltas` null rule → fan vs non-fan (§5.2) |
| `shared/automask/types.ts` (+1) | `ui_enabled?: boolean` on `ProposalJson` |
| `server/services/automaskFlag.ts` (+10) | `AUTOMASK_UI_FLAG_ENV`, `automaskUiEnabled()` — the `AUTOMASK` regex verbatim |
| `server/services/automaskOutcome.ts` (new, 74) | zod schema (strict) + pure `handleOutcome(jobId, body, deps)`; one `perfMark(jobId, 'automask.outcome', …)`; stores nothing |
| `server/routes.ts` (+23 −2) | `ui_enabled` stamped at serve time on the proposal GET (`:509`, `:512` — never into `automask.json`); `POST /api/jobs/:jobId/template-mask/proposal/outcome` |
| `client/src/components/MaskingCanvas.tsx` (+194 −4) | props `proposal` / `onProposalEvent`; `_automask` guards in `object:added` and `object:modified`; the `object:removed` hook; `internalRemoval` around both `canvas.clear()`s; `frameLoaded` tick; the layer effect (path replaced per change, handle created once and repositioned in place, Accept → `updateMaskFromCanvas(path)`, Adjust → back). `updateMaskFromCanvas` `:845-1135` and every `enable*` tool handler untouched |
| `client/src/pages/template-mask-spoke.tsx` (+82 −4) | the session reducer wiring, bar mount inside `<main>` (renders nothing without a session), outcome POST from `handleStartProcessing`, default tool `select` while the layer shows |
| `client/src/hooks/useAutomaskProposal.ts` (new, 160) | one GET per spoke mount once frame 1 is on screen, `pending` poll 1 s ≤ 60 s; `sessionReducer`; `decideOutcome`; `buildOutcome`; `postOutcome` (fire-and-forget, `keepalive`) |
| `client/src/hooks/useHoldRepeat.ts` (new, 76) | B3 scheduler: `holdDelay(elapsed)` = 400 → 100 → 25 ms; Shift ×10 re-read per tick; memoized handle (§5.4) |
| `client/src/components/AutomaskProposalBar.tsx` (new, 155) | grade words, model switch (Radix ToggleGroup), sliders (Radix, Shift ×10 native) with `fitted → now (Δ)`, arrow buttons, keyboard arrows (proposal mode only; ignores inputs / slider thumbs / modifier keys / OS auto-repeat; `preventDefault`) |
| tests (new) | `automaskShape.test.ts` (6), `automaskOutcome.test.ts` (4), `automaskHold.test.ts` (2) |
| docs | this report; `AUTOMASK_ROUND2B2_KICKOFF.md`, `_PLAN.md`, `_SIGNOFF.md` |

Sign-off §1 folded in: **1.1** the handle is created once per layer lifetime, repositioned with `set + setCoords` only while `draggingRef` is false, and settled from the parameters on `object:modified`; **1.2** stroke-removal fires only when `proposal.mode === 'proposal'` (after Accept the stroke unions, `freehand` → `edit`); **1.3** `internalRemovalRef` wraps the frame effect's `canvas.clear()` and `handleUndo`'s. **§2 I:** `model_switch` is logged whenever the final family differs from the fitted one, trap ↔ rect included (the `deltas` stay non-null there). §3: modifier keys ignored; `ms_to_decision` from the layer effect's first path add (`rendered` event); the worktree, not a stash, for the flag-off diff.

## 2. Test matrix (kickoff §4) — results

| row | result |
|---|---|
| **unit** | `automaskShape` 6/6: polygon vs `renderKeepMask` IoU **0.9992** (fan) / **0.9968** (trap + bound); joint control keeps `ay + r_in`, `ay + r_out`, bottom width to 1e-9 across its range and the readouts follow the current apex; trap `top`/`bottom` keep the side angle; fan → trap → fan exact; rect → fan chord = width, arc at `y_top`; all six kinds; untouched deltas all zero; every control a no-op at its fitted value; clips inside the frame, bound sides inset, frame-coincident bound sides not. `automaskOutcome` 4/4: 204 + one line; ten malformed bodies → 400, no line; either flag off → disabled, no line; unknown job → 404 in both flag states. `automaskHold` 2/2 (§2 nudge) |
| **family** | fan (`bfly_z2b`, `Normal_Lung`), trap with T0 box (`ge_e9_2124113685`), rect with T0 box (`ge_e9_4515056095`, a corpus clip): layer on the cone/box at zoom **50 / 75 / 100 / 150** (screenshots in the session; the layer scales with the canvas element, so alignment is structural) |
| **outcome** | headline table + §0 lines table: Accept untouched IoU ≥ 0.99 ×3; each B2 control's Δ and `controls_used` match the bar's readouts (bfly row); model switch fan → trap → rect → fan lands close (§5.1) and logs `model_switch`; Draw from scratch by button / first stroke / Clear Mask → layer gone, one line each, the button restores the Rectangle tool; Accept → Adjust → Accept → Apply → exactly one line |
| **nudge** | tap = 1 px (button and ArrowLeft/Down); Shift tap = 10 px; Shift+ArrowUp = −10; **hold measured with real timers in Node** (`automaskHold.test.ts`): first repeat at **401 ms**, **5 steps in the first 800 ms** (tap + repeats at 400/500/600/700; the 800 ms tick lands at 801), **39 steps between 2 s and 3 s**, nothing after release — see §5.4 for why not in-page; drag handle: zoom 75, 30 screenshot px → readout **+111 px** (expected 110); zoom 150, a **110 px continuous drag → −201 px** (expected −202), handle stayed where dropped, path followed (sign-off §1.1 row); arrows on a focused slider thumb move the slider (1064 → 1063) and not the position; ⌘/Ctrl/Alt+arrow and `repeat`-only keydowns do nothing; the arrow keydown is `defaultPrevented`; `scrollY` 0 |
| **withheld** | `screenrec_app_ui` (`background_not_dark`): today's spoke — no bar, Rectangle tool, canvas painted; 0 outcome lines; 3 `automask.served` for its 3 opens. `sonosite_011_clip10` is **not** withheld (§5.3) |
| **flag** | `AUTOMASK_UI` unset: no layer, no bar; **DOM identical** to the `74ed76b` worktree on the same job in 39 of 40 chunks, the 40th differing only in Vite's per-server `?v=` on the `main.tsx` script tag; **exactly one `automask.served` GET per spoke open** (3 GETs = 1 curl + 2 opens); GET body carries `ui_enabled:false`; POST → `{status:'none', reason:'disabled', ui_enabled:false}`, no line. Both flags unset: GET → the 2A disabled shape (+ `ui_enabled:false`), no `t0.json`, no `automask.*` lines; spoke = today's (one GET, disabled); POST → disabled, no line |
| **pending** | opened during extraction (ffmpeg frozen with SIGSTOP, then resumed): "Waiting for the first frame… 0 / 348" → 4 × `frames/0` 503 → 200 → **one** proposal GET → `automask.start {trigger:'lazy'}` → done 279 ms while ffmpeg still ran → at `ready` `served {cached:true, computed_by:'lazy', trigger:'ready'}`; one bar; no second GET across the `job.status` flips. Pre-2B-1 job (cache deleted, job ready): reopen → `automask.start {trigger:'lazy'}` → done 142 ms → one bar. A `pending` body is unreachable from the spoke's own flow (§5.5) |
| **display (Mac)** | **not run — Andre's row** (sign-off decision 6). The Browser-pane runs above were at `devicePixelRatio` 1 (recorded in `mask_data`, PNGs frame-sized), so the retina 2× export path (`MaskingCanvas.tsx:917` → `videoProcessor.ts:223-245` downsample) was **not** exercised here — it is part of Andre's row (§0.1) |
| **invariants** | `npx tsc --noEmit` = **12** (5 `frameExtractor.ts` + 7 `maskWorker.ts`); `npm run build` → `dist/index.js` 259 KB + `dist/automaskWorker.js` 52 KB; `automask.endpoint` **13/13**, `automaskWorkerClient` **5/5**, `automask.fixture` 2 + 1 skipped (PHI dir unset), `applyPaths` 8/8; `git diff --stat` shows `videoProcessor.ts`, `frameExtractor.ts`, `maskWorker.ts`, `automask.ts`, `automaskT0.ts`, `automaskWorkerClient.ts`, `server/workers/`, `ProcessingControls.tsx`, `MaskingTools.tsx`, `package.json` untouched; `run.ts --bench` **39/50 tolerant · 39/50 controls-only**, unchanged by the `shapeDeltas` fix |

## 3. Accept's look (sign-off §3)

After Accept the canvas shows the accepted path (1 px red stroke) **plus** the existing `_aiOverlay` effect's 50 %-opacity image of the exported PNG (`MaskingCanvas.tsx` `:259-284`, keyed on `maskData.canvasDataUrl`): the outside goes red-on-red, the cone interior darkens by half. Identical to what a brush stroke produces today; Adjust removes the overlay with the mask. Screenshots were taken in the session (not committed — the frames are sandbox clips); the sign-off already files this as a backlog item shared with the brush path.

## 4. Sandbox numbers worth keeping

| measurement | value |
|---|---|
| lazy compute while ffmpeg runs (1536 × 796, M4) | 279 ms |
| `apply.done` after Accept, reference clip (348 fr, reuse) | 1196 ms · mask_build 146 ms · masked 681 602 / 1 222 656 px |
| `apply.done` bfly_z2b (295 fr) / sonosite (180 fr) / DICOM (1 fr) | 851 / 906 / 163 ms |
| proposal GETs per spoke open (flag on or off) | 1 |

## 5. Deviations from the plan and sign-off (for Andre to strike or keep)

1. **Re-seed range guard (amends §10-F).** `reseed(shape, to, frame?)`: trap → fan takes the side lines' intersection unless the sides are < 1° **or that apex would sit above the position range (`ay < −0.5·h`)**, in which case the rect → fan rule (30°, apex just above the top) applies. Seen on `sonosite_011_clip10`: its 3.2° trapezoid put the literal apex 4936 px above the frame, where the half-angle slider (min 5°) could no longer do anything useful. Without a frame the literal rule still applies (unit-tested both ways).
2. **`shapeDeltas` returned null across trap ↔ rect** (`shape.ts:30` compared `kind`s; the kickoff §3.5 / sign-off claim that `:43` "treats them together" was wrong — `:43` was unreachable for mixed kinds). Now null only across fan ↔ non-fan. `run.ts --bench` unchanged (39/50 · 39/50).
3. **Outcome route order mirrors the GET:** job lookup first (unknown → 404 in both flag states), then the gate. The plan had the gate first.
4. **`useHoldRepeat` returns a memoized `{start, stop}`.** The first version returned a fresh object per render; the bar's keyboard effect keyed on it re-ran after the very first step and its cleanup called `stop()`, so no hold ever repeated — in the pane or for a user. Found by the nudge row's measurement, fixed, covered by `automaskHold.test.ts`. **Timing is proven in Node, not in-page:** the Browser pane is a hidden tab to Chrome (`document.hidden === true`), whose timer throttling turned a 25 ms timeout into 999 ms; any in-page hold number is an artifact. Andre's live row on a visible tab is the human check.
5. **`pending` is unreachable from the spoke's own flow:** the hook starts only once `frames/0` has served frame 1, and the service returns `pending` only when frame 1 is *not* on disk, so the GET meets a lazy compute instead. The poll branch was exercised once by accident (frames swept between the frames fetch and the GET → `pending` every second, 8 polls; it stops at 60 s) and behaves.
6. **The kickoff's withheld clip is not withheld.** `sonosite_011_clip10` proposes a `trap_sym` (bench too; Andre's verdict "incorrect geometric shape") — it is the B7 case, used here for the model-switch row. The withheld row ran on `screenrec_app_ui` (bench: `background_not_dark`).
7. **Bench `shape.js:208` has a sign slip:** moving a trapezoid's top edge up *widened* it (`w_top + 2·(y_top − v)·tan`). The port keeps the sides put (`w_top + 2·(v − y_top)·tan`), unit-tested via the invariant side angle. The joint control was ported verbatim as instructed.
8. **Radix slider grid:** the first key press on a slider snaps to the step grid from `min` (35.4° → 36.0°, shown honestly as +0.6). Bench sliders had the same property.

## 6. Known limitations carried forward

- **Sidebar collapses when the frame is wider than the window minus ~400 px** (pre-existing: the canvas element's layout width is the full frame, zoom is a CSS transform). At 1440 px wide the 1536-px reference clip hides the aside entirely, Apply included; the bar is unaffected. Backlog candidate, not 2B-2's.
- **Clear then Undo after Accept** restores the cone as an ordinary mask while the line said `draw_from_scratch`; **Accept → stroke → Undo → Adjust** can leave a restored red path under a fresh layer (sign-off §10-E family).
- **Accept's look** (§3) — shared with the brush path.
- Butterfly parametrisation caveat (2B-1 report §5) unchanged: the `bfly_z2b` fit needs a large apex move; B4 territory.
- Retina export payload (`MaskingCanvas.tsx:917`, out of scope) unchanged — the accepted path takes the same route as a brush mask; not exercised in the sandbox (dpr 1), see §0.1.
- **`uploads/`, `temp_extracted/`, `spokes/` are not in `.gitignore`** (they show as untracked whenever a sandbox job exists and hold PHI). The commit must be by explicit paths (§7); a one-line `.gitignore` addition is a separate, Andre-owned change since `.gitignore` carries his uncommitted `/sandbox/` line.
- Killing the dev server (SIGTERM) sweeps every `temp_extracted/` job — a sandbox restart means re-upload (2B-1 memory, re-confirmed the hard way twice).

## 7. Runbook facts

- **Commit by explicit paths:** `shared/automask/{shape,types}.ts`, `server/services/{automaskFlag,automaskOutcome}.ts`, `server/routes.ts`, `server/services/__tests__/{automaskShape,automaskOutcome,automaskHold}.test.ts`, `client/src/components/{MaskingCanvas,AutomaskProposalBar}.tsx`, `client/src/hooks/{useAutomaskProposal,useHoldRepeat}.ts`, `client/src/pages/template-mask-spoke.tsx`, `docs/refactor/AUTOMASK_ROUND2B2_{KICKOFF,PLAN,SIGNOFF,REPORT}.md`, `CLAUDE.md`. Not `uploads/`, `temp_extracted/`, `spokes/`, `scripts/automask_spike/dicoms.json`, `.idea/`.
- **Flag on:** `AUTOMASK_UI=1 pm2 restart masquerade --update-env && pm2 save` (`AUTOMASK=1` stays). Build: `npm run build` then `ls dist/` shows both files.
- **Verify:** upload a GE E9 `.dcm` → the spoke shows "Proposed" with a trapezoid, the yellow handle on the top edge, "Select & Move" active → Accept → "Cone accepted", Apply enabled → Apply → `pm2 logs masquerade --raw | grep '"stage":"automask.outcome"'` shows one line `{outcome:'accept', tier:'T0T1', deltas: all 0, model_switch: null}`; `apply.done` unchanged.
- **Flag-off check:** unset → a spoke open logs one `automask.served` (or `start/done` for a pre-2B-1 job) and renders today's spoke; POST answers `{status:'none', reason:'disabled', ui_enabled:false}`.
- **Pivot:** `pm2 logs masquerade --raw | grep '"stage":"automask.outcome"' | sed 's/.*\[PERF\] //' | node -e 'const L=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);const last={};for(const l of L)last[l.jobId]=l;const c={};for(const l of Object.values(last))c[l.outcome]=(c[l.outcome]||0)+1;console.log(c)'` — last line per `jobId`; a job with `automask.done` and no line is a dismiss.
- **Rollback:** one `git revert <sha>`; with `AUTOMASK_UI` unset the spoke is today's (§2 flag row).
- **B1 flip criterion:** met at 91 % accept-or-controls on the bench (kickoff §0); whether `AUTOMASK_UI=1` stays after the smoke test is the runbook's call.

## 8. Handoff — still to run outside the sandbox

1. **Display row (Andre's Mac, live):** Retina Accept → Apply → masked frame matches the drawn cone on the reference clip and one GE E9; keyboard hold on a visible tab (first repeat ≈ 0.4 s, visibly faster after 1.5 s).
2. **Prod smoke** per §7, then the flag decision.
3. The `automask.outcome` pivot after a week of real sessions → grade thresholds and the next tuning pass (B5's purpose).

---
> Round 2B-2 built per `AUTOMASK_ROUND2B2_PLAN.md` + sign-off; report `AUTOMASK_ROUND2B2_REPORT.md`. Headline: Accept-untouched IoU 0.9951 / 0.9944 / 0.9952 (fan / trap+T0 / rect+T0), one outcome line per job on nine jobs. Eight deviations in §5 for you to strike or keep (the re-seed range guard and the `shapeDeltas` null fix are the two that change behaviour). Uncommitted; commit by the §7 path list — `uploads/` and `temp_extracted/` are not ignored. Next: runbook → deploy behind `AUTOMASK_UI` → your display row → flag decision.
