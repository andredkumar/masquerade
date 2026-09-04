# Item 22 + Item 28 deploy runbook — one deploy, two commits

Supersedes `ITEM22_DEPLOY_RUNBOOK.md` (that one assumed item 22 shipped alone; its §5 image rows were
unrunnable until item 28). Same shape as `ROUND2B_DEPLOY_RUNBOOK.md`.
🖥️ LOCAL · ☁️ SERVER · 🌐 BROWSER · 🅰 AWS. GPU instance untouched.

Carries:
- **Item 22** — `8f067a7`, committed, **not pushed**: masked image files named after the encoder.
- **Item 28** — **uncommitted working tree**: image batches serve frame *n* from `uploads/`, plus
  honest 410 copy (server + client).

Item 28 is what makes item 22 observable — the image canvas has never painted since Phase 4b, so
nobody could reach Apply. Deploy them together and one test session closes both.

> ⚠️ Use a **uniform-dimension** image batch throughout §5. Mixed sizes hit backlog item 29 (one
> absolute-pixel mask from image 0 applied to every frame) and you'd be measuring two bugs at once.
> ⚠️ `manifest.json` filenames still won't resolve inside the ZIP — that's item 27, pre-existing.

## 1. Pre-flight (🖥️ LOCAL)

```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git log --oneline -1
git status
```
Expect HEAD `8f067a7` and modified: `CLAUDE.md`, `client/src/pages/template-mask-spoke.tsx`,
`server/routes.ts`, `server/services/frameAccess.ts`; untracked: `server/services/__tests__/imageBatchFrames.test.ts`
and the `docs/refactor/ITEM2*` + `NEXT_ROUND_CANDIDATES` files. Anything in `server/storage.ts`,
`server/pgStorage.ts`, `shared/schema.ts`, `migrations/` → **stop**, that's A3.

```
npx tsx server/services/__tests__/imageBatchFrames.test.ts
npx tsx server/services/__tests__/saveProcessedImage.test.ts
npx tsx server/services/__tests__/frameAccess.test.ts
npx tsx server/services/__tests__/applyPaths.test.ts
npx tsc --noEmit | grep -c "error TS"
npm run build
```
Gate: **6/6 · 11/11 · 8/8 · 8/8** · tsc = **12** · build clean. Run on the Mac — `node_modules`
carries the darwin esbuild binary, so `tsx`/`build` fail anywhere else with a TransformError.

## 2. Snapshot (🅰 AWS)

EC2 → `3.136.48.97` → Storage → volume → Create snapshot: `pre-item22-28-deploy 2026-MM-DD`.

## 3. Commit item 28 + push (🖥️ LOCAL)

Item 22 is already committed — do **not** re-commit it.
```
git add -A
git status
git commit -m "Item 28: serve image-batch frames from uploads/, and stop claiming a restart

Image batches never populate temp_extracted/ (no extraction — multer writes
uploads/<hash>, job goes straight to ready), so the raw branch of the frames
endpoint fell through to its trailing 410 for every image job. The spoke
rendered that as 'the server may have restarted', the canvas never painted,
so Apply could never enable: the whole image feature was unreachable since
Phase 4b (c66ca4e).

- frameAccess.ts: resolveImageBatchFrame() — indexed strictly by fileList
  order (the order processImages masks in), resolveWithinRoot on the path,
  mimetype allowlist so a .png declared text/html is never reflected back,
  no re-encode
- routes.ts: image-batch branch gated on jobV2.source.type === 'image_batch',
  after ?source=template_mask, before listRawFrameFiles; 404 past the end,
  410 only when the bytes are genuinely gone
- both 410s now carry reason (uploads_swept | frames_swept); the spoke reads
  it and names the real retention window
- imageBatchFrames.test.ts: 6 tests, incl. a co-indexing case that fails a
  sorted-listing implementation

tsc stays 12. A3 frozen. Verified live over real HTTP against the real route.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
git log origin/main --oneline -2
```
Top two: item 28, then `8f067a7`.

## 4. Deploy (☁️ SERVER)

```
ssh -i ~/Desktop/ultrasound-app-key.pem ubuntu@3.136.48.97
```
```
cd ~/template-masking-app
git fetch origin main && git reset --hard origin/main
git log --oneline -2
```
SHAs must match §3. Then **one line at a time**:
```
npm install
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 60 --nostream
```
Boot unchanged from 2B: uploads purge · temp_processed purge · spoke dirs · cleanup scheduler, six
targets · `DATABASE_URL` probe naming RDS with `jobs` present · `sharp concurrency set to 2` ·
FFmpeg/FFprobe READY · `serving on port 5000`. DB probe FATAL → `pm2 delete masquerade` + fresh start
with correct env (`PHASE_5C2_ENV_MISMATCH_HANDOFF.md`); don't loop on restart.

**Bundle hash is a real gate this time** — item 28 changes the client:
```
curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1
```
Must differ from the pre-deploy value. Then 🌐 hard reload (Cmd+Shift+R) and confirm DevTools shows
that same filename.

## 5. Test session (🌐 + ☁️ tail)

