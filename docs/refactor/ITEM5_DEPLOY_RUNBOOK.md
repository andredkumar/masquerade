# Item 5 — deploy runbook (RGB DICOM frames as RGB; reusePort guard; PostHog localhost guard)

**Branch:** `item5-rgb-dicom` — three commits on top of `dc45954` (item 28): `19dce35` server: only request SO_REUSEPORT on Linux · `2a5be5a` item 5: extract RGB (SamplesPerPixel 3) DICOM frames as RGB · `5a7526a` client: skip PostHog init on localhost or `VITE_POSTHOG_DISABLED=1`. Each reverts alone. **Verification before deploy:** `ITEM5_REPORT.md` (harness R1–R5), `ITEM5_UI_REPRODUCTION.md` (real UI, both DICOMs, nothing failed). `tsc` 12. A3 untouched. No schema, no status, no route change.

## 0. Before touching the box
- [ ] EBS snapshot `pre-item5-deploy <date>`.
- [ ] Confirm `3.136.48.97` is still the Elastic IP; `pm2 status` shows `masquerade` online.
- [ ] Note the current SHA on the box: `cd ~/template-masking-app && git log --oneline -1` (expect `dc45954` or later `main`).
- [ ] Keep one **pre-deploy ZIP** for the mono guard: upload `ge_e9_4351124429.dcm` (67-frame mono) on prod, draw the header rectangle, Apply, download — save as `pre_item5_mono.zip`. (Or run the harness on the box before and after: `npx tsx scripts/automask_spike/item5_rgb_dicom_check.ts <dcm> /tmp/before` — the spike scripts are untracked locally; copy the one file over if you want this variant.)

## 1. Deploy
```bash
cd ~/template-masking-app
git fetch origin
git merge --ff-only origin/item5-rgb-dicom      # or: git checkout main && git merge --ff-only item5-rgb-dicom after pushing the branch to main
git log --oneline -1                             # must be 5a7526a (or the merge SHA if not fast-forwarded)
npm ci
npx tsc --noEmit 2>&1 | grep -c "error TS"       # 12
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 40 --nostream        # boot lines unchanged: DATABASE_URL target, 'database reachable', 'serving on port 5000', FFmpeg INSTALLED
```
`reusePort`: on Linux the code path is unchanged (`process.platform === 'linux'` → still requests `SO_REUSEPORT`); if the port did not bind the boot log says so within seconds.

## 2. Verify (hard reload the browser first; confirm the `index-*.js` bundle hash changed)

| # | check | expected |
|---|---|---|
| I1 | **Mono guard.** Upload `ge_e9_4351124429.dcm` again, same header rectangle, Apply, download; `unzip` both ZIPs and `cmp images/frame_000010.jpg` (any frame) against `pre_item5_mono.zip` | identical bytes (same mask → same JPEG); `[PERF] bg_extract.done frames:67 parity:true` |
| I2 | **The fix.** Upload the colour-Doppler still `ge_e9_6193094661.dcm` | hub "1164×873 · 1 frames"; the Template Mask canvas shows the PDI box **in colour** (before item 5: a grey garble of three vertical thirds) |
| I3 | Header rectangle → Apply → Download ZIP on I2 | `apply.done` ~80–150 ms on the t3.large; `images/frame_000000.jpg` is 3-channel with colour below the band, black band on top |
| I4 | AI spoke on the I2 job | loads the masked colour frame; Run AI as usual (GPU endpoint) |
| I5 | A regular MP4 (the reference clip) | `bg_extract.done` ~8 s and `apply.done` ~8.7 s unchanged (item 5 touches only the DICOM branch) |
| I6 | PostHog | one `mask_processing_started` event still arrives from the prod hostname; no events from `localhost` sessions afterwards |
| I7 | `pm2 logs masquerade --raw \| grep -v PERF \| tail` | no new error lines during I1–I5 |

## 3. Rollback
`git revert 2a5be5a` (item 5 alone) or `git reset --hard dc45954` (all three), `npm run build`, `pm2 restart masquerade --update-env`. No data migration involved; masked frames already on disk stay readable.

## 4. After it is green
- CLAUDE.md, DICOM block, one line: *"RGB (SamplesPerPixel 3) DICOM frames extracted as RGB since item 5 (2026-09-04); `extractDicomImage` still mono-only (follow-up)."* (Andre's tree has uncommitted CLAUDE.md edits, so this was not committed by the agent.)
- Round 2A runbook row **A6** (colour-Doppler still through the proposer) becomes runnable.
- Follow-ups filed in `ITEM5_REPORT.md` §6 stay open: `extractDicomImage` RGB, per-frame whole-file re-read in `extractDicomFrame`, compressed transfer syntaxes.
