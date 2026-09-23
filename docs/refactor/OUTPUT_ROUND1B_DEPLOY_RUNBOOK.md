# Output Round 1a + 1b deploy + test runbook — the Remove-after-Keep leak, the preview race, labels, and F2

🖥️ LOCAL · ☁️ SERVER · 🌐 BROWSER · 🅰 AWS. Inputs: `OUTPUT_ROUND1A_REPORT.md` and `OUTPUT_ROUND1B_REPORT.md` (both 2026-09-23). **One deploy, two commits.** 1a is client-only, 1b server-only; neither is flag-gated.

## 0. Read first — 1a is a de-identification fix, not a cosmetic one

My hotfix doc said the flip only broke the preview and that "what Apply sends is already correct". Claude Code measured it and that was wrong. **On prod since `2dea93e`: draw in Remove, flip to Keep and back to Remove, Apply → the PNG sent has the shapes in black, the server blanks 0 px, and the frames ship unmasked** while the canvas and toggle say Remove. Cause: the export's `fabric.util.object.clone` is shallow in fabric 5.3.0, so the clone shares the on-canvas object's render cache. The Keep export repaints that cache black, and the next Remove export doesn't see a change and reuses it. The "old mask persists" you reported (shapes staying black in both modes) was this same cache. The fix marks clones dirty before export and the originals dirty after. A fresh Remove export is byte-identical to before, and Remove after a flip is byte-identical to a fresh Remove.

**Decisions on the 1a report:**
- **Export fix in 1a: keep** (report §0/§4). It's two lines, proven byte-identical where it should be and correct where it was wrong.
- **One 1a commit, not two.** The `git add -p` split buys a revert path for the preview half alone. That isn't worth an interactive hunk-picker, and the rollback rule below covers it.
- **Server-side backstop: next round, first.** Two client paths in one week (O6, then this) could send a mask that blanks nothing, and the server accepted both. The apply should refuse a hand-drawn mask that blanks 0 px, with a clear error. Tiny, own round; not in this deploy.

**The 1b report:** the one deviation (scan limited to the crop rectangle, since only the video path has an offsets list) is kept. Judge F2 by `mask_ms` ≈ 0 on a Keep apply, not by `apply.done`. The D4 check is done: credit mode is **unlimited**, so throttling is ruled out, and R3 below settles the 8.5 vs 11.4 s question.

**Until this deploys: don't flip Keep → Remove before an Apply.** If you did, reload the spoke and redraw.

## 1. Audit prod first (☁️, 1 min) — did anything ship unmasked?
```
ssh -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97
pm2 logs masquerade --raw --nostream --lines 50000 2>/dev/null | grep '"stage":"apply.mask_build"' | grep '"masked_px":0,'
```
Each line is an apply that blanked nothing; note its `jobId` and `t`. Treat any download from those jobs, taken after the `2dea93e` deploy (2026-09-23), as **unmasked** and delete the copy. Empty output means no fully unmasked apply. The command can't find partial cases (some shapes drawn before the flip, some after). If you applied a hand-drawn Remove mask after flipping the toggle today, look at that download. Send me the output either way.

## 2. Pre-flight (🖥️ LOCAL)
```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git status
git diff --stat
```
Expected modified: `CLAUDE.md`, `client/src/components/MaskingCanvas.tsx`, `client/src/components/MaskingTools.tsx`, `server/services/outputTransform.ts`, `server/services/videoProcessor.ts`. New: `server/services/__tests__/outputF2.test.ts`, `scripts/output_eval/serial_bench.ts`, `docs/refactor/OUTPUT_ROUND1A_{HOTFIX,REPORT}.md`, `docs/refactor/OUTPUT_ROUND1B_{KICKOFF,STEP1,SIGNOFF,REPORT,DEPLOY_RUNBOOK}.md`. **Stop if** the diff lists `storage.ts`, `pgStorage.ts`, `shared/schema.ts`, `migrations/`, `automask*.ts`, `frameExtractor.ts`, `package.json`.
```
for t in outputF2 outputTransform outputParity outcomeRounding automaskShape automaskOutcome automaskHold automask.endpoint automaskWorkerClient applyPaths saveProcessedImage imageBatchFrames frameAccess; do echo "== $t"; npx tsx server/services/__tests__/$t.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"; done
npx tsc --noEmit | grep -c "error TS"
npm run build && ls dist/
```
Gate: every file `fail 0` (pass 3 · 5 · 1 · 2 · 6 · 4 · 2 · 13 · 5 · 8 · 11 · 6 · 8) · tsc = **12** · `dist/` shows `index.js`, `automaskWorker.js`, `public/`.

