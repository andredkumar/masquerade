# Phase 4b-0 — FIX V2 FINAL PROPOSAL

**Status:** AWAITING APPROVAL. No code has been changed for this proposal. This
document describes (1) the literal run-2 directory-operation sequence that
corrupts state, (2) the idempotency fix, and (3) the residue-present repro test
that goes RED before the fix and GREEN after. Implementation begins only on
your approval.

**Scope reminder (unchanged from the FINAL kickoff):** backend-only; keep
4b-0's `deleteUploadFile` removal; keep `applyPaths.ts`; keep/extend
`applyPaths.test.ts`; no read-path / 5a-5c regression; no `global.extractedFrames`;
no retention / `SWEEP_TARGETS` change; no three-path consolidation; `npx tsc
--noEmit` stays at exactly **17** pre-existing errors.

---

## 0. What is settled (do not re-open)

- **Root cause = `processVideo` re-entrancy.** `processVideo` is not safe to run
  twice for the same `jobId`. The second run (the redo loop's re-apply) builds on
  filesystem state left by the first run.
- **Why it was invisible before 4b-0.** Pre-4b-0, the second run was
  *unreachable*: `processVideo`'s `finally` deleted the upload, so the second
  apply crashed at `ffprobe` (`uploads/<hash>: No such file or directory`) before
  reaching any directory logic. 4b-0 removed `deleteUploadFile` from `finally`
  (correctly — re-apply needs the upload), which *unmasked* the latent
  re-entrancy defect.
- **AI "doubling" is CLOSED — not a bug.** `spokes/ai/<jobId>/<runId>/` is the
  designed layout; the inner segment is `runId = randomUUID()`
  (`routes.ts:936-937`), distinct from `jobId`. There is no AI bugfix in this
  proposal. A pure `aiRunDir(jobId, runId)` helper + tripwire is included as
  **hygiene only**.

This proposal does **not** rest on static "the source can't double" analysis.
That was correct for a *single* run and irrelevant to the bug, which spans *two*
runs. Everything below is framed across run 1 → run 2.

---

## 1. The literal run-2 directory-operation sequence (the corruption mechanism)

Setup: a redo loop runs `processVideo(jobId, …)` a first time, then a second
time for the same `jobId` (re-apply after the user re-draws the mask). The
persistent raw frames live at `temp_extracted/<jobId>/frame_NNNNNN.png` and must
survive every re-apply. Apply-time re-extraction is staged in
`temp_extracted/<jobId>/_apply/`.

### 1a. Run 1 — what it leaves behind

`processVideo` (`videoProcessor.ts:284-480`):

1. `extractedFramesDir = applyStagingDir(jobId)` → `temp_extracted/<jobId>/_apply`
   (`:296`).
2. `extractAllFramesSequential(videoPath, extractedFramesDir, …)` (`:321-328`),
   which:
   - `await fs.mkdir(outputDir, { recursive: true })` — **does NOT clear
     existing contents** (`frameExtractor.ts:207`).
   - ffmpeg writes `frame_%06d.png` into `_apply` (`:209-222`).
   - `await fs.readdir(outputDir)` then filter `/^frame_\d+\.png$/`, sort, map —
     **reads back every `frame_*.png` present in the dir** (`:225-229`).
3. `finally`: `cleanupApplyStaging(jobId)` runs **only if `reachedTerminal`**
   (`videoProcessor.ts:472`). `reachedTerminal` is set true on the success path
   and on the caught-failure path (`:452`).

**The residue condition.** If run 1 does **not** reach a terminal state with the
`finally` actually executing to completion — e.g. the process receives SIGTERM
mid-extraction, the worker is killed, or an exception escapes the `catch` before
`:452` — then `cleanupApplyStaging` is skipped and `_apply` is left populated
with run-1 frames (`frame_000001.png … frame_00NNNN.png`). This is the residue
that run 2 inherits.

### 1b. Run 2 — operating on run-1 residue

With `_apply` already populated:

1. `extractedFramesDir = applyStagingDir(jobId)` → same
   `temp_extracted/<jobId>/_apply` string (pure, idempotent — `applyPaths.ts:50`).
   **No path nesting originates here.** The `<jobId>/<jobId>` symptom does not
   come from the current `_apply`-isolated path math; it was a property of the
   pre-`_apply` variant (see §1c).
2. `extractAllFramesSequential` again:
   - `mkdir(outputDir, { recursive: true })` — no-op, dir already exists, **stale
     frames remain** (`frameExtractor.ts:207`).
   - ffmpeg writes the run-2 frame set (e.g. 164 frames) into the **same** dir.
     If run 1 left a *higher* count (e.g. 200 stale frames at a different
     `samplingFps`), the high-numbered stale files `frame_000165.png …
     frame_000200.png` are **not overwritten**.
   - `readdir` + filter (`:225-229`) returns the **UNION** of stale + new frames.
3. Back in `processVideo`: `extractedCount = extractedPaths.length` (`:329`)
   and `extractedBuffers = Promise.all(extractedPaths.map(readFile))`
   (`:330-332`) now reflect the **wrong, inflated** frame set — stale run-1
   pixels interleaved with run-2 frames. `storage.updateVideoJob(… totalFrames:
   extractedCount …)` (`:334-341`) records the corrupted count.

This is the in-code corruption vector named by the kickoff: **re-extracting into
a dir whose pre-existing contents it then reads back to compute the frame list.**
The defect is the *absence of a clear-before-extract* step combined with the
*conditional* (`reachedTerminal`-gated) cleanup that can leave residue.

#### Scope caveat — the residue precondition == an *interrupted* run 1

Verified at `videoProcessor.ts:421` (success → `reachedTerminal = true`) and
`:452` (caught-failure → `reachedTerminal = true`): **both** terminal paths run
the `finally` cleanup (`:472`) and empty `_apply`. Therefore the *clean* redo
loop — run 1 succeeds (or fails-with-catch), then run 2 re-applies — starts run 2
with an **empty** `_apply` and does **not** corrupt in the current re-landed
source. The §1b stale-readback only triggers when run 1's `finally` cleanup
never completes: SIGTERM / OOM-kill mid-extraction, or a throw inside the `catch`
block before `:452`. So the in-code defect this proposal fixes is narrowly the
**interrupted-run-residue** case, and the repro in §3 deliberately constructs
that precondition. The original deployment's `<jobId>/<jobId>` nesting and frame
deletion were the *pre-`_apply` variant* (§1c), already replaced. The fix below
is still worth landing because it makes `_apply` start clean **unconditionally**
— robust to a killed run 1 — and the tripwire (§2c) catches the nesting class
however it might be reintroduced.

### 1c. The frame-deletion mechanism (historical, for completeness)

Pre-4b-0 (`git show 54487d3:server/services/videoProcessor.ts`):

- `:288` `extractedFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId)` — the
  **whole** job dir, not an `_apply` subdir.
- `:455` `finally` → `safeDelete(extractedFramesDir, TEMP_EXTRACTED_DIR)` —
  deleted **`temp_extracted/<jobId>` in its entirety**.

That whole-dir delete was safe pre-4b-0 because raw frames lived in memory
(`global.extractedFrames`); the dir held only transient extraction output. 4b-0
moved persistent raw frames *into* `temp_extracted/<jobId>/`. Had the whole-dir
delete still been in place, the second run's `finally` would have wiped the 164
persistent frames. The re-landed 4b-0 code already replaced that whole-dir delete
with `_apply`-only `cleanupApplyStaging` — so the **deletion is fixed in the
current source**, but only on the happy path. The fix below makes the isolation
hold on run 2 even with residue, and the repro test pins it.

---

## 2. The fix — make `processVideo` idempotent across re-invocation

Three coordinated changes, all backend-only, all preserving the `deleteUploadFile`
removal and the `applyPaths.ts` module.

### 2a. Clear `_apply` before every re-extraction (the load-bearing fix)

Add a pure, idempotent helper to `applyPaths.ts`:

```
export async function prepareCleanApplyStaging(jobId: string): Promise<string> {
  // 1. Delete any residue from a prior (possibly killed) run.
  await cleanupApplyStaging(jobId);          // _apply-only, already hardened
  // 2. Recreate the staging dir empty.
  const staging = applyStagingDir(jobId);
  await fs.mkdir(staging, { recursive: true });
  return staging;
}
```

In `processVideo`, replace the bare `applyStagingDir(jobId)` at `:296` with a
call to `prepareCleanApplyStaging(jobId)` **before** `extractAllFramesSequential`.
Now run 2 always re-extracts into an empty `_apply`, so the `readdir` readback
(`frameExtractor.ts:225`) can never return stale run-1 frames. `frameExtractor`
itself is **not** modified (it is shared; the clear is the caller's
responsibility, which matches where the per-job knowledge lives).

This directly closes the §1b vector: the readback set == exactly the frames this
run wrote.

### 2b. Cleanup stays `_apply`-only and re-entrancy-safe (verify, don't loosen)

`cleanupApplyStaging` (`applyPaths.ts:68-81`) already: derives the target from
`applyStagingDir(jobId)` (not caller input); asserts the resolved target ends
with `${sep}_apply`; delegates to `safeDelete(target, rawFramesDir(jobId))`.
With 2a calling it at the **start** of each run too, residue from a killed run is
reclaimed at the next entry, not only in the (skippable) `finally`. The
persistent `temp_extracted/<jobId>/frame_*.png` are provably never touched (the
delete is bounded to the `_apply` leaf). No change to the delete itself.

### 2c. Tripwire at every `mkdir` of a `<jobId>`-derived dir (runtime net)

At each staging/raw/AI mkdir site — `videoProcessor` (`_apply` via
`prepareCleanApplyStaging`), the persistent raw-frame dir in
`startBackgroundFrameExtraction`, and `routes.ts` AI `runOutputDir` (`:937-938`)
— log the literal resolved path and assert no equal-adjacent-segment nesting:

```
function assertNoSegmentDoubling(absPath: string): void {
  const segs = absPath.split(path.sep).filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === segs[i - 1]) {
      throw new Error(`path-doubling tripwire: '${segs[i]}/${segs[i]}' in ${absPath}`);
    }
  }
}
```

This converts any future re-suffixing regression into an immediate, located
crash instead of silent corruption. It is a net, not the fix.

### 2d. Hygiene only — `aiRunDir(jobId, runId)` helper

A pure helper `aiRunDir(jobId, runId) → path.join(SPOKE_AI_DIR, jobId, runId)`
that `routes.ts:937` calls instead of inlining the join, guarded by the same
tripwire. **This is hygiene, not a bugfix** — the AI layout was always correct.
Optional; can be dropped if you'd rather keep the AI handler untouched.

---

## 3. The repro test — first-run residue present, RED before / GREEN after

The previous `applyPaths.test.ts` ran cleanup **inside** each loop iteration
(`:81`), so `_apply` was empty at the top of run 2 — it never reproduced the
bug. The new test must leave run-1 residue **present** when run 2 extracts.

### 3a. Design (GPU-free, real fs under the existing tmp sandbox)

The test models `extractAllFramesSequential`'s directory lifecycle without
ffmpeg by treating "ffmpeg writes frame_%06d.png" as `fs.writeFile` of frame
files, and the readback as the real `readdir` + filter the production code uses.
It exercises the **actual** `prepareCleanApplyStaging` against the real
filesystem.

Sequence:

1. **Simulate run 1 leaving residue** (as if killed before `finally` cleanup):
   - `mkdir temp_extracted/<jobId>/_apply`
   - write a *high* stale set into `_apply`: `frame_000001.png …
     frame_000200.png` (200 files).
   - write the persistent raw frames into the parent:
     `temp_extracted/<jobId>/frame_000001.png … frame_000164.png` (164 files).
2. **Run 2's apply directory setup**, two variants:
   - **Pre-fix model:** skip the clear (current behavior) — `mkdir -p` (no-op),
     write run-2's 164 frames `frame_000001.png … frame_000164.png` (overwrites
     1-164, leaves 165-200 stale), then `readdir` + filter.
   - **Post-fix:** call the real `prepareCleanApplyStaging(jobId)`, then write
     run-2's 164 frames, then `readdir` + filter.
