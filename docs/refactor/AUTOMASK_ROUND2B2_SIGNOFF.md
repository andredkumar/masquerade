# Auto-mask Round 2B-2 — sign-off on the implementation plan (2026-09-09)

**Input:** `AUTOMASK_ROUND2B2_PLAN.md`. **Decision:** approved with three required changes (§1) and one amendment to §10 (§2). Build after folding §1–§3 in; stop after `AUTOMASK_ROUND2B2_REPORT.md` for the runbook. Line references below were re-checked against `MaskingCanvas.tsx` and `template-mask-spoke.tsx` on the current tree.

## 1. Required changes (each is a bug the plan as written would ship)

**1. The drag handle must survive its own drag.** Plan §1 re-runs the layer effect on every `proposal` change, removing and re-adding the path *and* the handle. But the handle's `object:moving` → `onProposalEvent({kind:'drag'})` → spoke `withControl(current,'position')` → new `proposal` → the effect removes the very object fabric is transforming (`_currentTransform.target`). The drag dies after the first move event, or the handle snaps. Fix: the effect replaces the **path** on every run but creates the handle **once per layer lifetime** and repositions it with `handle.set({left, top}).setCoords()` — and skips the reposition while the handle is the current transform target (a `dragging` ref set on its `object:moving`, cleared on `mouse:up`). New nudge-row test: drag the handle continuously ≥ 200 px at zoom 150; the readout tracks, the handle never jumps back, the path follows.

**2. The removal rule is `mode`-aware.** Plan §1's `object:added` guard — `if (obj.type !== 'image' && proposalRef.current) removeLayer()` — fires in **`'accepted'`** mode too, so the first hand stroke after Accept deletes the accepted cone; §10-E says it unions. Removal on a stroke happens only when `mode === 'proposal'`. In `'accepted'` mode the `'mask'` path stays and the stroke joins it (E, today's multi-object export at `:923-947`). The `object:removed` hook keeps its plan §1 behaviour in both modes (Clear / Eraser after Accept → `draw_from_scratch`, per E).

**3. Every internal `canvas.clear()` runs under `internalRemoval`** — the frame effect at `:252` and `handleUndo` at `:132` — not only the layer effect's own removals. The plan's argument that neither "can meet a live layer" is true today only because the spoke's re-fetch guard (`:116-120`) requires `frameStatus === 'extracting'`; one future edit there turns `:252` into a spurious `draw_from_scratch` POST plus a lost proposal, with nothing in the test matrix to catch it. One flag, zero cost, no row needed — say in the report that it is set.

## 2. §10 A–K

| # | decision |
|---|---|
| A, B, C, D, F, G, H, J, K | **Approved as written.** On G: a 1 px red stroke centred on the polygon edge over-blanks by ½ px — the fail-closed direction; fine. On C: note in the report that `excludeFromExport` only protects the Undo snapshots (`toJSON`); the export path uses `getObjects()` (`:849`), and the accepted path reaches it because the handle is removed first, not because of this flag. |
| E | **Approved with §1.2.** The Clear-then-Undo-after-Accept limitation is accepted as written. |
| I | **Amended.** `model_switch = {from: fitted model, to: final model}` whenever `to !== from` — **including trap ↔ rect**. B7 says "telemetry logs the switch", and a trap → rect switch is the `bfly_z9` "not a box" verdict in reverse; we want to count it. `deltas` stays non-null for trap ↔ rect (`shapeDeltas` `:43`) and null across fan ↔ trap/rect, as the kickoff §2.5 schema says. Intermediate switches still unlogged. |

## 3. Smaller notes (fold in; none needs a reply)

- **Accept's look.** The `_aiOverlay` effect (`:259-284`) is keyed on the `maskData` prop (`:29`), so Accept — like a brush stroke today — overlays the exported PNG at 50 % opacity: the cone interior darkens by half and the outside goes red-on-red. Reused byte for byte, as the plan says; Adjust must remove it (the plan does). Put a screenshot of the accepted state in the report. If it reads as a bug to a user, it is a backlog item shared with the brush path, not 2B-2's.
- **Flag-off DOM comparison: do not `git stash` the working tree.** It carries Andre's uncommitted `CLAUDE.md`, `.gitignore`, `ITEM22_REPORT.md`, `scripts/sandbox/`. Use `git worktree add ../masq-74ed76b 74ed76b`, symlink or copy `temp_extracted/<job>` into it, point it at the same sandbox DB with `AUTOMASK_UI` unset, and diff the normalised `document.body.innerHTML` from there.
- **Nudge arithmetic.** The plan's 6 px at 800 ms (tap + repeats at 400/500/600/700/800) is right; the kickoff's "≈ 4" was an arithmetic slip. Report what is measured; the acceptance is the schedule (first repeat at 400 ms, 100 ms to 1.5 s, 25 ms after), not the kickoff's rounded number.
- **Keyboard handler:** also ignore events with `metaKey`/`ctrlKey`/`altKey` (browser navigation shortcuts on the arrows), alongside `e.repeat` and the input/`role="slider"` targets.
- **`ms_to_decision`** starts at the first run of the layer effect that adds a path (`performance.now()`), not at the fetch.
- **Effort** is 3.0 days with no slack. Cut order stands (Adjust, then the rect row to the fixture); if the sandbox matrix runs over, the family-row screenshots collapse from four zooms to 75 and 150 before anything else moves.

## 4. Invariants (unchanged)
`tsc` 12 (the same 12) · A3 frozen · `updateMaskFromCanvas` `:845-1135`, every `enable*` handler except the three event hooks, `buildApplyMask`, apply loop, reuse guard, extraction, `maskWorker.ts`, the 2B-1 service files, `ProcessingControls.tsx`, `MaskingTools.tsx`, `package.json` untouched · `ui_enabled` stamped at serve time (`routes.ts:509/:512`), never into `automask.json` · one flag (`AUTOMASK_UI`) · one commit, one `git revert` · nothing PHI-bearing committed.

---
> `AUTOMASK_ROUND2B2_SIGNOFF.md`: plan approved with three required changes — (1) the handle is created once per layer and repositioned in place, never re-created mid-drag; (2) stroke-removal only in `mode:'proposal'`, strokes union after Accept per your E; (3) `internalRemoval` around every internal `canvas.clear()` (`:252`, `:132`). §10 A–H, J, K as written; **I amended**: `model_switch` logged whenever the final model differs from the fitted one, trap ↔ rect included. Fold in §3 (worktree not stash for the flag-off diff; modifier keys ignored; `ms_to_decision` from first layer render; screenshot of the accepted state). Build 2B-2 exactly per `AUTOMASK_ROUND2B2_PLAN.md` + this sign-off, `tsc` 12, A3 frozen, export path untouched, and stop after `AUTOMASK_ROUND2B2_REPORT.md` for the runbook.
