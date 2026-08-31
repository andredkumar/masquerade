# Template-mask apply performance — Round 1 report

**Spec:** `docs/refactor/TEMPLATE_MASK_APPLY_PERF_ROUND1.md`
**Instrumentation landed:** 2026-08-30 (log-only; no behavior change)
**Measurement status:** ⏳ **PENDING — §1 tables must be filled from a prod run.** §2–§5 below are
complete from source; the H1/H2/H3 verdicts are deliberately left blank until the box has run the
§4 matrix. Agent-env numbers appear in Appendix B and are **directional only** (see §2 note).

---

## 0. What was instrumented

New file `server/services/perf.ts` (25 lines) — `perfMark` / `perfSpan` exactly as specified in
spec §3.1. One `[PERF] ` prefix, one JSON object per line, no env flag, no new dependency.

### Probe inventory (as landed)

| stage | file:line region | fields |
|---|---|---|
| `upload.multer_done` | `server/routes.ts` (top of `videoUploadHandler`) | `bytes`, `filename` |
| `upload.ffprobe` | `server/routes.ts` — span around `extractVideoMetadata`, both branches | `ms`, `path`, `frames`, `w`, `h`, `fps` |
| `upload.first_frame` | `server/routes.ts` — span around `extractFirstFrame`, both branches | `ms`, `path` |
| `upload.job_created` | `server/routes.ts` — after `createVideoJob`, both branches | `uploadRef`, `path` |
| `upload.response_sent` | `server/routes.ts` — immediately before `res.json(...)` | `uploadRef` |
| `bg_extract.start` | `videoProcessor.startBackgroundFrameExtraction` | `totalFrames` |
| `bg_extract.first_frame_on_disk` | same, after the first batch's writes resolve | `ms_since_start`, `batchFrames` |
| `bg_extract.done` | same, before status → `ready` (and on the failure path) | `ms`, `frames`, `outcome` |
| `apply.request` | `server/handlers/templateMaskApply.ts` (first line) | — |
| `apply.env` | `videoProcessor.processVideo` (first line of `try`) | `cpus`, `uv_threadpool`, `sharp_concurrency`, `batch_size`, `volume_batch_size`, `node` |
| `apply.staging_clean` | span around `prepareCleanApplyStaging` | `ms` |
| `apply.extract_all` | span around `extractAllFramesSequential` | `ms`, `path` (`ffmpeg`\|`dicom`), `frames` |
| `apply.extract_frame` | `frameExtractor.extractAllFramesSequential`, **DICOM branch only** | `ms`, `i` |
| `apply.read_all` | span around the bulk `Promise.all(readFile)` | `ms`, `frames` |
| `apply.stack` | span per `processFrameBatch` call (one 8-frame volume) | `ms`, `stackIdx`, `batchIdx`, `stackSize`, `firstFrame`, `decode_ms`, `mask_build_ms`, `outcome` |
| `apply.frame` | per frame inside a stack | `i`, `stackIdx`, `decode_ms`, `mask_ms`, `encode_ms`, `w`, `h`, `out_bytes` |
| `apply.write_all` | span around the save-to-`spokes/template_mask/` loop | `ms`, `frames`, `ext` |
| `apply.done` | `processVideo` span close, both terminal paths | `ms`, `frames`, `outcome` |

### Deviations from spec §3.2 — and why

1. **`apply.frame` has `decode_ms` instead of `read_ms`, and no `write_ms`.** The apply path does
   not read or write per frame. Every extracted PNG is read in **one bulk `Promise.all`** before the
   mask loop (`videoProcessor.ts` — `apply.read_all`), and every masked frame is written in **one
   loop after** it (`apply.write_all`). So the read and write buckets are spanned whole, as §3.2's
   escape hatch allows, and the per-frame line reports the three costs that *are* per-frame:
   `decode_ms` (Sharp decode to raw pixels, Step 1 of `processFrameBatch`), `mask_ms` (the
   synchronous pixel loop, Step 3), `encode_ms` (resize + encode, Step 4). **H3 is decided by
   `encode_ms` vs `mask_ms` on these lines.**

2. **Pre-job-creation upload probes are keyed by a correlation ref, not a jobId.**
   `upload.multer_done` / `upload.ffprobe` / `upload.first_frame` (DICOM) fire before any job
   record exists, so they log `jobId: "upl_xxxxxxxx"`. `upload.job_created` carries both the real
   jobId and that `uploadRef`, so the pivot can join them. In the §4 pivot these appear as an extra
   `upl_*` group per upload — that is expected, not noise.