## 3. Snapshot + two commits (🅰 then 🖥️)
EBS snapshot `pre-output-round1a-1b 2026-09-23`.

**Commit 1 — 1a** (one line):
```
git add client/src/components/MaskingCanvas.tsx client/src/components/MaskingTools.tsx docs/refactor/OUTPUT_ROUND1A_HOTFIX.md docs/refactor/OUTPUT_ROUND1A_REPORT.md
git status
```
"Changes to be committed": **4 files**.
```
git commit -m "output round 1a: Remove export after a Keep flip shipped no red (shallow clone + shared render cache); mask preview race; labels Keep / Remove

- export: clones marked dirty before export, originals marked dirty after, so a Remove export after a Keep flip blanks the drawn shapes again (was 0 px on prod since 2dea93e)
- preview: old overlay removed at effect start (also on Clear/Erase), superseded fromURL loads cancelled
- MaskingTools: labels Keep / Remove with new hints; values unchanged"
```
**Commit 2 — 1b** (one line):
```
git add CLAUDE.md server/services/outputTransform.ts server/services/videoProcessor.ts server/services/__tests__/outputF2.test.ts scripts/output_eval/serial_bench.ts docs/refactor/OUTPUT_ROUND1B_KICKOFF.md docs/refactor/OUTPUT_ROUND1B_STEP1.md docs/refactor/OUTPUT_ROUND1B_SIGNOFF.md docs/refactor/OUTPUT_ROUND1B_REPORT.md docs/refactor/OUTPUT_ROUND1B_DEPLOY_RUNBOOK.md
git status
```
"Changes to be committed": **10 files**. Nothing staged afterwards should remain except `.DS_Store` and `ITEM22_REPORT.md` (unstaged, as always); `.idea/`, `scripts/sandbox/`, `dicoms.json` untracked.
```
git commit -m "output round 1b: mask only inside the output crop (F2); serial bench tool

- outputTransform.offsetsInCrop; prebuilt-mask offsets filtered once per apply; per-stack and per-frame alpha scans walk the crop rectangle
- no output byte changes (32 cases x 3 paths, 394 real frames, 24 geometry rows); apply.mask_build untouched
- CLAUDE.md: working-loop perf rule, --nostream / --line-buffered runbook conventions"
git push origin main
git log origin/main --oneline -2
```
Top two lines: 1b, then 1a.

## 4. Deploy (☁️ SERVER)
```
cd ~/template-masking-app
git fetch origin main && git reset --hard origin/main
git log --oneline -2
```
One per line:
```
npm install
npm run build
ls dist/
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 30 --nostream 2>/dev/null
```
🖥️ `curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1` → new hash. 🌐 **hard reload** (the fix is in the browser bundle; an old tab still has the leak).

Live tail (☁️, second terminal):
```
pm2 logs masquerade --raw 2>/dev/null | grep -E '"stage":"apply\.(output|done|mask_build)"'
```

## 5. Test session — quiet box: no uploads in the minute before each apply

