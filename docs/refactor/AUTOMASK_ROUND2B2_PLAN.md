# Auto-mask Round 2B-2 — implementation plan (step 1: stop here for sign-off)

**Status:** plan, 2026-09-08, against `main` @ `74ed76b` (working tree: `tsc` = 12 re-verified today). Answers `AUTOMASK_ROUND2B2_KICKOFF.md` §5 in order, with `file:line` from the current tree and from fabric 5.3.0 as served by the CDN (`client/index.html:20`; line numbers below prefixed `fabric:` are in `https://cdn.jsdelivr.net/npm/fabric@5.3.0/dist/fabric.js`, fetched 2026-09-08). §10 lists the sub-decisions this plan adds on top of kickoff §3; nothing in kickoff §1–§3 is reopened. **No production code has been written.**

## 0. Files

| file | change |
|---|---|
| `shared/automask/shape.ts` | **+** `keepPolygon`, `keepPathData`, `controlSpecs`, `readouts`, `withControl`, `reseed` (pure; imports only `./types`, `shape.ts:7`) |
| `shared/automask/types.ts` | **+** `ui_enabled?: boolean` on `ProposalJson` (`:60-84`, additive, optional so cached files type-check unchanged) |
| `server/services/automaskFlag.ts` | **+** `AUTOMASK_UI_FLAG_ENV = 'AUTOMASK_UI'`, `automaskUiEnabled(env)` — the `:11` regex verbatim |
| `server/services/automaskOutcome.ts` *(new)* | zod schema + pure `handleOutcome(jobId, body, deps)` (§6) |
| `server/routes.ts` | `:509` and `:512` stamp `ui_enabled`; **+** `app.post(".../proposal/outcome")` after `:514` |
| `client/src/components/MaskingCanvas.tsx` | props `:8-15`; guards in `object:added` `:64-75` and `object:modified` `:77-80`; `object:removed` hook in the init effect; frame-loaded tick at `:255`; **+** one layer effect (§1). `updateMaskFromCanvas` `:845-1135` untouched |
| `client/src/pages/template-mask-spoke.tsx` | proposal session state (reducer), bar mount inside `<main>` `:329`, canvas props `:336-343`, outcome POST from `handleStartProcessing` `:188` |
| `client/src/hooks/useAutomaskProposal.ts` *(new)* | fetch + `pending` poll (§2.1) + `postOutcome` |
| `client/src/hooks/useHoldRepeat.ts` *(new)* | the nudge scheduler (§7) |
| `client/src/components/AutomaskProposalBar.tsx` *(new)* | bar, grade words, Accept / Draw from scratch / Adjust, model switch (`ui/toggle-group.tsx`), controls (`ui/slider.tsx`), arrow buttons, `fitted → now (Δ)` |
| `server/services/__tests__/automaskShape.test.ts`, `automaskOutcome.test.ts` *(new)* | §4 unit row; `npx tsx …` like the 2B-1 tests |
| `docs/refactor/AUTOMASK_ROUND2B2_REPORT.md`, `CLAUDE.md` status block | step 2 |

## 1. Component boundary, the `_automask` path, the removal rule

**Surface.** `MaskingCanvas` (`:8-15`, sole call site `template-mask-spoke.tsx:336-343`) gains two optional props: `proposal?: { shape: KeepShape; bound: Bound | null; margin: number; mode: 'proposal' | 'accepted' } | null` and `onProposalEvent?: (e: { kind: 'drag'; dx: number; dy: number } | { kind: 'removed'; by: 'stroke' | 'clear' }) => void`. The spoke owns `fitted`, `current`, `model`, `controls_used`, `t_rendered`, `posted` (a `useReducer` in the page); the canvas owns nothing but pixels. `mode` replaces the kickoff's imperative accept hand-off (§10-A): Accept = `mode:'accepted'`, Adjust = `mode:'proposal'`, Draw from scratch / dismissed = `null` — three transitions through one prop.

**Create / replace.** One new effect keyed on `[proposal, frameLoaded]`. `frameLoaded` is a counter bumped at `:255` (the frame effect `canvas.clear()`s at `:252` and re-adds the image at `:253`, so the layer must be added after it). On each run it removes the previous `_automask:'proposal'` path and `'handle'` circle under an `internalRemoval` flag, then adds `new fabric.Path(keepPathData(shape, w, h, bound, margin), { fill:'rgba(255,0,0,0.35)', stroke:'red', strokeWidth:2, fillRule:'evenodd', selectable:false, evented:false, excludeFromExport:true, _automask:'proposal' })` and the handle (§2). Frame pixels: the canvas is `setDimensions`'d to the frame at `:235-238` and zoom is the CSS `scale()` at `:1279`, so no factor anywhere.

