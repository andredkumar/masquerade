# Round 2B deploy + test runbook — reuse raw frames · sharp concurrency · JPEG/PNG format fix

Same shape as `ROUND2A_DEPLOY_RUNBOOK.md`. 🖥️ LOCAL · ☁️ SERVER · 🌐 BROWSER · 🅰 AWS.
Carries: 2B-1 (reuse `temp_extracted/`), 2B-2 (`sharp.concurrency`), addendum A (format fix), addendum B
(test regex). **Not** 2B-3.

## 1. Pre-flight (🖥️ LOCAL)
```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git status
git diff --stat
```
Expected: `server/services/videoProcessor.ts`, `server/index.ts`, `server/services/frameAccess.ts`,
`server/routes.ts` (content-type / listing), the output-settings UI component(s),
`server/services/__tests__/applyPaths.test.ts`, `docs/refactor/ROUND2B_*.md`. Anything in
`storage.ts` / `pgStorage.ts` / `shared/schema.ts` / `migrations/` → stop.
```
npx tsx server/services/__tests__/applyPaths.test.ts
npx tsx server/services/__tests__/frameAccess.test.ts
npx tsc --noEmit | grep -c "error TS"
npm run build
```
Gate: 8/8 and 8/8 · tsc = **12** · build clean.

Also, once, so we know the headroom before masked output changes size (☁️ SERVER):
```
df -h /
du -sh ~/template-masking-app/temp_extracted ~/template-masking-app/spokes ~/template-masking-app/uploads
```
Write the numbers down; they go in the report.

## 2. Snapshot (🅰 AWS)
`pre-round2b-deploy 2026-MM-DD`. And while you're in the console: **EC2 → Elastic IPs — confirm
`3.136.48.97` is listed.** If it isn't, allocate + associate one now (this deploy doesn't need it, but
the eventual instance resize does, and it's the same five clicks).

## 3. Commit + push (🖥️ LOCAL)
```
git add -A
git status
git commit -m "Round 2B: reuse temp_extracted at apply, sharp.concurrency(cpus), honor output format (JPEG default / PNG optional)

- processVideo: tryReuseRawFrames (status ready + count match + IEND) else unchanged re-extract; [PERF] apply.source
- index.ts: sharp.concurrency(os.cpus().length) at boot
- masked frames: encoder follows outputSettings.format; default .jpg/image/jpeg, PNG level 3 when selected
- frameAccess/routes: extension-agnostic masked-frame listing, Content-Type from extension
- applyPaths.test.ts: stale regex fixed"
git push origin main
git log origin/main --oneline -1
```

## 4. Deploy (☁️ SERVER)
```
ssh -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97
cd ~/template-masking-app
git fetch origin main && git reset --hard origin/main
git log --oneline -1
```
One per line:
```
npm install
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 60 --nostream
```
Boot must additionally show the new **`sharp.concurrency` line = 2**. Then bundle check (🖥️ LOCAL)
`curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1` and 🌐 hard reload.

## 5. Test session (🌐 + ☁️ tail)
Tail: `pm2 logs masquerade --raw | grep -E '\[PERF\] \{"t":[0-9]+,"jobId":"[^"]+","stage":"(apply\.(source|env|extract_all|read_all|done)|bg_extract\.done)'`

Use **the same clip as Round 1** (`Normal Lung sliding 2.mp4`, 348 frames) so the numbers compare.

| # | Do | Expect |
|---|---|---|
| U1 | Upload the clip, draw a mask while extracting (2A still works), wait for ready, **Apply with default settings** | Log: `apply.env … sharp_concurrency:2`; `apply.source {mode:"reuse",frames:348}`; **no `apply.extract_all` line**; `apply.done` well under 33 s (target ≤ 15 s). |
| U2 | Open the frame viewer, scrub to first and last frame | Mask correct at both ends. DevTools → Network: masked frame response is `image/jpeg`, URL/filename `.jpg`. |
| U3 | Download ZIP | 348 files, `frame_000001.jpg … frame_000348.jpg`; open two in Preview; manifest + CSV present and `frames[]` count 348. |
| U4 | **Apply again** on the same job (redo) | `apply.source {mode:"reuse"}` again (V2-status choice). |
| U5 | New upload, same clip; in output settings choose **PNG**; Apply | `.png` files, `image/png`; `file` on one downloaded frame says PNG (not JPEG); apply time only slightly longer; note ZIP size vs U3. |
| U6 | AI spoke on the U1 job: run one inference on the masked frames; download the run | Works; overlays line up (co-indexing). |
| U7 | Multiframe `.dcm`: upload → apply → download | `apply.source {mode:"reuse"}`; frame count = NumberOfFrames; no 67× re-read (apply is fast). |
| U8 | Single-frame `.dcm` | Apply + download OK. |
| U9 | Any job: `grep '"stage":"apply.source"'` over the session | Every line is `reuse`; if any says `reextract`, copy its `reason`. |

## 6. Collect
```
pm2 logs masquerade --raw --lines 50000 | grep '\[PERF\]' | sed 's/^.*\[PERF\] //' > perf_2b_$(date +%Y%m%d_%H%M).jsonl
grep -E '"stage":"(apply\.source|apply\.env|apply\.done|bg_extract\.done)"' perf_2b_*.jsonl
```
Send me those lines (or the file). I'll update the Round 2B table with real before/after and write the
2B-3 kickoff (single-pass background extraction + grayscale evaluation).

## 7. Rollback
`git revert --no-edit HEAD && npm run build && pm2 restart masquerade --update-env` on the server. Jobs
masked under 2B keep working after a revert — `listFrameFiles` already accepted `png|jpg|jpeg` before
this round (per `ROUND2B_REPORT.md` addendum), so `.jpg` frames still list and serve; they'd just be
labeled `image/png` again until re-applied.

## 8. Close-out
CLAUDE.md status block: "Round 2B-1/2B-2 + format fix deployed <date>: apply reuses raw frames
(`apply.source`), sharp concurrency = cpus, masked output honors format (default `.jpg`); tsc 12;
instance t3.large." Point ACTIVE WORK at 2B-3.
