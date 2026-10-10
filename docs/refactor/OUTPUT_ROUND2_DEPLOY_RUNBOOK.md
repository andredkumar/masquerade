# Output Round 2 deploy + test runbook — the fail-closed apply guard, the mask-build fix, manifest filenames

🖥️ LOCAL · ☁️ SERVER · 🌐 BROWSER · 🅰 AWS. Input: `OUTPUT_ROUND2_REPORT.md` (2026-10-04). **One deploy, two code commits, already made locally:** `4f0c071` (mask build, server) and `3a410cf` (guard + client + manifest). Neither is flag-gated. Prod is `51289ae`.

## 0. Read first — what I checked, and the three things the report leaves open

**Verified independently of the report:** commit 1 is the single line at `videoProcessor.ts:2417` plus its test. Commit 2 touches only the files the sign-off allowed. The guard runs before anything is persisted on the canonical route and before dispatch on the legacy route, and it fails closed. Six test files re-run on a separate Linux copy of the tree, all green; `tsc` 12 in the same two files. The crafted `curl` bodies in §5 were built and counted against this tree: they land on 0 and on `total_px` at 1920 × 1080 and 1536 × 796.

**Taken from the report, not re-run:** the sandbox `curl` rows, the UI rows, the timings.

**Open, and settled here:**
1. **Mouse input stopped after a refused apply** (report finding 3). Real clicks did nothing until a reload; a scripted click worked. Unknown whether it is the app or the test browser. → **§1, before the deploy.**
2. **The "doesn't remove anything" toast has never been seen in the UI**, only by `curl`. → row U3.
3. **The cost gate has thin margin.** Your browser sends a 3840 × 2160 export; it measured 72 ms on the Mac, so roughly 0.35–0.45 s on prod against 500 ms. **Rule, agreed in advance:** judge `apply.validate ms` on the **median of three** Keep applies (row N1). Over 500 ms → **the deploy stays** (correctness does not depend on it) and the build-once follow-up opens. It is not a rollback trigger.

**What a refusal means for you as the user:** Apply answers with a red toast and nothing else happens. No "Processing Started" card, Apply stays clickable, the job is untouched.

## 1. Step 0 — the refused-apply click check, in your own Chrome, on the sandbox (🖥️ + 🌐, 5 min)

```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
scripts/sandbox/up.sh
```
Open the address it prints (the sandbox server, `http://localhost:5001`) in **Chrome**, not the Claude pane. Upload `../sandbox/clips/ge_venue/Kidney_copy.mp4`.

| do | expect |
|---|---|
| Draw from scratch → **Keep** → one rectangle → drag the rectangle completely off the image → **Apply** | red toast: "This mask removes the whole frame. Nothing would be left in the output." No status number, no JSON. No "Processing Started" card. |
| **without reloading:** click **Apply** again | the same toast again |
| click **Clear Mask**, draw a rectangle inside the image, **Apply** | "Processing Started", the job completes |

**Pass:** every real click responds. **Fail** (a click does nothing): stop, open DevTools → Console, screenshot it, send it to me, and do not deploy.

If two tries don't produce the refusal toast, skip this step and deploy; row U1 repeats it on prod. A stall, if real, costs the user a reload and nothing else.

Ctrl-C stops the sandbox server.

## 2. Pre-flight (🖥️ LOCAL)

```
cd /Users/akumar3/Desktop/Masquerade/masquerade-aws-latest
git status -sb
git log --oneline -3
git diff --name-only 51289ae..HEAD
```
Expected: `## main...origin/main [ahead 2]`; top two commits `3a410cf` then `4f0c071`; unstaged only `.DS_Store`; untracked `.idea/`, `scripts/sandbox/`, `scripts/automask_spike/dicoms.json`, and this runbook. **Stop if** the name list shows `storage.ts`, `pgStorage.ts`, `shared/schema.ts`, `migrations/`, `automask*.ts`, `frameExtractor.ts`, `outputTransform.ts`, `queryClient.ts`, `template-mask-spoke.tsx`, or `package.json`.

