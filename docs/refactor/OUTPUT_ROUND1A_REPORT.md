# Output Round 1a — report: stale preview after a Keep/Remove flip; toggle labels (+ a de-identification bug the flip also caused)

**Status:** built 2026-09-23 on `main` @ `2dea93e` per `OUTPUT_ROUND1A_HOTFIX.md`. **Uncommitted.** Client only. `tsc` 12 · build green (both `dist/` files) · diff = `MaskingCanvas.tsx`, `MaskingTools.tsx` (+ this report).

## 0. Read this first — the flip also broke the mask that Apply sends (on prod since `2dea93e`)

The hotfix doc's premise is that after a flip "the spoke's `maskData` — what Apply sends — is already correct; only the preview lies." **That is false.** After a flip **Remove → Keep → Remove**, the Remove-mode PNG that Apply sends contains the drawn shapes in **black**, with **zero** pixels the server blanks (`r > 150`), so **the apply ships the frames unmasked** while the canvas shows a rectangle and the toggle says Remove. Measured in the pane on the pre-fix code: a rectangle + circle + two brush strokes, fresh Remove export = 183 363 px the server would blank; the same drawing after one Keep flip and back = **0 px**.

**Cause (Output Round 1's O2 colour swap):** `updateMaskFromCanvas` exports each object through `fabric.util.object.clone(obj)`, which in fabric 5.3.0 is a **shallow** copy (`extend({}, obj)`, `fabric.js:2947`), so the clone shares the on-canvas object's render cache. `set()` marks an object dirty only when a value changes (`isChanged = this[key] !== value`, `fabric.js:15427+`). A Keep export sets the clone's fill to black (a change), so it repaints the shared cache black. A later Remove export sets the clone's fill to `'red'`, which is unchanged because the clone copied `'red'`. So nothing is dirty, and the clone blits the stale black cache into the PNG. Side effect: the on-canvas shapes also turn black after any Keep export (this is the "rectangle black" in both modes a screenshot would show).

**Fix — two lines in the export, so I made it part of this hotfix (strike it if you disagree, see §4):** mark each clone dirty before it is added (it always repaints in the export's own colour), then mark the on-canvas originals dirty after the export (the canvas repaints them red). Proof, same drawing, in the app:

| export | pre-fix | fixed |
|---|---|---|
| fresh Remove | 183 363 px blanked | **183 363, byte-identical to pre-fix** (checked against the old algorithm run in-page) |
| Keep | 1 889 641 | **1 889 641** (unchanged) |
| Remove after Keep → Remove | **0** | **183 363, byte-identical to the fresh Remove export** |
| on-canvas shapes after a Keep export | black (stale cache) | red |
| real Apply after the flip (Kidney 1920 × 1080, 46 fr) | — (would blank 0 px) | `apply.mask_build masked_px 183 363`; drawn rectangle mean 0 in the output (source 48); an untouched region 22 = 22 |

Two alternatives were measured and rejected. An uncached clone (`objectCaching:false`) is correct after flips but blanks 308 fewer pixels than today's export, a slightly less fail-closed edge. A clone with its own fresh cache loses about three quarters of the blanked area.

**Exposure and what to do now:**
- **Who is affected:** any hand-drawn Remove apply on prod since `2dea93e` where the user flipped to Keep and back first. Shapes drawn **before** the flip are not blanked; shapes drawn after it are. The auto-mask path is unaffected: the proposal and accepted cone render uncached, and the toggle is locked while it is up.
- **Until this deploys:** don't flip Keep → Remove before an Apply. If you did, reload the spoke and redraw.
- **Audit on prod:** fully unmasked applies show `"masked_px":0` on `apply.mask_build`, which you can grep for (§5). Partial cases, some shapes drawn after the flip, can only be found by looking at the downloads.
- **Runbook P7 exposes this:** its second half ("toggle back to Blanked, same rectangle → the rectangle is black") fails on the current prod build. That failure is this bug, not a misreading.
- **Backlog suggestion (not built):** a server-side fail-closed backstop. O6 checks only that a PNG exists. The apply could refuse, or at least warn, when a hand-drawn mask blanks 0 px.

## 1. What shipped

| file | change |
|---|---|
| `client/src/components/MaskingCanvas.tsx` — preview effect (`:378-408`) | the old `_aiOverlay` is removed at effect start under `internalRemoval`, **before** the no-PNG early return (so Clear Mask / Erase All clear it too); the load gets a `cancelled` flag set by the effect cleanup; the callback only adds |
| `client/src/components/MaskingCanvas.tsx` — export (`:1171-1175`, `:1186-1189`) | `clonedObj.dirty = true` before `maskCanvas.add`; after `maskCanvas.dispose()`, originals marked dirty + `canvas.requestRenderAll()` (§0) |
| `client/src/components/MaskingTools.tsx` (`:73-83`) | labels **Remove** / **Keep**; hints "Drawn areas are removed; everything else stays." / "Drawn areas are kept; everything else is removed."; lock note, values `exclude` / `keep`, `data-testid`s unchanged |

## 2. Rows (Browser pane, sandbox; Kidney 1920 × 1080)

How the rows were driven: the page's live fabric canvas was read through React's fiber (count of `_aiOverlay` objects, and whether the overlay's source equals the current `maskData.canvasDataUrl`). Out-of-order loads were forced by wrapping `fabric.Image.fromURL` so the second load of five finishes 900 ms late. Flips and strokes were dispatched 40 ms apart. **"Exactly one overlay" alone does not catch the bug**: the pre-fix code also always leaves one overlay, just the wrong one. The source comparison is the check.

| # | row | pre-fix | fixed |
|---|---|---|---|
| 1 | 5 flips in ~210 ms ending Keep, stale Remove load forced last | 1 overlay, **stale** (≠ current mask) | 1 overlay, = current Keep mask |
| 1 | same ending Remove, stale Keep load forced last | 1 overlay, **stale** | 1 overlay, = current Remove mask |
| 3 | 5 brush strokes in ~270 ms, stroke 2's load forced last | — | 1 overlay, = the last export; 5 paths |
| 4 | Clear Mask | overlay **stays** (1, with no mask) | 0 overlays, Apply hidden |
| 4 | draw again → Erase All | — | 1 matching → 0, Apply hidden |
| 5 | proposal → Accept → Adjust | — | 0 → 1 matching → 0; proposal back |
| 2 | Keep → Apply on prod (P7) | **Andre, prod** | |
| inv | `tsc`; Output Round 1 / 1b and automask tests; build | | `tsc` 12; outputF2 3, outputTransform 5, outputParity 1, outcomeRounding 2, automaskShape 6, automaskOutcome 4, automaskHold 2, automask.endpoint 13, automaskWorkerClient 5, automask.fixture 2 (+1 skipped); build ✓ |

Row 4's pre-fix failure is the same early-return mechanism the doc's fix 2 addresses: O6 sends a null mask, the effect returned before removing anything, and Clear Mask's own loop skips images.

## 3. Diff
`client/src/components/MaskingCanvas.tsx` +19 −4 (preview effect, export), `client/src/components/MaskingTools.tsx` +4 −4. No server change.

## 4. Commit and deploy

- The working tree also holds **Output Round 1b** (server: `outputTransform.ts`, `videoProcessor.ts`, `outputF2.test.ts`, `serial_bench.ts`, its docs, `CLAUDE.md`). **One deploy, separate commits** (1b sign-off §4).
- For 1a I recommend **two commits** so the preview fix can be reverted without re-opening the leak: (a) **the export fix** (the two hunks at `MaskingCanvas.tsx:1171` and `:1186`), (b) **the preview effect + labels** (the hunk at `:378` + `MaskingTools.tsx`). `git add -p client/src/components/MaskingCanvas.tsx` separates them (they are ~800 lines apart). If you prefer one commit, say so in the message: "…and the Remove export after a Keep flip carried no red (shallow clone + shared cache)".
- Runbook delta (the doc's §4) plus: after deploy, **P7 in full** — Keep → Apply (only the rectangle survives, centred), then toggle Remove, same rectangle → Apply → **the rectangle is black** and `apply.mask_build masked_px` ≈ the rectangle's area. That second apply is the row that proves the export fix on prod.

## 5. Prod audit command

```bash
pm2 logs masquerade --raw --nostream --lines 20000 | grep '"stage":"apply.mask_build"' | grep '"masked_px":0,'
```

Any line here from after the `2dea93e` deploy is an apply that blanked nothing. Its job's download should be treated as unmasked.
