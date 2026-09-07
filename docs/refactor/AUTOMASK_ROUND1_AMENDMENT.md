# Auto-mask — Amendment to `AUTOMASK_ROUND1_PROPOSAL.md` (decisions + Round 2 shape)

**Date:** 2026-09-04. **Applies to:** `docs/refactor/AUTOMASK_ROUND1_PROPOSAL.md` (main @ `dc45954`).
**Verdict on the proposal:** accepted with the amendments below. Recon, spike, and T2 verdict stand as written.

---

## 1. Decisions ratified

| # | Decision | Status |
|---|---|---|
| D1 | First proposal = **T0-bound + T1 only**. T0 is never the mask by itself. | **Ratified** |
| D2 | T2 (static-overlay subtraction): measured, not adopted. | **Ratified.** Do not revisit unless a leak appears that density+opening+T0 cannot remove. |
| D3 | T2max: not in Round 2. | **Amended** — re-run in the D5 evaluation in a constrained *extend-only* form (§3). Still not in Round 2 code. |
| D4 | Placement (a): in-process Node, pure-TS core in `shared/automask/`, `worker_threads`, lazy on first `GET …/proposal`, cached in `temp_extracted/<jobId>/automask.json`. | **Ratified** |
| D5 | Re-run with Andre's masks before Round 2 code. | **Ratified, and re-shaped**: references come from the local sandbox (§4), not from a one-off dump. |
| D6 | Strict rule unmeetable; tolerant rule reported post-hoc. | **Ratified.** The tolerant rule is now the pre-committed criterion for D5: **IoU ≥ 0.90 and leak_core6 ≤ 1 %**, 2-px margin kept. Committed here, before any of Andre's masks exist. |