```
for t in maskBuildIdentity applyGuard frameManifestNames outputF2 outputTransform outputParity outcomeRounding automaskShape automaskOutcome automaskHold automask.endpoint automaskWorkerClient applyPaths saveProcessedImage imageBatchFrames frameAccess; do echo "== $t"; npx tsx server/services/__tests__/$t.test.ts 2>&1 | grep -E "^(ℹ|#) (pass|fail)"; done
npx tsc --noEmit | grep -c "error TS"
npm run build && ls dist/
```
Gate: every file `fail 0` (pass 1 · 5 · 3 · 3 · 5 · 1 · 2 · 6 · 4 · 2 · 13 · 5 · 8 · 11 · 6 · 8) · tsc = **12** · `dist/` shows `index.js`, `automaskWorker.js`, `public/`.

## 3. Snapshot + push (🅰 then 🖥️)

EBS snapshot `pre-output-round2 <today's date>`.

The two code commits exist. Add this runbook as a docs commit and push:
```
git add docs/refactor/OUTPUT_ROUND2_DEPLOY_RUNBOOK.md
git status -sb
git commit -m "docs: output round 2 deploy runbook"
git push origin main
git log origin/main --oneline -3
```
"Changes to be committed": **1 file**. Top three lines after the push: the runbook commit, `3a410cf`, `4f0c071`.

## 4. Deploy (☁️ SERVER)

```
ssh -i ~/.ssh/ultrasound-app-key.pem ubuntu@3.136.48.97
cd ~/template-masking-app
git fetch origin main && git reset --hard origin/main
git log --oneline -3
```
One per line:
```
npm install
npm run build
ls dist/
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 30 --nostream 2>/dev/null
```
🖥️ `curl -s https://masqueradeimage.com/ | grep -o "index-[A-Za-z0-9_-]*.js" | head -1` → a new hash. 🌐 **hard reload** (the toast and the Apply behaviour are in the browser bundle).

Live tail (☁️, second terminal):
```
pm2 logs masquerade --raw 2>/dev/null | grep -E '"stage":"apply\.(validate|refused|mask_build|done)"'
```

## 5. Test session — quiet box: no uploads in the minute before each apply

### 5.1 Backstop without the client (☁️) — the rows that matter

🌐 Upload the Kidney 1080p clip, wait for it to finish extracting, and copy the job id from the address bar (`/jobs/<id>/…`). **Do not apply anything on it yet.**

☁️ Build the three crafted bodies (one paste):
```
cd ~/template-masking-app
node --input-type=commonjs -e '
const sharp=require("sharp"),fs=require("fs");(async()=>{
const png=async(bg)=>"data:image/png;base64,"+(await sharp({create:{width:64,height:64,channels:4,background:bg}}).png().toBuffer()).toString("base64");
const os={size:"original",format:"jpg",includeMetadata:true,parallelThreads:8,batchSize:12,aspectRatioMode:"letterbox"};
const body=(u)=>JSON.stringify({maskData:{type:"freeform",coordinates:[],opacity:75,canvasDataUrl:u},outputSettings:os,samplingFps:null});
fs.writeFileSync("/tmp/r2_transparent.json",body(await png({r:0,g:0,b:0,alpha:0})));
fs.writeFileSync("/tmp/r2_red.json",body(await png({r:255,g:0,b:0,alpha:1})));
fs.writeFileSync("/tmp/r2_malformed.json",body("x"));
console.log("wrote 3 bodies");})()'
```
Then, with the job id pasted in:
```
J=PASTE_JOB_ID
B=https://masqueradeimage.com
curl -s $B/api/jobs/$J | md5sum
for m in transparent red malformed; do echo "== $m"; curl -s -w "\nHTTP %{http_code}\n" -X POST -H "Content-Type: application/json" --data @/tmp/r2_$m.json $B/api/jobs/$J/template-mask/apply; done
for m in transparent red malformed; do echo "== legacy $m"; curl -s -w "\nHTTP %{http_code}\n" -X POST -H "Content-Type: application/json" --data @/tmp/r2_$m.json $B/api/videos/$J/process; done
curl -s $B/api/jobs/$J | md5sum
ls spokes/template_mask/$J 2>/dev/null | wc -l
```

