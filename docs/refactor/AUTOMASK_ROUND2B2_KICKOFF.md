# Auto-mask Round 2B-2 — kickoff: the spoke behind `AUTOMASK_UI`

**Status:** kickoff, 2026-09-09, against `main` @ `74ed76b` (2B-1 deployed 2026-09-08, green on prod). **Executor:** Claude Code. **Design is approved** — `AUTOMASK_ROUND2B_RECON_PROPOSAL.md` §3 with `AUTOMASK_ROUND2B_SIGNOFF.md` §1 decisions 1–7 — so this round has **no recon**. Step 1 is a one-page **implementation plan** with `file:line` answering §5 below, then stop for sign-off; step 2 is the build, stopping after `AUTOMASK_ROUND2B2_REPORT.md` for the runbook. No production code before the plan is approved. Budget: ~3 days (sign-off decision 7).

**Requirements:** `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md` §B — B1, B2, B3, B5, B7 are 2B-2's and are repeated verbatim in §1; B4 and B6 are 2C's. They are Andre's, from the bench sessions; do not re-interpret them.

## 0. What 2B-1 on prod means for 2B-2

| prod fact (`CLAUDE.md` status block, 2026-09-08) | consequence for the spoke |
|---|---|
| Proposal computed at `ready`, `automask.start` **14 ms** after `bg_extract.done`; `ms_propose` **1425 ms** cold on 1080p, **796 ms** on 1054×802; main-thread stall across a 1698 ms proposal **max 133 ms / p50 2 ms** | The spoke will almost always find `cached: true, computed_by: 'ready'` on its first GET. The `pending` poll (§2.1) covers only the ≤ ~1.5 s window between `ready` and `automask.done` and pre-2B-1 jobs (lazy compute). Nothing in the spoke waits on the proposer for long, and the proposer never blocks the frames poll. |
| Apply immediately after `ready`: **8528 ms** vs the 8.7 s baseline | Accept → Apply adds no timing concern; the outcome POST is fire-and-forget and must never delay or gate Apply. |
| Constants frozen 2026-09-06: 39/50 tolerant on the references; **91 % accept-or-controls** on Andre's fresh judgements | B1's flip criterion (≥ 90 %) is met on the bench. 2B-2 still ships **default-off**; whether `AUTOMASK_UI=1` stays set on prod after the smoke test is the runbook's decision, not this round's. |
| `fabric` **5.3.0** from the CDN (`client/index.html:20`) is what `MaskingCanvas` runs; `fillRule:'evenodd'` proven to survive `clone` + `toDataURL` (recon §1.4) | The proposal layer and the accepted mask are one `fabric.Path`; no raster fallback; the export path is untouched. |
| Canvas at native frame pixels (`MaskingCanvas.tsx:235`), zoom is a CSS transform (`:1276-1279`) | The layer is drawn in full-resolution frame pixels, no scale factor anywhere. |
| Sign-off decisions 3, 4, 5 | Accept **sets the mask; Apply stays the user's click**; the outcome is **one server `[PERF] automask.outcome` line** via a flag-gated POST; the UI flag reaches the client as **`ui_enabled` on the proposal body** (additive). |

## 1. Requirements (verbatim from the 2B/2C draft §B)

**B1. The proposal is the default entry to the template-mask spoke (2B).** On open: frame 1 with the proposed cone drawn, the controls, and two primary actions — **Accept** and **Draw from scratch**. Blank canvas on withheld/error/flag-off is exactly today's behaviour. Flag default-off at deploy; flipped to default-on when the corpus is at ≥ 90 % accept-or-controls.

**B2. Controls (2B) — the bench v4 set, not a subset:** half-angle (both sides together), **top width (arc stays)** joint control, top arc height, depth, apex/whole-cone position. Every control shows `fitted → now (Δ)`. Rectangles get width and top/bottom; trapezoids get side angle, top width, top, bottom.

