# Auto-mask Round 2B — sign-off on the recon + proposal (2026-09-07)

**Input:** `AUTOMASK_ROUND2B_RECON_PROPOSAL.md`. **Decision:** approved. **Go for 2B-1 now; 2B-2 after 2B-1 is green on prod.**

## 1. The seven decisions

| # | question | decision |
|---|---|---|
| 1 | Worker | **Dedicated entry + second esbuild entry + `tsx` bootstrap**, exactly as §1.1. The kickoff's "reuse `maskWorker`" was wrong (dead code, self-spawn); recorded here so nobody re-reads the kickoff and tries it. `maskWorker.ts` stays untouched; `tsc` 12. Add to the build row: `ls dist/` after `npm run build` must show both files, and the deploy runbook copies nothing by hand. |
| 2 | T0 persistence | **`temp_extracted/<jobId>/t0.json`.** Captured at upload from the dataset already in memory at `frameExtractor.ts:50`; `boundFromDataset` shared with `readDicomBound`. |
| 3 | Accept semantics | **(a) Accept sets the mask; Apply stays the user's click.** Reasons: output settings remain a deliberate choice, the apply contract and `ProcessingControls` stay untouched, and the outcome line fires on Apply, which is the real "committed" moment. One extra click is the right price for a de-identification step. |
| 4 | Outcome sink | **Server `[PERF]` via the flag-gated POST.** One sink, joinable by `jobId` with `automask.done`, present in the sandbox. Stores nothing (2C decides). |
| 5 | Flag surfacing | **`ui_enabled` on the proposal body**, additive. |
| 6 | D5 | **The surrogate stands as the pre-UI number (4/7 = bench).** Andre draws live as part of the 2B-2 test matrix (the Retina row and the Accept → Apply equivalence row), not as a separate gate. |
| 7 | Order | 2B-1 (~1 day) → runbook from me → deploy → measure §2.8 on prod → 2B-2 (~3 days) → runbook → deploy behind `AUTOMASK_UI`. |

## 2. Two rows added to the 2B-1 test matrix (§2.7)

- **Apply immediately after `ready`.** Users click fast. On the reference clip, click Apply within ~2 s of `ready` so the worker's ~1.5 s proposal overlaps the apply's `sharp` threads on the one physical core. Report `apply.done` against the 8.7 s baseline. Expected: a bounded slowdown (≤ ~1.5 s), never a failure; if it's worse, the enqueue moves to "after `ready` + 2 s" — one constant, not a redesign.
- **Cold worker on the first job after restart.** `pm2 restart` → first upload → `worker_spawned` logged once, `ms_propose` includes spawn; second job has no spawn. Both numbers in the report.

## 3. Notes for the 2B-1 report
- §2.8's stall measurement (20 Hz `GET /api/jobs/:id` across a proposal, max latency, target < 50 ms) is the headline number — put it first.
- `info.t0_from` and `trigger` land in the eval's `--db` join so D5-style runs can tell ready-triggered from lazy.
- Known-limitations carried forward unchanged (Butterfly parametrisation, the two model-type misses → B7).

## 4. Backlog acknowledged (not 2B's)
- `MaskingCanvas.tsx:917` export canvas without `enableRetinaScaling:false` → 2× PNG payloads on Retina. Verify once on prod (Andre is on a Mac; look at `mask_data.canvasDataUrl` size on a recent job), then a one-line fix, own commit. Not before 2B-2, since 2B-2's Accept path must behave identically to the brush path it reuses — fix both at once, later.
- `package.json` `fabric ^6.7.1` unused vs CDN 5.3.0 — remove or pin, own commit, after 2B-2.
- `maskWorker.ts` deletion (#23), `--jobs` filter for `run.ts --db`.

## 5. Invariants (unchanged)
`tsc` 12 (the same 12) · A3 frozen · `buildApplyMask`, apply loop, reuse guard, extraction untouched except the read-only T0 addition at `:50` · `maskWorker.ts` neither imported nor edited · one flag per deploy · one `git revert` each · measure at production shape · nothing PHI-bearing committed.

---
> `AUTOMASK_ROUND2B_SIGNOFF.md`: all seven decisions taken — dedicated worker entry + second esbuild entry + `tsx` bootstrap; `t0.json`; Accept sets the mask and Apply stays a click; outcome as a server `[PERF]` line via the gated POST; `ui_enabled` on the body; D5 surrogate stands; 2B-1 first. Two rows added to the 2B-1 matrix (Apply within 2 s of `ready`; cold worker after restart). Build 2B-1 exactly per your §2 with §2 of the sign-off, `tsc` 12, A3 frozen, and stop after `AUTOMASK_ROUND2B1_REPORT.md` for the runbook.