| # | Expect |
|---|---|
| **B1** canonical route | three `HTTP 422`. transparent and malformed: `{"success":false,"error":"This mask doesn't remove anything. …"}`. red: `"This mask removes the whole frame. …"`. |
| **B2** legacy route | the same three 422s, body `{"error":"…"}`. |
| **B3** nothing persisted | the two `md5sum` lines are **identical**; the `ls … wc -l` prints **0**. |
| **B4** log | the live tail shows six `apply.refused` lines: four `mask_blanks_nothing` (`masked_px` 0), two `mask_blanks_everything` (`masked_px` = `total_px` = 2073600), each with `w` 1920 `h` 1080. |

The legacy calls write three `[DEADROUTE-HIT]` lines with `ua=curl/…`. **Note the time.** They are yours and do not count against the 7B-1 "zero hits" evidence.

### 5.2 Through the browser (🌐)

| # | Do | Expect |
|---|---|---|
| **U1** | Same job → Draw from scratch → **Keep** → one rectangle → drag it completely off the image → **Apply**. Then click **Apply** again without reloading. | Red toast "This mask removes the whole frame…" both times, plain text. No "Processing Started" card. Apply stays clickable. Every click responds (finding 3). |
| **U2** | **Clear Mask** → **Keep** → one rectangle inside the image → **Apply** | "Processing Started", job completes, output is the rectangle centred on black. Tail: one `apply.validate` (`dims_source` `frame0`), no `apply.refused`. |
| **U3** | New upload of the same clip → **Keep** → a rectangle dragged over the whole frame → **Apply**. Then **Remove** → the same → **Apply**. | Either a refusal toast or a normal apply. **Record `masked_px` for both.** A hand-drawn "whole frame" usually leaves an edge strip, so a normal apply here is correct. If Keep lands on exactly 0, this is the first sighting of the "doesn't remove anything" toast. |

### 5.3 Normal applies and cost (🌐, tail running)