3. **`apply.done`'s total is spanned from `processVideo`, not from `apply.request`.** `processVideo`
   is fired detached (`.catch(...)`) and cannot be handed a closure without changing its signature,
   which §2 forbids. The handler→`processVideo` gap is exactly `apply.done.t − apply.request.t −
   apply.done.ms`, computable from the JSON. The `ms` field on `apply.done` **is** the spec's
   `total_ms`.

4. **`apply.request` omits `ms_since_bg_extract_done`.** No background-extraction completion
   timestamp is persisted on either job record, so it is not derivable — §3.2 permits omitting it.
   It *is* recoverable from the log: `apply.request.t − bg_extract.done.t` for the same jobId.

5. **⚠️ `apply.extract_frame` required touching the DICOM additive branch — flagging for veto.**
   Spec §3.2 asks for this probe by name ("DICOM branch only"), but §2 says "do not touch the DICOM
   additive branch in `extractAllFramesSequential`". Resolution taken: the probe was added because
   it is **log-only** — a `perfSpan` open/close around the existing `extractDicomFrame` call, with
   the extraction logic byte-for-byte unchanged. It is reached through a new **optional trailing
   `perfJobId?: string`** parameter that only the apply path passes; every other caller omits it and
   fires no probe at all. Verified byte-identical output against `HEAD` (Appendix A). If you would
   rather have zero edits in that block, revert the three-line change in
   `server/services/frameExtractor.ts` plus the `jobId` argument at the `extractAllFramesSequential`
   call site — nothing else depends on it.