**Accept** (`mode → 'accepted'`): remove the handle, set `strokeWidth:1`, `_automask:'mask'`, `excludeFromExport:false` on the path, then call the **existing** `updateMaskFromCanvas(path)` (`:845`). Its `objects` (`:849`) is then exactly `[path]`; `:923-947` clones it onto the export canvas — `fillRule` is in fabric's `toObject` list (`fabric:15036`) and honoured at render (`fabric:15970`), the recon §1.4 proof; the `path` branch at `:934-938` forces `stroke:'red', strokeWidth: obj.strokeWidth || 36` (hence 1, never 0 — §10-G); `case 'path'` `:1077-1105` → `type:'freeform'` + `canvasDataUrl`; `:1134 onMaskUpdate` → spoke `handleMaskUpdate` `:186` → `ProcessingControls` mounts (`:307`) → Apply via the existing `disabled` (`:314`). **Adjust** (`mode → 'proposal'`): remove the `'mask'` path and any `_aiOverlay` image (`:260-284` adds one for every `maskData.canvasDataUrl`, Accept included — today's behaviour for brush masks, reused byte for byte), re-add layer + handle from `current`; the spoke sets `maskData` null.

**Removal rule (kickoff §3.2) — three fabric hooks, all in the init effect `:46-219`:**
- `object:added` `:64-75`: first line `if (obj._automask) return;` (also stops the `:68` recolour from painting our translucent layer opaque red); then `if (obj.type !== 'image' && proposalRef.current) removeLayer(); onProposalEvent({kind:'removed', by:'stroke'})`. Every tool reaches it through `canvas.add`: rectangle `:362` (on `mouse:down`, so the layer goes at the first press), circle `:443` (same `:411` guard), polygon's first vertex helper `:523-532`, brush `:752`. **`path:created` never fires** — the brush is custom (`isDrawingMode = false` `:606`) and only `off`s it (`:613`).
- `object:modified` `:77-80`: `if (e.target?._automask) return;` — mandatory: a handle drag end would otherwise reach `updateMaskFromCanvas(handle)` → `case 'circle'` `:1005` → a circle mask enabling Apply.
- `object:removed` (`fabric:9666`): if the target is `'proposal'`/`'handle'` and `!internalRemoval` → `removeLayer(); onProposalEvent({kind:'removed', by:'clear'})`. This is how `clearMask` (`MaskingTools.tsx:39-43` → `:211` → the `:96-101` loop) and the Eraser tool (`:814-817`, §10-D) reach the same removal with no edit to either. `handleUndo`'s `canvas.clear()` `:132` cannot meet a live layer (the stack is only pushed by Clear/Eraser/tool `mouse:down`, each of which removed it first); `:252` runs before the layer exists.
- Undo snapshots (`toJSON` at `:86`, `:336`, circle/polygon equivalents, `:801`) skip `excludeFromExport` objects (`fabric:10064` `_toObjects` filter) — the layer and handle never come back as red selectable objects (§10-C).

**Draw from scratch (button):** spoke sets `proposal:null` (internal removal, no notice), POSTs `draw_from_scratch`, `setSelectedTool('rectangle')` (`:36`). **Default tool while the layer shows:** `setSelectedTool('select')` when the layer first renders — `enableSelectTool` `:835-843` `off`s all mouse handlers and leaves rubber-band selection, which adds nothing; the handle is the only selectable target. A stroke-removal leaves the user's chosen tool alone. `MaskingTools.tsx:54` highlights "Select & Move" — honest, not edited.

## 2. Pointer mapping under the CSS zoom

