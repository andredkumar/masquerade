# Phase 4b-0 FIX — Proposal (root-cause first)

**Status: investigation complete, awaiting approval. No code edited.**

All paths/line numbers below are from the **rolled-back 4b-0 commit `7bb7f8f`**
("Phase 4b-0: raw frames to disk"), because that is the code that actually
shipped and was pulled. They are *not* the current working tree (see §0).

---

## 0. A finding that must come first: what is actually on disk

The current `HEAD` is **`7ad2e77 Revert "Phase 4b-0: raw frames to disk"`**. The
working tree is the **clean pre-4b-0 baseline** — the `_apply/` isolation is not
present in it:

```
HEAD     server/services/videoProcessor.ts:288
  const extractedFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId);
7bb7f8f  server/services/videoProcessor.ts:295
  const extractedFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId, '_apply');
```

`grep -rn "_apply" server/` on the working tree returns nothing. So the buggy
behaviour the kickoff describes lives in commit `7bb7f8f`, which I read via
`git show`. The investigation below is against that commit.

**Headline result:** after tracing every apply-time, extraction, and cleanup
path in `7bb7f8f`, **neither of the two hypothesised defects (A: non-idempotent
re-suffixing; B: destructive parent cleanup) is present in the committed code.**
Every directory path is rebuilt fresh from module-load constants + `jobId` on
each run, and the only apply-time delete is bounded to the `_apply/` subdir. The
committed 4b-0 code is idempotent across repeated `processVideo` runs and cannot,
as written, produce `temp_extracted/<jobId>/<jobId>/` or delete the parent
`frame_*.png`.

This is the opposite of what the kickoff assumed, so I am **not** writing a fix
to a bug I cannot locate in the code. §1 answers the four questions with
evidence (a refutation is still an answer); §6 explains what most likely
produced the production symptoms and what evidence would settle it; §7 proposes
how to proceed so a re-deploy is *provably* safe regardless.

---

## 1. The four root-cause questions, answered with file:line

### Q1 — Where does the apply-time staging base come from on each run? Derived fresh, or read from job state / an already-`<jobId>` helper?

**Derived fresh from constants every run. Idempotent.**

`videoProcessor.ts:295` (7bb7f8f):

```ts
const extractedFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId, '_apply');
```

`TEMP_EXTRACTED_DIR` is resolved once at module load
(`cleanup.ts:44 → path.resolve(process.cwd(), 'temp_extracted')`) and never
mutated. `jobId` is the function argument. The base is therefore
`temp_extracted/<jobId>/_apply` on run 1, run 2, run N — there is no read-back of
a previously-resolved directory. It is passed straight into
`extractAllFramesSequential` as `outputDir` (`videoProcessor.ts:312–319`), which
`mkdir`s exactly that path (`frameExtractor.ts:207`) and reads back **only** that
path (`frameExtractor.ts:225–229`, `fs.readdir(outputDir)` filtered to
`/^frame_\d+\.png$/`). No `jobId` is ever appended to an already-suffixed value.

**Verdict: idempotent. Defect A is not in this code.**

### Q2 — Does the first run PERSIST a directory path onto the Job/VideoJob record that the second run re-suffixes?

**No.** The two writers in the apply path persist no re-suffixable directory:

- `templateMaskApply.ts:51` → `storage.updateVideoJob(jobId, { maskData, outputSettings })`
  — mask/settings only, no path.
- `setTemplateMaskState(...)` writes `outputDir: TempFolderManager.getJobTempFolder(jobId)`
  (`templateMaskApply.ts:59`, and again in `videoProcessor.ts` on
  complete/fail). `getJobTempFolder` is `path.join(SPOKE_TEMPLATE_MASK_DIR, jobId)`
  (`tempFolderManager.ts:62–64`) — a single-level `spokes/template_mask/<jobId>`,
  recomputed from `jobId` each call, and it is **not** a `temp_extracted` path
  and is never fed back into staging construction.

Crucially, the value `processVideo` re-extracts from is `job.filePath`
(`templateMaskApply.ts:84`; legacy endpoint `routes.ts:543,549`), i.e. the
upload path `uploads/<file>`. `job.filePath` is set at upload and never rewritten
to a `temp_extracted` directory. So run 2 reads the same upload and builds the
same `_apply` path as run 1.

**Verdict: nothing persisted is re-suffixed. Defect A has no second vector.**

### Q3 — Trace the literal string the `_apply/` `safeDelete` resolves to on the SECOND run. Can it ever resolve to the parent `temp_extracted/<jobId>/`?

**No.** `videoProcessor.ts:471` (7bb7f8f):

```ts
await safeDelete(extractedFramesDir, TEMP_EXTRACTED_DIR);
// extractedFramesDir === temp_extracted/<jobId>/_apply  (from line 295)
```

`safeDelete` (`cleanup.ts:86–104`):