```
pm2 logs masquerade --raw | grep -E "Converting to|Saved processed image|Fallback processed image|Error|error"
```
Prepare one **uniform-dimension** batch: `a.jpg`, `b.jpeg`, `c.png`. Note each `jobId` from the URL.

### A — item 28: the canvas paints (this is the whole fix)

| # | Do | Expect |
|---|---|---|
| A1 | Upload the 3-image batch → hub → click Template Mask | **Canvas paints the first image.** No "Frames are no longer available" |
| A2 | ☁️ `curl -si localhost:5000/api/jobs/<jobId>/frames/0 \| head -3` | `200`, `Content-Type: image/jpeg` or `image/png` per that file |
| A3 | ☁️ `curl -si localhost:5000/api/jobs/<jobId>/frames/3 \| head -3` (batch of 3) | `404 {"error":"Frame not found"}` |
| A4 | Co-indexing: use 3 visually distinct images; compare canvas frame 0 with the first file you selected | Same image. Then after A6, masked output `image_001_*` is that same source |
| A5 | Single-image batch | Canvas paints; `frames/1` → 404 |

### B — item 22: names match content (now reachable)

| # | Do | Expect |
|---|---|---|
| B1 | On the A1 job: draw a mask → **Apply** (default settings) | Apply enables and completes. Log: `image_001_a.jpg`, `_002_b.jpg`, `_003_c.jpg` — all `.jpg`, including the `.png` upload |
| B2 | ☁️ `file ~/template-masking-app/spokes/template_mask/<jobId>/*` | All `JPEG image data`, all named `.jpg`. Type/extension disagreement = **fail** |
| B3 | Download ZIP → 🖥️ `rm -rf /tmp/zipcheck && unzip -o ~/Downloads/processed_*.zip -d /tmp/zipcheck && file /tmp/zipcheck/images/*` | `images/frame_00000{0,1,2}.jpg`, each `JPEG image data` |
| B4 | New batch, **PNG** selected in output settings → Apply | All `.png`, all `PNG image data`, on disk and in the ZIP. Note ZIP size vs B3 (~3×) |
| B5 | Dotted filename `scan.2026-09-04.v2.png`, default settings | `image_001_scan.2026-09-04.v2.jpg` |

### C — honest copy

| # | Do | Expect |
|---|---|---|
| C1 | ☁️ On a finished image job: `mv uploads/<one hash> /tmp/` then reload its spoke | "Your uploaded images are no longer on the server / Uploads are kept for 2 hours." **Not** a restart claim. `mv` it back after |
| C2 | Any video job whose `temp_extracted/` is gone (or wait out 6 h) | "Frames are no longer available / kept for 6 hours, lost if the server restarts mid-extraction" |

### D — regressions

| # | Do | Expect |
|---|---|---|
| D1 | MP4 (`Normal Lung sliding 2.mp4`) → apply → download | Unchanged: `frame_000000.jpg …`, `apply.source {mode:"reuse"}`, apply ~8 s band |
| D2 | Multiframe DICOM → apply → download | Unchanged; frame count = NumberOfFrames |
| D3 | AI spoke on the B1 image job: run one inference, download the run | Masked `.jpg` frames found and labeled; overlays align |

Any red row → §7.

## 6. Collect

```
pm2 logs masquerade --lines 5000 --nostream --raw | grep "Saved processed image" | tail -20
for d in ~/template-masking-app/spokes/template_mask/*/; do echo "== $d"; file "$d"* 2>/dev/null | head -3; done
```
Paste that plus both `file /tmp/zipcheck/images/*` runs into `ITEM22_REPORT.md` §5 and
`ITEM28_REPORT.md` §3e, with the jobIds.

## 7. Rollback

Two independent commits, no schema change:
```
# ☁️ SERVER — item 28 only
cd ~/template-masking-app
git revert --no-edit <item28 sha>
npm run build
pm2 restart masquerade --update-env
```
Reverting **item 28 re-breaks every image job** at the canvas — do it only if the branch itself
misbehaves, not for an item 22 problem. Reverting **item 22** alone is safe: files written under it
keep serving (`listFrameFiles` accepts `png|jpg|jpeg`, `mimeForFrameFile` derives the type); new
image jobs just resume mislabeling. If both must go, revert item 22 first, then item 28.

## 8. Close-out

- Snapshot `post-item22-28-verified` (optional).
- `ITEM22_REPORT.md`: status → deployed + verified, §5 filled in.
- `ITEM28_REPORT.md`: §3e rows 2–3 and 6 now have live results.
- `CLAUDE.md`: item 22 gets the deploy date + "verified on the box (disk + ZIP, default and PNG)";
  item 28 marked FIXED with the date; **file item 29** (mixed-dimension batches — PHI-leak shape)
  from `ITEM28_REPORT.md` §6. Confirm the tsc = 12 invariant line is untouched.
- Next: item 29 if image batches are a real workflow for you; otherwise item 27 (manifest filenames)
  or Item 4A from `NEXT_ROUND_CANDIDATES.md` (`maskWorker.ts` delete, tsc 12 → 5).