3. **Assertions** (the same three the kickoff requires):
   - (a) **No nesting:** `temp_extracted/<jobId>/<jobId>` never exists.
   - (b) **Persistent frames survive:** all 164
     `temp_extracted/<jobId>/frame_0000NN.png` still present after run 2's setup
     **and** after a subsequent `cleanupApplyStaging`.
   - (c) **Staging is exactly `_apply` and the readback set is run-2's 164 — not
     200.** Asserts `readdir(_apply)` filtered count `=== 164` and the staging
     path `=== temp_extracted/<jobId>/_apply`.

### 3b. RED / GREEN

- **Pre-fix (RED):** assertion (c) fails — the readback returns **200** frames
  (164 fresh + 36 stale `frame_000165…200`), proving the stale-readback
  corruption. This output will be captured in the REPORT.
- **Post-fix (GREEN):** `prepareCleanApplyStaging` empties `_apply` first, so the
  readback returns exactly **164**; (a) and (b) also hold.

Because the test drives the real `prepareCleanApplyStaging` and the real
`readdir`/filter logic, RED-before and GREEN-after are produced by the actual
code change, not a mock. The directory-lifecycle decision (clear vs. no-clear) is
the pure, testable unit.

### 3c. Existing tests

The five current tests stay (idempotent path, single-level parent, twice-run
cleanup survival, no-op parent safety, empty-jobId rejection). The residue test
is **added**, not a replacement.

