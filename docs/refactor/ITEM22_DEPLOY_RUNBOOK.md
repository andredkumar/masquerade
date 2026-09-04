# Item 22 deploy + test runbook — masked image files named after the encoder

Same shape as `ROUND2B_DEPLOY_RUNBOOK.md`. 🖥️ LOCAL = Mac terminal · ☁️ SERVER = SSH on the app EC2 ·
🌐 BROWSER · 🅰 AWS Console. GPU instance untouched.

Carries **one commit**: `8f067a7` "Item 22: name masked images after the encoder, not the upload"
(already committed locally, **not pushed** — `main` is ahead of `origin/main` by 1).
Decision authority: `ITEM22_RECON.md` §6. What changed and why: `ITEM22_REPORT.md`.

**Scope of behavior change: the image-batch path only.** Video and DICOM are untouched by this
commit and appear below purely as regression guards.

> ⚠️ **Read before §5.** `manifest.json` / `metadata.csv` filenames still will **not** resolve to
> files inside the ZIP (`frame_0000.jpg` vs `images/frame_000000.jpg`). That is **backlog item 27**,
> pre-existing and deliberately untouched here. Do not log it as a regression from this deploy.

---

## 1. Pre-flight (🖥️ LOCAL)

```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git log --oneline -1
git status
git show --stat HEAD
```
Expected at HEAD: `server/services/videoProcessor.ts`, `server/services/templateMaskFolderManager.ts`,
`server/services/__tests__/saveProcessedImage.test.ts` (new), `CLAUDE.md`,
`docs/refactor/ITEM22_*.md`. Untracked `docs/refactor/NEXT_ROUND_CANDIDATES.md` is expected — add it
in §3. Anything under `server/storage.ts`, `server/pgStorage.ts`, `shared/schema.ts`, `migrations/`
→ **stop**, that's A3.

```
npx tsx server/services/__tests__/saveProcessedImage.test.ts
npx tsx server/services/__tests__/applyPaths.test.ts
npx tsx server/services/__tests__/frameAccess.test.ts
npx tsc --noEmit | grep -c "error TS"
npm run build
```
Gate: **11/11 · 8/8 · 8/8** · tsc = **12** · build clean (the 661 KB chunk warning is pre-existing).

*Run these on the Mac, not in a Linux shell — `node_modules` carries the darwin-arm64 esbuild binary,
so `tsx` and `npm run build` fail on any other platform with a TransformError. That failure is
environmental, not a code failure.*

Optional, 30 seconds, and it tells you what the old jobs on disk look like before you change the
naming (☁️ SERVER):
```
ls ~/template-masking-app/spokes/template_mask/*/image_* 2>/dev/null | head -20
file $(ls ~/template-masking-app/spokes/template_mask/*/image_* 2>/dev/null | head -3)
```
Expect the pre-fix lie: `.png` names reporting `JPEG image data`. Write one line down for the report.

## 2. Snapshot (🅰 AWS)

EC2 → instance `3.136.48.97` → Storage → volume → Actions → Create snapshot.
Description: `pre-item22-deploy 2026-MM-DD`. Don't wait for it.

## 3. Push (🖥️ LOCAL)

The commit already exists. Do **not** re-commit — just add the untracked doc and push.
```
git add docs/refactor/NEXT_ROUND_CANDIDATES.md docs/refactor/ITEM22_DEPLOY_RUNBOOK.md
git commit -m "docs: item 22 deploy runbook + next-round candidates"
git push origin main
git log origin/main --oneline -2
```
Top two SHAs: the docs commit, then `8f067a7`.

## 4. Deploy (☁️ SERVER)

```
ssh -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97
```
(`deploy.sh` uses `~/Desktop/ultrasound-app-key.pem` — either path, whichever is where the key
actually lives.)
```
cd ~/template-masking-app
git fetch origin main && git reset --hard origin/main
git log --oneline -2
```
Top SHAs must match §3. Then **one line at a time**:
```
npm install
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 60 --nostream
```
Boot must show, unchanged from Round 2B: uploads purge · temp_processed purge · spoke dirs ensured ·
cleanup scheduler with six targets · `DATABASE_URL` probe naming the RDS target with the `jobs` table
present · `sharp concurrency set to 2` · FFmpeg/FFprobe READY · `serving on port 5000`. No stack
traces. If the DB probe FATALs → `pm2 delete masquerade` and start fresh with the correct env
(`PHASE_5C2_ENV_MISMATCH_HANDOFF.md`); do not loop on restart.

Bundle check (🖥️ LOCAL) then 🌐 hard-reload (Cmd+Shift+R):
```
curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1
```
*(This commit is server-only — the bundle hash may legitimately be unchanged. Not a gate here.)*

## 5. Test session (🌐 BROWSER + ☁️ SERVER tail)

Second terminal, tailing throughout:
```
pm2 logs masquerade --raw | grep -E "Converting to|Saved processed image|Fallback processed image|Error|error"
```

