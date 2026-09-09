# Auto-mask Round 2B — kickoff: the proposal becomes the template-mask entry

**Status:** kickoff, 2026-09-07, against `main` with item 5 + 2A deployed (`AUTOMASK=1` on prod via pm2 env). **Executor:** Claude Code. **Recon + proposal first; no production code until sign-off.**
**Requirements:** `AUTOMASK_ROUND2B_2C_KICKOFF_DRAFT.md` §B, **B1–B7 verbatim** — they are Andre's, from the bench sessions; do not re-interpret them. This document adds what prod measured after that draft was written.

## 0. What prod changed since the draft

| prod fact | consequence |
|---|---|
| `ms_propose` **1463 ms** on a 1920×1080 frame cold, **701 ms** on 1164×873 warm (t3.large, one physical core) | The proposer **cannot run on the main thread** once the spoke calls it: a 0.7–1.5 s stall freezes every other request. It runs in a worker. `maskWorker.ts` already exists (its 7 parked `tsc` errors are the ones in the count), so the worker build path is not new — reuse that mechanism, not a second one. |
| `pm2 restart` purges `uploads/`; the 2 h sweep does the same later. A DICOM job proposed after that → `bound_source: unavailable` → GE E9 degrades trapezoid → rectangle, cached (seen on prod, job `438a9d4f`). | The `(0018,6011)` box is read **at extraction time** and persisted with the frames (`temp_extracted/<jobId>/t0.json` or a field in the existing per-job metadata — recon Q3 decides). The proposal is computed **at `ready`**, never lazily on first open. Lazy compute stays only as the fallback for jobs that predate 2B. |
| `AUTOMASK=1` reaches the process only via pm2's environment, not `.env` | 2B's UI gate is a second flag **`AUTOMASK_UI`** (default off), set the same way; documented in the runbook as `AUTOMASK_UI=1 pm2 restart masquerade --update-env && pm2 save`. |
| The grade bands flag the reference clip and most GE trapezoids as `check_depth` (set on n = 26) | 2B shows the grade words from B-side copy ("Proposed" / "Proposed — check the depth") and **logs** everything (B5); the thresholds move only from telemetry, after 2B ships. |

## 1. Split — two deploys

**2B-1 — server, no UI.** Compute at `ready` in the worker; T0 captured at extraction; `automask.json` written before the job is marked `ready`-complete *or* immediately after (recon Q2 says which is safe without touching the A3 status machine); lazy fallback kept; PERF lines gain `trigger: 'ready' | 'lazy'` and `worker_ms`. Verifiable with `curl` + log tail; identical user experience. Flag: `AUTOMASK=1` (already on).

**2B-2 — the spoke.** B1–B3 + B7 on `template-mask-spoke.tsx` / `MaskingCanvas.tsx`, behind `AUTOMASK_UI`. Telemetry B5. Blank canvas on any failure.

2B-2 does not start until 2B-1 is green on prod.

## 2. Recon (answer with `file:line`, stop for sign-off)

1. **Worker.** How `maskWorker.ts` is built and spawned (esbuild entry? `new Worker(new URL(...))`? `workerData` shape?), how it is pooled or one-shot, how errors/timeouts come back, and what the 7 parked errors are so none is "fixed" by accident. Can `propose(gray, w, h, bound)` ride the same entry with a message type, or does it need its own file on the same build path?
2. **`ready` hook.** Where `bg_extract.done` sets the job ready and emits the socket event; the safe point to enqueue the proposal so (a) `ready` is not delayed, (b) A3 is untouched, (c) the DICOM batch path and the MP4 path both hit it. Image-batch jobs: same hook or the upload handler?
3. **T0 capture.** Where in the DICOM extraction path `naturalizeDataset` already runs (item 5 touched it) and whether reading `SequenceOfUltrasoundRegions` there is a read-only addition; where to persist it (`temp_extracted/<jobId>/t0.json` vs existing job metadata file) without a schema change; the 6 h raw-frame sweep must take it with the frames.
4. **Spoke data flow.** How `template-mask-spoke.tsx` gets frame 0 and when `MaskingCanvas` mounts; the mask contract on Apply (`canvasDataUrl` from `updateMaskFromCanvas`); whether a `fabric.Path` with `fillRule:'evenodd'` survives clone + rasterisation (the Round 1 §5.3 assumption — prove or fall back to raster).
5. **Coordinate space.** Canvas display scale vs frame pixels (the 75 % seen on 1164×873); where the scale factor lives so the proposal (full-res px) is drawn once, correctly.
6. **Telemetry sink.** Where `[PERF]` lines are emitted client-side today (item 20 / PostHog?) and whether B5's `automask.outcome` should be a server PERF line posted from the spoke or a PostHog event — one place, not both.
7. **D5 (the applied-mask eval, folded in here).** In the sandbox with `AUTOMASK=1`: upload the seven kickoff clips, Andre draws/corrects, Apply; `run.ts --db --server` scores the proposals against the applied masks. Report the table; this is the last pre-UI number and the first the telemetry will be compared to.

## 3. Proposal must contain
- 2B-1: worker plumbing (reuse), enqueue-at-`ready`, T0 capture + persistence, PERF lines, fallback rules, test matrix (rows: MP4, DICOM single, DICOM multiframe during extraction, image batch, restart between upload and open → still `T0T1`, worker crash → lazy fallback → `none/error`, two jobs finishing at once).
- 2B-2: the proposal layer and bar (Accept / Draw from scratch / model switch B7), the controls (B2, bench-v4 set), nudge ergonomics (B3), grade copy, `automask.outcome` line (B5 — the five deltas + `d_arc_px` + model switch + outcome), and the Accept → mask conversion with the evenodd proof or the raster fallback. Test matrix by family (fan / trap / rect), by outcome, and on withheld.
- Both: `tsc` 12 · A3 frozen · `buildApplyMask`, apply loop, reuse guard, extraction untouched except the read-only T0 addition · one flag per deploy · one `git revert` each · measure at production shape (the two prod numbers above are the baseline).

## 4. Out of scope (2C)
Template library / fingerprints (B4), temporal support (B6), accounts. 2B-2's Accept must *emit* the final parameters in the outcome line so 2C has them, but stores nothing.

---
> Continuing Masquerade (bring `CLAUDE.md`). Item 5 + Round 2A are deployed. New round: **2B — the proposal becomes the template-mask entry**, per `AUTOMASK_ROUND2B_KICKOFF.md` with the requirements B1–B7 from the 2B/2C draft verbatim. Prod measured `ms_propose` 1463 ms cold on 1080p, so the proposer moves into the existing `maskWorker` build path and runs at `ready`, with the DICOM region box captured at extraction (the restart purge downgraded a prod GE job to a rectangle). Two deploys: 2B-1 server-only, then 2B-2 the spoke behind `AUTOMASK_UI`. Step 1 is recon §2 with `file:line` — including D5 in the sandbox — then stop for my sign-off. `tsc` 12, A3 frozen, no production code before the proposal is approved.
