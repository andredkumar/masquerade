# Phase 4b-0 FIX v2 — Proposal / Root-cause findings

**Status:** investigation complete, proposing direction. No code changed in v2. Awaiting approval.
**Method:** per the v2 kickoff, I traced the ACTUAL runtime call chain to the filesystem
for both directory constructions, using the committed git diff and an exhaustive grep of
every `path.join(..., jobId)` site — not reasoning from what constants "should" produce.
**Build-mismatch theory:** not invoked. It is treated as falsified, as instructed.

> Up-front honesty (the kickoff explicitly allows "if the doubling only manifests through a
> runtime path you cannot unit-test, say so explicitly"): I could not locate a file:line in
> the deployed-and-committed 4b-0 source (`7bb7f8f`) that produces `temp_extracted/<jobId>/<jobId>`
> or `spokes/ai/<jobId>/<jobId>`. I traced every path-construction site; none can re-suffix
> `jobId`. Rather than invent a shared re-suffix source to satisfy the template, this proposal
> reports what the code actually does, what it provably cannot do, the one symptom it CAN
> explain, and the single ground-truth artifact needed to close the rest.

---

## 1. The two directory constructions, traced to the fs (file:line)

### 1a. `temp_extracted/<jobId>` — persistent raw frames (Path A / template-mask)

Runtime chain on upload:

- `server/routes.ts:223` / `:289` — upload handler calls
  `videoProcessor.startBackgroundFrameExtraction(job.id, filePath, totalFrames)`.
  `job.id` is `randomUUID()` (`server/storage.ts:93`) — a clean UUID, no separators.
- `server/services/videoProcessor.ts:1116` — `const rawDir = rawFramesDir(jobId)`
  → `applyPaths.ts:38-41` → `path.join(TEMP_EXTRACTED_DIR, jobId)`.
  (Committed 4b-0 wrote this inline: `path.join(TEMP_EXTRACTED_DIR, jobId)` — see the
  4b-0 diff hunk at videoProcessor `@@ -1088`.)
- `server/services/videoProcessor.ts:1117` — `await fs.mkdir(rawDir, { recursive: true })`.
- `:1136` — `fs.writeFile(path.join(rawDir, 'frame_NNNNNN.png'), buf)`.

Apply-time chain (re-apply in the redo loop):

- `server/handlers/templateMaskApply.ts:85` — `videoProcessor.processVideo(jobId, job.filePath, …)`.
  Note it passes `job.filePath` (the **upload** path), never a temp_extracted dir.
- `server/services/videoProcessor.ts:296` — `const extractedFramesDir = applyStagingDir(jobId)`
  → `applyPaths.ts:50-53` → `path.join(TEMP_EXTRACTED_DIR, jobId, '_apply')`.
  (Committed 4b-0 wrote this inline: `path.join(TEMP_EXTRACTED_DIR, jobId, '_apply')`.)
- `:321` — passes `extractedFramesDir` as `outputDir` to `extractAllFramesSequential`.
- `server/services/frameExtractor.ts:207` — `fs.mkdir(outputDir, …)`;
  `:209` — `path.join(outputDir, 'frame_%06d.png')`. **No `jobId` is joined here.**

**Every base is a module constant.** `extractAllFramesSequential` joins only the ffmpeg
filename pattern onto the `outputDir` it is handed; it never re-appends `jobId`. Re-running
`processVideo` recomputes `extractedFramesDir` from `TEMP_EXTRACTED_DIR` each call, so the
string is byte-identical on every run. There is no place to accumulate `<jobId>/<jobId>`.

### 1b. `spokes/ai/<jobId>/<runId>` — AI run output (Path C)

- `server/routes.ts:936` — `const runId = randomUUID()` — a **second, distinct** UUID.
- `server/routes.ts:937` — `const runOutputDir = path.join(SPOKE_AI_DIR, jobId, runId)`.
- `server/routes.ts:938` — `await fsPromises.mkdir(runOutputDir, { recursive: true })`.
- `:955` — `outputDir: runOutputDir` stored on the `AIRun` record.

The stored `run.outputDir` is later only **read** for serving/deleting that run
(`routes.ts:1216`, `:1281`, `:1444`, `:1522`, `:1573`, `:1753`, `:1781`, `:1785`, `:1828`,
`:1833`). It is **never** `path.join(..., jobId)`-ed again. Grep proof below.

**Critical fact the kickoff did not have:** `spokes/ai` construction was **not introduced or
touched by 4b-0 at all.** It is Phase 3b code (`server/storage.ts:274` comment;
`git log` → `3099d74 Phase 3b: AI inference disk persistence`). The 4b-0 diff
(`git diff 7bb7f8f^ 7bb7f8f -- server/routes.ts`) changes only the *raw-frame read fallback*
from `global.extractedFrames` to `listRawFrameFiles` — it does not alter `runOutputDir`.
So an AI-path doubling cannot be a 4b-0 regression; the construction predates 4b-0 and is
unchanged.

---

## 2. Exhaustive proof: no re-suffix site exists

`grep -nE 'path\.(join|resolve)\([a-zA-Z_][\w.]*\s*,\s*jobId' server/` — every hit uses a
**constant** first argument:

```
frameAccess.ts:41,82,103,130   path.resolve(resolvedBase, jobId)   resolvedBase = path.resolve(<const baseDir>)
applyPaths.ts:40,52            path.join(TEMP_EXTRACTED_DIR, jobId[, '_apply'])
cleanup.ts:136-140             path.join(TEMP_EXTRACTED_DIR|TEMP_PROCESSED_DIR|SPOKE_*_DIR, jobId)
tempFolderManager.ts:19,35,63  path.join(this.TEMP_BASE, jobId)    TEMP_BASE = SPOKE_TEMPLATE_MASK_DIR (const)
routes.ts:937                  path.join(SPOKE_AI_DIR, jobId, runId)
```

There is **no** `path.join(<dir-already-ending-in-jobId>, jobId)` anywhere in `server/`.

Every directory **writer** to the relevant trees (`grep -nE '\.mkdir\(|extractAllFramesSequential\(|startBackgroundFrameExtraction\('`):

```
videoProcessor.ts:1117  mkdir(rawDir)            → temp_extracted/<jobId>
frameExtractor.ts:207   mkdir(outputDir)         → temp_extracted/<jobId>/_apply (apply) ; this.tempDir (batch)
routes.ts:938           mkdir(runOutputDir)      → spokes/ai/<jobId>/<runId>
tempFolderManager.ts:22,78  mkdir(folderPath)    → spokes/template_mask/<jobId>
```

None can emit `<jobId>/<jobId>/<jobId>` or `spokes/ai/<jobId>/<jobId>`. The kickoff's
candidate causes — "a helper returning an already-suffixed path", "a job-state field storing
a resolved dir that gets re-joined", "a base passed down a call chain and re-suffixed at the
leaf" — were each checked and are **absent** from `7bb7f8f`:

- Helper returning a suffixed dir: `listFrameFiles`/`listRawFrameFiles`
  (`frameAccess.ts:125-164`) **do** return `dir = <const>/<jobId>`, but every caller uses it
  only for `fs.readFile(path.join(dir, <filename>))` — never `path.join(dir, jobId)`. (See
  the AI handler, `routes.ts:997`, and the frame route, `routes.ts:1646`.)
- Job-state field re-joined: `run.outputDir` is the only resolved dir persisted; it is never
  re-joined (read-only, list above).
- Base re-suffixed at a leaf: `extractAllFramesSequential` joins only `frame_%06d.png`.

---

## 3. The one symptom the code history *does* explain: the deleted raw frames

This is the only piece I can tie to a concrete, evidence-grounded mechanism — and it does
**not** require build-mismatch.

Pre-4b-0 parent `54487d3` (`git show 54487d3:server/services/videoProcessor.ts`):

```
:288  const extractedFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId);   // the WHOLE job dir
:314  … extractAllFramesSequential(… extractedFramesDir …)                // apply extracts into it
:455  await safeDelete(extractedFramesDir, TEMP_EXTRACTED_DIR);           // finally → deletes temp_extracted/<jobId>
```

Pre-4b-0 this was safe: raw frames lived in `global.extractedFrames` (memory), so
`temp_extracted/<jobId>` held only transient apply frames and could be wiped each run.

4b-0 (`7bb7f8f`) changed **two coupled things in one commit**: (a) it moved raw frames onto
disk at `temp_extracted/<jobId>/frame_*.png`, and (b) it narrowed both the apply-extraction
target and the `finally` delete to the `_apply` subdir.

**If the running server had (a) without (b)** — disk frames written, but the old
whole-dir delete still in `finally` — then on every apply, `safeDelete(temp_extracted/<jobId>,
TEMP_EXTRACTED_DIR)` deletes the persistent `frame_*.png`. That reproduces the
"164 raw frames gone everywhere" symptom exactly, with a literal resolved target of
`temp_extracted/<jobId>`.

This is a **source-state** hypothesis (the deployed source was an intermediate 4b-0
iteration, or local edits, where the disk-write landed before the delete was narrowed), **not**
a build-artifact hypothesis. I cannot confirm it from the repo because there is exactly one
4b-0 commit and it already has both halves. It is the most parsimonious explanation for the
deletion and is worth stating, flagged as unverifiable-from-git.

It does **not**, by itself, explain the `<jobId>/<jobId>/<jobId>` nesting — no committed
revision (4b-0 or its parent) contains a nesting source.

---

## 4. Honest read of the AI "doubling" and the 3-level nesting

- **`spokes/ai/<jobId>/<jobId>/`:** the constructed path is `spokes/ai/<jobId>/<runId>`
  (`routes.ts:937`), where `jobId` and `runId` are two different 36-char UUIDs. On disk these
  are visually similar; an `ls` read as "doubled jobId" is consistent with the **designed
  `<jobId>/<runId>` layout**. A literal same-`jobId` double would require a source line that
  does not exist in `7bb7f8f` (or in Phase 3b, where this path was written).
- **`temp_extracted/<jobId>/<jobId>/<jobId>/` (empty, 3 deep):** no committed code path
  produces a single `<jobId>/<jobId>`, let alone three levels accumulating across runs. To
  emit three levels you need a `path.join(dirEndingInJobId, jobId)` executed on a base that is
  itself the prior run's output — i.e. exactly the "re-suffix a stored resolved dir" pattern
  the kickoff predicted. That pattern is **absent** from this source.

Both observations point the same way: the on-disk evidence was produced by **something other
than the committed `7bb7f8f` source running unmodified** — either a deployed source that
differs from `7bb7f8f` (intermediate iteration / uncommitted edits — not a stale *bundle*),
the `<runId>` segment misread as `<jobId>`, or out-of-process directory creation during the
incident. I will not assert a file:line root cause that the code does not contain.

---

## 5. What I need to close this (one artifact)

To distinguish "misread `<runId>`" from "real same-`jobId` double", and to confirm the
deployed source, I need ground truth that is not in the repo:

1. The literal `ls -la temp_extracted/<jobId>/` and `ls -la spokes/ai/<jobId>/` from the
   incident host (or scrollback) — so I can check whether the nested segment equals `jobId`
   or is a distinct UUID (`runId`).
2. The exact SHA (or `git status`/diff) the incident server had checked out and built. The
   kickoff says the deploy builds the checked-out SHA; the question is **which source** that
   SHA pointed at — if it was not `7bb7f8f`, the clean-source proof above stands and the bug
   lives in that other source, which I can then read.

If neither is recoverable, §6 is the defensible path: harden so the symptoms are impossible
regardless of which source variant runs, and add a server-side check that would have caught
it.

---

## 6. Proposed direction (no code yet — for approval)

Defense-in-depth that makes all three symptoms structurally impossible, explicitly labeled as
defense, not as "the located root cause":

1. **Keep `applyPaths.ts`** (already idempotent for the template-mask path). This is sound and
   already guarantees `temp_extracted/<jobId>/_apply` and the `_apply`-only delete.
2. **Bring the AI run dir under the same pattern** — add `aiRunDir(jobId, runId)` to a shared
   pure-path module deriving from `SPOKE_AI_DIR`, with an `assert` that the result is exactly
   `SPOKE_AI_DIR/<jobId>/<runId>` (two single segments, no separators inside either). Wire
   `routes.ts:937` to it. This is the "same source, both paths idempotent" the kickoff wants —
   one helper module, not two ad-hoc patches.
3. **Server-side tripwire** (the check that would have caught the real cause): at each `mkdir`
   site (`videoProcessor.ts:1117`, `frameExtractor.ts:207`, `routes.ts:938`), log the
   **literal resolved path**, and assert it contains no `<seg>/<seg>` where the two segments
   are equal. Cheap, and it converts a silent nesting into a loud failure with the literal
   string — exactly the runtime evidence this investigation lacked.
4. **Frame-deletion guard rationale (addresses the kickoff red flag):** the `_apply`-only
   delete in `applyPaths.cleanupApplyStaging` is justified by §3 — the historical delete
   target was the whole `temp_extracted/<jobId>`, and the narrowing to `_apply` is the actual
   correctness change, not a guard hiding an unknown. I will document this rationale inline so
   the guard is not "a guard that hides an unexplained cause."

### Tests (GPU-free, extend `applyPaths.test.ts`)
- Existing template-mask coverage retained.
- New: call `aiRunDir(jobId, runId)` twice for one `jobId` (two different `runId`s and the
  same `runId`), assert the result is always `spokes/ai/<jobId>/<runId>` and never contains
  `<jobId>/<jobId>`. This passes against the current source — presented honestly as
  **confirmation that the source cannot double**, with the tripwire (item 3) as the runtime
  net for the case the unit test cannot reach.

### Scope / constraints (unchanged)
- No 5a/5b/5c/read-path regression; no `global.extractedFrames`; no retention/`SWEEP_TARGETS`
  change; no three-path consolidation; `tsc --noEmit` stays at 17; backend-only.

---

## 7. Why this proposal does not fabricate a root cause

The kickoff lists three rejection triggers: (a) build mismatch — not invoked; (b) reasoning
from constants instead of the runtime chain — I traced the real chain and the git diff, and
present the chain, not the constants' intent; (c) `spokes/ai` doubling unexplained — I located
its construction at `routes.ts:937` and showed it yields `<jobId>/<runId>`, that it predates
4b-0, and that no source produces a same-`jobId` double.

The remaining gap (the literal 3-level nesting on disk) cannot be honestly attributed to a
line that does not exist. Per the kickoff's own allowance, I state that explicitly and propose
both the structural impossibility (helpers + asserts) and the runtime tripwire that would
capture it if it ever recurs. I would rather hand you a true "the committed source can't do
this, here's the one artifact that resolves it" than a confident, false file:line — that false
confidence is the exact failure mode this v2 was created to stop.
