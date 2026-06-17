# Phase 4b-0 — FIX V2 FINAL REPORT

**Status:** IMPLEMENTED. Approved proposal:
`docs/refactor/PHASE_4B0_FIX_V2_FINAL_PROPOSAL.md`. Backend-only. `npx tsc
--noEmit` held at exactly **17** pre-existing errors. The required repro test
goes **RED before** the fix and **GREEN after** — both outputs pasted below.

---

## 1. What changed

| File | Change |
|---|---|
| `server/services/applyPaths.ts` | + `prepareCleanApplyStaging(jobId)` (clear `_apply` residue → recreate empty); + `assertNoSegmentDoubling(absPath)` tripwire; + `aiRunDir(jobId, runId)` (hygiene). New imports: `fs.promises`, `SPOKE_AI_DIR`. Tripwire (§149) logs the literal resolved `_apply` mkdir path. |
| `server/services/videoProcessor.ts` | Import `prepareCleanApplyStaging`, `assertNoSegmentDoubling`. Call `await prepareCleanApplyStaging(jobId)` immediately before `extractAllFramesSequential` (the clear-before-extract). Tripwire `assertNoSegmentDoubling(rawDir)` + literal-resolved-path log (§149) at the raw-frame mkdir in `startBackgroundFrameExtraction`. `deleteUploadFile` removal and `_apply`-only `finally` cleanup left intact. |
| `server/routes.ts` | Import `aiRunDir`; AI `runOutputDir = aiRunDir(jobId, runId)` (was inline `path.join(SPOKE_AI_DIR, jobId, runId)`) — hygiene + tripwire only; literal-resolved-path log (§149) at the AI run mkdir. |
| `server/services/__tests__/applyPaths.test.ts` | + residue-present repro test (run-1 leaves 200 stale frames in `_apply`; run-2 prep must yield only 164). Existing 5 tests unchanged. |

No change to `frameExtractor.ts`, `cleanup.ts`, `frameAccess.ts`, retention,
`SWEEP_TARGETS`, or any read path.

---

## 2. The fix (one load-bearing line)

`prepareCleanApplyStaging` (`applyPaths.ts`):

```ts
export async function prepareCleanApplyStaging(jobId: string): Promise<string> {
  assertJobId(jobId);
  await cleanupApplyStaging(jobId);          // ← clear residue (the fix)
  const staging = applyStagingDir(jobId);
  assertNoSegmentDoubling(staging);
  await fs.mkdir(staging, { recursive: true });
  return staging;
}
```

Wired in `videoProcessor.processVideo` right before the single ffmpeg pass:

```ts
await prepareCleanApplyStaging(jobId);
const extractedPaths = await this.frameExtractor.extractAllFramesSequential(…);
```

Effect: every (re-)apply re-extracts into an **empty** `_apply`, so
`extractAllFramesSequential`'s `readdir`-readback (`frameExtractor.ts:225`) can
only ever return this run's frames. Idempotent across re-invocation, including
after a run 1 that was killed before its `finally` cleanup ran. The persistent
raw frames in the parent dir are never touched (the delete is `_apply`-bounded).

---

## 3. Repro test — RED before / GREEN after

The test (`applyPaths.test.ts`) sets up the **first-run-residue precondition the
old test never had**: run 1 (interrupted) leaves `frame_000001…000200.png` in
`_apply`; the parent holds the 164 persistent raw frames. It then drives the
real production seam `prepareCleanApplyStaging`, simulates ffmpeg writing run-2's
164 frames, and reads back exactly as the extractor does. Assertions: readback
== 164 (not 200), staging path == `temp_extracted/<jobId>/_apply`, no
`<jobId>/<jobId>` nesting, and all 164 persistent frames survive run-2 cleanup.

### 3a. RED — before adding the clear (`prepareCleanApplyStaging` did mkdir only)

