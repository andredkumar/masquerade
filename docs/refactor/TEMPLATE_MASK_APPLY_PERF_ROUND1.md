# Template-mask apply performance — Round 1: instrumentation only

**Status:** proposed 2026-08-30. Round 1 = measurement, no optimization.
**Owner:** Andre. **Executor:** Claude Code session on the repo, deploy to prod, Andre runs the test matrix.

---

## 1. Why this round exists

Applying the template mask to all frames is slow. The mask is a static shape, so the pixel math is
trivially cheap; the time must be going somewhere else. From CLAUDE.md the apply path is:

```
POST /api/jobs/:jobId/template-mask/apply
  → processVideo(jobId)
    → prepareCleanApplyStaging            (clear temp_extracted/<jobId>/_apply/)
    → extractAllFramesSequential          (ffmpeg re-decodes the ORIGINAL upload → PNG per frame into _apply/)
    → mask loop in stacks of ~10–15 frames (read PNG → mask → encode PNG → spokes/template_mask/<jobId>/)
    → status complete, progress emit
```

Three hypotheses, ranked by prior likelihood. **None is confirmed. This round exists to rank them with
numbers, not to fix any of them.**

| # | Hypothesis | Why suspected | What would confirm it |
|---|---|---|---|
| H1 | **Apply-time re-extraction dominates.** Frames already exist in `temp_extracted/<jobId>/` from upload; apply decodes the video again and PNG-encodes every frame a second time before masking starts. | Documented in CLAUDE.md ("double extraction", DICOM diagnosis). PNG encode is the most expensive per-frame CPU step in the pipeline. | `extract_all` wall-clock ≥ ~40% of total apply time. |
| H2 | **Mask loop is not actually parallel** (or is capped by libuv threadpool = 4 / sharp concurrency), so stack size is irrelevant. | Batch-of-15 with `Promise.all` still serializes on a 4-thread pool; DICOM path is `await`-in-a-loop. | Per-stack time ≈ sum of per-frame times (sequential), or per-stack time flat when stack size changes. |
| H3 | **PNG encode of masked output dominates the mask loop**, not the mask arithmetic. | zlib at default level on full-res frames. | `encode_ms` ≫ `mask_ms` within a stack. |

Plus one **workflow audit** (not a timing question): the original UX design was *upload → show frame 1
immediately → user draws the mask while the rest extracts in the background → apply*. CLAUDE.md
suggests the hub currently gates all spoke tiles on `job.status === 'ready'`, i.e. after **full**
extraction — which would mean the draw-while-extracting step was never wired through the
code/uncode/recode passes. Round 1 should state, from source, whether that is true.

---

## 2. Hard constraints (unchanged from the perf handoff in CLAUDE.md)

- **Log-only.** No behavior change. No reordering, no batch-size change, no caching. If a probe requires
  restructuring code to place it, place it somewhere coarser instead.
- **tsc stays at 12.**
- **A3 storage/schema/status/shim/`migrations/` FROZEN.** Probes live in `frameExtractor.ts`,
  `videoProcessor.ts`, `maskWorker.ts`, the upload handlers, and `templateMaskApply.ts` only.
- **Do not touch** the DICOM additive branch in `extractAllFramesSequential`, the `[DEADROUTE-HIT]`
  instrument, or `temp_processed/` handling.
- **Measure on the deployed EC2 box, not the agent environment.** Agent-env numbers are directional only.
- Regression guard before deploy: MP4 smoke + single-frame `.dcm` + multiframe `.dcm` still apply and download.

---

## 3. Instrumentation spec

### 3.1 One helper, one log prefix

Add `server/services/perf.ts` (new file, ~30 lines):

```ts
// server/services/perf.ts
export function perfMark(jobId: string, stage: string, extra: Record<string, unknown> = {}) {
  console.log(`[PERF] ${JSON.stringify({ t: Date.now(), jobId, stage, ...extra })}`);
}

export function perfSpan(jobId: string, stage: string, extra: Record<string, unknown> = {}) {
  const t0 = process.hrtime.bigint();
  return (more: Record<string, unknown> = {}) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`[PERF] ${JSON.stringify({ t: Date.now(), jobId, stage, ms: +ms.toFixed(1), ...extra, ...more })}`);
    return ms;
  };
}
```

Every line is one JSON object after a fixed `[PERF]` prefix so it can be grepped out of `pm2 logs`
and pivoted with a one-liner. No new dependency, no env flag (it's cheap; remove in a later round
or gate behind `PERF_LOG=1` if it gets noisy).

### 3.2 Probe placement

**Upload path** (`routes.ts` upload handler, `videoProcessor.startBackgroundFrameExtraction`,
`frameExtractor`):

| stage | where | extra fields |
|---|---|---|
| `upload.multer_done` | first line of the upload handler (multer has finished) | `bytes`, `filename` |
| `upload.ffprobe` | span around the ffprobe call | `frames`, `w`, `h`, `fps` |
| `upload.response_sent` | just before `res.json(...)` | — |
| `bg_extract.start` | first line of `startBackgroundFrameExtraction` | — |
| `bg_extract.first_frame_on_disk` | when `frame_000001.png` exists (or first batch written) | `ms_since_start` |
| `bg_extract.done` | end, before status → `ready` | `frames`, `ms` (span from start) |

