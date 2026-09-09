# Auto-mask Round 2B-1 — report: proposer in a worker, computed at `ready`, T0 captured at upload

**Status:** built and verified in the sandbox 2026-09-08, on `main` @ `a98a03c` (item 5 + 2A) as an **uncommitted working tree** — commit and deploy are Andre's calls, per the sign-off ("stop after `AUTOMASK_ROUND2B1_REPORT.md` for the runbook"). Built exactly per `AUTOMASK_ROUND2B_RECON_PROPOSAL.md` §2 with `AUTOMASK_ROUND2B_SIGNOFF.md` §1 decisions 1–7 and the two §2 rows. Flag: `AUTOMASK` (already on in prod). No UI. `tsc` 12 · A3 frozen · `buildApplyMask`, apply loop, reuse guard, extraction untouched except the read-only T0 addition at `frameExtractor.ts:50` · `maskWorker.ts` neither imported nor edited.

## 0. Headline numbers (sandbox = M4 laptop; the prod numbers are the runbook's to take)

| what | measured | context |
|---|---|---|
| **Main-thread stall across a 1920×1080 proposal** (§2.8; the sign-off's headline) | 20 Hz `GET /api/jobs/:id` during the proposal window: **max 8.8 ms**, p50 2.1 ms (idle: max 3.4 ms, p50 2.7 ms) | the proposal itself took `worker_ms` 216 ms in the thread. In 2A the same GET would have waited ≈ `ms_propose` (216 ms here; **1463 ms** on prod). Target on prod: < 50 ms, measured the same way (§6). |
| **Apply within 100 ms of `ready`** (sign-off §2 row 1) on the reference clip, 348 frames | `apply.done` **1129.6 ms** with the proposal overlapping the apply vs **1075.4 ms** control (Apply 4 s after `ready`) → **+54 ms (+5 %)**; `apply.source {mode: reuse}` both times, with `automask.json` + `t0.json` sitting in the job dir | prod baseline 8.7 s; the sign-off's bound is ≤ ~1.5 s slower and never a failure. If prod is worse, the enqueue moves to "ready + 2 s" — one constant. |
| **Cold worker on the first job after start** (sign-off §2 row 2) | tsx dev server: `ms_propose` 238.9 vs `worker_ms` 169.2 → **≈ 70 ms spawn** (registers tsx inside the thread). Production bundle: 143.2 vs 126.3 → **≈ 17 ms spawn**. Second job: 82.7 vs 82.4 → **0.3 ms** thread-hop overhead. | `automask.worker_spawned` is logged once per process lifetime (`spawn: 1`); `worker_spawned: true` only on the task that paid for it. |
| **Ready trigger latency** | `automask.start` **5 ms** after `bg_extract.done` (i.e. after the `ready` write + socket emit); `automask.done` 250 ms later; the first GET is `cached: true`, `computed_by: 'ready'` | `ready` itself is not delayed: the enqueue is the line after the emit. |
| **T0 from `t0.json`** | written 0–147 ms after `upload.job_created`, before extraction; restart simulation (upload file removed, cache deleted) → recompute → **`T0T1`, `bound_source: dicom`, `t0_from: 'file'`** | the pre-2B shape (no `t0.json`, no upload) still degrades to `unavailable` — by design, only jobs uploaded before 2B-1. |
| invariants | `npx tsc --noEmit` = **12** (5 `frameExtractor.ts` + 7 `maskWorker.ts`, the same 12) · `npm run build` → `dist/index.js` 262 KB + **`dist/automaskWorker.js` 53 KB, 0 references to sharp/express** · tests **13 + 5 + 2 pass** | |

## 1. What shipped

| file | change |
|---|---|
| `server/workers/automaskWorker.ts` (new) | Worker entry: `parentPort.on('message')` → `propose(grid(w,h,gray), {bound})` → `{ok:true, result (no keep), workerMs}` or `{ok:false, error}`. Imports only `worker_threads` + `shared/automask`. |
| `server/workers/automaskWorker.boot.mjs` (new, 3 lines) | Dev/test bootstrap: `tsx/esm/api register()` then `import('./automaskWorker.ts')`. Never used by the bundle. |
| `server/services/automaskWorkerClient.ts` (new) | `AutomaskWorkerClient`: one lazy worker, FIFO, one task in flight, 20 s timeout, terminate + respawn on failure, entry resolved by `import.meta.url` extension (`.ts` → bootstrap, else `./automaskWorker.js` beside the bundle). Transfers an owned copy of the gray buffer; `unref()`s the worker. `defaultWorkerClient` is process-wide. |
| `server/services/automaskT0.ts` (new) | `boundFromDataset` (the region → box arithmetic, now shared with `readDicomBound`), `t0Path` / `writeT0` / `readT0` (atomic tmp + rename), `captureT0AtUpload` (flag-gated, never throws; logs `automask.t0_captured`). |
| `server/services/automaskFlag.ts` (new) | `AUTOMASK_FLAG_ENV` / `automaskEnabled` moved here (re-exported from `automask.ts`) so `automaskT0.ts` can read the flag without a module cycle. *Delta from the proposal's file list — structure only.* |
| `server/services/automask.ts` | `compute()` calls `deps.proposeInWorker` instead of `propose()`; `getOrComputeProposal(jobId, deps, {trigger})`; new `enqueueProposalAtReady(jobId)`; T0 read order `t0.json` → upload → `unavailable`; PERF fields (§2.4); `AutomaskDeps.proposeInWorker` (tests inject faults). |
| `shared/automask/geometry.ts` | `boundToGrid` moved here from the service (the worker needs it without importing the service); `automask.ts` re-exports it. |
| `shared/automask/types.ts` | Contract v2, additive: `computed_by?: 'ready'|'lazy'`, `ms.worker?`, `ms.queue?` (and `info.t0_from`). |
| `server/services/frameExtractor.ts` | **The one extraction touch, read-only:** `VideoMetadata.ultrasoundBound?: Bound | null`, filled at the `naturalizeDataset` site (`:50` block) from the dataset already in memory. The 5 parked pixelBuffer errors are untouched. |
| `server/routes.ts` | Video/DICOM upload handler: `captureT0AtUpload(job.id, quickMetadata, true)` after `upload.job_created`; MP4 branch: the same with `false` (records `not_dicom`, so the proposer never re-reads an MP4 upload); image upload handler: `void enqueueProposalAtReady(job.id)` after the response. |
| `server/services/videoProcessor.ts` | One line after the `ready` write + `updateProgress` emit (`:1561-1568`): `void enqueueProposalAtReady(jobId)`. |
| `package.json` | `build` gains the second esbuild entry → `dist/automaskWorker.js`. |
| `scripts/automask_eval/run.ts` | `--db` rows carry `computed_by`, `t0_from`, `worker_ms`; the note column reads e.g. `check_depth · by:ready · t0:file` (sign-off §3). |
| tests | `automask.endpoint.test.ts` +6 cases (real worker through the bootstrap); new `automaskWorkerClient.test.ts` (5) with `fixtures/automask/faultWorker.mjs`; `automask.fixture.test.ts` unchanged and green (the core did not change). |

Not touched: `maskWorker.ts`, `buildApplyMask`, the apply loop, `tryReuseRawFrames`, `extractAllFramesSequential`/`extractAllFramesSinglePass`, storage, schema, the spoke, `client/`.

## 2. Design as built

### 2.1 Worker (sign-off decision 1)
As recon §1.1. The kickoff's "reuse `maskWorker.ts`" is recorded as wrong there and in the sign-off; nothing here imports or edits it. Entry resolution is by the client module's own URL: under tsx (`npm run dev`, the sandbox, `npx tsx …test.ts`) `import.meta.url` ends in `.ts` → `../workers/automaskWorker.boot.mjs`; under the bundle → `./automaskWorker.js`. Verified both ways in the sandbox: `"entry":"automaskWorker.boot.mjs"` under `npm run dev`, `"entry":"automaskWorker.js"` under `node dist/index.js` (row C2). One worker per process, spawned on the first task, FIFO with one task in flight; the second of two simultaneous jobs shows `queue_ms` ≈ the first's `worker_ms` (row A6: 112 ms behind an 111 ms task). Failure → `worker_timeout` / `worker_crash: …`, worker terminated, respawned by the next task (unit-tested with the fault worker: crash → respawn → success, hang → timeout → respawn → success, 3 spawns, 5 log lines in order). Decode stays on the service side (sharp/libvips); the gray frame crosses as a transferred copy (2 MB at 1080p); the `keep` grid never crosses back (`compute()` has no reader for it — verified, 0 references).

### 2.2 Enqueue at `ready`
`enqueueProposalAtReady(jobId)` = `getOrComputeProposal(jobId, deps, {trigger:'ready'})` behind a flag check and a catch that logs `automask.skipped {reason:'error', trigger:'ready'}` and never rejects. Call sites: `videoProcessor.ts` after the emit (MP4 and DICOM converge there) and the image upload handler after `res.json`. Dedupe is the existing in-flight map: two enqueues, or an enqueue and a GET, share one compute (unit test + row A4). A `pending` at ready (should not happen — all frames are on disk) is logged as `pending_at_ready` and left to the lazy path.

### 2.3 T0 (sign-off decision 2)
`t0.json` `{version:1, bound, bound_source, w, h, createdAt}` written by the upload handlers for every video upload (DICOM: `dicom` / `not_dicom` (no region) / `unavailable` (parse failed → `ultrasoundBound === undefined`); MP4/MOV: `not_dicom`). Read order in `compute()`: `t0.json` → `readDicomBound(upload)` (pre-2B jobs; `t0_from:'upload'`) → `unavailable`. The bound from the file is clipped to the decoded frame. `.json` files are invisible to the reuse guard's frame count (rows B3/B4/C1: `apply.source reuse` with the two files present).

### 2.4 `[PERF]` lines
`automask.start / done / skipped` carry `trigger`; `done`/`skipped(withheld)` add `worker_ms`, `queue_ms`, `worker_spawned`, `t0_from`; `served` adds `computed_by` (what produced the cache) and `trigger` (who is asking); `t0_unavailable` adds `trigger`. New stages: `automask.t0_captured {bound_source, w, h, dicom}` (upload), `automask.t0_capture_failed`, `automask.worker_spawned {entry, spawn}`, `automask.worker_failed {reason}`. `ms_propose` is the round trip (queue + transfer + worker); `ms_propose − worker_ms − queue_ms` is the thread-hop overhead (0.3 ms warm).

### 2.5 Fallback rules (unchanged semantics, off-thread)
Cache hit → served. No cache → compute (lazy) in the worker. Frame not on disk → `pending`, uncached. Worker failure → `{status:'none', reason:'error', error:'worker_…'}`, uncached (2A rule) → the next GET retries through a fresh worker (unit test r4: ready-trigger failure, then the lazy GET succeeds). Flag off → `disabled` before any disk access; `enqueueProposalAtReady` and `captureT0AtUpload` are no-ops (row C1: zero new files, zero PERF lines).

## 3. Runbook rows — sandbox (`scripts/sandbox/up.sh`, `AUTOMASK=1` unless stated; drivers in the session scratchpad, outputs summarised)

| row | expectation | result |
|---|---|---|
| A1 MP4, first job after start (`Normal_Lung _sliding.mp4`, 1536×796, 348 frames) | `t0_captured not_dicom`; `automask.start trigger:'ready'` right after `bg_extract.done`; `worker_spawned` once; GET `cached:true`, `computed_by:'ready'` | ✅ `t0_captured` +147 ms after `job_created`; `start` +5 ms after `bg_extract.done`; `done` fan_sym conf 0.8566 check_depth, `ms_propose` 238.9 / `worker_ms` 169.2 / `worker_spawned:true`; GET → `served {cached:true, computed_by:'ready', trigger:'lazy'}` |
| A2 MP4, second job (`bfly_z2b`) | no spawn; thread-hop ≈ 0 | ✅ `worker_spawned:false`, `ms_propose` 82.7 vs `worker_ms` 82.4; spawn lines in log: 1 |
| A3 DICOM single-frame (`ge_e9_2124113685.dcm`) | `t0_captured dicom`; `done tier T0T1, t0_from 'file'` | ✅ `t0.json {bound:{2,109,1055,805}, bound_source:'dicom'}`; `done trap_sym conf 0.8716 T0T1 t0_from:'file'` 127 ms |
| A4 DICOM multiframe (`ge_e9_4351124429.dcm`, 67 frames), GET polled every 0.5 s during extraction | at most one `automask.done` | ✅ tick 1 `pending` (frame 1 not yet complete); tick 2 the lazy GET computed (frame 1 lands with the first 15-frame batch, exactly as 2A) → `done trigger:'lazy' T0T1 t0_from:'file'`; at `ready` the enqueue found the cache → `served {trigger:'ready', computed_by:'lazy'}`; **`automask.done` count = 1** |
| A5 image batch (`bfly_frame_000092.png`) | `done trigger:'ready'` right after upload | ✅ +88 ms after upload, fan_sym 0.8657, `t0_from:null` (image batches have no T0) |
| A6 two image batches uploaded simultaneously | second waits; one worker | ✅ second `queue_ms 112` / `worker_ms 81` vs first `worker_ms 111`, `queue_ms 0`. *Caveat:* this row ran while a previous sandbox server was still alive on the same port (`reusePort` lets two share it), so the two jobs may have landed on different processes; the queue evidence is from one process's log. The cold/warm spawn evidence is rows A1/A2/B1/C2, each on a single fresh process. |
| A7 restart simulation (sign-off row "restart between upload and open → still T0T1") | upload file removed + `automask.json` deleted → recompute → `T0T1` from `t0.json` | ✅ job dir `frame_000001.png t0.json`; GET → `done trigger:'lazy' T0T1 bound_source:'dicom' t0_from:'file'` |
| A8 pre-2B shape: `t0.json` also removed | `unavailable` (what prod hit on `438a9d4f`) | ✅ `t0_unavailable {ENOENT uploads/…}` → `tier T1, bound_source:'unavailable', t0_from:null`, still `trap_sym` on this frame (conf 0.8693 — this single-frame E9 does not need the box; the prod job was a different frame) |
| B1 idle latency baseline + cold worker on this start | | ✅ idle GET p50 2.7 / max 3.4 ms; cold: `worker_spawned` then `done ms_propose 227.7 / worker_ms 124.6` |
| B2 **§2.8 stall** across the 1920×1080 proposal (`Kidney_copy.mp4`) | max GET latency in the proposal window ≪ `worker_ms` | ✅ window 0.24 s, `worker_ms` 216.2: **max 8.8 ms** (whole run p50 2.1 ms) |
| B3 **sign-off row 1** — Apply within 100 ms of `ready`, reference clip | bounded slowdown, `apply.source reuse` | ✅ `apply.done` **1129.6 ms**; `reuse` 348 frames; dir = 348 png + `automask.json` + `t0.json` |
| B4 control — Apply 4 s after `ready`, same clip | | ✅ `apply.done` **1075.4 ms** → overlap cost +54 ms (+5 %) |
| B5 eval join | `--db` rows show trigger + T0 source | ✅ `run.ts --db --server` rows: `check_depth · by:ready · t0:file`; both reference-clip jobs IoU 0.9904 ✅ vs the D5 mask (`sandbox/results/2026-09-08_2b1_phaseB.md`) |
| C1 **flag OFF** (`AUTOMASK` line commented in `.env.sandbox`; `up.sh` re-sources that file, so an exported empty var is not enough — first attempt was invalid and redone) | 2A/flag-off behaviour byte for byte | ✅ DICOM job dir = `frame_000001.png` only (no `t0.json`, no `automask.json`); **0** automask PERF lines after a DICOM and an image batch; GET → `{status:'none', reason:'disabled'}`; unknown job → 404; apply → `reuse`, `apply.done` 110.7 ms |
| C2 **production bundle** (`NODE_ENV=production node dist/index.js`) | worker = `dist/automaskWorker.js` | ✅ `worker_spawned {entry:"automaskWorker.js", spawn:1}`; image batch `done` 143.2 / 126.3 ms; DICOM through the bundle `t0_captured dicom` → `done T0T1 t0_from:'file'` |
| worker crash → lazy fallback → `none/error` | (not reproducible in the sandbox without a fault) | ✅ unit tests: client crash/hang/respawn (5 cases); service `r4`: ready-trigger failure → `skipped {reason:'error', detail:'worker_crash: exit 3', trigger:'ready'}`, nothing cached, next GET succeeds `computed_by:'lazy'` |
| build / dev | two files in `dist/`; dev path works | ✅ `dist/index.js` 262,319 B, `dist/automaskWorker.js` 53,122 B, 0 sharp/express refs; sandbox = `npm run dev` throughout (bootstrap entry logged) |

## 4. Tests (`npx tsx server/services/__tests__/<file>`)

- `automask.endpoint.test.ts` — **13/13**: the seven 2A cases (now through the real worker via the bootstrap — the happy path additionally asserts `ms.worker ≤ ms.propose`, `computed_by:'lazy'`, `trigger` in the PERF extra) plus six 2B-1 cases: enqueue at ready computes once / GET served / `computed_by:'ready'`; two enqueues + a GET → one compute; flag off → no lookup, no disk, no log; worker failure → uncached `none/error` with detail, next GET succeeds; `t0.json` wins with no upload on disk → `T0T1`, `t0_from:'file'`, and the fit equals the 2A `synthetic_trap` fixture computed with that box; no `t0.json` + no upload → `unavailable` (pre-2B path).
- `automaskWorkerClient.test.ts` — **5/5**: entry resolution; real worker result identical to in-thread `propose` (shape, model, conf, withheld), no `keep`, caller's buffer intact, spawn paid once; FIFO with `queue_ms`; fault worker crash → respawn → success and hang → timeout → respawn → success with the exact log sequence; terminate rejects in-flight + queued.
- `automask.fixture.test.ts` — unchanged, green (constants frozen equality; both synthetic fixtures).

## 5. Known limitations (carried verbatim from `AUTOMASK_ROUND2A_REPORT.md` §5, unchanged by 2B-1)

**Butterfly parametrisation caveat (pass-3 report §2).** `bfly_frame_000089` and `bfly_frame_000092` pass the tolerant rule with the re-seeded fan, but the *parametrisation* is far from Andre's: apex 237 / 31 px lower, half-angle 30° / 28° vs his 21° / 28°, r_out +232 / +15. The re-seeded cone hugs the visible speckle (the lateral near field is dark on Butterfly, so the true cone is wider than what is visible); the **mask** overlaps Andre's at IoU 0.915 / 0.941 with leak_core6 < 1 % — fail-closed — while the **controls** in 2B would need a 200-px apex move to reach his cone. `bfly_z2b` / `bfly_z2` / `bfly_z3` / `bfly_z7` fail. This is exactly B4's territory: one saved cone per Butterfly export geometry covers the family.

**The two model-type misses (GO §0).** The 3 "wrong" verdicts of the 2026-09-06_1041 re-review: `bfly_z9` (fit a **rect**, "not a box"), `sonosite_011_clip10` (fit a **trap** to a fan, "incorrect geometric shape"), `bfly_z7` (support failure) — two of three are **model-type** errors the controls cannot fix → B7 (the fan / trapezoid / rectangle switch in the 2B draft).

Also inherited unchanged from the freeze: GE E9 trapezoid depth ~30 px shallower than Andre's (over-blank, one slider); a header line directly above a sparse Butterfly near field is kept (`bfly_z3`); the sector clip; the three support failures (B6).

2B-1 adds one of its own: **jobs uploaded before 2B-1 have no `t0.json`**; if their upload is gone they still degrade to `unavailable` (row A8). Nothing to do — they age out with the 6 h sweep.

## 6. Facts the deploy runbook needs (the runbook itself is Andre's, per decision 7)

- **Build check:** `npm run build` then `ls dist/` must show **`index.js` and `automaskWorker.js`** (plus `public/`). Nothing is copied by hand; the bundle resolves the worker as `./automaskWorker.js` next to itself, regardless of pm2's cwd.
- **Flag:** `AUTOMASK=1` is already in pm2's env; no new flag for 2B-1. Flag off = row C1.
- **Verify after `pm2 restart`:** upload any clip → `pm2 logs masquerade --raw | grep '\[PERF\]' | grep automask` shows `t0_captured` (video) → `worker_spawned {entry:"automaskWorker.js", spawn:1}` (first job only) → `start {trigger:"ready"}` → `done {…, worker_ms, queue_ms, t0_from}`; then `GET /api/jobs/<id>/template-mask/proposal` → `computed_by:"ready"` and a `served {cached:true}` line. A GE E9 `.dcm` must show `bound_source:"dicom"`, `t0_from:"file"`, `tier:"T0T1"`.
- **The two prod measurements (sign-off §3):** (1) **stall** — during a 1080p upload run `while :; do curl -s -o /dev/null -w '%{time_total}\n' https://…/api/jobs/<id>; sleep 0.05; done` from the box and take the max in the window between `automask.start` and `automask.done` (target < 50 ms; 2A would have shown ≈ `ms_propose`); (2) **Apply within 2 s of `ready`** on the reference clip → `apply.done` vs 8.7 s (bound: ≤ ~1.5 s slower); plus the cold-worker pair (`ms_propose` − `worker_ms` on the first job after restart, ≈ 17 ms here in the bundle) and the warm `ms_propose`/`worker_ms` on 1080p against the 1463 / 701 ms baseline.
- **Rollback:** one `git revert` of the 2B-1 commit; the orphaned `dist/automaskWorker.js` after a revert is inert. No schema, status or column changed.
- **Disk:** two small `.json` files per job in `temp_extracted/<jobId>/`, swept with the frames (6 h); the reuse guard ignores them (rows B3/B4/C1).

## 7. Not done here, by design

- **Not committed.** The working tree also carries Andre's earlier uncommitted edits (`.gitignore`, `CLAUDE.md`, `ITEM22_REPORT.md`, `scripts/sandbox/`) and the never-to-commit `scripts/automask_spike/dicoms.json`; the 2B-1 commit should take: `server/workers/`, `server/services/automask{,Flag,T0,WorkerClient}.ts`, `server/services/frameExtractor.ts`, `server/routes.ts`, `server/services/videoProcessor.ts`, `shared/automask/{geometry,types}.ts`, `package.json`, `scripts/automask_eval/run.ts`, the two tests + `fixtures/automask/faultWorker.mjs`, and the three 2B docs. Nothing PHI-bearing: the only new fixture is the 15-line fault worker.
- **Not deployed; prod numbers not taken** (§6).
- **2B-2** (the spoke, `AUTOMASK_UI`) starts after 2B-1 is green on prod.