| # | Do | Expect |
|---|---|---|
| **N1** (the gate) | Kidney 1080p → **Keep** → one rectangle → **Apply, three times back to back** | Each: one `apply.validate`, no `apply.refused`. **Median `ms` ≤ 500** (est. 0.3–0.45 s). `apply.mask_build` ≈ 0.3 s (was ~1.8 s). `apply.done` lower than before by about the same 1.5 s. |
| N2 | Same job → **Remove** → one small rectangle → Apply | Proceeds. `apply.validate ms` about the same as `apply.mask_build` (the backstop's price, est. ~0.25 s). |
| N3 | Reference clip (`Normal Lung sliding`) → Accept the cone → Apply | Fan centred. One `apply.validate` `frame0`. One `automask.outcome` line. `apply.done` within the box's usual 8.5–11 s spread, or a little under. |
| N4 | GE E9 `.dcm` → Accept → Apply | Trapezoid centred on black. `dims_source` `frame0`. |
| N5 | A small image batch → draw → Apply | Proceeds. `dims_source` **`image0`**. |

### 5.4 Manifest (🖥️, after downloading)

🌐 Download N3's ZIP from the template-mask spoke. 🖥️ with the ZIP's path pasted in:
```
Z=~/Downloads/PASTE_ZIP_NAME.zip
python3 - "$Z" <<'EOF'
import sys, json, zipfile, csv, io
z = zipfile.ZipFile(sys.argv[1]); names = set(z.namelist())
m = json.loads(z.read('manifest.json'))
fn = [f['filename'] for f in m['frames']]
rows = list(csv.DictReader(io.StringIO(z.read('metadata.csv').decode())))
print('version:', m.get('masquerade_version'), '| images_included:', m.get('images_included', 'n/a (whole-job ZIP)'))
print('frames:', len(fn), '| first:', fn[0], '| last:', fn[-1])
print('manifest names missing from the ZIP:', sum(n not in names for n in fn))
print('csv filename column == manifest:', [r['filename'] for r in rows] == fn)
print('images/ entries in the ZIP:', sum(n.startswith('images/') and not n.endswith('/') for n in names))
EOF
```

| # | ZIP | Expect |
|---|---|---|
| **M1** | whole-job (N3) | `version: 1.1` · first `images/frame_000000.jpg` · missing **0** · csv == manifest **True** · `images/` entries = frames |
| M2 | AI run on that job, **with** "Include base frames" (only if the GPU box is up) | `version: 1.1` · `images_included: True` · missing **0** · csv **True** |
| M3 | the same run **without** base frames | the same names as M2 · `images_included: False` · missing = frames (correct: the names say where the files would be) · `images/` entries **0** |
| M4 | an AI run made on **raw** frames, with base frames | names end **`.png`** · missing **0** |

M2–M4 need the MedSAM2 server. If it is down, run M1 only and tell me; the sandbox covered the run ZIPs with synthetic runs.

## 6. Collect (☁️)

```
pm2 logs masquerade --raw --lines 50000 --nostream 2>/dev/null | grep -E '"stage":"apply\.(validate|refused|mask_build|done)"' | tail -80
pm2 logs masquerade --raw --lines 50000 --nostream 2>/dev/null | grep '"stage":"apply.mask_build"' | grep '"masked_px":0,'
pm2 logs masquerade --raw --lines 50000 --nostream 2>/dev/null | grep 'DEADROUTE-HIT' | tail -6
```
Send me: all three outputs, the §5.1 terminal output, the §5.4 lines, and the U3 `masked_px` pair.

**The second command must add nothing after this deploy.** A new line there is an apply that reached the mask build blanking 0 px, which means it got past the guard. That is the de-identification alarm for this round.

## 7. Rollback

| what you see | do |
|---|---|
| **A correct mask is refused**, or a refusal leaves the page unusable beyond a reload | ☁️ `git revert --no-edit 3a410cf && npm run build && pm2 restart masquerade --update-env`, then 🌐 hard reload. Back to the pre-round behaviour: no guard, old manifest names. |
| **Output frames are masked wrongly** (the mask shape itself changed) | also ☁️ `git revert --no-edit 4f0c071`, rebuild, restart. The two reverts are independent. |
| A crafted bad mask is **accepted** (a B row fails) | **don't roll back.** Nothing is worse than before the deploy. Send me §6. |
| `apply.validate` median over 500 ms | **don't roll back** (§0 rule). |

After any server-side revert, run the same `git revert` 🖥️ locally and `git push origin main`, so the next deploy's `reset --hard` does not undo it.

## 8. Close-out

One follow-up commit to `CLAUDE.md`: "Output Round 2 DEPLOYED <date>, `4f0c071` + `3a410cf`", the snapshot name, the N1 three `apply.validate ms` and the `apply.mask_build` / `apply.done` before and after, the B rows, the U3 `masked_px` pair, and the §6 audit result. Then refresh the project's `repo/CLAUDE.md` snapshot.

**Queue after this round:**
1. **UI simplification**, in its own conversation, starting from the control inventory. Add to it: Keep mode with nothing left on the canvas still shows Apply (the U1 path).
2. **Run download falls back to raw frames** for a run made on masked frames when the masked folder is empty (`routes.ts`, the base-frame listing). Older than this round and narrow (raw frames sweep at 6 h, masked at 24 h), but it is the same fail-open class. Small round: a masked-input run ships masked frames or none.
3. Build the mask once and hand it to the apply, **only if** N1 missed the gate or the extra ~0.25 s on Remove is noticeable.
4. 7B-1 (delete the legacy route), on the `[DEADROUTE-HIT]` evidence minus today's three `curl` hits.
5. Auto-mask 2C; dead code (`processBatchesInParallel`, `maskWorker.ts`, `createTransformedMask`, `convertToRgbaBuffer`).