Confidence: **keep the number and keep the displayed grade** (Andre's call). But §5 changes what the grade is allowed to say.

## 2. Round 2 is split

**Round 2A — proposer, no UI.** `shared/automask/{core,fan,geometry}.ts`; `server/services/automask.ts` (worker, cache, frame resolution via the frames-endpoint branches); `GET /api/jobs/:jobId/template-mask/proposal`; `[PERF] automask.done|skipped`; `AUTOMASK` flag default 0. **Plus** the fixture test (TS core reproduces the Python keep-regions to IoU ≥ 0.98 on the 14 spike frames, PHI kept out of git) and the evaluation script in §4. Verifiable with `curl` and the `[PERF]` tail; the spoke is untouched. Deployable and revertable on its own.

**Round 2B — spoke UX.** Proposal layer, bar, Accept/Edit/Dismiss, depth control (§3). Its step-1 recon gate: prove `fabric.util.object.clone` preserves `fillRule:'evenodd'` on a `fabric.Path` and that `updateMaskFromCanvas` rasterises the evenodd path correctly (the §5.3 assumption). If it does not, the raster fallback in §5.3 is the design, stated up front — not discovered mid-implementation.

2B does not start until 2A is deployed *and* D5 passes (§4).

## 3. Depth control replaces the "edit only adds" gap

The proposal's Edit only unions shapes; nothing subtracts. Over-blank of the far field is the dominant failure (Butterfly 11–41 %). So 2B adds a **depth control on the proposal bar** that edits the *parametric shape before Accept*:

- **Fan model:** vary `r_out` only. Apex, `th_l`, `th_r`, `r_in` fixed. Sides extend along their own lines; the top arc does not move; the bottom stays an arc centred on the apex. (Andre: "slide along the cone on both sides, angles unchanged, bottom keeps its curve" — that is exactly this.)
- **Poly model (trapezoid / linear / virtual-convex):** extend the two side edges along their fitted lines and translate the bottom edge with them; the bottom keeps whatever form the fit gave it (straight for linear, arc for virtual-convex).
- Range: from the fitted `r_out` down to `r_in + 10 %` and up to the frame edge (or the T0 bound when present — the bound is hard in both directions). Step 1 px at full res. Live re-render of the layer while sliding.
- The control edits only depth. It cannot change angles, apex, or the near field. Everything else the user wants is Edit (union) or Dismiss (redraw).
- Log the delta (`r_out_user − r_out_fit`) in the telemetry line; that number is the tuning signal for the far-field completion (`R_PROFILE_MIN`) and for the extend-only T2max decision.

**Extend-only T2max (D5 evaluation only, not Round 2 code):** compute the max projection at `ready`; allow it to *increase* `r_out` of the T1 fan (or move the poly bottom edge outward) and nothing else. Report it as a fourth tier in the results table. It is additive with T1 by construction and cannot add side leak. If it moves the tolerant count on Andre's clips, it becomes a 2C candidate offered at `ready`, never auto-applied.

## 4. D5 = local sandbox, and it doubles as the tuning loop

There is no ML; "training" here is parameter tuning against Andre's corrections. That happens locally, not on AWS: no deploy per iteration, no PHI leaving the Mac, and every drawn or edited mask lands in the local `jobs.mask_data`, which *is* the reference set.

**Recon before 2A (answer with `file:line`):**
1. Can the app run locally today? What `DATABASE_URL` does dev expect; is there a `docker-compose` or a documented local Postgres path; do migrations run against it? Prod RDS is **not** to be used. Is ffmpeg/ffprobe on the Mac path for the server, or only imageio-ffmpeg's bundle?
2. Does `npm run dev` serve client and server together, and does the frames endpoint work on a local `temp_extracted/`?
3. Anything else that blocks a clean local upload → draw → apply cycle (S3? PostHog? Socket.IO CORS with `ALLOWED_ORIGINS` unset?).

**2A deliverable — `scripts/automask_eval/`** (shipped, not throwaway): for every job in the local DB with both `automask.json` and `mask_data`, reconstruct the user's final keep-region from `mask_data.canvasDataUrl`, score the proposal (IoU, leak, over-blank, `_core6`, plus `r_out` delta when the depth control was used), and print the results table. Run with one command. This is the D5 harness and the permanent tuning loop.

**D5 procedure (Andre, local, `AUTOMASK=1`):** upload the seven kickoff clips (`Normal Lung sliding 2.mp4`, `Kidney.mp4`, Butterfly export, cart-vendor MP4 with a scale bar touching the fan edge, single-frame DICOM, multiframe DICOM, PNG still), draw or correct a mask on each, Apply. Run the eval. **Pass = ≥ 5/7 positive clips meet the tolerant rule** with the fitted `r_out`; report separately how many pass *after* the depth delta, since that is what 2B will deliver. Until 2B exists, Andre corrects by drawing; the eval still works because it scores against the final mask.

Fail → tune in the spike with Andre's masks as references (a re-run is seconds), port the change to the TS core, re-run the fixture test, re-run D5. No 2B until pass.

## 5. Confidence: kept, but honest

The grade is shown. Two constraints:
- `conf` measures fit-to-support, not fit-to-cone: bfly_z7 scored 0.81 at 41 % over-blank. Until telemetry exists, the displayed words are **"Proposed"** (≥ 0.70) and **"Proposed — check the depth"** when `masked_frac` is high for the model *or* the far-field completion stopped at the first gap within 30 % of `r_in`→frame edge (the agent picks the concrete signal from the spike's components and states it). No "High".
- Telemetry (backlog item 7) is pulled into **2B**, not later: Accept / Edit / Dismiss / depth-delta as one `[PERF] automask.outcome` line per job. The grade thresholds get set from that, not from n = 11.

## 6. Independent of this round — verify first

**Backlog item 5** (`processDicomPixelDataHelper` writes `channels: 1` unconditionally; an RGB multiframe DICOM would extract as garbage). Andre to supply a colour-Doppler cine if one exists; Claude Code to confirm or clear the bug with that file *before* 2A, as its own item with its own revert. Not blocked on automask; possibly wrong in prod today.

## 7. Invariants (unchanged)
`tsc --noEmit` = 12 · A3 frozen (`automask.json` on disk only) · masked 0-indexed / raw 1-indexed · reuse guard, `extractAllFramesSequential`, DICOM branch, `buildApplyMask`, apply loop, frame naming, extraction untouched · one flag, one deploy per round, one `git revert` · measure at production shape before believing any millisecond.

---

## Message for the Claude Code session

> Read `docs/refactor/AUTOMASK_ROUND1_AMENDMENT.md` (this file) against your proposal. Decisions are settled: T0-bound + T1 first proposal; T2 dropped; placement (a); tolerant rule pre-committed for D5; Round 2 split into 2A (proposer + endpoint + eval script, flag off, no UI) and 2B (spoke UX with the parametric depth control, §3). Before 2A code: (1) answer the local-sandbox recon in §4 with `file:line`, and (2) verify or clear backlog item 5 with the colour-Doppler cine Andre supplies, as a separate item. Then the 2A proposal: file list, the `automask_eval` output format, the fixture-test plan, and the `[PERF]` lines. No 2B work until 2A is deployed and D5 passes. `tsc` stays 12.
