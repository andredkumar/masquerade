# Auto-mask 2B-2 deploy + test runbook — the spoke behind `AUTOMASK_UI`

Same shape as the 2B-1 / Round 2B runbooks. 🖥️ LOCAL · ☁️ SERVER · 🌐 BROWSER · 🅰 AWS. Input: `AUTOMASK_ROUND2B2_REPORT.md` (2026-09-11). Two sub-phases on the server: deploy with the flag **unset** (reversible, must be today's spoke), then flip it on.

## 0. Report review — decisions

**All eight §5 deviations: keep.** The two that change behaviour are right: the re-seed range guard (a 3.2° trapezoid's literal apex 4936 px above the frame is useless to the half-angle slider) and the `shapeDeltas` fix — my kickoff and sign-off both claimed `shape.ts:43` treated trap ↔ rect together; it was unreachable for mixed kinds, so the claim was wrong and the fix stands. The `useHoldRepeat` memoisation bug (§5.4) is the kind of thing the measurement rows exist for; the hidden-tab timer-throttling explanation is correct, so the hold timing is yours to feel on a visible tab (P4 below).

**Boundary gate — passed (report §0.1, 2026-09-11, no code change).** I asked for a margin-0 re-score because I read the headline `leak` column as fail-open; it is not. `run.ts --db` scores `score(proposalKeep, appliedMask)`, so `leak` = proposal-kept ∧ applied-**blanked**: the accepted mask blanks a uniform **1 px ring inside** the eroded keep (fail-closed), and the fail-open count against the raw, un-eroded keep is **0 on all three families**. Mechanism: the 1 px stroke the export forces on every path (`MaskingCanvas.tsx:937`) plus the `r > 150` threshold, not retina — the sandbox exports were at dpr 1. Net: the applied edge sits 3 px inside the fitted cone edge (2 px margin + 1 px ring). **What this leaves for you:** the retina 2× export → lanczos3 downsample path was *not* exercised in the sandbox; P3 and P5 below are its first run with the accepted path. Look at the masked frames, not just the log line.

**`.gitignore`:** `uploads/`, `temp_extracted/`, `spokes/` are not ignored (report §6). You own that file and it is already modified in your tree — add the three lines and include `.gitignore` in this commit (§3). It removes a standing PHI-commit hazard for every future round.

**Backlog (→ `NEXT_ROUND_CANDIDATES.md`, not this round):** the sidebar collapse when the frame is wider than the window − ~400 px (at 1440 px the 1536-px reference clip hides Apply entirely — pre-existing, but the proposal bar will bring more users into the spoke, so it moves up); Accept's look (`_aiOverlay` at 50 % on every `maskData`, shared with the brush path); the retina export payload (`MaskingCanvas.tsx:917`); `fabric ^6.7.1` pin; `maskWorker.ts` deletion.

## 1. Pre-flight (🖥️ LOCAL)
```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git status
git diff --stat
```
Expected modified/new: `shared/automask/{shape,types}.ts`, `server/services/{automaskFlag,automaskOutcome}.ts`, `server/routes.ts`, `server/services/__tests__/{automaskShape,automaskOutcome,automaskHold}.test.ts`, `client/src/components/{MaskingCanvas,AutomaskProposalBar}.tsx`, `client/src/hooks/{useAutomaskProposal,useHoldRepeat}.ts`, `client/src/pages/template-mask-spoke.tsx`, `docs/refactor/AUTOMASK_ROUND2B2_*.md`, `CLAUDE.md`, `.gitignore`. **Stop if** `git diff --stat` lists `videoProcessor.ts`, `frameExtractor.ts`, `maskWorker.ts`, `automask.ts`, `automaskT0.ts`, `automaskWorkerClient.ts`, `ProcessingControls.tsx`, `MaskingTools.tsx`, `package.json`, `storage.ts`, `pgStorage.ts`, `shared/schema.ts`, `migrations/`.
```
npx tsx server/services/__tests__/automaskShape.test.ts
npx tsx server/services/__tests__/automaskOutcome.test.ts
npx tsx server/services/__tests__/automaskHold.test.ts
npx tsx server/services/__tests__/automask.endpoint.test.ts
npx tsx server/services/__tests__/automaskWorkerClient.test.ts
npx tsc --noEmit | grep -c "error TS"
npm run build && ls dist/
```
Gate: 6/6 · 4/4 · 2/2 · 13/13 · 5/5 · tsc = **12** · `dist/` shows `index.js`, `automaskWorker.js`, `public/`.

## 2. Snapshot (🅰 AWS)
EC2 → the app instance → EBS volume → Create snapshot: `pre-automask-2b2 2026-09-11`.

## 3. Commit by explicit paths + push (🖥️ LOCAL)
```
printf 'uploads/\ntemp_extracted/\nspokes/\n' >> .gitignore
git add .gitignore CLAUDE.md shared/automask/shape.ts shared/automask/types.ts \
  server/services/automaskFlag.ts server/services/automaskOutcome.ts server/routes.ts \
  server/services/__tests__/automaskShape.test.ts server/services/__tests__/automaskOutcome.test.ts server/services/__tests__/automaskHold.test.ts \
  client/src/components/MaskingCanvas.tsx client/src/components/AutomaskProposalBar.tsx \
  client/src/hooks/useAutomaskProposal.ts client/src/hooks/useHoldRepeat.ts \
  client/src/pages/template-mask-spoke.tsx \
  docs/refactor/AUTOMASK_ROUND2B2_KICKOFF.md docs/refactor/AUTOMASK_ROUND2B2_PLAN.md docs/refactor/AUTOMASK_ROUND2B2_SIGNOFF.md docs/refactor/AUTOMASK_ROUND2B2_REPORT.md docs/refactor/AUTOMASK_ROUND2B2_DEPLOY_RUNBOOK.md
git status
```
**Read `git status` before committing:** nothing under `uploads/`, `temp_extracted/`, `spokes/`, `scripts/automask_spike/dicoms.json`, `.idea/`, `scripts/sandbox/` may be staged. If `git status` still lists `uploads/` etc. as untracked after the `.gitignore` line, they contain files — fine, they stay untracked. Then:
```
git commit -m "automask 2B-2: the spoke behind AUTOMASK_UI — proposal layer, bench-v4 controls, nudge, model switch, Accept, automask.outcome

- MaskingCanvas: proposal layer as one fabric.Path (evenodd), handle, Accept via the existing updateMaskFromCanvas path case; export path untouched
- AutomaskProposalBar + hooks: grade words, fan/trap/rect switch with re-seed, controls with fitted -> now (delta), hold-repeat nudge, keyboard arrows
- shared/automask/shape.ts: controlSpecs, readouts, withControl (bench withParam port), reseed, keepPolygon
- POST /api/jobs/:id/template-mask/proposal/outcome -> one [PERF] automask.outcome line; ui_enabled stamped on the proposal GET
- flag AUTOMASK_UI (default off); with it unset the spoke is today's
- .gitignore: uploads/, temp_extracted/, spokes/"
git push origin main
git log origin/main --oneline -1
```

## 4a. Deploy, flag unset (☁️ SERVER) — reversible
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
ls dist/
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 60 --nostream
```
`ls dist/` must show **both** `index.js` and `automaskWorker.js`. Boot clean. Bundle check (🖥️ LOCAL): `curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1` — new hash; 🌐 hard reload.

Tail for the whole session (☁️, second terminal):
```
pm2 logs masquerade --raw | grep -E '"stage":"(automask\.(served|start|done|skipped|outcome|t0_captured)|apply\.done)"'
```

| # | Do (🌐) | Expect |
|---|---|---|
| P1 | Upload a GE E9 `.dcm`, open the template-mask spoke | **Today's spoke** — no bar, no layer, Rectangle tool. Tail: `t0_captured {dicom}` → `start/done {trigger:"ready"}` → exactly **one** `served` for the open. Draw a rectangle → Apply → `apply.done` normal. This is the flag-off row on prod; if anything automask-looking renders, stop here (flag is off, so it would mean a build/gate bug). |

## 4b. Flag on (☁️ SERVER)
```
AUTOMASK_UI=1 pm2 restart masquerade --update-env && pm2 save
pm2 env 0 | grep AUTOMASK
```
Expect both `AUTOMASK=1` and `AUTOMASK_UI=1` (the pm2 id may not be 0 — `pm2 list` first). Reopen the P1 job's spoke: the bar appears on a job proposed *before* the flip (proves `ui_enabled` is stamped at serve time, not cached).

## 5. Test session (🌐 + ☁️ tail) — this is also your display row (sign-off decision 6)

| # | Do | Expect |
|---|---|---|
| P2 | Same GE E9 job → spoke | Frame with the trapezoid layer, grade "Proposed", handle on the top-edge midpoint, "Select & Move" active, bar with Accept / Draw from scratch / fan-trap-rect. Tail: one `served`, nothing else. |
| P3 | **Accept** (untouched) → "Cone accepted", Apply enabled → **Apply** | Tail: **one** `automask.outcome {outcome:"accept", tier:"T0T1", model_switch:null}`, all Δ 0; `apply.done` normal. Open the frame viewer: masked frames blank exactly outside the trapezoid — check first and last frame. Download the ZIP, open two frames in Preview. **This is the retina equivalence row.** |
| P4 | New upload: the reference clip (`Normal Lung sliding`, 348 fr). Spoke → fan layer. On a **visible** tab: hold ArrowRight ~2 s, then Shift+ArrowLeft taps; drag the handle ~100 px at zoom 150; nudge depth via its slider | Hold: first repeat ≈ 0.4 s after the press, visibly faster after ~1.5 s; Shift taps move 10 px; the readouts show `fitted → now (Δ)` and the drag lands where you drop it (path follows, handle stays). Arrow keys while focused in an output-settings input do **not** move the cone. |
| P5 | Accept → **Adjust** → nudge once more → Accept → Apply | Tail: **exactly one** `automask.outcome {outcome:"edit", controls_used:[…position, depth…]}` with non-zero Δ. `apply.done` vs the 8.5 s baseline (expect no change). Frame viewer: mask matches the cone you left. |
| P6 | New upload (any clip): switch **trap → fan** (or fan → trap) on the bar, adjust, Accept → Apply | Layer re-seeds "close" — you land near the cone, not from nothing. Tail: `outcome:"edit"`, `model_switch:{from,to}`, `deltas:null` when the family changed. |
| P7 | New upload: press **Draw from scratch** | Layer gone, Rectangle tool restored, bar gone; tail: **one** `outcome:"draw_from_scratch"` immediately. Draw a rectangle → Apply → **no second line**. |
| P8 | Any job with the layer showing: start drawing without pressing the button | Layer disappears at the first press; one `draw_from_scratch` line. |
| P9 | Optional, if you have a withheld-type clip handy (a screen recording, non-dark background) | Today's spoke; tail shows `skipped {withheld}`, no bar, no outcome line. |

If anything in P2–P8 is wrong: `AUTOMASK_UI=0 pm2 restart masquerade --update-env && pm2 save` (the flag regex is `^(1|true|on|yes)$`, so `0` is off) and the spoke is today's; then send me the tail.

## 6. Collect (☁️)
```
pm2 logs masquerade --raw --lines 50000 | grep '\[PERF\]' | sed 's/^.*\[PERF\] //' > perf_2b2_$(date +%Y%m%d_%H%M).jsonl
grep -E '"stage":"(automask\.outcome|automask\.served|apply\.done)"' perf_2b2_*.jsonl
```
Send me those lines. I want: one `outcome` per job you applied, `served` = 1 per spoke open, `apply.done` unchanged.

## 7. Flag decision
B1's criterion (≥ 90 % accept-or-controls) is met at 91 % on the bench, and the outcome pivot — B5's whole point — only fills up with the flag on. **Recommendation: leave `AUTOMASK_UI=1` set** after P2–P8 pass. Cost of being wrong: one `pm2 restart` with the flag cleared, no data loss, no schema. Give it a week, then run the pivot from report §7 and send me the counts; that sets the grade thresholds and picks the next tuning target.

## 8. Rollback
☁️ `git revert --no-edit HEAD && npm run build && pm2 restart masquerade --update-env`. Jobs applied under 2B-2 are ordinary freeform masks — nothing to redo. Clearing the flag alone (§5) is the softer option and is the first thing to try.

## 9. Close-out
`CLAUDE.md`'s status heading currently reads "Auto-mask Round 2B-2 BUILT (2026-09-11, uncommitted — awaiting the runbook)". After §7, one follow-up commit (🖥️ LOCAL, then the §4a server steps) changes it to "2B-2 DEPLOYED <date>, `<sha>`, `AUTOMASK_UI` on/off" with the P3/P5 numbers — the same close-of-phase update every round gets. Add the §0 backlog items to `NEXT_ROUND_CANDIDATES.md`. Next round candidates in order: the sidebar collapse (it now gates whether users reach Apply at all on laptops), then 2C (B4 template library — the outcome lines' `final_keep` are its input; B6 temporal support in the sandbox first).

---
> Addendum done 2026-09-11 (report §0.1): margin-0 fail-open 0.0000 on all three families; the residual is a 1 px fail-closed ring from the forced export stroke. Nothing gates the commit. Go from §1.