---

## 4. Files touched (on approval)

| File | Change |
|---|---|
| `server/services/applyPaths.ts` | + `prepareCleanApplyStaging(jobId)` (clear-then-mkdir); + `assertNoSegmentDoubling`; (optional) + `aiRunDir`. |
| `server/services/videoProcessor.ts` | `:296` use `prepareCleanApplyStaging` before extraction; tripwire at raw-frame mkdir in `startBackgroundFrameExtraction`. Keep `deleteUploadFile` removed; keep `_apply`-only `finally`. |
| `server/routes.ts` | (optional/hygiene) `:937` via `aiRunDir` + tripwire at AI `runOutputDir` mkdir. |
| `server/services/__tests__/applyPaths.test.ts` | + residue-present repro test (§3). |

No change to `frameExtractor.ts`, `cleanup.ts`, `frameAccess.ts`, retention,
sweep targets, or any read path. `npx tsc --noEmit` expected to stay at **17**.

---

## 5. Acceptance criteria (self-check against the kickoff's rejection triggers)

- [x] Treats AI `<jobId>/<runId>` as designed, NOT a doubling bug (§0, §2d).
- [x] Repro test **leaves first-run residue present** before run 2 (§3a step 1).
- [x] Test **fails before the fix** (RED, §3b) and passes after (GREEN) — both to
  be shown in the REPORT.
- [x] No "build mismatch" theory anywhere.
- [x] Does not stop at static "can't double" — the mechanism is the temporal
  run-1→run-2 stale-readback (§1), fixed by clear-before-extract (§2a).

---

## 6. Deliverable after approval

`docs/refactor/PHASE_4B0_FIX_V2_FINAL_REPORT.md` — with the literal RED (pre-fix)
and GREEN (post-fix) test output both pasted, the final `tsc` count, and a
short re-entrancy post-mortem note proposed for `CLAUDE.md`.

**Awaiting your approval before any code change.**
