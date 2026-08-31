# Round 2A deploy + test runbook — frame-0 unblock (+ collect the Round 1 perf numbers)

Same shape as `PHASE_4_DEPLOY_PLAYBOOK.md`. 🖥️ LOCAL = Mac terminal · ☁️ SERVER = SSH on the app EC2 ·
🌐 BROWSER · 🅰 AWS Console. GPU instance untouched.

This one deploy carries **two** things: the Round 2A gate removal and the Round 1 `[PERF]` probes
(already landed, never deployed). So the test session doubles as the perf measurement run — do the
matrix in §5 while you're at it and you close both rounds in one sitting.

---

## 1. Pre-flight (🖥️ LOCAL)

```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git status
git diff --stat
```
Expected touched files: `server/routes.ts`, `server/services/frameAccess.ts`, a new test under
`server/services/__tests__/`, `client/src/pages/hub.tsx`, `client/src/pages/template-mask-spoke.tsx`,
`client/src/components/ProcessingControls.tsx` (or wherever Apply lives), `docs/refactor/ROUND2A_REPORT.md`,
plus the Round 1 files (`server/services/perf.ts`, probe sites, `PERF_ROUND1_REPORT.md`).
Anything under `server/storage.ts`, `server/pgStorage.ts`, `shared/schema.ts`, `migrations/` → **stop**, that's A3.

```
npx tsx server/services/__tests__/<the isCompletePng test>.ts
npx tsc --noEmit | grep -c "error TS"
npm run build
```
Gate: test passes · tsc = **12** · build clean (the 661 KB chunk warning is pre-existing).

## 2. Snapshot (🅰 AWS)

EC2 → instance `3.136.48.97` → Storage → volume → Actions → Create snapshot.
Description: `pre-round2a-deploy 2026-MM-DD`. Don't wait for it.

## 3. Commit + push (🖥️ LOCAL)

```
git add -A
git status
git commit -m "Round 2A: unblock draw-while-extracting (frame-0 gate) + Round 1 PERF probes

- frames endpoint raw branch: serve frame n during extraction if on disk + complete PNG (IEND); 503 no-store otherwise
- hub: Template Mask tile enabled during extracting; AI tile still gated on ready
- template-mask spoke: poll frames/0 on 503 until frame arrives
- Apply disabled until status=ready with extraction progress
- server/services/perf.ts + [PERF] probes (log-only)"
git push origin main
git log origin/main --oneline -1
```

## 4. Deploy (☁️ SERVER)

```
ssh -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97
```
```
cd ~/template-masking-app
git fetch origin main && git reset --hard origin/main
git log --oneline -1
```
Top SHA must match step 3. Then, one line at a time:
```
npm install
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 60 --nostream
```
Boot must show: uploads purge, temp_processed purge, spoke dirs ensured, cleanup scheduler with six
targets, `DATABASE_URL` probe reporting the RDS target + `jobs` table present, FFmpeg/FFprobe READY,
`serving on port 5000`. No stack traces. If the DB probe FATALs → `pm2 delete masquerade` and start
fresh with the correct env (see `PHASE_5C2_ENV_MISMATCH_HANDOFF.md`), don't loop on restart.

Confirm the bundle changed (🖥️ LOCAL):
```
curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1
```
Then 🌐 hard-reload (Cmd+Shift+R) and check DevTools → Network shows that same filename.

## 5. Test session (🌐 BROWSER + ☁️ SERVER tail)

Open a second terminal tailing the server the whole time:
```
pm2 logs masquerade --raw | grep -E '\[PERF\]|frames/0|Error|error' 
```

Use the **largest MP4 you have** for the main test — you need extraction to take long enough to
observe the mid-extraction state. If your biggest clip extracts in 3 seconds, none of T1–T4 is
observable; find a longer/higher-res one.

