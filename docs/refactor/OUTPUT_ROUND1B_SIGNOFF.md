# Output Round 1b — sign-off on step 1 (2026-09-23)

**Input:** `OUTPUT_ROUND1B_STEP1.md`. **Decision:** D1–D5 approved as recommended, D4 re-ordered (§2), one addition to D5 (§3). Step 2 = **F2 only**. Build, `tsc` 12, A3 frozen, `buildApplyMask` untouched; stop after `OUTPUT_ROUND1B_REPORT.md` for the runbook.

## 1. What step 1 corrected in the kickoff

Two errors of mine, both caught by the measurement:

- **§2.1's "move one `perfSpan` boundary" could not have measured anything.** sharp pipelines are lazy; a boundary around `applyOutputTransform()` times graph construction (0.03 ms/frame), so the pre-committed rule would have read "< 3 ms" whatever the crop cost. Step 1 measured the fused delta and an end-to-end server A/B instead, and the two agree: **the crop costs 0.41–0.47 ms/frame serially, ~5 % of the apply.** F1 is not built. The decision rule did its job.
- **The 34 % "regression" was never established.** The same clip on the *old* code produced 11 095 ms and 8 513 ms on consecutive applies (job `8c689870`, 2026-09-11) — I had noted that 11.1 s and then built the kickoff on the 8.5 s one anyway. The prod numbers are within the box's own run-to-run spread.

## 2. The prod explanation — the evidence is already in the log

`mask_ms` is the one field in `apply.frame` that is **not** a queue wait: the offsets loop is synchronous JS on the main thread, so its duration is a direct measure of how fast the CPU ran that loop. Output Round 1 has no hunk in it (report §6), and the serial A/B shows it identical across trees (0.77 vs 0.76 ms). On prod it went **8.4 → 16.3 ms/frame** between the 2026-09-11 and 2026-09-23 sessions on the same clip and a near-identical mask (675 k vs 681 k offsets). Identical work taking twice as long is the box running at half speed — CPU-credit throttling on the burstable `t3.large`, or contention from another process. (Hyperthread contention from the crop's extra libvips work could slow the main thread slightly, but 0.4 ms/frame of added work cannot explain an 8 ms/frame slowdown.)

**D4, re-ordered — cheapest and most decisive first:**
1. **CloudWatch → EC2 → the app instance → `CPUCreditBalance` and `CPUUtilization`, 1-minute resolution**, over two windows: **2026-09-11 18:55–19:10 PDT** (old code, 11.1 s then 8.5 s) and **2026-09-23 14:55–15:10 PDT** (new code, 11.4 / 10.0 / 11.4 s). Credit balance near zero in the second window and not the first settles it. Also note whether the instance is in *unlimited* or *standard* credit mode (EC2 → instance → Actions → Instance settings → Change credit specification).
2. **P4 twice back to back on a quiet box** (no upload in the preceding minutes). If both land ≤ 9 s, done.
3. The prod harness run (step 1 §5 D4.1) **only if 1 and 2 leave it open** — it answers x86 vs arm64 libvips, which the `mask_ms` evidence already makes unlikely to matter.

## 3. D5 — the `CLAUDE.md` rule, approved with one clause added

> Per-frame perf rows run serially (`UV_THREADPOOL_SIZE=1`, sharp concurrency 1) or on prod, and time executed work: sharp pipelines are lazy, so a boundary around pipeline construction measures nothing, and per-frame wall means under a shared queue are waits, not costs. **The exception is `mask_ms`, which is synchronous: if it moves between two runs of identical work, suspect the box (CPU credits, contention) before the diff.**

And two runbook conventions, both learned this week, for the close-out block:
- **Collect commands use `pm2 logs … --nostream`.** Without it pm2 never exits, and a `grep` feeding another pipe stage block-buffers ~4 KB that is lost on ^C.
- **Multi-stage live tails use `grep --line-buffered`** on every stage but the last.

## 4. Step 2 — F2, scoped

As step 1 §5 D3: filter `maskedOffsets` to the keep bbox **once per apply, after the plan**, in the batch path, the per-frame path, and the image setup (all four `keepBbox` sites — report §5.5 of Output Round 1). Unit test: filtered vs unfiltered offsets → byte-identical output frame at Original and at 256, Letterbox and Crop. `check.ts` 24 geometry rows re-run, reference diff 0. `serial_bench.ts` before/after on the Keep synthetic (expect the loop 3.36 → 0 ms) and on the reference clip Remove (expect no change — the bbox there is 65 % of the frame).

**Expectation, amended per step 1 §4:** on prod, Keep on the 46-frame 1920 × 1080 job ≈ **3.5–3.8 s** (from 4.26 s). The remaining gap to Remove is `apply.mask_build` building 2 M offsets (1.55 s), inside `buildApplyMask` — **out of scope, backlog** ("Keep-mode `buildApplyMask` cost: emit only in-bbox offsets; needs the pixel-equivalence proof, own round"). On the 348-frame reference clip a Keep apply saves proportionally more (~3–5 s on prod).

**Deploy:** F2 is server-only and independent of 1a (client-only). If 1a has not shipped yet, **one deploy, two commits** (one `git revert` each). Runbook rows: 1a §3 rows 1–2; a Keep apply on a 1080p clip (`apply.mask_build` unchanged, `apply.done` down); a Remove apply on the reference clip (`apply.done` within the box's spread of the prior run on the same job).

## 5. Invariants (unchanged)
`tsc` 12 · A3 frozen · `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, extraction, reuse guard, `automask*.ts` untouched · the `output_transform` sidecar and manifest bytes unchanged · `serial_bench.ts` committed as a tool; the preload / driver / parser helpers stay out of the tree · one commit, one `git revert`.

---
> `OUTPUT_ROUND1B_SIGNOFF.md`: step 1 approved — D1 F1 not built (0.41 ms < 3 ms), D2 no `transform_ms`, D3 **F2 only**, D5 the `CLAUDE.md` rule as you worded it plus one clause (`mask_ms` is synchronous, so a change between runs of identical work points at the box). D4 is Andre's and re-ordered (CloudWatch credits first). Build F2: filter `maskedOffsets` to the keep bbox once per apply at all four `keepBbox` sites; unit test filtered vs unfiltered byte-identical; `check.ts` 24 rows; `serial_bench.ts` before/after on the Keep synthetic and the reference clip; Keep expectation per your §4. `tsc` 12, A3 frozen, `buildApplyMask` untouched; stop after `OUTPUT_ROUND1B_REPORT.md` for the runbook.