```
✔ applyStagingDir is idempotent across repeated applies (no nesting)
✔ rawFramesDir is the single-level parent of the staging dir
✔ twice-run cleanup removes _apply but persistent raw frames survive
✔ cleanupApplyStaging never deletes the parent raw-frame dir
✖ run-2 re-extraction with run-1 RESIDUE present: readback is run-2 frames only, persistent frames survive, no nesting
✔ cleanupApplyStaging rejects an empty jobId
ℹ tests 6
ℹ pass 5
ℹ fail 1

✖ failing tests:
  AssertionError [ERR_ASSERTION]: staging readback must be run-2's 164 frames, got 200 (stale residue leaked in)

  200 !== 164

    actual: 200,
    expected: 164,
    operator: 'strictEqual',
```

The readback returned **200** = run-2's 164 frames + 36 stale run-1 frames
(`frame_000165…000200.png`) that were never overwritten — the exact
stale-readback corruption the kickoff named.

### 3b. GREEN — after adding `await cleanupApplyStaging(jobId)` (one line)

```
✔ applyStagingDir is idempotent across repeated applies (no nesting)
✔ rawFramesDir is the single-level parent of the staging dir
✔ twice-run cleanup removes _apply but persistent raw frames survive
✔ cleanupApplyStaging never deletes the parent raw-frame dir
✔ run-2 re-extraction with run-1 RESIDUE present: readback is run-2 frames only, persistent frames survive, no nesting
✔ cleanupApplyStaging rejects an empty jobId
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

The clear-before-extract empties `_apply`; readback == **164**; persistent frames
survive; no nesting. The RED→GREEN delta is produced by the single production
line, driven through real filesystem ops (no mock).

---

## 4. tsc baseline held

```
$ npx tsc --noEmit 2>&1 | grep -E "error TS" | wc -l
17
  10 server/services/frameExtractor.ts
   7 server/services/maskWorker.ts
```

Exactly the pre-existing 17 (10 `frameExtractor.ts` + 7 `maskWorker.ts`). The new
code (helpers, wiring, tripwires, test) added **zero** type errors.

---

## 5. Scope check against the kickoff's rejection triggers

- AI `<jobId>/<runId>` treated as **designed, not a bug** — `aiRunDir` is labeled
  HYGIENE ONLY in code and docs. ✔
- Repro test **leaves first-run residue present** (200 stale frames) before run 2. ✔
- Test **fails before the fix** (RED, §3a) and **passes after** (GREEN, §3b),
  both shown. ✔
- No "build mismatch" theory. ✔
- Mechanism is the temporal run-1→run-2 stale-readback, fixed by
  clear-before-extract — not static "can't double" analysis. ✔
- Constraints honored: `deleteUploadFile` removal kept; `applyPaths.ts` kept and
  extended; no read-path/5a-5c regression; no `global.extractedFrames`; no
  retention/`SWEEP_TARGETS` change; tsc 17; backend-only. ✔
- Tripwire §149 fully satisfied: each of the three mkdir sites (videoProcessor
  raw, `_apply`, routes.ts AI run dir) now BOTH asserts no equal-adjacent-segment
  nesting AND logs the literal `path.resolve(...)` mkdir path. ✔

---

## 6. Re-entrancy post-mortem — proposed `CLAUDE.md` note

> **Re-entrancy lesson (Phase 4b-0).** `processVideo` was implicitly single-shot:
> a prior run's `finally` deleted the upload, so a second run for the same jobId
> crashed at ffprobe before exercising directory logic. Moving raw frames to disk
> and (correctly) preserving the upload for re-apply *unmasked* a latent
> re-entrancy bug — the second run read back a directory the first run had
> populated. Lesson: any per-job stage that re-derives a working directory and
> then `readdir`s it must **clear that dir first** (or use a per-run unique dir);
> never let cleanup that protects re-entrancy be *conditional* on a flag that a
> killed process can skip. Tests for re-entrancy MUST leave first-run residue
> present before the second run; a test that cleans state between runs proves
> nothing.

> **Deploy hygiene.** Run `git status` and confirm a clean tree (no uncommitted
> source, built `dist/` matches `HEAD`) before `npm run build` + PM2 start, so a
> deployed build always corresponds to a known commit.

---

## 7. Manual follow-ups (not done here)

- The `CLAUDE.md` note in §6 is proposed text; append it on your go-ahead.
- No commit/deploy performed. Awaiting your instruction to commit (and to gate a
  re-deploy).