6. **Two additions beyond §3.2, both log-only:** `upload.first_frame` (in *both* upload branches,
   `extractFirstFrame` blocks the 200 exactly as `ffprobe` does — the spec's §1 "what blocks the
   upload response" question is unanswerable without it) and `apply.read_all` / `apply.write_all`
   (see deviation 1).

7. **`processImages` and `processBatchesInParallel` are uninstrumented.** The perf context is
   optional and only `processFrameBuffersInParallel` (the template-mask video apply path) passes it.
   The §4 matrix has no images case.

8. **`server/services/maskWorker.ts` was not instrumented — it is dead code.** Nothing in `server/`
   or `client/` imports `MaskWorkerPool` or that module (verified by grep). It contributes 7 of the
   12 baseline tsc errors. The real mask loop is `videoProcessor.processFrameBatch`. Spec §2 lists
   `maskWorker.ts` as a probe site; that appears to be based on the filename rather than the call
   graph.

---

## 1. Wall-clock table per case — ⏳ TO BE FILLED FROM PROD

Run the §4 matrix on the box, then paste the pivot output and fill this in.

| Case | `upload.ffprobe` | `upload.first_frame` | `bg_extract.first_frame_on_disk` | `bg_extract.done` | `apply.extract_all` | `apply.read_all` | Σ `apply.stack` | Σ `apply.frame.decode` | Σ `.mask` | Σ `.encode` | `apply.write_all` | `apply.done` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A — small MP4, run 1 | | | | | | | | | | | | |
| A — run 2 | | | | | | | | | | | | |
| A — run 3 | | | | | | | | | | | | |
| B — large MP4, apply 1 | | | | | | | | | | | | |
| B — apply 2 (redo) | | | | | | | | | | | | |
| C — multiframe DICOM | | | | | | | | | | | | |
| D — single-frame DICOM | | | | | | | | | | | | |

**Reading the per-frame sums correctly.** The 8 frames inside a stack run concurrently
(`Promise.all` in `processFrameBatch` Step 3), and the outer batches run concurrently too. So
`decode_ms` / `mask_ms` / `encode_ms` are **overlapping wall-clock spans**, and their sum will
exceed the stack's own `ms`. Use the sums for **ratios** (H3: is encode ≫ mask?) and
`apply.stack.ms` / `apply.done.ms` for **wall-clock**. Do not add the per-frame sums to
`apply.extract_all` and expect them to reach `apply.done`.

## 2. `apply.env` facts — ⏳ TO BE FILLED FROM PROD

Grep one line: `grep '"stage":"apply.env"' perf_*.jsonl | head -1`

| field | prod value |
|---|---|
| `cpus` (`os.cpus().length`) | |
| `uv_threadpool` (`UV_THREADPOOL_SIZE`) | |
| `sharp_concurrency` (`Sharp.concurrency()`) | |
| `batch_size` (outer, `outputSettings.batchSize \|\| 12`) | |
| `volume_batch_size` (inner stack, hardcoded) | 8 |
| `node` | |

These decide whether **H2 is even possible** before any timing is read. Note the pipeline uses
**Sharp's own libvips threadpool**, not the libuv pool, for decode/resize/encode — `sharp_concurrency`
is the number that matters for H3's parallelism, `uv_threadpool` for the `fs.readFile` fan-out in
`apply.read_all`.

## 3. Verdicts — ⏳ PENDING

| # | Hypothesis | Verdict | Deciding number |
|---|---|---|---|
| H1 | Apply-time re-extraction dominates | *confirmed / killed / inconclusive* | `apply.extract_all.ms ÷ apply.done.ms` ≥ 0.40 ⇒ confirmed |
| H2 | Mask loop is not actually parallel | *confirmed / killed / inconclusive* | `apply.stack.ms` vs Σ of its frames' `(decode+mask+encode)`; ≈ equal ⇒ serialized, ≪ ⇒ parallel |
| H3 | PNG/JPEG encode dominates the mask loop | *confirmed / killed / inconclusive* | Σ `encode_ms` ÷ Σ `mask_ms` within a stack |

## 4. Workflow audit (spec §3.3) — COMPLETE

**Q1. What does the template-mask spoke gate its interactivity on?**
On the **HTTP result of `GET /api/jobs/:jobId/frames/0`**, not on a status field directly. The spoke
fetches frame 0 on mount ([template-mask-spoke.tsx:46](client/src/pages/template-mask-spoke.tsx:46));
a `503` sets `frameStatus = "extracting"`
([:52-53](client/src/pages/template-mask-spoke.tsx:52)), and that state **early-returns a spinner
before the canvas is ever rendered** ([:149](client/src/pages/template-mask-spoke.tsx:149)). It
re-fetches when `job.status` flips to `"ready"` ([:71-75](client/src/pages/template-mask-spoke.tsx:71)).
So the gate is one indirection away from `job.status`, but resolves to the same thing.

**Q2. What does the hub gate the Template Mask tile on?**
`job.status === "ready"`, exactly as CLAUDE.md suggested. `const isReady = job.status === "ready"`
([hub.tsx:47](client/src/pages/hub.tsx:47)) feeds `disabled={!isReady}` on the Template Mask tile
([hub.tsx:169](client/src/pages/hub.tsx:169)) and the AI tile ([hub.tsx:187](client/src/pages/hub.tsx:187)).
Until then the hub shows the "Extracting frames…" panel instead.

**Q3. Does `GET /api/jobs/:jobId/frames/0` return successfully mid-extraction?**
**No — it returns `503` by explicit design.** The raw-source branch short-circuits on the job status
before it ever looks at the disk:

```ts
if (jobV2.status === 'extracting') {
  return res.status(503).json({ error: "Extraction in progress" });
}
```
([routes.ts:1612-1613](server/routes.ts:1612))

And `jobV2.status` stays `'extracting'` for the whole run: `mapVideoJobStatusToJobStatus` maps both
`'uploaded'` and `'extracting'` → `'extracting'` ([storage.ts:30-31](server/storage.ts:30)), and the
flip to `'ready'` happens only after the batch loop finishes, at
[videoProcessor.ts:1253](server/services/videoProcessor.ts:1253). `frame_000001.png` is on disk long
before that — the first 15-frame batch writes it within the first batch iteration (this is precisely
what the new `bg_extract.first_frame_on_disk` probe times) — but the endpoint refuses to serve it.
The gate is on status, not on file existence.

**Q4. Is "draw the mask while frames are still extracting" currently possible in the UI?**
**No.** It is blocked twice over, independently:
1. The hub tile is `disabled` until `job.status === "ready"`, so the user cannot navigate to the
   spoke mid-extraction at all ([hub.tsx:169](client/src/pages/hub.tsx:169)).
2. Even reaching the spoke directly by URL, `frames/0` answers `503` and the spoke renders a spinner
   in place of the canvas ([template-mask-spoke.tsx:149](client/src/pages/template-mask-spoke.tsx:149)).

The original "upload → show frame 1 immediately → user draws while the rest extracts" design is
**not wired through**. The one surviving piece of it is the upload response, which still returns
`firstFrame` as a base64 data URL ([routes.ts](server/routes.ts) — both branches) — but the spoke no
longer consumes it (Phase 4b replaced that sessionStorage cache with the `frames/0` fetch). The
missing link is a status-independent frame-0 read, not a missing frame: **the pixels are already on
disk minutes before the UI will show them.**

## 5. Biggest bucket — ⏳ ONE SENTENCE, AFTER THE PROD NUMBERS

*(Round 1 stops here by design. Fix design is Round 2.)*

---

## Appendix A — regression guard run in the agent environment

**What ran.** This box has **no ffmpeg binary and no Postgres**, so the MP4 path and the whole
HTTP/download layer cannot execute here. What *can* run — and did — is the DICOM extraction branch
(dcmjs + Sharp only) and the full mask loop.

A pristine `git worktree` of `HEAD` (`fed7953`) was built and driven through an identical harness, so
this is a true before/after, not a self-check:

| case | frames | naming | masked frames OK | output bytes vs `HEAD` | extracted PNGs vs `HEAD` |
|---|---|---|---|---|---|
| single-frame `.dcm` | 1 | `frame_000001.png` | 1/1 | **byte-identical** | **sha256 match** |
| multiframe `.dcm` | 67 | `frame_000001.png` … `frame_000067.png` | 67/67 | **byte-identical** | **sha256 match** |

The 1-indexed `frame_%06d.png` invariant that the DICOM fix and the Phase 6 co-indexing depend on is
intact.

**`tsc` stays at 12** — and it is the *same* 12 (5× `frameExtractor.ts` `pixelBuffer` +
7× `maskWorker.ts`), not a new set. `npm run build` is clean.

**Still owed on the box, before or alongside the measurement run:** the MP4 smoke and the
apply-and-**download** half of all three cases. Case D in the §4 matrix doubles as the single-frame
DICOM guard and case C as the multiframe one; add one MP4 apply+download (case A covers it).

## Appendix B — agent-environment dry run (DIRECTIONAL ONLY — do not quote)

From the 67-frame DICOM above, on this laptop, with a 12%-of-frame rectangle mask:

```
== job smoke-multi67
apply.extract_frame   count 67   total 1261ms   mean 18.8ms   max 39.8ms
apply.stack           count  1   total  325ms
apply.frame sums:     decode 167ms   mask 87ms   encode 4012ms   (67 frames)
```

Two things worth carrying into the prod read — **neither is a verdict**:

- **Σ`encode_ms` is ~46× Σ`mask_ms`.** If that ratio survives on the box, H3 is confirmed and the
  mask arithmetic is a rounding error, exactly as the spec's §1 intuition predicted.
- **`apply.stack.ms` (325ms) is far below the summed per-frame spans (4.3s).** The frames inside a
  stack really are overlapping, so H2's "not actually parallel" is *not* obviously true — but this
  box's core count and Sharp concurrency are not prod's, which is why `apply.env` exists.
- **A source observation that needs no timing:** `extractDicomFrame` re-reads **and re-parses the
  entire `.dcm` file on every single frame** ([frameExtractor.ts:308-311](server/services/frameExtractor.ts:308)).
  For the 56 MB / 67-frame file above that is 67 full-file reads plus 67 `dcmjs` parses for one
  apply. `isDicomFile` likewise `readFile`s the whole file to inspect 4 bytes at offset 128
  ([frameExtractor.ts:152](server/services/frameExtractor.ts:152)) and is called several times per
  upload and per apply. `apply.extract_frame` will quantify the first of these on case C.

---

## Appendix C — commands to run on prod

Deploy, then run the §4 matrix (A ×3, B with two applies, C, D). Collect:

```sh
pm2 logs masquerade --raw --lines 20000 | grep '\[PERF\]' | sed 's/^.*\[PERF\] //' > perf_$(date +%Y%m%d_%H%M).jsonl
```

Pivot (no deps):

```sh
node -e '
const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const byJob={};for(const r of L){(byJob[r.jobId]??=[]).push(r)}
for(const [j,rs] of Object.entries(byJob)){
  console.log("\n== job",j);
  const agg={};for(const r of rs){if(r.ms==null)continue;const a=agg[r.stage]??={n:0,ms:0,max:0};a.n++;a.ms+=r.ms;a.max=Math.max(a.max,r.ms)}
  console.table(Object.fromEntries(Object.entries(agg).map(([k,v])=>[k,{count:v.n,total_ms:+v.ms.toFixed(0),mean_ms:+(v.ms/v.n).toFixed(1),max_ms:+v.max.toFixed(1)}])));
}' perf_*.jsonl
```

`apply.frame` carries no `ms` field, so the pivot above skips it. Sum its sub-buckets separately —
this is the line that decides H3:

```sh
node -e '
const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.stage==="apply.frame");
const byJob={};for(const r of L){(byJob[r.jobId]??=[]).push(r)}
for(const [j,rs] of Object.entries(byJob)){
  const s={decode_ms:0,mask_ms:0,encode_ms:0};for(const r of rs)for(const k in s)s[k]+=r[k]||0;
  console.log(j,"frames",rs.length,JSON.stringify(Object.fromEntries(Object.entries(s).map(([k,v])=>[k,+v.toFixed(0)]))));
}' perf_*.jsonl
```

And the concurrency facts:

```sh
grep '"stage":"apply.env"' perf_*.jsonl | tail -1
```
