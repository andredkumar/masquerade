# Output Round 1b — step 1: the crop's cost, measured serially (stop for sign-off)

**Status:** measurement, 2026-09-23, on `main` @ `2dea93e`, sandbox (M4). Answers `OUTPUT_ROUND1B_KICKOFF.md` §2. **No server code changed.** One file added: `scripts/output_eval/serial_bench.ts` (the measurement tool, reused for step 2's before/after). No fix built.

## 0. Headline — the decision rule

| measurement (serial: `UV_THREADPOOL_SIZE=1`, `sharp.concurrency(1)`) | Letterbox · Original, reference clip, accepted cone |
|---|---|
| the crop's added cost inside the fused pipeline (`enc_new − enc_old`, 348 frames) | **0.41 ms/frame** (+10 % of a 4.00 ms encode) |
| the transform executed on its own (`extract` + `extend` materialized) | 0.78 ms/frame |
| end to end, server A/B on the same job (current vs `c909d36` worktree, 3 applies each) | **3 168 vs 3 003 ms `apply.done`** → +165 ms = 0.47 ms/frame |

**Rule (§2.3): serial `transform_ms` ≥ 3 ms → build F1. Measured 0.41–0.78 ms → F1 is not built. F2 still goes.** Scaled to prod at 3–5×, the crop costs 1.2–2.4 ms/frame, i.e. **0.4–0.8 s of the 2.85 s prod regression.** The rest is not produced by the Output Round 1 code under serial conditions (§3).

## 1. The kickoff's timing split cannot be done by moving a boundary

sharp builds a lazy libvips pipeline: `applyOutputTransform()` records `extract` / `extend` and returns; the pixel work runs inside the later `.jpeg().toBuffer()`. So a `perfSpan` boundary around the call times the graph build — **0.03 ms/frame** — and the decision rule would read "< 3 ms" whatever the crop really cost. The harness shows it directly (`naive` row). Timing the transform on its own requires materializing it (`.raw().toBuffer()` then a second pipeline for the encode). That is byte-identical to the fused pipeline (**348/348 frames**) but costs 0.78 + 3.92 = 4.70 ms against 4.41 ms fused: **the instrument would cost ~0.3 ms/frame, most of what it measures.** I therefore added no `transform_ms` to `apply.frame`. The two valid measures are the fused delta (harness) and the end-to-end A/B (servers), and they agree.

## 2. Numbers

**Harness** (`serial_bench.ts`: the batch path's per-frame steps replayed one frame at a time with the server's own `buildApplyMask`, `keepBbox`, `planOutputTransform`, `applyOutputTransform`; four variants per frame in rotating order). Job `506cd243` (Normal_Lung, 1536 × 796, 348 frames); mask = the auto-mask cone as prod's P4 row applied it; keep bbox (268, 0) 996 × 796 → offset (270, 0).

| step, ms/frame | Original | 512 × 512 |
|---|---|---|
| decode | 3.42 | 3.48 |
| mask (offsets loop, 680 420 px) | 0.74 | 0.77 |
| `enc_old` — `c909d36`: no resize at Original; whole-frame contain at 512 | 4.00 | 3.05 |
| `enc_new` — `2dea93e`: crop fused into the encode | 4.41 | 2.91 |
| **`enc_new − enc_old`** | **+0.41** | **−0.13** |
| transform materialized alone | 0.78 | 2.41 |
| naive boundary (graph build) | 0.03 | 0.02 |

At 512 × 512 the crop makes the apply slightly cheaper: it resizes a 996-px keep instead of the 1536-px frame.

**Servers** (current tree on :5001, `c909d36` worktree on :5002, both with `UV_THREADPOOL_SIZE=1` and sharp forced to 1 by a `NODE_OPTIONS=--import` preload — no code change; batch size 1; same job, same mask, alternating; `apply.env` confirmed `uv_threadpool 1, sharp_concurrency 1`; `apply.source reuse` every time).

| | current `2dea93e` | `c909d36` |
|---|---|---|
| `apply.done` ms | 3 252.6 / 3 138.8 / 3 113.3 (mean **3 168**) | 3 027.5 / 3 025.5 / 2 955.1 (mean **3 003**) |
| `apply.frame` wall means: decode / mask / encode | 598.1 / 0.77 / 1 363.6 | 596.4 / 0.76 / 1 282.9 |

The `apply.frame` wall means are queue waits, not costs: all 348 frames are in flight on one thread (batches run under `Promise.all` whatever the batch size), so a 3.4 ms decode reads 598 ms. They agree with the harness on one point: **decode and mask are identical across the two trees.**

## 3. Where the rest of the prod regression is not

The kickoff's own §0 table shows prod `decode_ms` +11 % and `mask_ms` +94 % alongside `encode_ms` +15 %. Output Round 1 does not touch decode or the mask loop, and the serial runs confirm it (598.1 vs 596.4; 0.77 vs 0.76). A slowdown that lifts decode and mask as well as encode is a box condition, not this diff. Candidates, all prod-side and unverifiable here:

- **CPU credits.** `t3.large` is burstable (`CLAUDE.md` infra facts): a depleted `CPUCreditBalance` throttles every stage evenly.
- **Concurrent work** during the 11.4 s applies: another job's extraction, an auto-mask proposal at `ready`, the 1a hotfix build.
- **x86 vs arm64 libvips.** If `extend` is much slower on the prod CPU than on the M4, the 3–5× scaling understates it. §5.1's harness run on prod settles this in ten seconds.

## 4. Keep mode — the F2 baseline, and a corrected expectation

A synthetic 1920 × 1080 frame with a 225 × 152 keep (the shape of prod job `57d4fe30`), serial:

| | M4 serial |
|---|---|
| masked offsets, all / inside the keep bbox | 2 039 400 / **0** |
| offsets loop per frame, all → bbox-filtered (F2) | **3.36 → 0 ms** |
| `buildApplyMask` (once per apply; untouched by F2) | 267–317 ms |

F2 removes 46 × 3.36 ms ≈ 0.15 s on the M4, **≈ 0.5–0.8 s on prod**. The prod gap on that job is 2.2 s (Keep 4 256 ms vs Remove ~2 000 ms), of which **1.55 s is `apply.mask_build`** (1 810 vs ~260 ms), which F2 does not touch (kickoff §5 keeps it out of scope). **Expect Keep after F2 ≈ 3.5–3.8 s on that job, not "≈ 2.0 s + a bbox-proportional term"** (kickoff §1). The difference is the mask build.

## 5. Decisions for sign-off

| # | question | recommendation |
|---|---|---|
| D1 | F1 (original-size row-copy fast path) | **Not built**, per the pre-committed rule (0.41 ms < 3 ms). Revisit only if §5.1's prod harness run reads ≥ 3 ms fused. |
| D2 | `transform_ms` in `apply.frame` | **Drop it.** A moved boundary measures 0.03 ms; a materialized split costs ~0.3 ms/frame. `encode_ms` stays documented as "transform + encode". |
| D3 | step 2 scope | **F2 only**: filter `maskedOffsets` to the keep bbox once per apply (after the plan); unit test filtered vs unfiltered → identical output frame; `check.ts` geometry re-run; harness before/after. Keep expectation amended per §4. |
| D4 | prod checks before step 2 locks its expectations (Andre, ~10 min) | (1) the harness on prod against a fresh reference job: `UV_THREADPOOL_SIZE=1 npx tsx scripts/output_eval/serial_bench.ts --job <id> --server http://localhost:<port> --concurrency 1` (reads `temp_extracted/`, fetches the proposal, writes nothing); (2) P4 twice back to back on a quiet box; (3) CloudWatch `CPUCreditBalance` over the 11.4 s window. |
| D5 | the `CLAUDE.md` working-loop rule (kickoff §6) | Keep it, reworded to what was measured: **"Per-frame perf rows run serially (`UV_THREADPOOL_SIZE=1`, sharp concurrency 1) or on prod, and time executed work: sharp pipelines are lazy, so a boundary around pipeline construction measures nothing, and per-frame wall means under a shared queue are waits, not costs."** Here the M4's parallelism hid a ~5 % cost, not a 34 % one. |

## 6. Reproduce

```bash
cd ~/Desktop/Masquerade/masquerade-aws-latest
UV_THREADPOOL_SIZE=1 npx tsx scripts/output_eval/serial_bench.ts --job <reference job> --concurrency 1 --size original --mode letterbox
```

The server A/B used three throwaway helpers (session scratchpad, not in the tree): a `NODE_OPTIONS=--import` preload that pins `sharp.concurrency` to 1 regardless of `server/index.ts:123`, an alternating-apply driver, and a log parser. The `c909d36` worktree shared `node_modules` and `temp_extracted/` by symlink; servers were stopped with SIGKILL so the SIGTERM sweep could not delete the shared frames. Raw tables: `sandbox/results/2026-09-23_output_round1b_serial_v2.md`. The reference job `506cd243` is still extracted in the sandbox for step 2.
