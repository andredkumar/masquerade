# Phase 4b-0 Report — Raw Frames to Disk

**Date:** 2026-06-12
**Scope:** Backend-only. Move raw extracted frames off the volatile in-memory
`global.extractedFrames` map onto disk at `temp_extracted/<jobId>/frame_NNNNNN.png`,
eliminating the PM2-restart data-loss class for jobs in the `'ready'` state.
**Constraint:** No frontend changes (verified, see §6). No new dependencies.
tsc error count unchanged (17 pre-existing, see §7).

---

## 1. Summary

Before this phase, three things were true and inconsistent:

1. `startBackgroundFrameExtraction` wrote raw frames as `Buffer`s into
   `global.extractedFrames: Map<jobId, Map<frameNumber, Buffer>>`.
2. `temp_extracted/<jobId>/` existed, was defined as `TEMP_EXTRACTED_DIR`, was
   listed in `SWEEP_TARGETS`, and was documented as the raw-frame target — but
   nothing ever wrote to it.
3. A PM2 restart wiped the in-memory frames, leaving `'ready'` jobs un-maskable
   (same volatility class as the pre-3b `maskArtifactStore`).

Phase 4b-0 makes the code match the documentation: background extraction now
writes to `temp_extracted/<jobId>/`, the frames endpoint and the AI raw-frame
fallback read from there, and the in-memory store is gone. Raw frames now
survive a restart for the duration of the `temp_extracted/` 6h retention window.

A collision hazard surfaced during implementation (apply-time re-extraction
shares the same job directory) and forced a design refinement that was NOT in
the literal approved plan: apply-time staging is isolated into an `_apply/`
subdirectory. This is documented in full in §4.

---

## 2. Files Changed

| File | Change |
|---|---|
| `server/services/frameAccess.ts` | Imported `TEMP_EXTRACTED_DIR`; added `listRawFrameFiles(jobId)` — a thin wrapper over `listFrameFiles` pinned to `TEMP_EXTRACTED_DIR`. The `.png/.jpg` filter ignores the `_apply/` subdir entry. |
| `server/services/videoProcessor.ts` | (a) `startBackgroundFrameExtraction` now writes frames to `temp_extracted/<jobId>/frame_NNNNNN.png` (1-indexed) instead of `global.extractedFrames`; removed the in-memory `frameStore` Map and the `global.extractedFrames` write. (b) `processVideo`'s apply-time staging dir moved to the isolated `temp_extracted/<jobId>/_apply/` subdir. (c) `processVideo`'s `finally` now `safeDelete`s only `_apply/` and **no longer calls `deleteUploadFile`** — the upload and persistent raw frames must survive for the redo loop. |
| `server/routes.ts` | (a) `GET /api/jobs/:jobId/frames/:n` raw branch reads from disk via `listRawFrameFiles` (positional index), returns 410 when the dir is absent/empty. (b) AI inference raw-frame fallback reads frames from disk via `listRawFrameFiles` instead of the in-memory map. (c) Corrected the two `startBackgroundFrameExtraction` `.catch` comments that referenced processVideo's finally. |
| `CLAUDE.md` | Marked the "Raw frames live in-memory" and "`temp_extracted/` documentation drift" known-issue sections RESOLVED; updated "Three extraction paths" path #2 to disk and #3 to `_apply/`; updated the cleanup eager-delete bullets to reflect the `_apply` retarget and removed `deleteUploadFile`. |
| `docs/refactor/PHASE_4B0_PROPOSAL.md` | Updated with the approved amendments + the collision-hazard discovery and `_apply` resolution (done before implementation). |

### Files explicitly NOT touched

- `client/**` — no frontend change required (see §6).
- `server/services/frameExtractor.ts` — `extractAllFramesSequential` and
  `extractFrameBatch` unchanged; only their call sites' output directories
  changed.
- `server/services/cleanup.ts` — `SWEEP_TARGETS`, retention windows, and
  `safeDelete` unchanged. `temp_extracted/` was already a sweep target; it is
  now actually populated.

---

## 3. The disk migration, in detail

### Background extraction (the core change)

`startBackgroundFrameExtraction` previously accumulated each batch into an
in-memory `Map<number, Buffer>` keyed 0-indexed, then assigned it to
`global.extractedFrames`. It now:

```ts
const rawFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId);
await fs.mkdir(rawFramesDir, { recursive: true });
// ...per batch:
await Promise.all(
  batchFrames.map((frameBuffer, index) => {
    const frameNumber = batch.start + index;
    const padded = String(frameNumber + 1).padStart(6, '0');
    return fs.writeFile(path.join(rawFramesDir, `frame_${padded}.png`), frameBuffer);
  }),
);
```

Frame numbering is **1-indexed** (`frame_000001.png` for batch frame 0) to match
`extractAllFramesSequential`'s ffmpeg `%06d` convention, so the persistent raw
store and the apply pipeline name frames identically.