```ts
const resolvedTarget = path.resolve(absPath);   // …/temp_extracted/<jobId>/_apply
const resolvedRoot   = path.resolve(allowedRoot); // …/temp_extracted
// isRoot=false; isDescendant=resolvedTarget.startsWith(resolvedRoot + sep)=true
await fs.rm(resolvedTarget, { recursive: true, force: true });
```

On every run `resolvedTarget` is literally `…/temp_extracted/<jobId>/_apply`, and
`fs.rm` removes exactly that subtree. It can only reach the parent
`temp_extracted/<jobId>/` (which holds the raw `frame_*.png`) if
`extractedFramesDir` itself were the parent — but line 295 always appends
`'_apply'`. The bound check would *permit* deleting the parent (the parent is a
descendant of `TEMP_EXTRACTED_DIR`), but the target string never points there.

**Verdict: the apply cleanup cannot delete the raw frames in this code. Defect B
is not in this code.**

### Q4 — What shared path source feeds BOTH the `temp_extracted/` doubling and the `spokes/ai/` doubling?

**There is no shared doubling source, because there is no doubling source.**

- `temp_extracted/`: only two writers — `startBackgroundFrameExtraction`
  (`videoProcessor.ts:1113`, `temp_extracted/<jobId>/`, upload-time only) and the
  apply-time `_apply/` extraction (§Q1). Both single-level, both idempotent.
- `spokes/ai/`: `routes.ts:935–937`:

  ```ts
  const runId = randomUUID();
  const runOutputDir = path.join(SPOKE_AI_DIR, jobId, runId);
  ```

  `runId` is a fresh UUID, **not** `jobId`. The correct, by-design layout is
  `spokes/ai/<jobId>/<runId>/` (documented at `cleanup.ts:11`). A UUID `runId`
  subdir under `<jobId>/` is *visually* easy to misread as a repeated job id
  when eyeballing `ls spokes/ai/<jobId>/`, but it is not a second `<jobId>`.

The kickoff's inference — "the same doubling in both trees implies a shared
already-suffixed source" — rests on the `spokes/ai/<jobId>/<jobId>/` reading. In
`7bb7f8f` that second segment is a random UUID, so the premise of a shared
source does not hold.

The one genuinely already-`<jobId>`-suffixed value in the codebase is the `dir`
field returned by `listFrameFiles`/`listRawFrameFiles` (`frameAccess.ts`,
`dir = path.resolve(base, jobId)`). I checked **every** consumer of that return
value in `7bb7f8f` (`routes.ts:595, 622, 628, 818, 916, 919, 997, 1025, 1622,
1639, 1651`): each uses `dir` only as the directory to `path.join(dir, <filename>)`
or `readFile` from — none ever does `path.join(dir, jobId)` or `mkdir(dir/…jobId)`.
So even the one suffixed helper is not re-suffixed anywhere.

**Verdict: no shared doubling source exists in the committed code.**

---

## 2. Summary table

| Hypothesis (kickoff) | Evidence in `7bb7f8f` | Verdict |
|---|---|---|
| A. Re-suffixing builds `…/<jobId>/<jobId>/` | staging = `path.join(TEMP_EXTRACTED_DIR, jobId, '_apply')` fresh each run (`videoProcessor.ts:295`); no persisted dir re-joined (§Q2) | **Refuted** |
| B. `_apply/` cleanup deletes parent frames | `safeDelete(temp_extracted/<jobId>/_apply, TEMP_EXTRACTED_DIR)` → `fs.rm` of `_apply` only (`videoProcessor.ts:471`, `cleanup.ts:86–104`) | **Refuted** |
| `spokes/ai/<jobId>/<jobId>/` doubling | `runOutputDir = SPOKE_AI_DIR/jobId/randomUUID()` (`routes.ts:935–937`) — second segment is a UUID `runId`, not `jobId` | **Refuted (likely misread)** |
| Shared already-suffixed source | only `listFrameFiles().dir` is `<jobId>`-suffixed; no consumer re-joins `jobId` (§Q4) | **Refuted** |

---

## 3. So how do we reconcile the real production evidence?

The disk state in the kickoff (`temp_extracted/<jobId>/<jobId>/<jobId>/`, raw
frames gone) is concrete and triggered a rollback, so *something* happened. Since
the committed `7bb7f8f` provably cannot produce it, the cause is **outside the
four files I can see at that commit**. Ranked by likelihood:

1. **Build / artifact mismatch (most likely).** The deployed bundle did not
   correspond to `7bb7f8f`. A partially-rebuilt `dist/`, a stale Docker layer, or
   a hand-edited experimental staging path (an earlier draft that *did* derive
   the staging dir by joining `jobId` onto `listRawFrameFiles().dir`) would
   produce exactly the triple-nesting + parent deletion. The repo's
   `deployment-package/` is itself a stale pre-Phase-3 snapshot (still uses
   `global.extractedFrames`, no `spokes/`, no `frameAccess.ts`), proving stale
   artifacts exist in this workspace.

2. **`spokes/ai` "doubling" was a misread UUID** (`runId`), which then made the
   `temp_extracted` observation look like part of a shared pattern it isn't.

