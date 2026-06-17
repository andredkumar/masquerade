# Phase 4b-0 FIX — Implementation Report

**Status:** Implemented in working tree, **not committed** (awaiting review).
**Baseline:** `npx tsc --noEmit` = **17 errors** before and after (10 `frameExtractor.ts` + 7 `maskWorker.ts`, all pre-existing). No new type errors.
**Test:** `server/services/__tests__/applyPaths.test.ts` — **5/5 passing** (GPU-free, real-fs).

---

## 1. What this fix actually addresses

The FIX kickoff was written against a hypothesis: that the second `processVideo`
run (the redo loop) re-suffixes the job dir into `temp_extracted/<jobId>/<jobId>/`
and that the `_apply/` cleanup deletes the parent raw frames.

Per `PHASE_4B0_FIX_PROPOSAL.md` (approved), both hypothesized defects were
**refuted** against the reverted commit `7bb7f8f`: the apply-time staging path
was already derived fresh from constants each call (`path.join(TEMP_EXTRACTED_DIR,
jobId, '_apply')`), and `safeDelete` was already bounded. The most likely real
cause was a **build/artifact mismatch** (the deployed bundle not matching the
committed source).

This fix therefore does **not** "repair a doubling bug" — it removes the
*possibility class* by making the path math a single pure source of truth and
making the apply-time delete *provably* unable to hit the persistent frames,
then locks both properties in with a regression test. This is §6 of the proposal
(A: re-land, B: pure helpers, C: hardened cleanup, D: GPU-free test).

---

## 2. Changes

### B. New pure, idempotent path helpers — `server/services/applyPaths.ts` (new)

Single source of truth for the 4b-0 layout. Every function is a pure transform
of `jobId`, derived fresh from `TEMP_EXTRACTED_DIR`:

- `rawFramesDir(jobId)` → `temp_extracted/<jobId>` (persistent raw frames)
- `applyStagingDir(jobId)` → `temp_extracted/<jobId>/_apply` (isolated apply pass)
- `cleanupApplyStaging(jobId)` → hardened delete of the `_apply` leaf only
- `APPLY_SUBDIR = '_apply'`

Idempotency is structural: the helpers never read job state, so repeated calls
return the identical string — nesting cannot accumulate.

### C. Wired into `server/services/videoProcessor.ts`, cleanup hardened

| Site | Before | After |
|------|--------|-------|
| `processVideo` staging (≈L296) | `path.join(TEMP_EXTRACTED_DIR, jobId, '_apply')` | `applyStagingDir(jobId)` |
| `processVideo` finally (≈L472) | `safeDelete(extractedFramesDir, TEMP_EXTRACTED_DIR)` | `cleanupApplyStaging(jobId)` |
| `startBackgroundFrameExtraction` (≈L1116) | `path.join(TEMP_EXTRACTED_DIR, jobId)` | `rawFramesDir(jobId)` |

`cleanupApplyStaging` is the hardening: it (1) re-derives the target from
`applyStagingDir(jobId)`, (2) **asserts the resolved target ends with
`${path.sep}_apply`** before any delete, and (3) bounds the delete via
`safeDelete` to the job's **own** `rawFramesDir(jobId)` rather than the broad
`TEMP_EXTRACTED_DIR`. Two independent guards must both pass for a delete to
occur, so the persistent `frame_*.png` and the parent dir can never be the
target.

Incidental correctness fix found while wiring: the post-extraction completion
log interpolated the old local `rawFramesDir` variable, which now collides with
the imported function name — repointed to the renamed local `rawDir` so it logs
the path, not a function source. `TEMP_EXTRACTED_DIR`/`safeDelete` imports were
dropped from `videoProcessor.ts` as they are no longer referenced there.

### D. Regression test — `server/services/__tests__/applyPaths.test.ts` (new)

`node:test` + `node:assert/strict`, run via `tsx`. No ffmpeg, GPU, or Sharp —
real filesystem under an `os.tmpdir()` sandbox (cwd is switched to the sandbox
*before* importing `cleanup.ts`, so its module-load `TEMP_EXTRACTED_DIR` constant
resolves inside the sandbox). `*.test.ts` is excluded by `tsconfig.json`, so the
test does not affect the 17-error tsc baseline.

---

## 3. Test output

```
$ npx tsx server/services/__tests__/applyPaths.test.ts
✔ applyStagingDir is idempotent across repeated applies (no nesting) (0.5185ms)
✔ rawFramesDir is the single-level parent of the staging dir (0.062541ms)
✔ twice-run cleanup removes _apply but persistent raw frames survive (5.435875ms)
✔ cleanupApplyStaging never deletes the parent raw-frame dir (0.836375ms)
✔ cleanupApplyStaging rejects an empty jobId (0.251375ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ duration_ms 10.9575
```

Coverage maps directly to the kickoff's required assertions:

- **Idempotent staging path** — `applyStagingDir(jobId)` equals
  `temp_extracted/<jobId>/_apply` on both calls; never contains
  `<jobId>/<jobId>`.
- **Raw frames survive each cleanup** — two full apply cycles; after each
  `cleanupApplyStaging`, `_apply/` is gone but `frame_000001.png` and the raw
  dir remain.
- **No `<jobId>/<jobId>` nesting** — asserted absent after each run.
- **Parent never deleted** — no-op cleanup with no `_apply` present leaves the
  parent frame intact.
- **Guard rejects bad input** — empty jobId throws.

---

## 4. tsc baseline (unchanged)

```
$ npx tsc --noEmit 2>&1 | grep 'error TS' | sed -E 's/\(.*//' | sort | uniq -c
  10 server/services/frameExtractor.ts
   7 server/services/maskWorker.ts
```

17 total, identical files/counts to the pre-fix baseline. The fix introduces no
new errors and does not touch the two files carrying the pre-existing ones.

---

## 5. Scope compliance

- 5a/5b/5c/read-path: untouched (no edits to `routes.ts` apply/AI/labeling logic,
  `frameAccess.ts`, or handlers beyond the re-land).
- `global.extractedFrames`: not reintroduced.
- Retention / `SWEEP_TARGETS`: unchanged.
- No three-path consolidation.
- `tsc --noEmit`: stays at 17.
- Backend-only.

---

## 6. Open item before re-deploy (E — operational, not code)

The proposal's leading real-cause hypothesis is an artifact/build mismatch.
Before re-deploying, confirm the box **builds from the re-landed SHA** (clean
`build/` from the committed source) and that the running bundle's
`processVideo`/`startBackgroundFrameExtraction` match this source. The code-level
fix above removes the doubling possibility regardless, but reconciling the
artifact is what closes the original rollback's root cause.

---

## 7. Files changed (working tree, uncommitted)

- `server/services/applyPaths.ts` — new (pure helpers + hardened cleanup)
- `server/services/__tests__/applyPaths.test.ts` — new (regression test)
- `server/services/videoProcessor.ts` — wired to helpers; cleanup hardened
- (re-landed from `7bb7f8f`, unmodified by this fix beyond the above)
  `CLAUDE.md`, `server/routes.ts`, `server/services/frameAccess.ts`,
  `docs/refactor/PHASE_4B0_PROPOSAL.md`, `docs/refactor/PHASE_4B0_REPORT.md`

No commit has been made.