The existing tools call `canvas.getPointer(e.e)` (`:60` readout, rect `:347/:368`, brush `:646/:660`) inside the `transform: scale(zoom/100)` container (`:1279`) and land where the pointer is at the 75 % default. `fabric:12499` `getPointer` reads `upperCanvasEl.getBoundingClientRect()` (`:12510`), `calcOffset()` (`:12524`), divides out retina (`:12531-12534`), then multiplies by `cssScale = upperCanvasEl.width / boundsWidth` (`:12542-12551`) — that ratio *is* the CSS scale. Object dragging runs `__onMouseMove` (`fabric:13711`) → `_transformObject` (`:13848`) → `_performTransformAction` (`:13863`) with the same `getPointer`, so the handle's `object:moving` `left/top` are canvas pixels at any zoom. The handle: `fabric.Circle` r 8, `_automask:'handle'`, `selectable:true, evented:true, hasControls:false, hasBorders:false, lockScalingX/Y, lockRotation, excludeFromExport:true`, placed each render at the apex (fan; when the apex is above the frame — Butterfly, 2B-1 report §5 — at the axis ∩ top edge instead) or `(cx, y_top)` (trap/rect); `object:moving` emits `{dx, dy}` against the last event and the spoke applies `withControl(current, 'position', {dx, dy})`. The rect tool's `:331` early-return on `e.target` means a press on the handle never starts a rectangle even with the rectangle tool selected. No new pointer math.

## 3. `@shared` alias; nothing Node-side

`vite.config.ts:22` `"@shared": path.resolve(import.meta.dirname, "shared")`; `tsconfig.json:20` `"@shared/*": ["./shared/*"]`, `include` `:2`. The client already imports `@shared/schema` (`template-mask-spoke.tsx:10`). `shape.ts:7` imports only `./types`; `types.ts` imports nothing; every `shared/automask/*.ts` import is relative (`grep ^import shared/automask/*.ts` — no `fs`/`path`/`sharp`/`worker_threads`). The client imports `@shared/automask/shape` and `@shared/automask/types` only; the test imports `render.ts`/`fan.ts` (Node side, fine).

## 4. The joint control — signatures and invariants

```ts
type ControlId = 'half_angle' | 'top_width' | 'top_arc' | 'depth' | 'position'      // fan
               | 'side_angle' | 'top' | 'bottom' | 'width';                         // trap / rect ('top_width' shared)
controlSpecs(kind, w, h): { id; label; unit:'deg'|'px'; min; max; step }[]           // kickoff §3.7 ranges (§10-H)
readouts(shape): Partial<Record<ControlId, number>>                                  // from the CURRENT shape — the PASS2 §4 bug
withControl(shape, id, value: number | { dx: number; dy: number }): KeepShape        // pure; out-of-range → clamped
```
Port of `bench_static/shape.js:185-213 withParam()`, key by key: fan `half_angle` (`:188`, sets `th_l/th_r`), **`top_width` = `top_width_arc` `:189-199` verbatim** — `yArc = ay + r_in`, `yOut = ay + r_out`, `wBot = 2·r_out·sin h`, `wTop = min(v, 0.98·wBot)`, `ρ = wTop/wBot`, `ay' = (ρ·yOut − yArc)/(ρ − 1)`, `r_out' = yOut − ay'`, `r_in' = yArc − ay'`, `sin h' = min(0.999, wBot/(2·r_out'))`, unchanged unless `r_in' > 0 ∧ r_out' > r_in' ∧ sin h' > 0.01` — `top_arc` = `r_in`, `depth` = `r_out`; trap `side_angle` `:205` (top edge fixed, `w_bottom` follows), `top_width` = `w_top` `:207` (bottom stays), `top` = `y_top` `:208` (sides stay → `w_top` follows the side lines, trap only), `bottom` = `y_bottom` `:209`; rect `width` `:206` (`w_top = w_bottom`), `top`/`bottom` plain; `position` (new, B3) translates `ax,ay` / `cx,y_top,y_bottom`. Unit tests (§4 row): after any `top_width` value, `ay'+r_in' = yArc`, `ay'+r_out' = yOut`, `2·r_out'·sin h' = wBot` to 1e-9 across the range; `readouts(withControl(s,'top_width',v)).top_arc_y = current.ay + current.r_in` (not the fitted apex); `shapeDeltas(fit, fit)` all zero; every control is a no-op at its fitted value.

## 5. `reseed(shape, to: 'fan' | 'trap' | 'rect')` — six transitions