**Apply path** (`templateMaskApply.ts`, `videoProcessor.processVideo`, `frameExtractor`, `maskWorker`):

| stage | where | extra fields |
|---|---|---|
| `apply.request` | first line of the apply handler | `ms_since_bg_extract_done` if derivable from job record, else omit |
| `apply.staging_clean` | span around `prepareCleanApplyStaging` | — |
| `apply.extract_all` | span around `extractAllFramesSequential` | `frames`, `path` (`ffmpeg` \| `dicom`) |
| `apply.extract_frame` | **DICOM branch only**: span per `extractDicomFrame` | `i` |
| `apply.stack` | span per stack/batch in the mask loop | `stackIdx`, `stackSize`, `firstFrame` |
| `apply.frame` | span per frame inside a stack, split into sub-fields | `i`, `read_ms`, `mask_ms`, `encode_ms`, `write_ms` |
| `apply.done` | before final status update | `frames`, `total_ms` (span from `apply.request`) |

Per-frame lines (`apply.frame`, `apply.extract_frame`) are the noisy ones; that's fine for a
measurement round on one box with one user. If a frame's read/mask/encode/write aren't separable
without restructuring, log the whole frame as one `ms` and say so in the report.

**Also log, once per apply, the concurrency facts** (`apply.env`): `os.cpus().length`,
`process.env.UV_THREADPOOL_SIZE ?? 'default(4)'`, `sharp.concurrency()` if sharp is used, and the
stack size constant. These tell us whether H2 is even possible before we look at timings.

### 3.3 Workflow audit (source reading, no code)

Answer in the report, with file:line citations:

1. What does the template-mask spoke gate its interactivity on? (`job.status === 'ready'`, extraction
   progress, or existence of frame 0?)
2. What does the hub gate the Template Mask tile on?
3. Does `GET /api/jobs/:jobId/frames/0` return successfully mid-extraction (frame 1 written early), or
   only after extraction completes?
4. Conclusion: is "draw the mask while frames are still extracting" currently possible in the UI, yes/no.

---

## 4. Test matrix (Andre runs on prod after deploy)

| Case | File | Why |
|---|---|---|
| A | Small MP4 (~50 frames, e.g. Kidney.mp4) | baseline; fast enough to repeat 3× |
| B | Large MP4 (≥ 500 frames, highest-res clip on hand) | where slowness is felt |
| C | Multiframe uncompressed DICOM | DICOM branch timings (per-frame `await` loop) |
| D | Single-frame DICOM | sanity / regression guard only |

For each: upload → wait for `ready` → draw a mask → Apply → wait for complete → download once.
Run **A three times** to see variance. For **B, run Apply twice** on the same job (redo loop) —
the second apply isolates apply-path cost from any first-run disk-cache effects.

Collect logs:

```sh
pm2 logs masquerade --raw --lines 20000 | grep '\[PERF\]' | sed 's/^.*\[PERF\] //' > perf_$(date +%Y%m%d_%H%M).jsonl
```

Pivot (Node one-liner, no deps):

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

---

## 5. Deliverable of Round 1

`docs/refactor/PERF_ROUND1_REPORT.md` containing:

1. The wall-clock table per case: `upload.ffprobe`, `bg_extract.done`, `bg_extract.first_frame_on_disk`,
   `apply.extract_all`, sum of `apply.stack`, sum of `apply.frame.{read,mask,encode,write}`, `apply.done`.
2. `apply.env` facts (vCPUs, threadpool, sharp concurrency, stack size).
3. Verdict on H1 / H2 / H3, each marked **confirmed / killed / inconclusive** with the number that decides it.
4. The workflow-audit answers (§3.3).
5. **No recommendations beyond one sentence naming the biggest bucket.** Fix design is Round 2.

---

## 6. Kickoff message for the Claude Code session

> Continuing Masquerade (bring CLAUDE.md). Backend refactor through Phase 7A + the DICOM apply fix are
> deployed. Now: **template-mask apply is slow to propagate from frame 1 to all frames.** Per
> `docs/refactor/TEMPLATE_MASK_APPLY_PERF_ROUND1.md`, this round is **instrumentation only — no
> optimization, no batch-size change.** Add the `[PERF]` probes exactly as specified in §3 (new
> `server/services/perf.ts` + probe sites in the upload handler, `startBackgroundFrameExtraction`,
> `processVideo`, `extractAllFramesSequential`, and the mask loop), log the `apply.env` concurrency facts,
> and do the §3.3 workflow audit from source with file:line cites. tsc stays 12; A3 frozen; do not touch
> the DICOM branch, `[DEADROUTE-HIT]`, or `temp_processed/`. Before handing back for deploy, run the
> MP4 + single-frame DICOM + multiframe DICOM smoke tests. Output: a diff summary, the audit answers,
> and the exact `pm2 logs` + pivot commands from §4 for me to run on prod.
