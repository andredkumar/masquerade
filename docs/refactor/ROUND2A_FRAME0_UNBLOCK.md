# Round 2A — Unblock "draw while extracting" (frame-0 gate removal)

**Status:** proposed 2026-08-30. Independent of the perf timings (Round 2B waits on the prod `[PERF]` numbers).
**Background:** `docs/refactor/FRAME0_GATE_HISTORY.md` — the block was a Phase 4b design default for an
in-memory frame store, carried forward unchanged after frames moved to disk in 4b-0. No error ever
required it. `docs/refactor/PERF_ROUND1_REPORT.md` §4 has the current gating sites with line cites.

## 1. Target behavior

Restore the original design, with one guard the legacy flow never had:

1. Upload → hub. The **Template Mask tile is clickable as soon as frame 1 is on disk** (practically:
   immediately after upload). The AI tile stays gated on `status === 'ready'` — inference needs all frames.
2. The template-mask spoke shows **frame 1 and lets the user draw while extraction continues.**
3. **Apply is disabled until `job.status === 'ready'`**, with live extraction progress shown next to
   it ("Extracting frames… 212 / 640"). It enables itself when extraction completes — no reload.
4. If the user opens the spoke *before* frame 1 exists (fast click, slow disk), the spoke shows the
   existing "extracting" spinner and **polls until the frame arrives**, then swaps to the canvas.

Everything else — apply pipeline, download, AI spoke, image-batch jobs (already `ready` at upload),
DICOM — behaves exactly as today.

## 2. Hard constraints

- **tsc stays at 12.** (Same 12: 5 `frameExtractor.ts` + 7 `maskWorker.ts`.)
- **A3 storage/schema/status FROZEN.** No new status value, no new column, no change to
  `mapVideoJobStatusToJobStatus`, no touching `storage.ts` / `pgStorage.ts` / `migrations/`.
  `'extracting'` and `'ready'` are the only two states this change reads.
- **No changes to extraction code.** `frameExtractor.ts`, `startBackgroundFrameExtraction`,
  `processVideo`, `extractAllFramesSequential` are untouched. The `[PERF]` probes from Round 1 stay.
- **Do not touch** the DICOM branch, `[DEADROUTE-HIT]`, `temp_processed/`, or the swept-dir (410) semantics.
- Frame naming/indexing invariant unchanged: positional index into the sorted `frame_%06d.png` list.

## 3. Changes

### 3.1 Backend — `server/routes.ts`, frames endpoint, raw branch (~`:1612`)

Today:
```ts
if (jobV2.status === 'extracting') return res.status(503).json({ error: "Extraction in progress" });
// … list temp_extracted/<jobId>/, 410 if empty, 404 if n out of range, serve rawFiles[n]
```

New logic for the **raw branch only** (`?source=template_mask` branch unchanged):

```
list temp_extracted/<jobId>/ (sorted frame_*.png)
if status === 'extracting':
    if n < files.length AND isCompletePng(files[n]):   → 200, serve it
    else                                               → 503 { error: "Extraction in progress", framesReady: files.length }
else (ready / failed — unchanged from today):
    empty dir → 410 ; n out of range → 404 ; else 200
```

`isCompletePng(path)`: read the file, check the last 8 bytes are the PNG IEND trailer
(`49 45 4E 44 AE 42 60 82`). This is the whole race guard — the extractor writes each batch's files
with concurrent `writeFile`s, so a read can land on a partially written frame; a truncated PNG has no
IEND. Cost is one read you were doing anyway. Put the helper in `server/services/frameAccess.ts`
next to `listRawFrameFiles` and cover it with a red/green test in
`server/services/__tests__/` (truncated file → false; whole file → true) following the
`applyPaths.test.ts` pattern (`npx tsx <file>`).

**Cache header:** the 200 response carries `Cache-Control: private, max-age=3600` today. Keep it for
the 200; make sure the 503 sends `Cache-Control: no-store` so a browser never caches the "extracting"
answer.

Add `framesReady` to the 503 body — the spoke can show "Extracting… 12 / 640" without a socket
dependency, and it costs nothing.

### 3.2 Frontend — `client/src/pages/hub.tsx` (~`:47`, `:169`)

