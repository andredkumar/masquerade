# Output Round 1 deploy + test runbook — crop to the cone · Keep/Exclude · O3–O6

Same shape as the 2B-2 runbook. 🖥️ LOCAL · ☁️ SERVER · 🌐 BROWSER · 🅰 AWS. Input: `OUTPUT_ROUND1_REPORT.md` (2026-09-16). **Not flag-gated** — every download changes from the moment pm2 restarts; rollback is one `git revert`.

## 0. Report review — decisions

**All eight §5 findings: keep.** Two deserve a sentence. §5.1 (every mask PNG the app has ever sent has a transparent background, not black — fabric's `renderAll` clears the fill) is correct, harmless for Exclude, and the Keep fix (fabric's own `backgroundColor`) is the right one; the fact that the first `fillRect` version "silently masked nothing" and was caught by the Keep pixel row is exactly why that row exists. §5.4 (`processBatchesInParallel` is dead code, the live `'original'` fallback is 512 × 512 not 632 × 1080) corrects the recon; the warn is on the live path, the dead method goes to backlog with `maskWorker.ts`.

**One addendum before commit (🤖 Claude Code, ~5 min, sandbox).** The §0 "placed at" and "pad" columns are read from the sidecar record; the report says so (§3, §5.6). That proves the server executed the plan, not that the pixels are centred. `check.ts:103` already computes the non-black bbox of the server's output pixels — report it: on the **eight fan rows** (where the non-black extent *is* the keep bbox, so the comparison is exact), non-black bbox `(x, y, w, h)` from the pixels vs the record's `(offset, placedW × placedH)`, and the resulting centre error in px. Append as §0.1. Expected ≤ 1 px everywhere; if any row is > 1 px, stop and send me the numbers. (For the trapezoid and image rows the two differ by construction — say so in one line, don't chase it.)

**Backlog (→ `NEXT_ROUND_CANDIDATES.md`):** delete `processBatchesInParallel` and `maskWorker.ts` together (neither carries a tsc error); the retina 2× export payload (now proven functional at dpr 2 — §5.2 — so it is purely a size item); a real fit-to-pane for `handleFitToScreen`; mixed-dimension image batches (#29/#30).

## 1. Pre-flight (🖥️ LOCAL)
```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git status
git diff --stat
```
Expected modified: `CLAUDE.md`, `client/src/components/{FrameViewer,MaskingCanvas,MaskingTools,ProcessingControls}.tsx`, `client/src/hooks/useAutomaskProposal.ts`, `client/src/pages/template-mask-spoke.tsx`, `server/handlers/frameManifest.ts`, `server/routes.ts`, `server/services/{frameAccess,templateMaskFolderManager,videoProcessor}.ts`. New: `server/services/outputTransform.ts`, the three tests, `scripts/output_eval/`, the four `OUTPUT_ROUND1_*.md`. **Stop if** the diff lists `storage.ts`, `pgStorage.ts`, `shared/schema.ts`, `migrations/`, `automask*.ts`, `server/workers/`, `frameExtractor.ts`, `package.json`.
```
for t in outputTransform outputParity outcomeRounding automaskShape automaskOutcome automaskHold automask.endpoint automaskWorkerClient applyPaths frameAccess; do echo "== $t"; npx tsx server/services/__tests__/$t.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"; done
npx tsc --noEmit | grep -c "error TS"
npm run build && ls dist/
```
Gate: every file `fail 0` (pass 5 · 1 · 2 · 6 · 4 · 2 · 13 · 5 · 8 · 8) · tsc = **12** · `dist/` shows `index.js`, `automaskWorker.js`, `public/`.

## 2. Snapshot (🅰 AWS)
EBS snapshot `pre-output-round1 2026-09-17`. Before SSH this time.

## 3. Commit by explicit paths + push (🖥️ LOCAL) — one line, no continuations
```
git add CLAUDE.md server/services/outputTransform.ts server/services/videoProcessor.ts server/services/frameAccess.ts server/services/templateMaskFolderManager.ts server/handlers/frameManifest.ts server/routes.ts server/services/__tests__/outputTransform.test.ts server/services/__tests__/outputParity.test.ts server/services/__tests__/outcomeRounding.test.ts scripts/output_eval/check.ts client/src/components/MaskingCanvas.tsx client/src/components/MaskingTools.tsx client/src/components/ProcessingControls.tsx client/src/components/FrameViewer.tsx client/src/hooks/useAutomaskProposal.ts client/src/pages/template-mask-spoke.tsx docs/refactor/OUTPUT_ROUND1_KICKOFF.md docs/refactor/OUTPUT_ROUND1_RECON.md docs/refactor/OUTPUT_ROUND1_SIGNOFF.md docs/refactor/OUTPUT_ROUND1_REPORT.md docs/refactor/OUTPUT_ROUND1_DEPLOY_RUNBOOK.md
git status
```
Read "Changes to be committed": 22 files. Nothing under `output/`, `uploads/`, `temp_extracted/`, `spokes/`, `.idea/`, `scripts/sandbox/`, `dicoms.json`; `.DS_Store` and `ITEM22_REPORT.md` stay unstaged.
```
git commit -m "output round 1: crop to the kept region before every output mode; Keep/Exclude toggle; Clear/Erase disable Apply; debug writes removed; sidebar fix; outcome deltas rounded

- outputTransform.ts: keepBbox, planOutputTransform (original = centre without scaling; else contain/cover), applyOutputTransform; one [PERF] apply.output line per apply
- sidecar spokes/template_mask/<job>/output_transform.json -> manifest.json output_transform + ten metadata.csv columns
- stretch removed from the UI; a stale 'stretch' is applied as letterbox and logged
- MaskingCanvas/MaskingTools: what-you-draw-is Blanked/Kept toggle (fabric backgroundColor red + black objects in Keep); locked while an auto-mask session exists
- O6: Clear Mask / Erase All -> no mask, Apply disabled until something is drawn
- O3: three debug frame writes to output/ removed; O4: sized canvas wrapper, aside shrink-0, main min-w-0; O5: outcome deltas rounded to 2 dp
- FrameViewer: letterbox gate is size !== 'original'"
git push origin main
git log origin/main --oneline -1
```

## 4. Deploy (☁️ SERVER)
```
ssh -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97
cd ~/template-masking-app
ls -la output/ 2>/dev/null
```
**Look at that listing before anything else.** Until this deploy every apply wrote `output/debug_frame_0_original.png` — the **unmasked** first frame of the last job applied on prod — plus the processed and mask PNGs. Note what is there, then remove it; nothing writes there after this deploy (report §5.5, §5.8):
```
rm -rf output/
git fetch origin main && git reset --hard origin/main
git log --oneline -1
```
One per line:
```
npm install
npm run build
ls dist/
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 40 --nostream 2>/dev/null
```
Bundle check (🖥️): `curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1` — new hash; 🌐 hard reload.

Tail (☁️, second terminal): `pm2 logs masquerade --raw 2>/dev/null | grep -E '"stage":"(apply\.(output|done|mask_build)|automask\.outcome)"'`

## 5. Test session (🌐 + ☁️ tail)

| # | Do | Expect |
|---|---|---|
| P1 | Upload a GE E9 `.dcm` → spoke → Accept the trapezoid → **Apply, Letterbox, Original Size** | Tail: `apply.output {mode:"letterbox", size:"original", bbox:{…}, offset:{…}}`, `apply.done`. Frame viewer: the trapezoid **centred on black**, even margins. This is the download you started the round with. |
| P2 | Download the ZIP from P1 | `manifest.json` has `output_transform { mode, size, crop, scale, offset, output, resampled:false }`; `metadata.csv` header ends `…,crop_x,crop_y,crop_w,crop_h,scale_x,scale_y,offset_x,offset_y,output_w,output_h`; README has the sentence. Open two frames in Preview. |
| P3 | Same job → **Apply again, Letterbox, 256×256** | Frame viewer: 256 × 256, trapezoid full width, black bars top and bottom, equal to within a pixel. `apply.output` shows `scale` < 1. |
| P4 | Upload the reference clip (`Normal Lung sliding`, 348 fr) → Accept → Apply, Letterbox, Original | `apply.done` vs **8.5 s** (sandbox: 1094 vs 1196 ms — expect no slowdown). Frame viewer: the fan centred; scrub to the last frame. |
| P5 | Same job → **Apply, Centre Crop, 512×512** | 512 × 512, the fan fills the width, top/bottom cropped evenly; no black bars. |
| P6 | New upload, any clip → **Draw from scratch** → draw one rectangle → **Clear Mask** | Apply controls **disappear** (O6). Draw again → reappear. **Erase All** → disappear. |
| P7 | Same job → toggle **Kept** → draw one rectangle → Apply, Original | Output: only the rectangle's content survives, centred on black; tail `apply.mask_build` shows a large `masked_px`. Toggle back to **Blanked**, same rectangle → the rectangle is black, everything else intact. |
| P8 | New upload → the proposal appears | The Blanked/Kept toggle is **disabled** with "Auto-mask active"; Draw from scratch → enabled. |
| P9 (your window, 1440-px) | The reference clip at 75 % | Sidebar visible at full width, Apply reachable; at 150 % the canvas scrolls inside the pane; a rectangle dragged at 150 % lands under the pointer. **O4's human check.** |
| P10 (GPU) | AI spoke on the P4 job (cropped, original size): one inference, download the run | Overlays line up with the masked frames (Round 2B U6 row); run `manifest.json` carries `output_transform` (it is a template-mask input). |
| P11 | `ls output/` on the box after all of the above | `No such file or directory`. |

If anything in P1–P8 is wrong: §7 rollback, then send me the tail. P9–P11 failing is a follow-up, not a rollback.

## 6. Collect (☁️)
```
pm2 logs masquerade --raw --lines 50000 2>/dev/null | grep '\[PERF\]' | sed 's/^.*\[PERF\] //' > perf_out1_$(date +%Y%m%d_%H%M).jsonl
grep -E '"stage":"(apply\.output|apply\.done)"' perf_out1_*.jsonl | tail -20
```
Send me those lines: one `apply.output` per apply, no `warn` fields (a `stretch_as_letterbox` would mean a stale tab — harmless, but tell me), `apply.done` on P4 vs 8.5 s.

## 7. Rollback
☁️ `git revert --no-edit HEAD && npm run build && pm2 restart masquerade --update-env`. Sidecars left in `spokes/` are inert `.json` files beside the frames; jobs applied under this round are ordinary masked frames — nothing to redo. After a revert the debug writes come back, so `output/` reappears on the next apply; that is the old behaviour, not damage.

## 8. Close-out
`CLAUDE.md` currently reads "Output Round 1 BUILT (2026-09-16, uncommitted — awaiting the runbook)"; after §6, one follow-up commit: "Output Round 1 DEPLOYED <date>, `<sha>`" with the P4 number, and the §0 backlog lines into `NEXT_ROUND_CANDIDATES.md`. Then the auto-mask outcome pivot (`AUTOMASK_ROUND2B2_REPORT.md` §7) once it has a week of real sessions — that decides the grade thresholds and whether 2C starts with B4 or a tuning pass.

---
> **Paste-prompt for the addendum (Claude Code, before commit):** `OUTPUT_ROUND1_REPORT.md` §0's "placed at" and "pad" columns come from the sidecar record. `check.ts:103` already has `nonBlack()`; on the eight fan rows report the non-black bbox of the server's output pixels vs the record's `(offset, placedW × placedH)` and the centre error in px, as §0.1. Expected ≤ 1 px; if any row exceeds it, stop and report. One line for the trapezoid/image rows saying why the two differ by construction. No code changes.