### Read sites

- **`GET /api/jobs/:jobId/frames/:n`** (raw branch): `listRawFrameFiles(jobId)`
  returns a sorted, deduped filename list; the frame is addressed by sorted
  position (`rawFiles[frameNumber]`), identical to the existing `template_mask`
  branch. Returns **410** when the directory is absent/empty (swept or never
  written), **404** when the index is out of range, **503** while
  `status === 'extracting'`.
- **AI inference raw-frame fallback**: iterates `rawFrameFileNames` and reads
  each frame from disk on demand (`await fsPromises.readFile(...)`), decoding to
  base64 only for the duration of one inference call — the same per-frame
  read-then-discard pattern already used by the masked-frames branch.

### Indexing note (carried forward from the pre-4b-0 behavior)

The in-memory store keyed frames 0-indexed; the read sites addressed them
positionally into a sorted key/file list. Both old and new code resolve frame
`n` to "the n-th frame in sorted order," so this migration is index-neutral. The
1-indexed *filename* is an internal naming detail; callers never see it.

---

## 4. Divergence from the approved plan: `_apply/` staging isolation

This is the one place the implementation departs from the literal approved
proposal, and it was necessary.

### The collision hazard

`processVideo` re-extracts frames from the original upload at apply time, into
what was `temp_extracted/<jobId>/`. `extractAllFramesSequential`:

1. does `mkdir(outputDir, { recursive: true })` — it does **not** clear the dir;
2. runs ffmpeg writing `frame_%06d.png`;
3. reads back **every** `frame_\d+.png` in the dir to compute the returned frame
   list and, transitively, `totalFrames`.

Before 4b-0 this was safe because `temp_extracted/<jobId>/` was empty until apply
(background frames lived in memory). Once 4b-0 persists background frames into
that same directory, an apply re-extraction would read back BOTH the persistent
background frames AND the freshly re-extracted ones. If the apply runs at a
different `samplingFps` (fewer frames), the stale higher-numbered background
frames inflate the count and corrupt the applied set. Even at a matched fps,
ffmpeg seek/`-vsync` drift could leave a mismatched tail.

### The resolution

Apply-time staging is sandboxed into an isolated subdirectory:

```ts
const extractedFramesDir = path.join(TEMP_EXTRACTED_DIR, jobId, '_apply');
```

- Persistent raw frames stay at `temp_extracted/<jobId>/frame_*.png`.
- Apply re-extraction reads/writes only `temp_extracted/<jobId>/_apply/`.

The isolation is bidirectional and verified in code, not just prose:

- **Apply readback is scoped to `_apply/`** (the load-bearing claim).
  `processVideo` passes `extractedFramesDir = temp_extracted/<jobId>/_apply` as
  the `outputDir` argument to `extractAllFramesSequential` (videoProcessor.ts:295,
  320–327). Inside that function, the ffmpeg write target is
  `path.join(outputDir, 'frame_%06d.png')` (frameExtractor.ts:209 — writes into
  `_apply/`, 1-indexed from `frame_000001.png`) **and** the readback is
  `await fs.readdir(outputDir)` (frameExtractor.ts:225) — a single-level read of
  `_apply/` only. It never reads the parent `temp_extracted/<jobId>/`, so the
  returned count (→ `extractedCount` → `totalFrames`, videoProcessor.ts:328/340)
  reflects `_apply/` files exclusively. Persistent background frames in the
  parent cannot inflate or corrupt the applied set.
- **Raw reads never descend into `_apply/`.** `listFrameFiles`/`listRawFrameFiles`
  do a non-recursive `fs.readdir` of the parent and filter `/\.(png|jpe?g)$/i`;
  the `_apply` directory entry has no file extension, so it is excluded. A
  raw-frame read never sees apply-time staging.
- `processVideo`'s `finally` `safeDelete`s `_apply/` only — bounded to
  `TEMP_EXTRACTED_DIR`, error-swallowed so it can't re-throw out of `finally`.

This keeps the two re-extraction paths independent (the same independence
CLAUDE.md's "Three extraction paths" note describes) while letting them coexist
under one job directory.

---

## 5. Upload-file lifetime widening (investigation results)

The approved amendment authorized widening 4b-0 to touch upload-file lifetime if
documented. Investigation answered the four sub-questions:

1. **Does `processVideo` read from `uploads/` at apply time?** Yes. It is invoked
   with `job.filePath` (an `uploads/<file>` path) and re-extracts from it.
2. **Did `finally` call `deleteUploadFile`?** Yes — pre-4b-0, `processVideo`'s
   `finally` deleted the upload on every terminal status.
3. **Can re-apply work without the upload?** No. Re-apply re-extracts from the
   upload, so deleting it after the first apply broke the redo loop.
4. **Minimal change to support a redo loop?** Remove the `deleteUploadFile` call
   from `processVideo`'s `finally`. (Verified `deleteUploadFile` is still used by
   `processImages` at videoProcessor.ts:756, so the import stays.)

