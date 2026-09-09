# Auto-mask Round 2B — recon (§2 answers) + proposal for 2B-1 / 2B-2

**Status:** recon complete 2026-09-07, **awaiting Andre's sign-off. No production code was written.** Against `main` @ `a98a03c` (item 5 + Round 2A). Kickoff: `AUTOMASK_ROUND2B_KICKOFF.md`; requirements B1–B7 verbatim in `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md` §B (not restated here — the proposal cites them by number). Every `file:line` below was read on this SHA.

## 0. What recon changed about the kickoff's assumptions

| kickoff assumption | what the code says | consequence |
|---|---|---|
| "`maskWorker.ts` already exists … the worker build path is not new — reuse that mechanism" | `server/services/maskWorker.ts` is **dead code with no build path**: nothing imports it (`grep -rn maskWorker server client` → only the file itself), the build is a single esbuild entry (`package.json:8` → `dist/index.js`, nothing else in `dist/` besides `public/`), and its own spawn is the self-file pattern `new Worker(fileURLToPath(import.meta.url))` (`maskWorker.ts:35`) — under the bundle that URL is `dist/index.js`, so the worker thread would boot the entire server (routes, DB probe, cleanup cron) a second time. | There is no working worker path to reuse. 2B-1 adds a **dedicated worker entry + a second esbuild entry** (verified: bundles standalone to 52 KB with no sharp/express), and a 3-line `tsx` bootstrap for `npm run dev` / the sandbox (verified — the obvious `execArgv: ['--import','tsx']` does **not** work in worker threads; §1.1). `maskWorker.ts` is neither imported nor edited, so its 7 parked errors stay exactly as they are (tsc = 12). |
| "prove evenodd or fall back to raster" | **Proven on fabric 5.3.0** — the version the app actually loads from the CDN (`client/index.html:20`; `package.json`'s `fabric ^6.7.1` is not what `MaskingCanvas` uses). `fillRule:'evenodd'` survives `fabric.util.object.clone` and rasterisation via `toDataURL`; hole pixels are black. The first reading was a false negative caused by fabric's default retina scaling (§1.4). | The Accept → mask conversion is a single `fabric.Path` through the **unchanged** export path; no raster fallback needed (the fallback is still written down in §1.4 in case a browser disagrees). |
| D5: "Andre draws/corrects, Apply" | Ran with a **labelled surrogate**: the applied mask for each clip is Andre's frozen reference shape from `reviews_freeze.json` (his bench corrections), pushed through the real upload → proposal → `POST …/template-mask/apply` path. | **4/7 tolerant, the same four rows as the bench** (§1.7). The apply path adds nothing and loses nothing; the pre-UI number *is* the bench number. Live drawing is a re-run of one command if wanted. |
| T0 box "at extraction time" | The naturalised DICOM dataset is already in memory at **upload** time (`frameExtractor.ts:50`, `extractVideoMetadata`, called from the upload handler at `routes.ts:178`) — earlier than extraction, and before the upload can be purged. | Capture there (one added read of `SequenceOfUltrasoundRegions`), persist `temp_extracted/<jobId>/t0.json` from the upload handler; the 6 h sweep deletes job dirs whole, so it goes with the frames (§1.3). |

Everything else in the kickoff holds: ready hook at `videoProcessor.ts:1561`, canvas at native pixels with zoom as a CSS transform, one telemetry sink (server `[PERF]`), two deploys.

## 1. Recon — §2 questions 1–7

### 1.1 Q1 — Worker

**How `maskWorker.ts` is built and spawned.** It isn't. Facts:

- `package.json:8` — `build: vite build && esbuild server/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist`. One entry, one output (`dist/index.js`). `dev` (`:7`) is `NODE_ENV=development tsx server/index.ts`; the sandbox's `scripts/sandbox/up.sh:84` runs that same `npm run dev`. Prod `start` (`:9`) is `node dist/index.js`. No `ecosystem.config.*` in the repo (pm2 is driven from the box).
- `maskWorker.ts:1-6` imports `worker_threads`, `sharp`, `@shared/schema`, `os.cpus`; `:22` `class MaskWorkerPool` with a task queue + `busyWorkers` set; `:29` pool size `min(cpus(), 8)`; **`:35` `new Worker(fileURLToPath(import.meta.url))`** — the self-file entry; `:98-112` the `if (!isMainThread)` message loop (`parentPort.on('message', task → processFrameWithMask → postMessage)`); errors come back as `{success:false, error}` messages (`:104-110`) plus `worker.on('error')` (`:48`). No timeout anywhere. `workerData` is unused.
- Its 7 parked tsc errors (the "12" invariant): `maskWorker.ts(164,13)`, `(174,13)` — `coordinates` union used as an array; `(185,48)`, `(186,24)`, `(186,51)` — `.length` / index on the same union; `(207,16)`, `(209,91)` — `feather` not on `MaskData`. All in `processFrameWithMask`, i.e. in the *mask-application* code, none in the spawn/pool code. **2B does not import, move or edit this file**, so none of them can be "fixed" by accident; `npx tsc --noEmit` today = 12 (5 `frameExtractor.ts` + these 7).

**Can `propose()` ride the same entry with a message type?** No — there is no entry. A self-file worker would re-run `server/index.ts` (in dev) or the whole `dist/index.js` bundle (in prod) inside the thread: the DB probe, the cleanup scheduler, `server.listen` (`index.ts:169`) → `EADDRINUSE` or worse. Guarding all of that behind `isMainThread` would touch boot code that 2B has no business touching. So: **its own file, its own build entry**, and the *pattern* worth keeping from `maskWorker.ts` is the queue-of-promises shape (`:56-89`), not the file.

**Two spikes run this session (results, not plans):**

| spike | command | result |
|---|---|---|
| standalone bundle | `esbuild <worker.ts importing shared/automask/core> --platform=node --packages=external --bundle --format=esm` | `52,633 bytes`, **0** references to `sharp` or `express` — the worker pulls in only `shared/automask/*`. A second `esbuild` invocation in the build script (`… server/workers/automaskWorker.ts … --outdir=dist`) yields `dist/automaskWorker.js` next to `dist/index.js`, resolvable as `new URL('./automaskWorker.js', import.meta.url)` from the bundle regardless of pm2's cwd. |
| dev (`tsx`, Node v25.6.1, tsx 4.19.2) — `new Worker(new URL('./worker.ts', …), { execArgv: process.execArgv })` | ✗ `Cannot find module …/shared/automask/constants` — Node's native type-stripping loads the `.ts` but does not resolve the extensionless imports `shared/automask/*.ts` use (22 of them; `from './constants'` etc.). |
| dev — `execArgv: ['--import','tsx']` and `['--import','tsx/esm']` | ✗ same error. tsx's loader does not attach to worker threads via `execArgv`. |
| dev — **`worker.boot.mjs`**: `import { register } from 'tsx/esm/api'; register(); await import('./automaskWorker.ts')` | ✅ `fan_sym conf 0.9826`, `152 ms` in-worker on the synthetic fan fixture, `238 ms` round trip including thread start. |

So the worker client resolves its entry as: `import.meta.url` ends in `.ts` (tsx / tests) → `./automaskWorker.boot.mjs`; otherwise → `./automaskWorker.js` beside the bundle. No `NODE_ENV` sniffing.

**Pooling.** One long-lived worker, spawned lazily on the first task, FIFO queue. Prod is one physical core (`t3.large`); a pool would compete with the main thread and ffmpeg for the same core and buy nothing — the point is to get the ~1.5 s off the event loop, not to parallelise. Errors/timeouts: per-task timeout 20 s (13× the cold prod number); on timeout or `error`/`exit`, the task rejects (`detail: 'worker_timeout' | 'worker_crash'`), the worker is terminated and the next task respawns it. The service maps a rejection to today's `{status:'none', reason:'error'}` body, which 2A never caches, so the next GET simply tries again (§2.6).

**What crosses the thread boundary.** The service keeps decoding on the main side (`sharp` is libvips, already off-thread; measured 4–11 ms on the M4, ~50–80 ms expected on prod) and posts `{ jobId, w, h, gray: ArrayBuffer (transferred, w×h bytes — 2 MB at 1080p), bound: Bound | null }`; the worker returns `ProposeResult` **minus the `keep` grid** — `compute()` (`automask.ts:146-207`) reads `shape, paramsSmall, model, conf, withheld, flag, info, ms` and never `res.keep` (verified: 0 references), so the 2 MB mask never crosses back. Keeping `sharp` out of the worker keeps the bundle at 52 KB and avoids two libvips instances.

### 1.2 Q2 — `ready` hook

- **The single exit.** `startBackgroundFrameExtraction` (`videoProcessor.ts:1363`) has two branches (DICOM 15-frame batch loop vs ffmpeg single pass) that **converge** on one tail: the parity block ends at `:1550`; `endBgExtract({… path: isDicom ? 'dicom-batch' : 'ffmpeg-single-pass', outcome:'ok'})` at `:1552-1559` is the `bg_extract.done` span close; **`:1561` `await storage.updateVideoJob(jobId, { status: 'ready' })`**; `:1562-1568` `updateProgress(jobId, { stage:'ready', … })`, which emits the socket event via `this.io.to(jobId).emit('progress', …)` at `:1350`. The error path is the `catch` at `:1570-1578` (`status: 'error'`).
- **Where to enqueue.** Immediately after `:1568`, i.e. **after** the `ready` write and the emit: one fire-and-forget line `void enqueueProposalAtReady(jobId)` whose promise cannot reject (the helper catches everything and logs `automask.skipped {reason:'error', trigger:'ready'}`). (a) `ready` is not delayed by a millisecond — the proposal starts after the client has already been told; (b) A3 untouched — no status value, no column, no schema; the status machine never learns the proposal exists; (c) both extraction paths pass through `:1561`, so both hit it. Not before `:1561`: the kickoff's alternative ("written before the job is marked ready-complete") would put ~1.5 s of prod compute between `bg_extract.done` and `ready` and would make the ready write conditional on the proposer — the exact coupling A3 forbids. `automask.json` therefore lands *shortly after* `ready`; a spoke opened in that window gets `{status:'pending'}` and polls (§3.1) — the same shape as the frames/0 503 poll it already has.
- **Image batches** never reach this function: they are `ready` at upload — `routes.ts:410` (`createVideoJob … status:'ready'`) and `:437` (`createJobV2 … status:'ready'`). Same helper, called from the image upload handler after `res.json(...)`. Their frame 0 is `uploads/<fileList[0]>` (item 28), so computing at upload is also what keeps them ahead of the 2 h `uploads/` sweep.
- **Dedupe** is already there: `getOrComputeProposal` keeps an in-flight `pending` map (`automask.ts:139-143`); a GET arriving mid-compute joins the promise instead of starting a second proposal. The ready trigger uses the same entry point with `trigger:'ready'`.

### 1.3 Q3 — T0 capture

- **Where `naturalizeDataset` runs.** `frameExtractor.ts:41` `extractVideoMetadata(videoPath)` → `:43` `isDicomFile` → `:48` `readFile` → `:49` `DicomMessage.readFile` → **`:50` `naturalizeDataset(dataSet.dict)`** → `:53` `detectDicomFrameCount(dataset)` → `:56-71` returns `{duration, width: dataset.Columns, height: dataset.Rows, frameRate:1, totalFrames, isDicom:true, dicomMetadata:{…}}`. Item 5 touched this function (RGB fix). The per-frame path (`extractDicomFrame`, `:372-376`) re-parses the file per frame — the wrong place (N parses, and it runs *after* the upload could be purged).
- **Is reading the sequence there read-only?** Yes. `dataset.SequenceOfUltrasoundRegions` is a property of an object already built at `:50`; adding `ultrasoundBound?: Bound | null` to the returned `VideoMetadata` (a TS interface, `frameExtractor.ts` top) changes no DB column — the upload handler copies only five scalars from `quickMetadata` into the job (`routes.ts:191-195`, `:214-218`, `:233-236`). The parse itself is the same call 2A's `readDicomBound` (`automask.ts:76-88`) makes on the upload later — 2B moves that read to the moment the file is guaranteed to exist and reuses `readDicomBound`'s region → box arithmetic (extract it into a pure `boundFromDataset(dataset, w, h)` so the two call sites share one function).
- **Where it is called from.** `routes.ts:178` `const quickMetadata = await frameExtractor.extractVideoMetadata(req.file.path)` in the video/DICOM upload handler — before `createVideoJob`/`createJobV2` (`:186-220`) and before `startBackgroundFrameExtraction(job.id, dicomFilePath, quickMetadata.totalFrames, true)` at `:248`.
- **Where to persist.** `temp_extracted/<jobId>/t0.json` — `{ version:1, bound: Bound|null, bound_source: 'dicom'|'not_dicom'|'unavailable', w, h, createdAt }`, written by the upload handler right after `createJobV2`, `mkdir -p` first (harmless ahead of extraction's own recursive mkdir; the `_apply/` staging is a sibling and untouched). Why not the job record: A3 frozen, no free-form column. Why not inside `automask.json`: that file is the proposal cache and is deleted to force a re-proposal (`automask.ts:6`); T0 must outlive that. Why not the upload: it is exactly the file that vanishes.
- **Sweep and guards.** `SWEEP_TARGETS` (`cleanup.ts:65-67`) sweeps the immediate children of `temp_extracted/` — the job directories — at `TEMP_EXTRACTED_MAX_AGE_MS` = 6 h (`:55`); SIGTERM runs the same with `maxAgeMs=0` (`:29`). A whole job dir goes at once, so `t0.json` and `automask.json` leave with the frames; nothing new for cleanup. The 2B-1 reuse guard counts raw frames via `listRawFrameFiles` → `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` (`frameAccess.ts:160-164`), which matches by image extension only (`png|jpg|jpeg`), so `.json` files are invisible to the count — already proven in the field: 2A's `automask.json` sat in every A-row job dir while apply reused the frames (`apply.source: reuse`).
- **Read order at compute time:** `t0.json` → (missing, pre-2B job) `readDicomBound(upload)` as today → (upload gone) `bound_source:'unavailable'`. `info.t0_from: 'file' | 'upload' | null` records which. The prod degradation (job `438a9d4f`, trapezoid → rectangle) can then only recur for jobs uploaded before 2B-1.

### 1.4 Q4 — Spoke data flow, mask contract, evenodd proof

**Frame 0 and mount.** `template-mask-spoke.tsx:63-108` `fetchFirstFrame`: `GET /api/jobs/${jobId}/frames/0` (`:68`) → blob URL → `frameStatus 'ready'`; 503 → `'extracting'` + `framesReady` (`:74-84`), polled; 404 → `'not_found'`; 410 → `'gone'` with `reason` (`:88-100`). Re-fetch when `job.status` flips to `ready` (`:112-116`). `MaskingCanvas` mounts at `:336-343` as soon as `frameStatus !== 'loading'` with `firstFrame`, `selectedTool`, `onMaskUpdate={handleMaskUpdate}` (`:186` → spoke state `maskData`), `zoom={canvasZoom}` (state, default **75**, `:37`), `maskData`. `ProcessingControls` renders only when `maskData && jobId` (`:306-320`) with `disabled={!jobId || !maskData || !canApply}` (`:314`), `canApply = job?.status === 'ready'` (`:172`) — so **a mask in state + `ready` = Apply enabled**; that is the whole hand-off Accept needs.

**The mask contract on Apply.** `ProcessingControls.tsx:94-98` posts `{ maskData, outputSettings, samplingFps }` to `POST /api/jobs/:jobId/template-mask/apply`. `maskData` comes from `MaskingCanvas.updateMaskFromCanvas` (`:845-1130`): `objects = canvas.getObjects().filter(type !== 'image')` (`:848`); temp `<canvas>` at `canvas.width × canvas.height`, black fill (`:909-916`); `new fabric.Canvas(tempCanvas, {width, height})` (`:917`); every object cloned with **`fabric.util.object.clone(obj)`** (`:924`) and recoloured red (`:931-944`); `renderAll`; **`tempCanvas.toDataURL('image/png')`** (`:952`) → `canvasDataUrl`; then a per-type switch (`rect` `:971` → `type:'rectangle'`, `circle` `:1005`, `polygon` `:1043`, **`path` `:1077` → `type:'freeform'`**, `default` `:1106`) fills the rest of `MaskData` (`shared/schema.ts:174-`: `originalCanvasDimensions`, `displayDimensions`, `devicePixelRatio`, …). Server side (`videoProcessor.ts:76-77`, `:136-137`, `:187-192`): canvas dims from `originalCanvasDimensions`, scale = frame / canvas, PNG decoded from the data URL; **red > 128 = blanked** (what `run.ts --db` also assumes). So a `fabric.Path` on the canvas is already a first-class mask object — the brush tool is one.

**Evenodd proof (fabric 5.3.0, the app's CDN build, Chromium in the in-app browser; page kept at `sandbox/bench/_2b/evenodd.html`, served by `bench.py --serve`, result in `window.__result`).**

| check | result |
|---|---|
| `fabric.version` | `5.3.0` |
| `fabric.Object.prototype._renderFill` (read from the loaded library) | `… "evenodd"===this.fillRule ? t.fill("evenodd") : t.fill() …` — fill rule honoured at paint time |
| `fabric.util.object.clone(path).fillRule` | `'evenodd'` (also in `cacheProperties` and `stateProperties`, so a cached render invalidates on change) |
| clone → fresh `fabric.Canvas` over a black temp canvas → `renderAll` → `toDataURL` → decode: pixel **inside** the inner subpath (200,200) | `0,0,0,255` (black — not blanked) |
| same export, pixel **outside** (20,20) | `255,0,0,255` (red — blanked) |
| pixel just inside the hole's left edge (143,200) | `0,0,0,255` |
| `toObject()` → `fabric.Path.fromObject()` → render | `fillRule 'evenodd'`, same pixels |
| control: Canvas2D `ctx.fill(path2d, 'evenodd')`, same geometry | identical pixels |

The path was `M0 0 H400 V300 H0 Z M200 40 L120 260 Q200 290 280 260 Z` — the frame rectangle plus one inner subpath — which is precisely the Accept object's shape (§3.4). **Caveat worth recording:** the first pass read red *inside* the hole. fabric's default `enableRetinaScaling: true` had made the backing store 800×600 on this dpr-2 display, so a `getImageData(200,200)` sampled the point (100,100) — outside the wedge. Repeating with `enableRetinaScaling:false` (and, separately, sampling at dpr-scaled coordinates) gave the table above. **This is not only a test artefact:** the app's export canvas at `MaskingCanvas.tsx:917` does not set `enableRetinaScaling:false`, so on a Retina display today's `canvasDataUrl` is a 2× PNG (3072×1592 for the 1536×796 reference clip) while `originalCanvasDimensions` says 1536×796. The server's `frameWidth / canvasWidth` scaling (`videoProcessor.ts:136`) evidently copes (the item 5 UI run on this Mac drew and applied correctly) but the payload is 4× larger than it needs to be. 2B-2 does not touch the export path (`buildApplyMask`/apply untouched); this goes to the backlog (§6) and to the 2B-2 test matrix as an explicit "draw on a Retina display" row.

**Raster fallback (not needed; kept for completeness).** Render the keep complement with Canvas2D `fill('evenodd')` at frame size → `fabric.Image` via the existing `externalMaskData` hook (`MaskingCanvas.tsx:259-282`, `_aiOverlay` tag). Its cost: `updateMaskFromCanvas` **excludes** `type === 'image'` at `:848`, so an image layer would never reach the exported mask — the fallback would need its own export branch. That is why the Path form is the design.

### 1.5 Q5 — Coordinate space

The 75 % is display only. The `<canvas>` is resized to the frame's natural dimensions (`MaskingCanvas.tsx:235` `canvas.setDimensions({width: img.width, height: img.height})`, image at `scaleX:1, scaleY:1, left:0, top:0`, `:241-248`) — "DIRECT PIXEL MAPPING" in the code's own words — and zoom is a **CSS transform on the container**: `` transform: `scale(${zoom / 100}) translate(${panOffset.x}px, ${panOffset.y}px)` `` (`:1276-1279`), `zoom` from the spoke (`useState(75)`, `:37`; ±25 steps). Nothing is scaled in canvas space, so **a proposal in full-resolution frame pixels is drawn as-is** — no factor to find or store. The `displayDimensions`/`devicePixelRatio` fields in `MaskData` are diagnostics; the server uses `originalCanvasDimensions` (= frame size) only.

### 1.6 Q6 — Telemetry sink

- Client today: **PostHog only**, two captures — `ProcessingControls.tsx:133` `mask_processing_started` and `ProcessingStatus.tsx:125` `frames_downloaded`. `initPostHog` (`client/src/lib/posthog.ts:10`) **returns without initialising on `localhost`/`127.0.0.1` or `VITE_POSTHOG_DISABLED=1`**, so every sandbox session — where the thresholds get tuned — would record nothing. No client-side `[PERF]` exists.
- Server: `perfMark(jobId, stage, extra)` (`perf.ts:14`) → `[PERF] {t, jobId, stage, …}`; `perfSpan` (`:18`) for durations. The eval already consumes these lines (`run.ts --log`), and every number in this project's reports came from `pm2 logs masquerade --raw | grep '\[PERF\]'`.
- **Decision: one sink, the server.** `automask.outcome` is a `[PERF]` line emitted by a small flag-gated `POST /api/jobs/:jobId/template-mask/proposal/outcome` that the spoke calls on Apply / Draw-from-scratch (§3.5). Not PostHog: it is off in the sandbox, it is not in the eval loop, and the payload (shape parameters, deltas) belongs next to `automask.done` where `run.ts` can join them by `jobId`.

### 1.7 Q7 — D5, the applied-mask eval (sandbox, `AUTOMASK=1`)

**Method.** Sandbox on this Mac (`scripts/sandbox/up.sh`, Postgres 5433, server 5001, `AUTOMASK=1`). The seven kickoff clips uploaded through the real endpoints (`POST /api/uploads/video` ×6 incl. the two GE E9 `.dcm`, `POST /api/uploads/images` for the still); proposal computed by the 2A server at first `GET …/proposal`; then the **applied mask** — Andre's frozen reference shape (`sandbox/bench/reviews_freeze.json` `shape_user`, rendered by `bench.py shape_full_mask` with `MARGIN_PX 0`, red = blanked, at frame size) — posted through the real `POST …/template-mask/apply` with default output settings; all seven reached `templateMask.status = 'complete'`; then `npx tsx scripts/automask_eval/run.ts --db … --server http://localhost:5001 --manifest ../sandbox/manifest.csv --log <server log>` scored each proposal against `mask_data.canvasDataUrl`. Results: `sandbox/results/2026-09-07_d5_applied_masks.md` (+ `.json`). **Labelled surrogate:** Andre did not draw in this run; the reference shapes are his bench corrections, so this is the bench passed through the production path. If he wants to draw live, the sandbox is the same `up.sh`, and the same `run.ts` line re-scores.

| clip | model / tier | conf | IoU | leak₆ | over₆ | tolerant | grade | ms_propose (M4) | bench IoU (frozen refs) | Andre's verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| Normal_Lung_sliding | fan_sym / T1 | 0.86 | 0.9904 | 0.0000 | 0.0000 | ✅ | check_depth | 188 | 1.0000 | right |
| kidney_copy (1920×1080) | fan_sym / T1 | 0.99 | 0.9835 | 0.0000 | 0.0000 | ✅ | check_depth | 230 | 1.0000 | right |
| bfly_z2b | fan_sym / T1 | 0.93 | 0.8648 | 0.0168 | 0.1115 | ✗ | proposed | 116 | 0.8651 | right (ref carries Δ: half −5°, apex 45 px, depth 124 px) |
| sector_unknown_vendor | fan_sym / T1 | 0.98 | 0.8937 | 0.0330 | 0.0729 | ✗ | proposed | 150 | 0.8946 | wrong |
| ge_e9_2124113685 (.dcm) | trap_sym / **T0T1** | 0.87 | 0.9006 | 0.0000 | 0.0828 | ✅ | proposed | 138 | 0.9106 | adjusted |
| ge_e9_4351124429 (.dcm) | trap_sym / **T0T1** | 0.76 | 0.8919 | 0.0017 | 0.0942 | ✗ | proposed | 119 | 0.8929 | adjusted |
| bfly_frame_000092 (image batch) | fan_sym / T1 | 0.87 | 0.9442 | 0.0049 | 0.0345 | ✅ | proposed | 89 | 0.9412 | adjusted |

**Tolerant 4/7 — the same four rows as the bench.** The residual differences (≤ 0.017 IoU) are the margin convention: the bench erodes both proposal and reference by `MARGIN_PX` (2 px), the applied mask is un-eroded, so the two "right" verdicts score 0.98–0.99 instead of 1.00. `leak₆` = proposal keeps what the reference blanks, after a 6 px core erosion. Both GE jobs proposed with the DICOM box (`bound_source: dicom`, T0T1) because the sandbox does not purge `uploads/` between upload and first GET — the case 2B-1 makes permanent. The raw eval output also lists 12 older sandbox jobs whose frames were swept (`pending`/`no_frame`); they are excluded above and marked in the saved file.

**Timing at sandbox shape (`[PERF] automask.done`):** `ms_propose` 89–230 ms, `ms_decode` 4–11 ms on the M4. Prod measured 1463 ms cold (1080p) / 701 ms warm (1164×873) — a ×6–7 gap, which is the whole case for the worker.

## 2. Proposal — 2B-1: server only (flag `AUTOMASK`, already on)

### 2.1 Files

| file | change |
|---|---|
| `server/workers/automaskWorker.ts` (new) | Worker entry: `parentPort.on('message')` → `propose(grid(w,h,gray), {bound})` → `postMessage({ ok:true, result })` (result without `keep`) or `{ ok:false, error }`. Imports only `shared/automask/*` and `worker_threads`. |
| `server/workers/automaskWorker.boot.mjs` (new, 3 lines) | Dev/test bootstrap: `tsx/esm/api` `register()` then `import('./automaskWorker.ts')` (§1.1 spike). |
| `server/services/automaskWorkerClient.ts` (new) | `proposeInWorker(gray, w, h, bound, {timeoutMs})`: lazy spawn, FIFO queue, 20 s timeout, terminate + respawn on failure, entry resolution by `import.meta.url` extension. Injectable through `AutomaskDeps` so the endpoint tests keep their mocks. |
| `server/services/automask.ts` | `compute()` calls the client instead of `propose()`; `getOrComputeProposal(jobId, deps, {trigger})`; `enqueueProposalAtReady(jobId)`; `t0.json` read before `readDicomBound`; PERF fields (§2.5). `GRADE_THRESHOLDS`, contract v2, cache rules unchanged. |
| `server/services/frameExtractor.ts` | `:50` region: add `ultrasoundBound: boundFromDataset(dataset, Columns, Rows)` to the returned metadata (read-only; the sanctioned T0 addition). `boundFromDataset` extracted from `readDicomBound`. |
| `server/routes.ts` | Video/DICOM upload handler: write `t0.json` after `createJobV2` (~`:220`). Image upload handler: `enqueueProposalAtReady(job.id)` after `res.json` (~`:445`). |
| `server/services/videoProcessor.ts` | One line after `:1568`: `void enqueueProposalAtReady(jobId)`. Nothing else in the file. |
| `package.json` | `build`: append `&& esbuild server/workers/automaskWorker.ts --platform=node --packages=external --bundle --format=esm --outdir=dist`. |
| tests | `automask.endpoint.test.ts` gains: trigger `ready` computes once / GET serves `cached:true`; `pending` while extracting; worker rejection → `none/error` uncached; two enqueues → one compute (in-flight map). New `automaskWorkerClient.test.ts`: real worker round trip on the synthetic fan fixture (result equals in-thread `propose` — same shape, same conf), timeout path with a fault-injected entry, respawn after crash. `automask.fixture.test.ts` unchanged (the core is untouched). |

### 2.2 Worker plumbing

As §1.1: one worker, lazy, FIFO, transfer the gray buffer, 20 s timeout, terminate + respawn. Main-thread work per proposal: `sharp` decode (libvips thread), one `postMessage`, one JSON write. Expected event-loop stall < 50 ms per proposal on prod (to be measured, §2.8).

### 2.3 Enqueue at `ready`

`enqueueProposalAtReady(jobId)` = `getOrComputeProposal(jobId, undefined, {trigger:'ready'})` with a `catch` that logs and never throws. Call sites: `videoProcessor.ts` after `:1568` (MP4 + DICOM), image upload handler after the response. A GET during compute joins the in-flight promise (existing map); a GET after finds the cache (`cached:true`, `trigger` recorded in the cached body as `computed_by`).

### 2.4 T0

`t0.json` per §1.3; `boundFromDataset` shared by `frameExtractor.ts:50` and `readDicomBound`; read order `t0.json` → upload → `unavailable`; `info.t0_from`. Contract vocabulary for `bound_source` unchanged.

### 2.5 `[PERF]` lines

`automask.start / done / skipped` gain `trigger: 'ready' | 'lazy'`, `worker_ms` (in-worker propose time), `queue_ms` (time waiting behind another job); `ms_propose` becomes the round trip (queue + transfer + worker), so `ms_propose − worker_ms − queue_ms` is the thread-hop overhead. New `automask.t0_captured {bound_source, w, h}` at upload. Contract `ms.propose` keeps its meaning (round trip); `ms.worker` is added.

### 2.6 Fallback rules

- No cache at GET (pre-2B job, or the ready trigger failed) → lazy compute in the worker, `trigger:'lazy'` — today's behaviour, just off-thread.
- Frame not yet on disk → `{status:'pending'}` (uncached); the spoke polls.
- Worker timeout/crash → `{status:'none', reason:'error', error:'worker_timeout'|'worker_crash'}` (uncached, as every error is in 2A); the next GET retries once more through a fresh worker. Only user GETs retry, so there is no loop.
- Flag off → `{status:'none', reason:'disabled'}` before any disk access, and `enqueueProposalAtReady` is a no-op (checked first, so extraction never pays for a disabled feature).

### 2.7 Test matrix (runbook rows; sandbox unless marked prod)

| row | expectation |
|---|---|
| MP4 upload | `automask.done trigger:'ready'` within ~2 s of `bg_extract.done`; first GET `cached:true`; body identical to a 2A lazy result on the same frame (compare against `sandbox/results/2026-09-06_2a_eval1.json`) |
| DICOM single-frame | as above with `bound_source:'dicom'`, `info.t0_from:'file'`, `automask.t0_captured` logged at upload |
| DICOM multiframe, GET during extraction | `pending` while extracting; after `ready` one `done` line; GET → `cached:true`; no second compute |
| image batch | `done trigger:'ready'` right after upload; frame label `uploads/<hash>` |
| restart between upload and open → still T0T1 | prod shape: `pm2 restart` (purges `uploads/`, keeps `temp_extracted/`). Sandbox equivalent: after `ready`, delete `uploads/<hash>` and `automask.json` by hand (SIGTERM would sweep everything in the sandbox — `cleanup.ts:29`), GET → recompute → `tier:'T0T1'`, `bound_source:'dicom'`, `t0_from:'file'` |
| worker crash → lazy fallback → `none/error` | fault-injected entry (test-only env var read by the client, never by the worker); PERF `skipped {reason:'error', detail:'worker_crash'}`; next GET succeeds after respawn |
| two jobs finishing at once | two uploads back-to-back; second `done` has `queue_ms > 0`; both cached; one worker thread throughout (`worker_spawned` logged once) |
| build | `npm run build` produces `dist/index.js` and `dist/automaskWorker.js`; `node dist/index.js` proposes through the bundle (not the boot file) |
| dev | `npm run dev` proposes through `automaskWorker.boot.mjs` |
| invariants | `npx tsc --noEmit` = 12 (same 12); both automask tests + the new client test green; A-rows A1–A16 from `ITEM5_DEPLOY_RUNBOOK.md`/2A report re-run unchanged (flag off → 2A behaviour; apply reuse unaffected by the extra `.json`) |

### 2.8 Measure at production shape

Baseline: `ms_propose` 1463 ms cold (1920×1080), 701 ms warm (1164×873), main thread. After deploy, on the reference clip and one 1080p clip: `worker_ms` should be ≈ those numbers (same CPU, same code); the new fact is the **main-thread stall**, measured as the max latency of a 20 Hz `curl GET /api/jobs/:id` loop running across the proposal — target < 50 ms, versus ≈ `ms_propose` today. Both numbers go in the 2B-1 report next to their frame sizes.

### 2.9 Revert

One commit, plain `git revert` (touches no schema, no status, no `buildApplyMask`/apply/reuse/extraction beyond the `:50` read). The orphaned `dist/automaskWorker.js` after a revert is inert.

## 3. Proposal — 2B-2: the spoke (flag `AUTOMASK_UI`, default off)

Does not start until 2B-1 is green on prod.

### 3.1 Flag plumbing and fetch

`AUTOMASK_UI` is read server-side (same regex as `AUTOMASK`) and surfaced as one **additive** field on the proposal body, `ui_enabled: boolean` — the client has no other way to learn a pm2 env var, and a separate config endpoint is a second thing to gate. The spoke fetches `GET …/template-mask/proposal` once `frameStatus === 'ready'`; `pending` → poll every 1 s for ≤ 60 s (silent, like the frames poll); `none`/`disabled`/`ui_enabled:false`/timeout → **nothing rendered, today's spoke exactly** (B1: blank canvas on withheld/error/flag-off). Runbook line: `AUTOMASK_UI=1 pm2 restart masquerade --update-env && pm2 save`.

### 3.2 The proposal layer

One `fabric.Path` on the canvas: outer subpath = frame rectangle, inner subpath = the keep shape as a polygon (fan: arc sampled at ≤ 1 px chord error, two radii; trap/rect: four points), **clipped to the T0 box** (axis-aligned Sutherland–Hodgman, ~30 lines) and offset inward by `MARGIN_PX` so the accepted mask matches the proposer's `keep` to within a pixel; `fillRule:'evenodd'`, fill `rgba(255,0,0,0.35)`, red stroke, tagged `_automask`, `selectable:false, evented:false` while it is a proposal. Drawn in frame pixels — no scaling (§1.5). The existing tools keep working; drawing anything removes the layer (Draw from scratch), as does `clearMask` (`MaskingTools.tsx:39-41` → `MaskingCanvas.tsx:211`). The layer is recomputed from parameters on every control change (cheap: one path of ≤ 200 points).

Shape math lives in `shared/automask/shape.ts` (already the home of `topWidthPx`/`shapeDeltas`) as pure functions — `keepPolygon(shape, bound, margin)`, `withControl(shape, control, value)`, `reseed(shape, toModel)` (B7's rules verbatim: fan → trap widths at `r_in`/`r_out` on the axis; trap → fan apex from the side-line intersection, radii from top/bottom; rect ↔ trap equal widths) — unit-tested and shared with the eval, so the deltas the outcome line reports are computed by the same code the bench used.

### 3.3 The proposal bar and controls

- **Bar:** grade copy — `proposed` → "Proposed", `check_depth` → "Proposed — check the depth" (words only; thresholds unchanged, `info.grade_thresholds` stays for the eval). Actions: **Accept**, **Draw from scratch**, and the **model switch** fan / trapezoid / rectangle (B7) with re-seed on switch.
- **Controls (B2, the bench v4 set):** fan — half-angle (both sides), **top width (arc stays)** joint control, top arc height (`r_in`), depth (`r_out`), apex / whole-cone position; trapezoid — side angle, top width, top, bottom; rectangle — width, top, bottom. Every control shows `fitted → now (Δ)`.
- **Nudge (B3):** arrow buttons + keyboard arrows, tap = 1 px, press-and-hold repeats with acceleration (≈ 10 px/s after 400 ms, ≈ 40 px/s after 1.5 s), Shift = ×10; drag handle on the apex (fan) / top-edge midpoint (trap/rect); sliders keyboard-adjustable with the same Shift rule. Keyboard handlers ignore events whose target is a text input.

### 3.4 Accept → mask

Accept flips the layer from proposal to mask object (`_automask` → ordinary object, still non-interactive) and calls the canvas's **existing** `updateMaskFromCanvas` with it — the `path` case (`MaskingCanvas.tsx:1077`) yields `type:'freeform'` + `canvasDataUrl`, exactly what the brush tool produces today. `maskData` lands in spoke state → `ProcessingControls` appears → Apply enabled by the existing `canApply`. **Decision for Andre (§5.3):** (a) *recommended* — Accept sets the mask and the user clicks the existing Apply (one extra click, the apply contract and `ProcessingControls` untouched, the user still chooses output settings); (b) Accept also triggers Apply with the current settings. The exported PNG is red outside the cone, black inside = `keep` complement; equivalence check in the test matrix (§3.7).

### 3.5 `automask.outcome` (B5)

On Apply (and on Draw from scratch), the spoke POSTs `…/template-mask/proposal/outcome`:

```
{ outcome: 'accept' | 'edit' | 'draw_from_scratch',
  controls_used: ['half_angle', 'top_width', ...],
  deltas: { d_half_angle_deg, d_apex_px, d_top_px, d_top_width_px, d_depth_px, d_arc_px },   // shapeDeltas(fit, final)
  model_switch: { from, to } | null,
  final_keep: KeepShape | null,        // what 2C will need; stored nowhere
  grade_shown, tier, ms_to_decision }
```

The server validates (zod), and emits **one** `[PERF] automask.outcome` line with those fields + `jobId`; it stores nothing (2C decides storage). "Dismiss" is not inferred from page-leave (unreliable); the absence of an outcome line for a job with `automask.done` is the dismiss signal in the pivot. Gate: `AUTOMASK_UI`.

### 3.6 Grade copy

Words only (§3.3). Thresholds move only from `automask.outcome` pivots after 2B-2 ships.

### 3.7 Test matrix

| axis | rows |
|---|---|
| family | fan (bfly_z2b, Normal_Lung), trap with T0 box (ge_e9_2124113685), rect (a corpus clip that proposes `rect`, else the `synthetic_trap` fixture uploaded as an image batch) — layer aligned with the frame at zoom 50 / 75 / 100 / 150 |
| outcome | Accept untouched → Apply → `run.ts --db --server` IoU vs the proposal ≥ 0.99 (polygon vs raster arc); each B2 control nudged ±N px → outcome line carries the matching Δ; model switch fan → trap → rect → fan lands "close" per B7 and logs `model_switch`; Draw from scratch removes the layer and logs the outcome |
| withheld | a `none/withheld` clip (sonosite_011_clip10) → blank canvas, no bar, no outcome POST |
| flag | `AUTOMASK_UI` off → no layer, no bar; A-rows identical; `AUTOMASK` off → same |
| pending | open the spoke during extraction → frames poll then proposal poll; layer appears once; no duplicate fetch on `job.status` flips |
| display | Retina display: Accept → Apply → masked frame matches the drawn cone (the `enableRetinaScaling` observation, §1.4); keyboard nudges do not fire while typing in the output-settings inputs |
| invariants | `tsc` 12; `buildApplyMask`, apply loop, reuse guard, extraction untouched; both automask tests + shape tests green |

### 3.8 Revert

One commit, `git revert`; with `AUTOMASK_UI` off the spoke is byte-for-byte today's.

## 4. Both deploys — constraints

`tsc` = 12 (the same 12) · A3 frozen (no schema/status/column) · `buildApplyMask`, apply loop, reuse guard, extraction untouched **except the read-only T0 addition at `frameExtractor.ts:50`** · one flag per deploy (`AUTOMASK` for 2B-1, `AUTOMASK_UI` for 2B-2) · one `git revert` each · measure at production shape (baseline: 1463 ms cold / 701 ms warm on the main thread) · `maskWorker.ts` neither imported nor edited · nothing PHI-bearing committed (`sandbox/` ignored).

## 5. Decisions needed for sign-off

1. **Worker:** dedicated entry + second esbuild entry + `tsx` bootstrap (§1.1) — because the "existing worker build path" does not exist. Alternative rejected: making `maskWorker.ts` bootable (touches boot code, changes the tsc invariant).
2. **T0 persistence:** `temp_extracted/<jobId>/t0.json` (recommended) vs a field in `automask.json` (rejected: deleted to re-propose).
3. **Accept semantics:** (a) Accept sets the mask, Apply stays a separate click (recommended) vs (b) Accept applies immediately.
4. **Outcome sink:** server `[PERF]` via POST (recommended) vs PostHog (off in the sandbox).
5. **`ui_enabled` on the proposal body** (additive) vs a separate config endpoint.
6. **D5 surrogate:** accept 4/7-equals-bench as the pre-UI number, or draw live in the sandbox before 2B-2.
7. **Order of work:** 2B-1 estimate ~1 day + runbook; 2B-2 ~3 days (controls + nudge ergonomics are most of it) + runbook.

## 6. Backlog opened by this recon (not 2B's)

- `MaskingCanvas.tsx:917` export canvas without `enableRetinaScaling:false` → 2× PNG payloads on Retina displays (works, wasteful). Verify once on prod, then a one-line fix in its own commit.
- `package.json` lists `fabric ^6.7.1`; the canvas uses `fabric@5.3.0` from the CDN. Unused dependency, and a trap for anyone reading the lockfile to learn the API.
- `maskWorker.ts` deletion (backlog #23) is now also *the* reason the worker path had to be built fresh.
- The bench eval's `--db` mode lists every job in the sandbox DB; a `--jobs a,b,c` filter would make D5-style runs read cleanly.

## 7. Out of scope (2C)

Template library / fingerprints (B4), temporal support (B6), accounts. 2B-2's Accept **emits** the final parameters in `automask.outcome` for 2C and **stores nothing**.

---

### Appendix A — reproduction

- **Worker spikes:** `scripts/automask_eval/_spike_worker/` was created and deleted in-session; the three `tsx` variants and the esbuild bundle are described in §1.1 with their outputs. Re-run: any `.ts` worker importing `shared/automask/core` under `npx tsx` with `execArgv: ['--import','tsx']` fails on the first extensionless import; the `.mjs` `register()` bootstrap succeeds.
- **Evenodd proof:** `python3 scripts/automask_spike/bench.py --serve` (from `scripts/automask_spike/`, `SANDBOX_ROOT` set), open `http://localhost:8765/_2b/evenodd.html`, read `window.__result`. Page: `sandbox/bench/_2b/evenodd.html` (fabric 5.3.0 from the same CDN URL as `client/index.html:20`).
- **D5:** sandbox up with `AUTOMASK=1`; for each clip: upload → wait `ready` → `GET …/proposal` → `POST …/template-mask/apply` with `{maskData:{canvasDataUrl,type:'polygon',coordinates:[],opacity:1}, outputSettings:{size:'original',format:'jpg',includeMetadata:true,parallelThreads:8,batchSize:12,aspectRatioMode:'letterbox'}}` → wait `templateMask.status='complete'`; then `npx tsx scripts/automask_eval/run.ts --db "$DATABASE_URL" --server http://localhost:5001 --manifest ../sandbox/manifest.csv --log <server log> --out ../sandbox/results/2026-09-07_d5_applied_masks.md`. The seven job ids are in the saved `.md`.
