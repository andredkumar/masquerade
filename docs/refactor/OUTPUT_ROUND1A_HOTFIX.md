# Output Round 1a — hotfix: stale mask preview after a Keep/Remove flip; toggle labels

**Status:** kickoff, 2026-09-23, against `main` with Output Round 1 deployed. **Executor:** Claude Code. Small enough to build directly — no recon, no proposal; stop after a short `OUTPUT_ROUND1A_REPORT.md` (the §3 rows and the diff). One commit, one `git revert`.

## 1. The bug (reported on prod by Andre)

Flipping the What-you-draw-is toggle can leave the **previous** mode's preview on the canvas. Cause, `MaskingCanvas.tsx:379-402`: the preview effect calls `fabric.Image.fromURL(externalMaskData.canvasDataUrl, cb)` and does *both* the removal of the old `_aiOverlay` and the add of the new one **inside the async callback**. Two flips in quick succession start two loads; if the earlier load completes second, its callback removes the newer overlay and re-adds the stale one. The flip's re-export (`:489-496`) is synchronous, so the spoke's `maskData` — what Apply sends — is already correct; only the preview lies. The same race has always existed for rapid brush strokes; the toggle just makes it easy to trigger.

## 2. The fix

1. **Cancel superseded loads.** In the preview effect: `let cancelled = false;` … in the callback `if (cancelled) return;` … `return () => { cancelled = true; };`. A load that finishes after a newer `externalMaskData` arrived does nothing.
2. **Remove the old overlay at effect start**, under `internalRemoval` (the `_aiOverlay` removal helper already used at `:416` / `:450`), so the previous preview disappears the moment the mode flips or the drawing changes, before the new PNG has decoded. The callback then only adds.
3. **Labels** (`MaskingTools.tsx:73-74`): `Blanked` → **Remove**, `Kept` → **Keep**. Heading stays "What you draw is". Hints: Remove — "Drawn areas are removed; everything else stays." Keep — "Drawn areas are kept; everything else is removed." Lock note unchanged. Internal values `exclude` / `keep`, `data-testid`s, the outcome line and the lock rule do not change.

Nothing else. No server change.

## 3. Rows (Browser pane; Andre repeats 1 and 2 on prod)

| # | do | expect |
|---|---|---|
| 1 | draw one rectangle; flip Remove → Keep → Remove → Keep as fast as the pane allows (≥ 4 flips in < 1 s via `javascript_tool`) | after the last flip the canvas shows exactly **one** `_aiOverlay` (`canvas.getObjects().filter(o => o._aiOverlay).length === 1`) and it is the Keep preview (frame tinted red, rectangle clear); repeat ending on Remove → one overlay, rectangle red only |
| 2 | Keep → Apply on prod (the open P7 row) | `apply.mask_build` `masked_px` ≈ frame area minus the rectangle; `apply.output` bbox = the rectangle; output frame: only the rectangle's content, centred on black |
| 3 | rapid brush strokes (5 in < 1 s) | one overlay, matching the last export |
| 4 | Clear Mask / Erase All | overlay gone immediately (O6 path unchanged) |
| 5 | auto-mask proposal → Accept → Adjust | the accepted-state overlay appears once and is gone after Adjust (2B-2 §3 behaviour unchanged) |
| inv | `tsc` 12; the Output Round 1 and automask tests green; `git diff --stat` = `MaskingCanvas.tsx`, `MaskingTools.tsx`, the report |

## 4. Runbook delta (Andre)
🖥️ tests + `tsc` + build → commit the two files + report → push · ☁️ fetch/reset, build, `pm2 restart masquerade --update-env` · 🌐 hard reload, rows 1 and 2 · no snapshot needed for a two-file client change; rollback `git revert`.

---
> Continuing Masquerade (bring `CLAUDE.md`). Output Round 1 is deployed. Hotfix **1a** per `OUTPUT_ROUND1A_HOTFIX.md`: the mask preview effect (`MaskingCanvas.tsx:379-402`) races on rapid Keep/Remove flips — cancel superseded `fromURL` loads with an effect-cleanup flag and remove the old `_aiOverlay` at effect start under `internalRemoval`; rename the toggle labels to Remove / Keep with the hints in §2.3, values unchanged. Build directly, run §3 rows 1, 3, 4, 5 in the pane, `tsc` 12, stop after a short `OUTPUT_ROUND1A_REPORT.md`.