```ts
const isReady = job.status === "ready";
const canMask = isReady || job.status === "extracting";   // new
```
Template Mask tile: `disabled={!canMask}`. AI tile: unchanged `disabled={!isReady}`.
While `extracting`, the Template Mask tile shows a small sub-label ("Frame 1 ready — draw your mask
while frames extract") so the user knows this is intended. The "Extracting frames…" panel stays.

### 3.3 Frontend — `client/src/pages/template-mask-spoke.tsx` (~`:46-75`, `:149`)

- On `503`: keep `frameStatus = "extracting"` and the spinner, but **poll `frames/0` every 1000 ms**
  until it returns 200 (then stop). Cap at ~120 s, then fall to the existing error state. Also keep
  the existing "refetch when `job.status` becomes `ready`" as the belt-and-braces path. Clear the
  interval on unmount and on success.
- On `200`: render the canvas exactly as today. Nothing about drawing changes.
- The `framesReady` field from the 503 body (if present) is shown in the spinner text.

### 3.4 Frontend — Apply gating (`ProcessingControls.tsx` or the spoke, wherever the Apply button lives)

- `disabled` when `job.status !== 'ready'` (in addition to the existing "no mask drawn" condition).
- While `extracting`, render next to/under the button: "Extracting frames… {current} / {total}",
  driven by the `progress` socket event `JobContext` already joins (5D). If `JobContext` does not
  expose the granular progress, fall back to "Extracting frames…" + the `framesReady` count from the
  latest 503 — do **not** add a new backend progress source (that is 7A-3 territory; keep it out).
- When `status` flips to `ready` the button enables with no reload — `JobContext` already refetches
  on the `progress` event and polls while non-terminal.

### 3.5 Not in scope (say so in the report if tempted)

- The orphan base64 `firstFrame` in the upload response (dead since 4b). Leave it; cleanup backlog item.
- Any extraction, apply, or DICOM performance change — Round 2B, after the numbers.
- Deleting `maskWorker.ts` (dead code, 7 tsc errors) — separate tsc-baseline pass.
- `temp_extracted/` 6 h retention / the 410 path — unchanged.

## 4. Known edge cases — decide these explicitly, don't discover them in prod

| Case | Expected |
|---|---|
| Server restart mid-extraction (status stuck `extracting`, upload purged on boot) | Same as today: Apply never enables. Spoke shows spinner then the 120 s cap → error state. Not a regression; note it. |
| Extraction fails (`status: 'failed'`) | Hub tile behavior unchanged from today (whatever it does for `failed`); spoke's existing error UX. |
| `temp_extracted/<jobId>/` swept while spoke open | 410 path unchanged. |
| Image batch job | `ready` at upload; nothing changes. |
| DICOM single-frame | 1 frame, `ready` almost immediately; nothing observable changes. |
| DICOM multiframe | Per-frame sync loop writes `frame_000001.png` first; canvas appears early. |
| User draws, then extraction finishes | Mask state is client-side; nothing resets. Apply just enables. |
| User hits Apply the instant it enables | Apply handler reads `temp_extracted` after `ready` was set at the end of the batch loop — all frames present. No new race. |

## 5. Deliverable

- The code changes above, `npx tsc --noEmit` = 12 (same 12), `npm run build` clean.
- The `isCompletePng` red/green test passing.
- `docs/refactor/ROUND2A_REPORT.md`: files changed with line cites, the edge-case table above with
  each row marked *verified-in-code / deferred*, and anything that deviated from this spec and why.
- Do **not** deploy; hand back for the runbook (`ROUND2A_DEPLOY_RUNBOOK.md`).

## 6. Kickoff message for Claude Code

> Continuing Masquerade (bring CLAUDE.md). Round 1 perf instrumentation is landed (`[PERF]` probes,
> `docs/refactor/PERF_ROUND1_REPORT.md`) and stays. Now implement
> `docs/refactor/ROUND2A_FRAME0_UNBLOCK.md`: remove the frame-0 gate so the user can draw the template
> mask while frames are still extracting, with Apply disabled until `status === 'ready'`. Read
> `docs/refactor/FRAME0_GATE_HISTORY.md` first for why the gate exists. Exactly the four changes in §3
> (frames-endpoint raw branch with the IEND completeness check + `no-store` on 503, hub tile `canMask`,
> spoke 503 polling, Apply gating). No extraction/apply/DICOM code changes, no new status values,
> A3 frozen, tsc stays at the same 12. Add the `isCompletePng` red/green test. Walk the §4 edge-case
> table and mark each row. Output `docs/refactor/ROUND2A_REPORT.md` and stop before deploying.