| from → to | rule |
|---|---|
| fan → trap | sides = the fan's radii, top/bottom = the chords: `cx = ax`, `y_top = ay + r_in·cos h`, `w_top = 2·r_in·sin h`, `y_bottom = ay + r_out·cos h`, `w_bottom = 2·r_out·sin h` (draft: "widths at `r_in`/`r_out` and the axis") |
| trap → fan | apex = side-line intersection: `h = atan2((w_bottom−w_top)/2, y_bottom−y_top)`, `ax = cx`, `ay = y_top − (w_top/2)/tan h`, `r_in = (w_top/2)/sin h`, `r_out = (w_bottom/2)/sin h`; **|h| < 1° (parallel) → the rect → fan rule on the mean width** (§10-F). fan → trap → fan round-trips exactly (§4 test: ≤ 2 px / 1°) |
| trap → rect | `w_top = w_bottom = (w_top + w_bottom)/2`, y's kept |
| rect → trap | `kind:'trap'`, widths equal (side angle 0; the user opens it) |
| rect → fan | kickoff §3.6 verbatim: `h = 30°`, `r_in = w` (chord `2·r_in·sin 30° = w`), `ay = y_top − w` (arc's lowest point at `y_top`), `ax = cx`, `r_out = y_bottom − ay`; test: chord = width, `ay + r_in = y_top`, `r_out > r_in` |
| fan → rect | `rect(trap(fan))` — the mean of the two chords (§10-F) |

Re-seed always takes the **current** shape (kickoff §3.6). `shapeDeltas` (`shape.ts:29`) already returns non-null for trap ↔ rect (`:43`) and null across fan ↔ trap/rect.

**`keepPolygon(shape, w, h, bound, margin): Pt[] | null`** (§2.2): fan = outer arc sampled at ≤ 1 px chord error (`n = ceil(2h / (2·acos(1 − 1/r)))` segments), two radii, inner arc (or the apex when `r_in < margin`); trap/rect = the four `roundHalfEven` points `trap.ts:15-18` uses. Clip (axis-aligned Sutherland–Hodgman) to `frame ∩ bound` in index space — a kept pixel `x ∈ [x0, x1]` inclusive (`render.ts:20`, `geometry.ts:577`) is the continuous interval `[x0 − ½, x1 + ½]`. Inset every edge by `margin` along its inward normal **except edges lying on the frame border**: `erode` counts outside the image as 1 (`geometry.ts:171`) but pixels outside the T0 box as 0, so shape edges and bound edges erode, frame edges do not. The kernel is cv2's 5 × 5 ellipse (`geometry.ts:165-168`), support 2.0 on-axis / ≈ 2.1 diagonal, so a uniform 2 px inset is within 0.12 px of the raster. `keepPathData` = `M0 0 H w V h H 0 Z` + the inset polygon shifted by +½ px (pixel index → canvas pixel centre) for `fabric.Path`. §4 test: rasterise `keepPolygon` with a point-in-polygon sampler at integer coordinates (the convention `renderFan` samples, `fan.ts:15-22`) vs `renderKeepMask(shape, w, h, bound, margin)` (`render.ts:14`) on `fixtures/automask/synthetic_fan/proposal.json` (no bound) and `synthetic_trap/proposal.json` (bound `{8,100,623,860}`) → IoU ≥ 0.99 via `iou` (`fan.ts:69`); the half-pixel conventions are settled by that test, not by argument.

## 6. The outcome route

- **Flag read:** `automaskFlag.ts` — `automaskUiEnabled(env)` beside `automaskEnabled` `:10-12`, same regex. **`ui_enabled` stamped at serve time** in `routes.ts:509` (`res.json({ ...proposal, ui_enabled: automaskUiEnabled() })`) and on the `:512` error body — never into `temp_extracted/<job>/automask.json`, so a pm2 flag flip is live on the next GET; `run.ts --server` (`run.ts:91`) tolerates the extra field. The 13 endpoint tests call the service, not the route, and are unchanged.
- **Route:** `app.post("/api/jobs/:jobId/template-mask/proposal/outcome", …)` after `routes.ts:514`. Order: gate `automaskEnabled(env) && automaskUiEnabled(env)` else `200 {version:2, status:'none', reason:'disabled', jobId, ui_enabled:false}` and **no log** (the GET's disabled shape, `automask.ts:129`); `storage.getJobV2` (`routes.ts:5`) → `404 {error:'Job not found'}` (as `:508`); `outcomeSchema.safeParse(req.body)` → `400 {error:'invalid outcome', issues}`; then **one** `perfMark(jobId, 'automask.outcome', {...parsed, fingerprint:null, template:null})` (`perf.ts:14-16`) → `204`. `express.json` is already 50 MB (`index.ts:10`). Nothing stored.
- **Schema** (`server/services/automaskOutcome.ts`, zod `^3.24.2` `package.json:93`, used in `shared/schema.ts:4,134`): `.strict()` object of kickoff §2.5 — `outcome: enum`, `controls_used: string[].max(16)`, `deltas: ShapeDeltas | null` (six nullable finite numbers), `model_switch: {from: Model, to: Model} | null`, `final_keep: KeepShape | null` (discriminated on `kind`, `sym: literal(true)`), `fingerprint: null`, `template: null`, `grade_shown: enum`, `tier: enum`, `ms_to_decision: number ≥ 0`. Tests: valid → 204 + exactly one log line with `jobId`; malformed → 400, no log; either flag off → disabled body, no log; unknown job → 404.
- **`run.ts --db` gains outcome columns: No.** The outcome is a log line, not a job column; the §4 IoU row already works through the existing join (`run.ts:80-107`, applied mask decoded at `:101-105`). Pivot = `pm2 logs masquerade --raw | grep '"stage":"automask.outcome"'`; the one-liner goes in the report §8.

## 7. The nudge scheduler (`useHoldRepeat`)

One `setTimeout` chain (no `setInterval`): `start(dir)` steps once, records `t0`, then `tick()` schedules the next step at `elapsed < 400 ? 400 − elapsed : elapsed < 1500 ? 100 : 25` ms → first repeat at 400 ms, 10 px/s to 1.5 s, 40 px/s after. Step = `dir × (shiftRef.current ? 10 : 1)` read at each tick (`shiftRef` set by window `keydown`/`keyup` of Shift, so Shift multiplies the step, never the rate). Stop: `pointerup` / `pointercancel` / `pointerleave` on the arrow button, `keyup` of the held arrow, window `blur`, and the hook's effect cleanup (unmount, or `proposal` becoming null / `mode:'accepted'`). Keyboard: one window `keydown` listener registered only while `proposal?.mode === 'proposal'`; ignores `e.repeat` (OS auto-repeat — the schedule is ours), ignores targets `INPUT`/`SELECT`/`TEXTAREA`/`isContentEditable`/`role="slider"` (the output-settings inputs in `ProcessingControls` and the Radix thumbs), `preventDefault()` on the four arrows so the page does not scroll. Sliders: `ui/slider.tsx` is Radix Slider — arrow = 1 step, Shift+arrow = 10 steps natively (`@radix-ui/react-slider/dist/index.mjs:127-128`), which is B3's slider clause with no code. Report numbers (nudge row): `pointerdown` via `javascript_tool`, readout sampled at 800 ms (expect 1 tap + repeats at 400/500/600/700/800 = 6 px; kickoff says ≈ 4 in the first 800 ms — I report what is measured) and at 2000 ms (≈ 40 px/s after 1.5 s).

## 8. §4 rows → drivers

| row | driver | where |
|---|---|---|
| unit | `npx tsx server/services/__tests__/automaskShape.test.ts` + `automaskOutcome.test.ts`; 2B-1 tests re-run | unattended, no DB |
| family | curl-upload `bfly_z2b`, `Normal_Lung`, `ge_e9_2124113685` (+ a corpus clip proposing `rect`, else `synthetic_trap` as an image batch); Browser pane on `localhost:5001/jobs/<id>/template-mask`, screenshots at 50 / 75 / 100 / 150 | sandbox, me |
| outcome | Accept → Apply in the Browser pane; `run.ts --db postgresql://masq@localhost:5433/masq --server http://localhost:5001` IoU row; the other outcomes by clicking / `javascript_tool`; `grep automask.outcome` on the server log counts lines per job | sandbox, me |
| nudge | `javascript_tool` `pointerdown` + timed readouts; synthetic `KeyboardEvent`s (with/without Shift, from an output-settings input); `computer` drag of the handle at zoom 50 and 150 vs the readout; `window.scrollY` unchanged | sandbox, me |
| withheld | `sonosite_011_clip10` → no bar, no POST in the log | sandbox, me |
| flag | `AUTOMASK_UI` unset in `sandbox/.env.sandbox` → `document.body.innerHTML` (blob URLs normalised) vs the same job on `git stash`ed `74ed76b` (same cwd, same frames; a worktree would have an empty `temp_extracted/`); `automask.served` count per open = 1; both flags off → curl the POST → disabled body, no log | sandbox, me |
| pending | curl-upload the reference clip, open the spoke within 2 s: `frames/0` 503s → one proposal GET sequence, layer once; `job.status` flips cause no second GET (network list) | sandbox, me |
| display | Andre live: Accept → Apply on the reference clip and one GE E9 (sign-off 6). My Browser-pane runs are already on this Retina Mac (dpr 2), so the equivalence IoU comes from my run; Andre's row is the human check | Andre's Mac |
| invariants | `npx tsc --noEmit` = 12; `npm run build` → both `dist/` files; `git diff --stat` shows `videoProcessor.ts`, `frameExtractor.ts`, `maskWorker.ts` absent and `MaskingCanvas.tsx:845-1135` unchanged | unattended |
| prod | runbook (Andre): flag on, the kickoff §8 verify sequence, flag-off check | prod |

## 9. Effort vs 3 days

| part | days |
|---|---|
| server: flag, `ui_enabled`, outcome route + zod + 4 tests | 0.25 |
| `shape.ts`: polygon/clip/inset, specs/readouts/`withControl` (joint control port), `reseed` × 6, tests | 0.75 |
| `MaskingCanvas`: props, layer effect, handle, three hooks, accept/adjust | 0.5 |
| spoke: fetch hook, session reducer, bar + controls + switch, nudge hook + keyboard, outcome POST | 0.75 |
| §4 matrix in the sandbox + report | 0.75 |
| **total** | **3.0** |

Cut order if over: **§3.4 Adjust first** (≈ 0.15 d — the `'accepted' → 'proposal'` transition and the collapsed bar); then the rect family row degrades to the synthetic fixture (already allowed by §4). B3's hold-acceleration and drag handle are requirements and stay.

## 10. Sub-decisions this plan adds (sign off or strike)

- **A.** Declarative `proposal.mode` (`'proposal' | 'accepted'`) instead of an imperative accept ref — Adjust needs the reverse transition, and one prop gives both with `MaskingCanvas` a function of its props.
- **B.** Removal notices ride the single `onProposalEvent` callback (`drag` | `removed`): only the canvas sees `object:added` / `object:removed`.
- **C.** `excludeFromExport: true` on the layer and handle, so the tools' Undo snapshots never capture them and no tool handler is edited (`fabric:10064`). The accepted `'mask'` object is exportable like any mask.
- **D.** The Eraser tool ("Erase All", `:799-833`) is a fourth removal path, handled as `'clear'` by the `object:removed` hook.
- **E.** After Accept a hand stroke is unioned with the cone (today's multi-object export, `:923-947`); the outcome is then `edit` with `'freehand'` appended to `controls_used`. Clear after Accept → `draw_from_scratch`. Clear then Undo after Accept restores the cone as an ordinary mask while the line says `draw_from_scratch` — known limitation, reported.
- **F.** Compositions the draft does not name: fan → rect = `rect(trap(fan))`; trap → fan with parallel sides (|angle| < 1°) uses the rect → fan rule; trap → rect takes the mean width.
- **G.** Mask stroke 1 px at Accept (the export forces `strokeWidth: obj.strokeWidth || 36`, `:937`); ± 0.5 px is inside the IoU ≥ 0.99 row.
- **H.** Ranges are the kickoff's §3.7 numbers, not the bench's (`shape.js:148-150` had 1° and −4·h).
- **I.** `model_switch = {from: fitted model, to: final model}` when the families differ, else `null` — the §2.5 schema literally; intermediate switches are not logged.
- **J.** `controlSpecs` / `readouts` live in `shape.ts` with the rest (pure, testable).
- **K.** `accept` vs `edit` is decided at Apply from `shapeDeltas(fitted, current)` with the kickoff §3.5 thresholds (0.5 px / 0.5°), plus E.

## 11. Do not touch
`updateMaskFromCanvas` `:845-1135`, every tool's `enable*` handler (`:316-843`) except the three event hooks in §1, `buildApplyMask`, the apply loop, the reuse guard, extraction, `maskWorker.ts`, `automask.ts` / `automaskT0.ts` / `automaskWorkerClient.ts` / the worker entry, `ProcessingControls.tsx`, `MaskingTools.tsx`, A3 storage/schema, `package.json` (`fabric ^6.7.1` stays unused), `info.grade_thresholds`. One commit, one `git revert`.

---
> Plan approved → build 2B-2 exactly per `AUTOMASK_ROUND2B2_PLAN.md` (§10 A–K as written, or with the ones I struck), `tsc` 12, A3 frozen, export path untouched, then stop after `AUTOMASK_ROUND2B2_REPORT.md` for the runbook.