| # | Do | Expect | Pass? |
|---|---|---|---|
| T1 | Upload large MP4 → land on hub | "Extracting frames…" panel visible. **Template Mask tile enabled** with the "draw while frames extract" sub-label. **AI tile disabled.** | |
| T2 | Click Template Mask tile immediately | Spoke opens. Either the canvas with frame 1, or the spinner for ≤ a few seconds that swaps to the canvas **without a reload**. Network tab: `frames/0` → maybe a few 503s (each `Cache-Control: no-store`), then a 200. | |
| T3 | Draw a mask while status is still extracting | Drawing works normally. **Apply button disabled**, progress text "Extracting frames… N / total" advancing. | |
| T4 | Wait for extraction to finish (don't touch anything) | Apply enables by itself. Mask you drew is still there. | |
| T5 | Click Apply → wait → download ZIP | Completes; ZIP frame count = totalFrames; masked region correct on first and last frame. (This is also the MP4 apply+download regression guard owed from Round 1.) | |
| T6 | Same job: back to hub → AI tile now enabled → open AI spoke → run one inference | Works as before (regression). | |
| T7 | New upload of the same large MP4; go **directly** to `/jobs/<id>/template-mask` by URL within ~1 s | Spinner → canvas, no error state. | |
| T8 | New upload; on the spoke mid-extraction, **hard reload** the page | Comes back to spinner-or-canvas, not an error; Apply still gated. | |
| T9 | Upload a small MP4 (Kidney.mp4) | Flow feels the same as before — tile may go straight to ready. Apply + download OK. **Run this one 3×** (perf case A). | |
| T10 | Multiframe DICOM (uncompressed) | Tile enabled early; frame 1 canvas appears; Apply gated then enables; apply + download OK, frame count = NumberOfFrames. (Perf case C + DICOM regression guard.) | |
| T11 | Single-frame DICOM | Nothing visibly different; apply + download OK. (Perf case D + guard.) | |
| T12 | Image batch upload (a few PNGs) | `ready` immediately; unchanged behavior. | |
| T13 | On the large-MP4 job from T5: **Apply a second time** (redo loop) | Completes; identical output. (Perf case B, second apply.) | |

Any red row: go to §7.

## 6. Collect the perf numbers (☁️ SERVER, after T13)

```
cd ~
pm2 logs masquerade --raw --lines 50000 | grep '\[PERF\]' | sed 's/^.*\[PERF\] //' > perf_$(date +%Y%m%d_%H%M).jsonl
wc -l perf_*.jsonl
grep '"stage":"apply.env"' perf_*.jsonl | tail -1
```
Then the two pivot one-liners from `PERF_ROUND1_REPORT.md` Appendix C (stage table, then the
`apply.frame` decode/mask/encode sums). Copy the `.jsonl` to your Mac:
```
scp -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97:~/perf_*.jsonl ~/Desktop/
```
Send me the `.jsonl` (or paste the pivot output + the `apply.env` line) and I'll fill §1–§3 and §5 of
`PERF_ROUND1_REPORT.md` and write Round 2B.

Write down which jobId was which test case while you go — the pivot groups by jobId, and you won't
remember afterwards.

## 7. Rollback

Frontend + one endpoint branch, no storage change → plain revert:
```
# ☁️ SERVER
cd ~/template-masking-app
git revert --no-edit HEAD
npm run build
pm2 restart masquerade --update-env
```
(If you want to keep the `[PERF]` probes and drop only 2A, revert 2A's files selectively on LOCAL and
redeploy instead.) EBS restore is the last resort and shouldn't be needed here.

## 8. Close-out

- Snapshot `post-round2a-verified` (optional, cheap).
- Tick the table above into `docs/refactor/ROUND2A_REPORT.md` under "Production verification".
- CLAUDE.md status block: add "Round 2A deployed + verified <date>: draw-while-extracting restored;
  Apply gated on ready. Round 1 perf probes live in prod. tsc 12." and point the ACTIVE WORK section
  at the perf numbers / Round 2B.