### What this changes

- **`processVideo` no longer deletes the upload** on apply completion. The upload
  is reclaimed by: the hourly retention sweep (`uploads/` 2h), the SIGTERM purge,
  `cleanupJobArtifacts(jobId)`, and the explicit `DELETE /api/jobs/:jobId`
  handler.
- The background-extraction `.catch` blocks (routes.ts) still call
  `deleteUploadFile` on **extraction** failure. That is correct: a job whose
  extraction fails never becomes applyable, so no redo loop depends on its
  upload. Their comments were corrected to say so.

### Redo-loop bound

- **How many loops?** Unbounded *count* within the retention windows — the same
  upload and raw frames can drive any number of re-mask/re-apply cycles.
- **What bounds it?** The binding constraint is the `uploads/` **2h** window,
  because re-apply re-extracts from the upload. Drawing/masking alone (frames
  endpoint) is bounded by `temp_extracted/` **6h**.
- **Past 2h:** re-apply degrades gracefully — `processVideo` fails to read the
  upload and the job moves to a processing error, not a crash. The PHI-shortest
  2h `uploads/` retention is unchanged.

---

## 6. Client verification (no change required)

The template-mask spoke's frame-0 fetch was verified to read RAW, not
`?source=template_mask`:

`client/src/pages/template-mask-spoke.tsx:47`
```ts
const res = await fetch(`/api/jobs/${jobId}/frames/0`);
```

No `source` query param → hits the raw branch → reads
`temp_extracted/<jobId>/frame_000001.png` from disk. **No client edit was made.**
The masking canvas continues to work unchanged because the frames endpoint's
raw branch is now disk-backed and returns the same bytes the in-memory path used
to.

---

## 7. Verification

- **`global.extractedFrames` removed from live code:** `grep -rn
  "global.extractedFrames" server/` returns only historical comments
  (frameAccess.ts:148, videoProcessor.ts:1108, routes.ts:914/993/1597). No live
  read/write remains. The `frameStore` Map is gone. No orphaned `declare global`
  for it. (The bare token `extractedFrames` also legitimately appears as a local
  loop counter and the `extractedFramesDir` path variable in videoProcessor.ts —
  neither is the old store.)
- **`rawFrameMap` / `rawFrameKeys` removed:** zero references in `server/`.
- **tsc:** `npx tsc --noEmit` reports exactly **17 errors**, all pre-existing —
  10 in `frameExtractor.ts`, 7 in `maskWorker.ts`. None in the three files this
  phase changed. No new errors introduced.

---

## 8. Durability test (REQUIRED — the load-bearing check for this phase)

The following within-session sequence must pass. Step 6 (full redo after an AI
delete) is the load-bearing verification for Phase 4b-0; the upload-lifetime and
`_apply` changes exist specifically to make it pass.

1. Upload a video → background extraction writes
   `temp_extracted/<jobId>/frame_*.png`.
2. Open the template-mask spoke → frame 0 loads from disk (frames endpoint, raw
   branch).
3. Draw a mask → apply → masked frames land in
   `spokes/template_mask/<jobId>/`; apply-time staging used `_apply/` and was
   swept by `processVideo`'s `finally`. **Persistent raw frames and the upload
   still exist.**
4. Run AI → AIRun output in `spokes/ai/<jobId>/<runId>/`.
5. Delete the AI run.
6. **REQUIRED PASS — full redo loop:** re-open the template-mask spoke (frame 0
   still loads from `temp_extracted/<jobId>/`), re-draw the mask, re-apply
   (`processVideo` re-extracts from the surviving `uploads/<file>`), then re-run
   AI. Verify that after the re-apply, **both** the `temp_extracted/<jobId>/`
   raw frames **and** the `uploads/<file>` upload still exist.

**Boundary:** The redo loop is guaranteed only within the `uploads/` 2h window
(re-apply's extraction source). Beyond 2h, drawing may still work (frames within
6h) but re-apply will fail gracefully with a processing error once the upload
has been swept.

---

## 9. Residual notes / follow-ups

- **Partial-extraction + failure interaction:** if `startBackgroundFrameExtraction`
  writes some batches then throws, the `.catch` deletes the upload while partial
  frames remain in `temp_extracted/<jobId>/`. The job is broken regardless (status
  → `'error'`) and both artifacts are reclaimed by the sweep. No correctness
  impact; noted for completeness.
- **Full extraction-path consolidation** (single extraction, single source of
  truth feeding both the canvas and apply) remains a backlog item. Phase 4b-0
  only relocated path #2's storage from memory to disk; paths #2 and #3 still
  re-extract independently, now coexisting under `temp_extracted/<jobId>/` via
  the `_apply/` split.