**B3. Nudge ergonomics (2B).** Arrow buttons and keyboard arrows: tap = 1 px; **press-and-hold repeats with acceleration** (≈ 10 px/s after 400 ms, ≈ 40 px/s after 1.5 s); Shift = ×10; drag handle on the apex (fan) / top-edge midpoint (trap/rect) for coarse moves. Sliders: keyboard-adjustable with the same Shift rule.

**B5. Telemetry (2B).** One `[PERF] automask.outcome` line per job: Accept / Edit / Dismiss, which controls were used, each Δ, fingerprint id, template hit or miss. This is what sets the grade thresholds and tells us which vendor needs the next tuning pass.

**B7. Model switch (2B) — added 2026-09-06 from `AUTOMASK_2A_GO.md` §3, Andre's requirement from the `2026-09-06_1041` re-review (notes on `bfly_z9` and `sonosite_011_clip10`).** The controls edit parameters; two of the three residual "wrong" verdicts are the wrong *shape family*. 2B adds a three-way switch **fan / trapezoid / rectangle** on the proposal bar. Switching re-seeds the new model from the current shape's geometry (fan → trap: top/bottom widths at `r_in`/`r_out` and the axis; trap → fan: apex from the side lines' intersection, radii from top/bottom; rect ↔ trap: equal widths), so the user lands close and adjusts, never starts from nothing. Telemetry logs the switch.

*B5 note:* "fingerprint id" and "template hit or miss" are B4 fields; 2B-2 emits them as `fingerprint: null, template: null` so the line's shape is stable when 2C fills them. Dismiss is not inferred (recon §3.5): the absence of an outcome line for a job with `automask.done` is the dismiss signal in the pivot.

## 2. Design (approved — recon §3; restated only where 2B-2 has to make it concrete)

### 2.1 Flag and fetch
`AUTOMASK_UI` read server-side in `automaskFlag.ts` with the same regex as `AUTOMASK`; surfaced as `ui_enabled: boolean` on **every** proposal body (additive, contract stays v2). The spoke fetches `GET …/template-mask/proposal` once `frameStatus === 'ready'`; `pending` → poll every 1 s for ≤ 60 s, silently; `none` / `disabled` / `ui_enabled: false` / timeout / fetch error → nothing rendered, today's spoke. **The one observable difference with `AUTOMASK_UI` off is one cached GET (`automask.served`) per spoke open** — state that in the report; the DOM must be identical.

### 2.2 The proposal layer
One `fabric.Path`, outer subpath = frame rectangle, inner subpath = the keep polygon (fan: arc sampled at ≤ 1 px chord error, two radii; trap/rect: four points), clipped to the T0 box (axis-aligned Sutherland–Hodgman) and offset inward by `margin_px` from the body, so the accepted mask matches the proposer's `keep` to within a pixel. `fillRule:'evenodd'`, fill `rgba(255,0,0,0.35)`, red stroke, tagged `_automask`, `selectable:false, evented:false` while it is a proposal. Recomputed from parameters on every control change. Frame pixels, no scaling.

Shape math is pure and lives in `shared/automask/shape.ts` next to `topWidthPx` / `shapeDeltas`: `keepPolygon(shape, bound, margin)`, `withControl(shape, control, value)`, `reseed(shape, toKind)`. Unit-tested; imported by the client through the existing `@shared` alias; nothing Node-side may leak into that file.

### 2.3 Bar, controls, nudge
- **Bar:** grade words only — `proposed` → "Proposed", `check_depth` → "Proposed — check the depth". Actions: **Accept**, **Draw from scratch**, model switch **fan / trapezoid / rectangle** with re-seed.
- **Controls (B2):** fan — half-angle, top width (arc stays), top arc height (`r_in`), depth (`r_out`), position; trapezoid — side angle, top width, top, bottom; rectangle — width, top, bottom. Each shows `fitted → now (Δ)`; readouts computed from the *current* shape (the PASS2 readout bug). The joint control's closed form is `AUTOMASK_PASS2_REPORT.md` §4 / `bench_static/shape.js withParam()` — port it, do not re-derive it.
- **Nudge (B3):** arrow buttons + keyboard arrows move the whole cone (the position control). Tap = 1 px. Hold: first repeat at 400 ms, then every 100 ms (10 px/s); from 1.5 s every 25 ms (40 px/s). Shift multiplies the step ×10, not the rate. Drag handle on the apex (fan) / top-edge midpoint (trap/rect), a small `evented:true` fabric object whose `moving` event writes the position. Sliders: arrow keys step 1 unit, Shift ×10. Keyboard handlers run only while a proposal is active, ignore events whose target is a text input / select / textarea, and `preventDefault` so the page does not scroll.

### 2.4 Accept → mask (sign-off decision 3)
Accept flips the layer from proposal to mask object (`_automask` cleared, still non-interactive) and hands it to the **existing** `updateMaskFromCanvas` (`MaskingCanvas.tsx:845-1130`; the `path` case at `:1077` → `type:'freeform'` + `canvasDataUrl`). `maskData` lands in spoke state → `ProcessingControls` appears → Apply enabled by the existing `canApply`. Nothing in the export path changes.

### 2.5 `automask.outcome` (B5)
`POST /api/jobs/:jobId/template-mask/proposal/outcome`, gated by `AUTOMASK` **and** `AUTOMASK_UI`, zod-validated, body:

```
{ outcome: 'accept' | 'edit' | 'draw_from_scratch',
  controls_used: string[],           // control names from §2.3, e.g. ['half_angle','depth','position']
  deltas: ShapeDeltas | null,        // shapeDeltas(fitted, final); null when the family changed (fan ↔ trap/rect)
  model_switch: { from: Model, to: Model } | null,
  final_keep: KeepShape | null,      // what 2C needs; stored nowhere
  fingerprint: null, template: null, // B4 placeholders
  grade_shown: 'proposed' | 'check_depth', tier: 'T1' | 'T0T1',
  ms_to_decision: number }           // layer first rendered → Apply click (or → Draw from scratch)
```
Server emits **one** `[PERF] automask.outcome` line with those fields + `jobId`, stores nothing, returns `204`. Flag off → the GET's disabled shape, no log. Unknown job → 404 (as the GET).

### 2.6 Grade copy
Words only. `info.grade_thresholds` and the thresholds themselves do not move in 2B-2.

## 3. Sub-decisions settled here (so the plan does not reopen them)

1. **State ownership.** Proposal state — `fitted` (the body's `keep`), `current`, `model`, `controls_used`, `t_rendered` — lives in the spoke (a hook is fine). `MaskingCanvas` gets **one additive prop** (`proposal: { shape, bound, margin } | null`) plus one callback for the drag handle and one imperative accept hand-off; it never owns the parameters. Its existing tool handlers are not edited beyond the removal rule in (2).
2. **"Drawing anything removes the layer."** The layer is removed on the first non-`_automask` object added to the canvas, on `clearMask` (`MaskingTools.tsx:39-41` → `MaskingCanvas.tsx:211`), and on the **Draw from scratch** button. Selecting a tool does *not* remove it — a stray tool click must not cost the user the proposal; the first stroke does. Whichever of the three fires first POSTs `draw_from_scratch` once.
3. **Default tool while a proposal is shown:** none / select, so a stray click on the canvas does nothing. Today the spoke defaults to `"rectangle"` (`template-mask-spoke.tsx:36`), so a stray click-drag would draw a rectangle and, under (2), delete the proposal. The plan states how the tool is set to none only when a proposal renders, and restored to `"rectangle"` on Draw from scratch.
4. **Accept is reversible until Apply.** After Accept the bar collapses to "Cone accepted" with **Adjust** (removes the mask object, re-adds the layer, clears `maskData`) and **Draw from scratch**. Nothing is POSTed on Accept or Adjust; the outcome line fires on Apply with whatever is final. This is the one addition beyond B1–B7; if the plan is over budget it is the first thing cut.
5. **`accept` vs `edit`:** `edit` when the family changed or any `|Δ|` > 0.5 px (0.5° for angles); otherwise `accept`. Same-family switches (trap ↔ rect) keep `deltas` non-null (`shapeDeltas` already treats `trap` and `rect` together).
6. **Re-seed (B7) is a pure function with the draft's rules verbatim**, plus the degenerate case the draft does not cover: **rect → fan** (parallel sides, no apex). Rule: half-angle 30°, apex placed above the top edge so the arc's chord at `r_in` equals the rect width and the arc's lowest point sits at `y_top`; `r_out` = apex-to-`y_bottom`. Re-seed from a **fan** uses the current (possibly adjusted) shape, not the fitted one.
7. **Control ranges** are generous, not tight: half-angle 5–85°; apex anywhere in the frame extended by 50 % of the frame height above the top (the Butterfly fits need a ~200 px apex move — 2B-1 report §5); `r_in` 0 … `r_out` − 10; `r_out` up to the frame's far corner; trap/rect `y_top ≥ 0`, `y_bottom ≤ h`, widths 10 px … 1.5 × w, side angle ±60°. The keep polygon is still clipped to the T0 box when one exists; the controls are not.
8. **One outcome POST per job per spoke session**, deduped client-side. Reopening the spoke later shows the cached proposal again and may POST a second line; the pivot takes the last line per `jobId`. The server does not dedupe.
9. **Pointer mapping for the drag handle** rides whatever the existing rect/brush tools use under the CSS zoom; the plan names the code path that proves it (§5.2). No new pointer math.
10. **Errors never surface as UI.** A failed proposal fetch, a rejected outcome POST, or a shape-math exception logs to the console and leaves today's spoke; never a toast, never a blocked Apply.

## 4. Test matrix (runbook rows; sandbox unless marked Mac/prod)

| axis | rows |
|---|---|
| unit | `keepPolygon` rasterised vs `propose().keep` on both synthetic fixtures: IoU ≥ 0.99; joint top-width control keeps the arc's lowest point (`ay + r_in`) fixed; `withControl` readouts come from the current shape; `reseed` fan → trap → fan lands within 2 px / 1° of the start, rect → fan produces a valid fan with the chord = width; `shapeDeltas` of an untouched Accept is all-zero; outcome zod rejects a malformed body |
| family | fan (`bfly_z2b`, `Normal_Lung`), trap with T0 box (`ge_e9_2124113685`), rect (a corpus clip that proposes `rect`, else the `synthetic_trap` fixture as an image batch) — layer aligned with the frame at zoom 50 / 75 / 100 / 150 |
| outcome | Accept untouched → Apply → `run.ts --db --server` IoU vs the proposal ≥ 0.99; each B2 control nudged ±N px → the outcome line carries the matching Δ and `controls_used`; model switch fan → trap → rect → fan lands "close" per B7 and logs `model_switch`; Draw from scratch (button, first stroke, `clearMask` — one row each) removes the layer and POSTs once; Accept → Adjust → Accept → Apply → exactly one line |
| nudge | tap = 1 px; hold ≈ 4 px in the first 800 ms and ≈ 40 px/s after 1.5 s (measure, report the numbers); Shift ×10; drag handle at zoom 50 and 150 lands where the pointer is; arrows in the output-settings inputs do not nudge; the page does not scroll |
| withheld | `sonosite_011_clip10` → blank canvas, no bar, no POST |
| flag | `AUTOMASK_UI` off → no layer, no bar, DOM identical, exactly one `automask.served` GET per open; `AUTOMASK` off → no GET beyond today's, `{status:'none', reason:'disabled'}`; outcome POST with either flag off → disabled shape, no log |
| pending | open the spoke during extraction → frames poll then proposal poll; layer appears once; no duplicate fetch on `job.status` flips; a pre-2B-1 job (no cache, lazy compute) behaves the same |
| display (Mac) | Retina: Accept → Apply → masked frame matches the drawn cone; Andre draws live on the reference clip and one GE E9 (sign-off decision 6 — the Retina row and the Accept → Apply equivalence row replace a separate D5 gate) |
| invariants | `tsc` 12 (the same 12); `buildApplyMask`, apply loop, reuse guard, extraction, `updateMaskFromCanvas` untouched; 2B-1 tests 13 + 5 + 2 still green; `npm run build` still yields both `dist/index.js` and `dist/automaskWorker.js` |

## 5. The implementation plan must answer (with `file:line`) — then stop

1. Component boundary: the prop/callback surface between `template-mask-spoke.tsx` and `MaskingCanvas.tsx` (§3.1); where the `_automask` path is created, replaced, and removed; which fabric events implement §3.2 (`object:added`? `path:created`?), and that `clearMask` at `:211` reaches the same removal.
2. The existing code path that maps pointer events under the CSS zoom (§3.9), so the drag handle inherits it.
3. Where the client's `@shared` alias is defined (vite / tsconfig), and confirmation that `shape.ts` and `types.ts` import nothing Node-side.
4. The joint control ported from `withParam()` — the function signature and the invariant tests (§4 unit row).
5. `reseed` for all six transitions, including rect → fan per §3.6.
6. The outcome route: file, zod schema, gate, PERF stage name, and where `AUTOMASK_UI` is read. Whether `run.ts --db` gains outcome columns is optional — say yes or no, not "later".
7. The nudge scheduler (timer design, cleanup on unmount and on `keyup` / `mouseup` outside the button).
8. The rows in §4 mapped to drivers — which run in the sandbox unattended, which need Andre's Mac.
9. Effort against the 3-day budget, and what is cut first if over (the answer is §3.4's Adjust; B3's hold-acceleration and drag handle are requirements and are not cuttable).

## 6. Constraints (both steps)

`tsc` 12 · A3 frozen · `buildApplyMask`, apply loop, reuse guard, extraction, and the `updateMaskFromCanvas` export path untouched · `maskWorker.ts` neither imported nor edited · 2B-1 server code untouched except `ui_enabled` on the body and the new outcome route · one flag (`AUTOMASK_UI`) · one commit, one `git revert` · no new npm dependencies (fabric stays the CDN 5.3.0; `package.json`'s `fabric ^6.7.1` is backlog, do not touch it) · no PostHog · nothing PHI-bearing committed · with `AUTOMASK_UI` off the spoke renders byte for byte today's.

## 7. Out of scope
Template library / fingerprints (B4), temporal support (B6), accounts, grade thresholds, the Retina export payload (`MaskingCanvas.tsx:917`, sign-off §4 — fix both paths at once after 2B-2), the fabric package pin, `maskWorker.ts` deletion.

## 8. Report → `AUTOMASK_ROUND2B2_REPORT.md`
Headline first: the Accept-untouched IoU per family and the one-line-per-job proof. Then what shipped (file table), the §4 rows with results, tests, known limitations carried forward, and the facts the runbook needs: `AUTOMASK_UI=1 pm2 restart masquerade --update-env && pm2 save`; the verify sequence (upload a GE E9 `.dcm` → spoke shows "Proposed" with a trapezoid → Accept → Apply → `[PERF] automask.outcome {outcome:'accept', tier:'T0T1'}` in `pm2 logs masquerade --raw`); the flag-off check (`served` line, no UI); rollback = one `git revert`. Note B1's flip criterion (met at 91 % on the bench) so the runbook can decide whether the flag stays on after the smoke test.

---
> Continuing Masquerade (bring `CLAUDE.md`). 2B-1 is deployed and green on prod (`74ed76b`: stall 133 ms across a 1.7 s proposal, Apply unaffected). New round: **2B-2 — the spoke behind `AUTOMASK_UI`**, per `AUTOMASK_ROUND2B2_KICKOFF.md` — requirements B1–B3, B5, B7 verbatim from the 2B/2C draft, design as approved in `AUTOMASK_ROUND2B_RECON_PROPOSAL.md` §3 + `AUTOMASK_ROUND2B_SIGNOFF.md`, the ten sub-decisions in kickoff §3 already taken. No recon this time. Step 1 is a one-page implementation plan answering kickoff §5 with `file:line` — component boundary, the removal rule's fabric events, the joint control and re-seed functions, the outcome route, the nudge scheduler, drivers per test row, effort vs 3 days — then stop for my sign-off. `tsc` 12, A3 frozen, export path untouched, no production code before the plan is approved.
