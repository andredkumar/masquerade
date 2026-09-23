# Output Round 1b — kickoff: the apply cost of the crop, measured then removed

**Status:** kickoff, 2026-09-23, against `main` @ `2dea93e` (Output Round 1 deployed; 1a client hotfix in flight, independent). **Executor:** Claude Code. **Step 1 is a measurement with a pre-committed decision rule (§2), then stop for sign-off; step 2 builds and stops after `OUTPUT_ROUND1B_REPORT.md` for the runbook.** Server only. One commit, one `git revert`.

## 0. What prod measured (2026-09-23, reference clip 1536 × 796, 348 frames, all `apply.source: reuse`)

| | 2B-2 (`8c689870`, 2 applies) | Output Round 1 (`8d042c32`, 3 applies) | Δ |
|---|---|---|---|
| `apply.done`, Letterbox · Original | **8 512.9 ms** | **11 362 / 11 402 ms** | **+34 %** |
| `apply.frame` mean wall (n = 696 / 1044): decode / mask / encode | 523.1 / 8.4 / 1083.9 | 579.4 / 16.3 / 1247.5 | +56 / +8 / **+164** |
| Keep-mode apply, 46 frames 1920 × 1080, drawn 225 × 152 (`57d4fe30`) | — | **4 256 ms** vs 1 991 / 2 137 ms for Remove on the same job; `apply.mask_build` 1 810 ms vs ~260 | **≈ 2×** |

Reading: `encode_ms` is "resize + encode" and now contains the per-frame `extract` + `extend` that centres the keep; on one physical core that is ~10 ms CPU per frame, ≈ 3.5 s over the clip — the whole gap, within contention noise. The sandbox reported "no cost" (1094 vs 1196 ms) because the M4 absorbs ~10 ms of extra per-frame work in parallelism; **prod cannot.** Keep mode is slow for a different reason: the apply blanks by walking `maskedOffsets`, which in Keep mode is ~98 % of the frame — two million entries per frame, and the `extract` a step later throws almost all of that work away.

## 1. The two fixes (design; §2 decides whether the first one is built)

**F1 — `original`-size fast path (no sharp pipeline).** When `plan.resampled === false` and output dims equal source dims (Letterbox and Centre Crop at Original Size — identical by design), produce the output raw buffer by **row copy**: allocate a zeroed frame-sized buffer, copy the bbox rows from the masked frame at the planned offset (`Buffer.copy`, one call per row, ~1 ms/frame), then encode from raw exactly as before. When the bbox is the full frame and the offset is (0, 0), skip the copy entirely (today's Remove-mode common case). The sharp `extract` → `extend` path stays for every other case. **The fast path must be pixel-identical to the sharp path** — unit test on a synthetic gradient with a non-trivial bbox: both buffers equal, byte for byte.

**F2 — offsets filtered to the keep bbox.** Once per apply, after the plan: `maskedOffsets = maskedOffsets.filter(inBbox)`. Every offset outside the bbox is discarded by the crop anyway, so this changes no output pixel; it makes the mask loop cost proportional to the bbox instead of the frame. `buildApplyMask` (`:628-672`) is **not** edited — the filter is a pass over its result in the plan step. `apply.mask_build` itself (1.8 s in Keep) is the offsets build inside `buildApplyMask`; it stays as is this round and is noted (§6).

Expected after both: reference clip Letterbox · Original back to **≤ 8.7 s** (the only new per-frame work is gone); Keep on the 46-frame job **≈ 2.0 s + a bbox-proportional term**.

## 2. Step 1 — measure at production shape, with a decision rule

The sandbox measurement that cleared this round was wrong because of parallelism, so 1b measures where parallelism can't hide it:

1. **Split the timing.** `apply.frame` gains `transform_ms` (the extract/extend, or the row copy) separated from `encode_ms`. One `perfSpan` boundary moved; no behaviour change.
2. **Serial sandbox run.** The reference clip, Letterbox · Original, JPEG, on the current tree with `sharp.concurrency(1)`, `UV_THREADPOOL_SIZE=1`, batch size 1 (env-driven for the run, not committed as defaults) — per-frame `transform_ms` and `encode_ms` means; then the same on a `2dea93e~1` (= `c909d36`) worktree for `encode_ms` alone. Serial numbers on the M4 are still ~5× faster than prod, but the *ratio* transform : encode transfers.
3. **Decision rule, pre-committed:** if serial `transform_ms` ≥ 3 ms/frame → F1 is justified, build F1 + F2. If < 3 ms → the regression is somewhere else in the Output Round 1 hunks (§6 of its report lists them); **stop, report the numbers, do not build F1** — F2 still goes (it is correct regardless). Report the serial numbers either way.

## 3. Test matrix (runbook rows)

| axis | rows |
|---|---|
| identity | unit: fast path vs sharp path byte-identical on the synthetic gradient at three bboxes (interior, touching the left edge, full frame); F2 filtered vs unfiltered offsets → identical output frame (the crop discards the difference) |
| geometry | `scripts/output_eval/check.ts` re-run: all 24 rows still ✅ with reference diff 0 (the reference now goes through the fast path where it applies — say so) |
| serial perf (sandbox) | §2.2 numbers before / after F1: `transform_ms` after ≤ 1 ms/frame on the `original` rows; unchanged on the 256 / 512 / custom rows |
| Keep (sandbox, serial) | the 225 × 152 Keep drawing on a 1920 × 1080 clip: `mask_ms` after ∝ bbox (expect < 1 ms/frame vs ~15); output identical to before |
| prod (runbook) | reference clip Letterbox · Original: `apply.done` ≤ 8.7 s; Keep on `57d4fe30`-style job ≈ Remove + small; `apply.frame` `transform_ms` ≈ 0–1 ms on `original` rows |
| invariants | `tsc` 12; Output Round 1 + automask tests green; `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, extraction, reuse guard, `automask*.ts` untouched; `apply.output` line unchanged (the plan does not change, only its execution) |

## 4. Constraints
`tsc` 12 · A3 frozen · `buildApplyMask` untouched (F2 filters its output) · the `output_transform` sidecar and manifest bytes unchanged · no new dependencies · one commit, one `git revert` · the serial-mode env settings are for measurement only and are not committed as defaults.

## 5. Out of scope
The `apply.mask_build` cost in Keep mode (building 2 M offsets — a `buildApplyMask` change, own round if Keep becomes common); the decode-dominated apply profile (`decode_ms` 500+ ms wall under contention has been the ceiling since Round 1 perf; separate); 1a (client).

## 6. For the report and `CLAUDE.md`
A one-line rule for the working loop, recorded at close-out: **per-frame perf rows run at concurrency 1 or on prod; the M4's parallelism hides per-frame CPU.** The sandbox's "no cost" in Output Round 1 was a measurement failure of this kind, and the runbook's ±10 % gate on `apply.done` is what caught it.

---
> Continuing Masquerade (bring `CLAUDE.md`). Output Round 1 is deployed (`2dea93e`); prod shows `apply.done` 11.4 s vs 8.5 s on the reference clip (reuse both times) and Keep-mode applies at ~2× Remove. New round: **Output Round 1b** per `OUTPUT_ROUND1B_KICKOFF.md`. Step 1: split `transform_ms` out of `encode_ms` in `apply.frame`, run the reference clip serially (`sharp.concurrency(1)`, `UV_THREADPOOL_SIZE=1`, batch 1) on the current tree and on a `c909d36` worktree, and apply the §2.3 decision rule — then stop for my sign-off with the numbers. `tsc` 12, A3 frozen, `buildApplyMask` untouched, no fix before the measurement.