3. **Frames removed by something other than the apply cleanup** — e.g. the
   `temp_extracted/ 6h` hourly sweep (`SWEEP_TARGETS`, `cleanup.ts:67`) firing
   between apply cycles during a long manual redo session, or a manual
   `cleanupJobArtifacts(jobId)` (`cleanup.ts:136`), not the `_apply/` `safeDelete`.

I cannot discriminate among these from the source alone, and I cannot run the
GPU/deploy stack. The discriminating evidence is listed in §5.

---

## 4. What I did NOT find (explicitly, so review can challenge it)

- No code at `7bb7f8f` appends `jobId` to an already-`jobId`-suffixed path.
- No `mkdir`/write under `temp_extracted/` other than the two idempotent
  single-level sites.
- No persisted directory on the Job/VideoJob record that staging re-derives from.
- No `safeDelete`/`fs.rm` whose resolved target is `temp_extracted/<jobId>/`
  (parent) in the apply path.

If any of these *is* the bug, it is in a file/commit I was not pointed at. Tell
me where the deployed code lived and I will trace it.

---

## 5. Evidence that would settle it (please provide if available)

1. The **git SHA / image tag actually deployed** when the failure was seen. If it
   is not `7bb7f8f`, that is the answer.
2. The literal `ls -la temp_extracted/<jobId>/` and `spokes/ai/<jobId>/` output
   from the failing box (raw, un-paraphrased) — to confirm whether the second
   `spokes/ai` segment is a 36-char UUID or a repeated jobId.
3. Server logs around the re-apply: the `🎬 Extracted N sequential frames into
   <path>` line (`frameExtractor.ts:231`) prints the *literal* `outputDir`. One
   log line proves whether staging was `_apply/` or something nested.

---

## 6. Proposed path forward (pending your approval — no code yet)

The goal is a **provably safe re-deploy of 4b-0**, whether or not the original
cause is ever reproduced. I propose to make the idempotency a *guaranteed,
tested invariant* rather than an emergent property, so a mismatched build can't
silently reintroduce the symptom. Concretely:

**A. Re-land 4b-0.** `git revert 7ad2e77` (or cherry-pick `7bb7f8f`) to restore
the disk-write migration + `_apply/` isolation, since HEAD is currently the
revert. (Flagging because this is the first action and changes the tree.)

**B. Extract the path math into one pure, idempotent helper** (minimal). New
module e.g. `server/services/applyPaths.ts`:

```ts
export function rawFramesDir(jobId)   // temp_extracted/<jobId>
export function applyStagingDir(jobId)// temp_extracted/<jobId>/_apply
```

Both `startBackgroundFrameExtraction`, `processVideo`, and the `_apply/`
`safeDelete` call these instead of inlining `path.join`. A single source of
truth makes "run N == run 1" structural, not coincidental.

**C. Harden the apply cleanup** so it is *provably* incapable of hitting the
parent: assert the resolved target ends with `${path.sep}_apply` before
`fs.rm`, and bound it to `applyStagingDir(jobId)` (a tighter root than
`TEMP_EXTRACTED_DIR`). This addresses the kickoff's safety requirement directly
and would have contained even a mismatched-build regression.

**D. GPU-free regression test** (the required, non-negotiable deliverable) —
`server/services/__tests__/applyPaths.test.ts`:
- call `applyStagingDir(jobId)` twice → assert `=== temp_extracted/<jobId>/_apply`
  both times, no nesting;
- create `temp_extracted/<jobId>/frame_000001.png` + a populated `_apply/`, run
  the cleanup helper twice, assert after each: `_apply/` gone, `frame_*.png`
  still present, no `temp_extracted/<jobId>/<jobId>/` exists;
- assert the cleanup helper *throws* if handed a non-`_apply` path (lock the
  guard from C). No ffmpeg, no GPU, real `fs` in a tmp dir.

**E. Reconcile the artifact** before re-deploy: confirm the box builds from the
re-landed SHA (kills hypothesis #1).

### Scope / constraints (unchanged from kickoff)
- No regression of 5a/5b/5c/read-path; no reintroduction of `global.extractedFrames`.
- No retention / `SWEEP_TARGETS` change.
- No three-path extraction consolidation.
- `npx tsc --noEmit` stays at exactly 17 errors.
- Backend-only.

---

## 7. Decision requested

I will not edit code until you pick a direction:

1. **Proceed with §6 (A–E)** — re-land 4b-0 and convert idempotency into a
   tested, guarded invariant, even though I could not locate the defect in
   `7bb7f8f`. This is the safest route to re-deploy and satisfies the
   regression-test requirement regardless of the original cause.
2. **Hand me the real deployed SHA / the raw `ls` + logs (§5)** first, so I can
   trace the actual failing artifact before changing anything.
3. Something else.

My recommendation is **(1) and (2) together**: give me whatever §5 evidence
exists, and in parallel let me re-land + harden + test per §6 so the re-deploy
is safe even if the original artifact is never recovered.