Prepare **one mixed 3-image batch**: `a.jpg`, `b.jpeg`, `c.png` (any content). Run the whole batch
**twice** — once with default output settings, once with **PNG** selected — and note each `jobId`
from the URL as you go.

| # | Do | Expect | Pass? |
|---|---|---|---|
| I1 | Upload the 3-image batch, draw a mask, Apply with **default** settings | Completes. Log shows `Saved processed image: …/image_001_a.jpg`, `…_002_b.jpg`, `…_003_c.jpg` — **all `.jpg`, including the `.png` upload** | |
| I2 | ☁️ `file ~/template-masking-app/spokes/template_mask/<jobId>/*` | All three `JPEG image data`, all named `.jpg`. Any type/extension disagreement = **fail** | |
| I3 | 🌐 Frame viewer / spoke review on that job; DevTools → Network on a frame request | Frames render; masked region correct; response `Content-Type: image/jpeg` | |
| I4 | Download the ZIP; 🖥️ `rm -rf /tmp/zipcheck && unzip -o ~/Downloads/processed_*.zip -d /tmp/zipcheck && file /tmp/zipcheck/images/*` | 3 entries, `images/frame_00000{0,1,2}.jpg`, each reporting `JPEG image data`. **This is the check that justified the deploy** | |
| I5 | Repeat I1 with **PNG** selected in output settings | `…_001_a.png` / `_002_b.png` / `_003_c.png` — all `.png`, including the `.jpg` uploads | |
| I6 | Repeat I2 + I4 on the PNG job | On disk and in the ZIP: all `PNG image data`, all named `.png`. Note the ZIP size vs I4 (~3× is expected) | |
| I7 | Single-image "batch" (upload one `.png`, default settings) | `image_001_<name>.jpg`, JPEG bytes. Guards the one-image edge of the volumetric loop | |
| I8 | Filename with dots, e.g. `scan.2026-09-04.v2.png`, default settings | `image_001_scan.2026-09-04.v2.jpg` — basename preserved, only the final extension replaced | |
| I9 | **Regression, video:** MP4 (`Normal Lung sliding 2.mp4`) → apply → download | Unchanged from Round 2B: `frame_000000.jpg …`, `apply.source {mode:"reuse"}`, apply time in the ~8 s band | |
| I10 | **Regression, DICOM:** one multiframe `.dcm` → apply → download | Unchanged; frame count = NumberOfFrames | |
| I11 | **Regression, AI spoke:** open the AI spoke on the I1 image job, run one inference, download the run | Masked `.jpg` frames are found and labeled; overlays line up (extension-agnostic listing holds) | |
| I12 | ☁️ Old pre-fix job still on disk (from §1), open it in the viewer if it's inside retention | Still renders — `mimeForFrameFile`'s PNG fallback covers legacy `.png`-named JPEGs. Not migrated, by design | |

Any red row → §7.

**Not a gate**, but cheap and it settles recon §6.5 disposition 3 — has the `catch` fallback ever
fired in prod (i.e. does any job on disk hold PNG-in-`.jpg` rather than JPEG-in-`.png`):
```
pm2 logs masquerade --lines 200000 --nostream --raw | grep -c "Fallback processed image"
```

## 6. Collect

```
pm2 logs masquerade --lines 5000 --nostream --raw | grep "Saved processed image" | tail -20
for d in ~/template-masking-app/spokes/template_mask/*/; do echo "== $d"; file "$d"* 2>/dev/null | head -3; done
```
Paste that plus the two `file /tmp/zipcheck/images/*` outputs (default run and PNG run) into
`ITEM22_REPORT.md` §5 as the on-box verification record, with the `jobId`s.

## 7. Rollback

Single commit, no schema change, no data implications:
```
# ☁️ SERVER
cd ~/template-masking-app
git revert --no-edit 8f067a7
npm run build
pm2 restart masquerade --update-env
```
Files written **under** the fix keep working after a revert — `listFrameFiles` /
`getProcessedImages` accept `png|jpg|jpeg` and `mimeForFrameFile` derives the type, so a correctly
named `.jpg` still lists and serves. The only regression on revert is that new image jobs resume
lying about their extension. EBS restore is the last resort and shouldn't be needed.

## 8. Close-out

- Snapshot `post-item22-verified` (optional, cheap).
- Fill in `ITEM22_REPORT.md` §5 with the actual outputs and mark it verified; change its status line
  from "not yet deployed" to "deployed + verified <date>".
- `CLAUDE.md`: item 22 already says DONE — add the deploy date and "verified on the box (disk + ZIP,
  default and PNG runs)" to that entry. Confirm the tsc = **12** invariant line is untouched.
- Next: item 27 (manifest filenames don't resolve in the ZIP) is now the cheapest open correctness
  item and sits in the same export path — natural follow-on. Otherwise the `NEXT_ROUND_CANDIDATES.md`
  order stands: Item 4A (`maskWorker.ts` delete, tsc 12 → 5), then Item 2 (review masked frames).