| # | Do | Expect |
|---|---|---|
| **L1** (the leak, the row that matters) | 1080p clip (Kidney, 46 fr) → Draw from scratch → **Remove** → one rectangle → **Apply (A)**. Toggle **Keep** (don't redraw) → **Apply (B)**. Toggle **Remove** (don't redraw) → **Apply (C)**. | Labels read **Remove / Keep**. `apply.mask_build masked_px`: **A = C exactly**, both ≈ the rectangle's area; B ≈ frame − rectangle. Output C: the rectangle **black**, everything else intact. The rectangle on the canvas stays **red** after every flip. |
| L2 | Same job → draw a second shape → flip Remove ↔ Keep fast, 5 times, ending on **Remove** → Apply | `masked_px` > C's (both shapes); both shapes black in the output. On the canvas: one preview, matching Remove. |
| P1 | Same job → **Clear Mask** | Preview gone immediately, Apply hidden. |
| R1 | Same job → **Keep** → one rectangle → Apply, Letterbox · Original | Output: only the rectangle, centred on black. `apply.mask_build` ≈ ~1.8 s, unchanged (correct). Note `apply.done`; ≈ 3.5–3.8 s expected. |
| R3 | Reference clip (`Normal Lung sliding`) → Accept the cone → Apply, Letterbox · Original — **twice, back to back** | Fan centred. The Keep/Remove toggle **locked** while the proposal is up. Note both `apply.done`. |
| R4 | GE E9 `.dcm` → Accept → Apply | Trapezoid centred on black. |
| R5 | Download R3's ZIP | `manifest.json` `output_transform` present, unchanged in shape. |

Per-frame summary that judges F2 (☁️, put in the L1 and R3 job ids):
```
pm2 logs masquerade --raw --lines 50000 --nostream 2>/dev/null | grep '"stage":"apply.frame"' | grep -E 'L1_JOB_ID|R3_JOB_ID' | sed 's/^.*\[PERF\] //' | node -e '
const L=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);const g={};
for(const l of L){const k=l.jobId.slice(0,8);g[k]??={n:0,d:0,m:0,e:0};g[k].n++;g[k].d+=l.decode_ms;g[k].m+=l.mask_ms;g[k].e+=l.encode_ms;}
for(const[k,v]of Object.entries(g))console.log(k,"frames",v.n,"decode",(v.d/v.n).toFixed(1),"mask",(v.m/v.n).toFixed(1),"encode",(v.e/v.n).toFixed(1));'
```
**Pass:** L1 `A == C`, C's rectangle black (**de-identification gate: if this fails, §7 now**). F2: the L1 job's `mask` ≈ 0 on the Keep applies and small on the Remove ones; R3 `mask` roughly half of 16.3.

**Reading R3's `apply.done`:** both ≤ ~9 s → the earlier 11.4 s runs were contention or variance. Both ≈ 11 s → Output Round 1 costs more on this x86 box than on the M4, and the next step is the prod harness run (`OUTPUT_ROUND1B_STEP1.md` §5 D4.1).

## 6. Collect (☁️)
```
pm2 logs masquerade --raw --lines 50000 --nostream 2>/dev/null | grep -E '"stage":"apply\.(output|done|mask_build)"' | tail -20
pm2 logs masquerade --raw --lines 50000 --nostream 2>/dev/null | grep '"stage":"apply.mask_build"' | grep '"masked_px":0,'
```
Send me: the first output, the §5 per-frame summary, and the second (should add nothing new after the deploy).

## 7. Rollback
- **1b misbehaves:** ☁️ `git revert --no-edit HEAD && npm run build && pm2 restart masquerade --update-env`. F2 changes no output byte; nothing to redo.
- **1a misbehaves:** reverting it **re-opens the leak**. Fix forward. If it must come out, revert with `git revert --no-edit HEAD~1` (not HEAD), rebuild, restart, and don't flip Keep → Remove before an Apply until it's back.

## 8. Close-out
One follow-up commit to `CLAUDE.md`: "Output Round 1a + 1b DEPLOYED <date>, `<1a sha>` `<1b sha>`" with the L1 `A == C` numbers, the R1 `mask` number, the R3 pair, "credit mode unlimited — throttling ruled out", and the §1 audit result. Next round, in order: **(1) the server-side fail-closed backstop** (refuse a hand-drawn apply that blanks 0 px, with a clear error); then the Keep-mode `buildApplyMask` cost; dead `processBatchesInParallel` + `maskWorker.ts`.
