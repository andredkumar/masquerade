# Phase 4b-0 Proposal — Raw Frames to Disk

**Goal:** Move raw extracted frames from volatile in-memory storage
(`global.extractedFrames`) to disk (`temp_extracted/<jobId>/frame_NNNNNN.png`).
This makes frames durable within a server lifetime and eliminates the
PM2-restart data-loss class.

---

## 1. Current state (what exists today)

### Three extraction paths

| # | Routine | Trigger | Output | Naming |
|---|---------|---------|--------|--------|
| 1 | `extractFirstFrame` | Upload time (inline) | Single `Buffer` returned in the upload response as base64 | Temp file `first_frame_<ts>.png`, deleted immediately |
| 2 | `startBackgroundFrameExtraction` | `setImmediate` after upload response (`videoProcessor.ts:1068`) | `Map<number, Buffer>` stored on `global.extractedFrames` | In-memory keys: 0, 1, 2, … (frame index) |
| 3 | `extractAllFramesSequential` via `processVideo` | Template-mask Apply click (`videoProcessor.ts:312`) | Disk: `temp_extracted/<jobId>/frame_000001.png` … | ffmpeg `frame_%06d.png` (1-indexed by ffmpeg convention) |

### Readers of `global.extractedFrames`

Full grep accounting (excluding `deployment-package/`, docs, and `CLAUDE.md`):

| Location | Line(s) | Access | Description |
|----------|---------|--------|-------------|
| `videoProcessor.ts` | 1132–1133 | **Write** | `startBackgroundFrameExtraction` stores the frame map |
| `routes.ts` | 1629–1630 | **Read** | `GET /api/jobs/:jobId/frames/:n` — raw frame serving endpoint |
| `routes.ts` | 912–913 | **Read** | AI inference handler — raw-frame fallback when no template-mask frames exist |

Three references total in live code. All must be migrated.

### `processVideo` staging dir behavior

`processVideo` (`videoProcessor.ts:288`) creates `temp_extracted/<jobId>/` via
`extractAllFramesSequential`, reads the frames back into buffers for mask
application, then **deletes** the staging dir in its `finally` block
(`videoProcessor.ts:455`: `safeDelete(extractedFramesDir, TEMP_EXTRACTED_DIR)`).

This means `processVideo` already writes to `temp_extracted/<jobId>/` using
the same directory 4b-0 will populate during background extraction. The key
difference: processVideo uses `frame_%06d.png` (1-indexed by ffmpeg:
`frame_000001.png`, `frame_000002.png`, …).

### Cleanup coverage

`temp_extracted/` is already in `SWEEP_TARGETS` (`cleanup.ts:67`) with a 6-hour
retention window. The hourly cron, SIGTERM handler, and
`cleanupJobArtifacts(jobId)` all cover it. No retention-window or membership
changes needed.

---

## 2. Files to change

| File | Action | What changes |
|------|--------|-------------|
| `server/services/videoProcessor.ts` | Modify | (a) `startBackgroundFrameExtraction`: write each batch frame to disk at `temp_extracted/<jobId>/frame_NNNNNN.png` (1-indexed, matching ffmpeg) instead of the in-memory `frameStore`. Remove `global.extractedFrames` write at line 1132–1133. (b) `processVideo`: move apply-time staging to the isolated subdir `temp_extracted/<jobId>/_apply/` (so re-extraction can't collide with the persistent raw frames — see Section 6). (c) `processVideo` `finally` (lines 445–461): retarget `safeDelete` to the `_apply` subdir only (keep the persistent raw frames) and **remove** `deleteUploadFile(videoPath)` (line 459) so the upload survives for re-apply. |
| `server/routes.ts` | Modify | `GET /api/jobs/:jobId/frames/:n` endpoint (line 1596): read raw frames from `temp_extracted/<jobId>/` on disk instead of `global.extractedFrames`. AI inference handler (line 906–1012): read raw-frame fallback from `temp_extracted/<jobId>/` on disk. |
| `server/services/frameAccess.ts` | Modify | Add a `resolveRawFramePath` helper (or reuse `listFrameFiles` with a `TEMP_EXTRACTED_DIR` base) for bounded path resolution against `temp_extracted/`. |
| `CLAUDE.md` | Modify | Update "Raw frames live in-memory" section, "temp_extracted/ documentation drift" section, and "Three extraction paths" section to reflect the new disk-based reality. |

### Files NOT touched

- Zero frontend files (`client/src/**`) — template-mask spoke already reads
  raw frames (`/api/jobs/:jobId/frames/0`, no `?source` param); verified, no change
- `videoProcessor.ts` mask-application logic — the `processVideo` mask/extract
  body stays as-is. **Exception:** its `finally` block loses two eager deletions
  (raw-frame dir + upload file); see Sections 2 and 6
- `frameAccess.ts` mask/overlay resolution helpers (only adding a raw-frame helper)
- `templateMaskApply.ts`, `sam2-service/`, `frameExtractor.ts`
- `cleanup.ts` (no SWEEP_TARGETS or retention changes)
- No `UPLOAD_PROCESS_BEFORE_AND_AFTER.md` exists in the repo — nothing to update

---

## 3. Disk layout

After 4b-0, background extraction writes to:

```
temp_extracted/<jobId>/
  frame_000001.png
  frame_000002.png
  …
  frame_NNNNNN.png
```

This matches the naming convention `extractAllFramesSequential` already uses
(ffmpeg `frame_%06d.png`, 1-indexed). Using the same convention means:

- The frames endpoint and AI inference raw-frame fallback can use
  `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` (or a similar bounded helper)
  to enumerate and serve frames by sorted position, exactly like the
  `?source=template_mask` path already does for `SPOKE_TEMPLATE_MASK_DIR`.
- `processVideo` at apply time already writes to the same path. See
  section 6 for how the apply-time interaction is handled.

---

## 4. Endpoint behavior changes

### `GET /api/jobs/:jobId/frames/:n`

**Current:** Reads from `global.extractedFrames` (in-memory).

**After 4b-0:** Reads from `temp_extracted/<jobId>/` (disk) via the
`listFrameFiles` helper with `TEMP_EXTRACTED_DIR` as baseDir.

Response contract is preserved:

| Status | Condition | Change? |
|--------|-----------|---------|
| `200` + PNG bytes | Frame found | Same (source changes from memory to disk) |
| `400` | Invalid frame number | No change |
| `404` | Job V2 not found, or frame index out of range | No change |
| `503` | Job V2 status is `extracting` | No change |
| `410` | Job exists but `temp_extracted/<jobId>/` has no frames (swept or never written) | Same semantics, now checks disk instead of in-memory map |

Cache headers (`private, max-age=3600`) preserved.

The `?source=template_mask` path is **untouched** — it already reads from
`SPOKE_TEMPLATE_MASK_DIR` on disk.

### AI inference handler (raw-frame fallback)

**Current** (`routes.ts:912`): Reads `global.extractedFrames.get(jobId)`, iterates
buffer map keys, converts each to base64.

**After 4b-0:** Uses `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` to enumerate
raw frame files on disk, reads each file and converts to base64 for the
inference client. Same branching logic: try template-mask frames first
(`listFrameFiles(jobId, SPOKE_TEMPLATE_MASK_DIR)`), fall back to raw frames
(`listFrameFiles(jobId, TEMP_EXTRACTED_DIR)`), then single-frame-base64
fallback.

---

## 5. Decommission plan for `global.extractedFrames`

After the disk writes and reads are in place, `global.extractedFrames` is
removed entirely:

1. **`videoProcessor.ts:1132–1133`** — Delete the two lines that write to
   `global.extractedFrames`. The local `frameStore` Map and the batching loop
   that populates it also become unnecessary: instead, each batch writes PNGs
   to disk directly.

2. **`routes.ts:1629–1630`** — Replace in-memory map read with disk read via
   `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)`.

3. **`routes.ts:912–913`** — Replace in-memory map read with disk read via
   `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)`.

No dual-write. No "keep the old path for safety." The in-memory store is gone
after this phase.

---

## 6. `processVideo` apply-time interaction (AMENDED)

`processVideo` already writes to `temp_extracted/<jobId>/` via
`extractAllFramesSequential` (reading from `videoPath` = `job.filePath`, the
original upload), reads the frames back into buffers for mask application, then
runs a `finally` block that — when `reachedTerminal` is true —
**deletes both the staging dir and the upload file**:

```ts
// videoProcessor.ts:445–461 (verified)
} finally {
  if (reachedTerminal) {
    try {
      await safeDelete(extractedFramesDir, TEMP_EXTRACTED_DIR);   // line 455 — deletes temp_extracted/<jobId>/
    } catch (cleanupErr) { /* swallowed */ }
    await deleteUploadFile(videoPath);                            // line 459 — deletes uploads/<file>
  }
}
```

### Decision: keep apply-time re-extraction, but STOP deleting the shared raw-frame dir and the upload file in `finally`.

Removing `processVideo`'s apply-time re-extraction (so it reads the persisted
`temp_extracted/<jobId>/` frames directly) is the "full extraction path
consolidation" item and stays **out of scope** for 4b-0. What changes here is
narrow: the two `finally` deletions that destroy the raw frames and the upload
source the redo loop depends on.

### Investigation findings (upload-source-file lifetime vs re-apply)

The kickoff asked four questions. Answers, all verified against the working tree:

1. **Does `processVideo` read from the original upload in `uploads/` at apply
   time?** **Yes.** `applyTemplateMask` calls
   `videoProcessor.processVideo(jobId, job.filePath, …)`
   (`templateMaskApply.ts:85`). `job.filePath` is the `uploads/<file>` original.
   `extractAllFramesSequential(videoPath, extractedFramesDir, …)`
   (`videoProcessor.ts:312`) re-extracts from that upload every apply.

2. **Does the `finally` block call `deleteUploadFile`?** **Yes**, at
   `videoProcessor.ts:459`, when `reachedTerminal` is true (i.e. on every
   completed OR definitively-failed apply). It also `safeDelete`s the
   `temp_extracted/<jobId>/` staging dir at line 455.

3. **Can re-apply work without the upload file?** **Not without the out-of-scope
   change.** Because apply-time re-extraction is retained, `processVideo` needs
   the upload file present to re-extract. The persisted `temp_extracted/<jobId>/`
   frames are enough for *drawing* (the frames endpoint serves them) but not for
   *applying*, since the apply path re-runs ffmpeg against `videoPath`. So the
   redo loop requires the upload file to survive.

4. **Minimal change to support ONE full redo loop** — see the collision note
   below, which forces a small refinement over "just remove the two deletes."

### Collision hazard discovered during implementation tracing

`extractAllFramesSequential` (`frameExtractor.ts:207–232`) does **not** clear its
output dir before running ffmpeg; it `mkdir(recursive)`, writes `frame_%06d.png`,
then **reads back every** `frame_\d+.png` in the dir to compute the returned
list. `processVideo` uses that list length as `extractedCount` →
`job.totalFrames` and feeds those buffers to the mask pipeline
(`videoProcessor.ts:312–336`).

Before 4b-0 this was safe because `temp_extracted/<jobId>/` was empty until
apply (background frames lived in memory). Once 4b-0 persists background frames
into that same dir, an apply at a **lower `samplingFps`** writes fewer frames
(`frame_000001…frame_00000M`) but leaves the higher-numbered background frames
(`frame_00000(M+1)…`) in place. The readback would then see `N` files, inflate
`totalFrames`, and apply the mask to a mismatched/stale frame set. Even at
matched fps, `-vsync 0` can differ by a frame. **This is a real corruption bug**
introduced by sharing the directory.

### Resolution: isolate apply-time staging from the persistent raw store

- **Persistent raw frames** (background extraction; what the frames endpoint and
  AI raw-fallback read): `temp_extracted/<jobId>/frame_NNNNNN.png`. **Never
  deleted by `processVideo`.**
- **Apply-time staging** (`processVideo`'s transient ffmpeg output): moved to an
  isolated subdir `temp_extracted/<jobId>/_apply/`. `extractAllFramesSequential`
  reads back only that subdir, so it can never see the persistent raw frames.
  `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` reads the top level and ignores the
  `_apply` subdir (directory entry, no `.png` extension), so the read path only
  ever serves the persistent raw frames.
- **`finally` change:** retarget `safeDelete` from the parent to the `_apply`
  subdir only (keeps the persistent raw frames), and **remove**
  `deleteUploadFile(videoPath)` entirely (keeps the upload for re-apply).
  Clearing `_apply` each apply also prevents the same stale-frame collision
  across *repeated* applies.

This keeps `processVideo`'s mask/extract body intact; only the staging path, the
`finally` target, and the dropped upload-delete change.

### Exactly what changes, and what bounds the redo loop

| Concern | Before 4b-0 | After 4b-0 |
|---------|-------------|-----------|
| Background raw frames | In-memory `global.extractedFrames` (lost on restart) | `temp_extracted/<jobId>/frame_NNNNNN.png`, **never deleted by `processVideo`**; swept only by the 6h window / SIGTERM / `cleanupJobArtifacts` |
| `processVideo` staging dir | `temp_extracted/<jobId>/` (shared), deleted in `finally` (line 455) | Isolated `temp_extracted/<jobId>/_apply/`, deleted in `finally` (transient; no collision with raw frames) |
| `uploads/<file>` after a terminal apply | Deleted in `finally` (line 459) | **Retained** — swept only by the 2h `uploads/` window / SIGTERM / `cleanupJobArtifacts` |
| Re-draw (frames endpoint) | Broke after first apply (dir gone) | Works while `temp_extracted/` survives (≤ 6h) |
| Re-apply (processVideo re-extract) | Broke after first apply (upload gone) | Works while `uploads/` survives (≤ 2h) |

**How many redo loops:** unbounded in count within the retention windows. The
binding constraint is the **shortest** window, `uploads/` at **2 hours**,
because every apply re-extracts from the upload file. Drawing alone is bounded
by `temp_extracted/` at 6 hours. After the upload's 2h sweep, drawing still
works (frames persist to 6h) but applying no longer does (re-extraction source
gone) — this degradation is graceful and matches the existing failure surface
(`410`/processing error), not a crash.

**Retention windows are NOT changed.** Only the *eager* per-apply deletion in
`processVideo`'s `finally` is removed. The existing 2h/6h cron sweeps, the
SIGTERM purge, and `cleanupJobArtifacts(jobId)` remain the authoritative
reclaimers for both dirs. This is the documented **upload-file-lifetime
widening** the kickoff explicitly permitted: the upload now lives up to its full
2h retention instead of being deleted at first apply.

### Disk / PHI implications (must also appear in the report)

- The `uploads/<file>` original (PHI) now persists up to its full 2h window
  instead of being deleted at first apply. This is a **longer PHI-at-rest
  window for the upload**, bounded by the existing 2h sweep — no new retention
  policy, just the removal of an early delete. Called out here per the kickoff's
  requirement to flag any change to upload-file deletion timing.
- `temp_extracted/<jobId>/` (raw frames) similarly persists to its 6h window.
  These are already covered by `SWEEP_TARGETS`; only the eager delete is removed.
- Net effect: bounded, predictable extra disk + PHI-at-rest, reclaimed by the
  same cron/SIGTERM machinery already in place. No unbounded growth.

### Template-mask spoke draws on RAW frame (verified — no client change)

Requirement: the template-mask spoke must read the **raw** frame, not the
masked `?source=template_mask` variant. **Verified satisfied today.**
`template-mask-spoke.tsx:47` fetches:

```ts
const res = await fetch(`/api/jobs/${jobId}/frames/0`);   // no ?source param → RAW
```

The `?source=template_mask` preference is **AI-spoke-only**
(`ai-spoke.tsx:52`, masked-first with raw fallback). The template-mask spoke
already draws on the raw frame. **No client change is required.** If
implementation reveals otherwise, a one-line frame-source correction is
acceptable but will be explicitly flagged in the report rather than edited
silently.

---

## 7. Implementation detail: writing frames to disk in `startBackgroundFrameExtraction`

The current code extracts frames into `Buffer[]` via `extractFrameBatch`, then
stores them in a `Map<number, Buffer>`. The change:

1. At the start of `startBackgroundFrameExtraction`, create the output
   directory: `await fs.mkdir(path.join(TEMP_EXTRACTED_DIR, jobId), { recursive: true })`.

2. After each `extractFrameBatch` returns, write each buffer to disk:
   ```
   frame_NNNNNN.png  (1-indexed, zero-padded to 6 digits, matching extractAllFramesSequential)
   ```
   Use `fsPromises.writeFile` with the path bounded to `TEMP_EXTRACTED_DIR`.

3. Remove the `frameStore` Map and the `global.extractedFrames.set(...)` call.
   The frames now live on disk only.

4. Frame numbering: `extractFrameBatch` returns frames as `Buffer[]` where
   index 0 = `batch.start`, index 1 = `batch.start + 1`, etc. The disk
   filename for frame N is `frame_${String(N + 1).padStart(6, '0')}.png`
   (1-indexed to match ffmpeg's `%06d` convention used by
   `extractAllFramesSequential`).

### Path safety

The output path is constructed as:
```ts
const jobDir = path.join(TEMP_EXTRACTED_DIR, jobId);
// jobDir is already validated by mkdir + safeDelete patterns
const framePath = path.join(jobDir, `frame_${padded}.png`);
```

`jobId` is a UUID generated server-side (not user input), so path traversal is
not a risk here. But for defense-in-depth, the read helpers go through
`listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` which uses the
`resolve + startsWith` guard.

---

## 8. Doc drift fixes

### CLAUDE.md changes

1. **"Raw frames live in-memory" section** — Rewrite to state that raw frames
   are now written to `temp_extracted/<jobId>/frame_NNNNNN.png` during
   background extraction. Note that `global.extractedFrames` has been removed.
   Keep the volatility class note but update it: frames survive PM2 restart
   (on disk), but the Job record does not (MemStorage). Jobs in `'ready'`
   state can now be re-masked after restart **if** the Job record is
   re-created (requires Postgres; deferred).

2. **"`temp_extracted/` documentation drift" section** — Mark as RESOLVED.
   `temp_extracted/` now genuinely holds disk frames. The drift between docs
   and code is closed.

3. **"Three extraction paths" section** — Update path #2 to note it now writes
   to disk (`temp_extracted/<jobId>/`) instead of `global.extractedFrames`.
   Note that structural consolidation of the three paths remains deferred.

4. **Disk lifecycle table** — The `temp_extracted/<jobId>/` row already says
   "Raw frames pulled from a video before template-masking" with 6h retention.
   This is now accurate. No change needed to the table itself.

### No `UPLOAD_PROCESS_BEFORE_AND_AFTER.md`

This file does not exist in the repo. The CLAUDE.md references it as a source
of drift, but it's absent from the working tree. No update needed; note in the
report that it was not found.

---

## 9. Cleanup integration confirmation

| Cleanup mechanism | Covers `temp_extracted/`? | Action needed? |
|-------------------|---------------------------|----------------|
| `SWEEP_TARGETS` entry | Yes (`cleanup.ts:67`, 6h retention) | None |
| Hourly cron (`startCleanupScheduler`) | Yes (iterates `SWEEP_TARGETS`) | None |
| SIGTERM handler | Yes (sweeps all `SWEEP_TARGETS` with `maxAgeMs=0`) | None |
| `cleanupJobArtifacts(jobId)` | Yes (`cleanup.ts:136`) | None |
| `processVideo` finally block | Deleted the shared staging dir `temp_extracted/<jobId>/` (`videoProcessor.ts:455`) AND the upload (line 459) | **CHANGED** — `safeDelete` retargeted to the isolated `temp_extracted/<jobId>/_apply/` staging subdir (persistent raw frames untouched); `deleteUploadFile` removed (Section 6). Reclamation of the raw-frame dir and the upload now relies on the cron/SIGTERM/`cleanupJobArtifacts` machinery below, which already covers both. |
| Boot-time purge | **No** — only `uploads/` and `temp_processed/` are purged on startup | **Acceptable** — boot wipes MemStorage, so Job records are lost anyway. Raw frames (and now uploads) on disk after a restart are orphaned but reclaimed by the hourly sweep (6h / 2h max respectively). Not adding a boot purge for `temp_extracted/`; the windowed sweep is the safety net. |

No retention-window or `SWEEP_TARGETS` membership changes. The only cleanup
delta is the **removal** of `processVideo`'s two eager per-apply deletes, which
shifts reclamation of `temp_extracted/<jobId>/` and `uploads/<file>` onto the
existing windowed sweeps (6h and 2h). Both dirs were already swept by those
mechanisms, so nothing is left unreclaimed.

---

## 10. tsc / build impact

- No new types or interfaces are introduced.
- The change removes reads/writes of an untyped `(global as any).extractedFrames`
  and replaces them with typed `fs` operations. This should not introduce new
  type errors.
- Existing 17 tsc errors (10 in `frameExtractor.ts`, 7 in `maskWorker.ts`)
  remain untouched.
- `npm run build` impact: none — no frontend files are changed.

---

## 11. Durability acceptance test

### Within-session test (what 4b-0 delivers)

Steps 1–5 set up the loop; **step 6 is the REQUIRED, load-bearing acceptance
check for this phase** — 4b-0 is not considered passing unless step 6 fully
completes. It is the direct verification that removing the two eager `finally`
deletions (Section 6) actually enables the redo loop.

1. Upload a video. Wait for extraction to complete (`status: 'ready'`).
2. Verify frames on disk: `ls temp_extracted/<jobId>/ | head` shows
   `frame_000001.png` through `frame_NNNNNN.png`.
3. Open template-mask spoke → frame 0 renders (read from disk, raw).
4. Draw a mask, click Apply → processing succeeds (applies across disk frames).
   After apply, verify **both survive**: `ls temp_extracted/<jobId>/` still
   lists frames AND the `uploads/<file>` original still exists (the two eager
   deletes are gone).
5. Open AI spoke → draw bbox, Run → inference runs on masked frames (or raw
   fallback if no template mask).
6. **REQUIRED PASS — full redo loop after an AI delete.** Delete the AI run.
   Return to the template-mask spoke → frame 0 still renders (raw frames
   survived). Re-draw the mask, **re-apply** → processing succeeds a *second*
   time (the upload survived, so re-extraction works). Return to the AI spoke,
   **re-run** inference. Every sub-step must complete. If any sub-step fails
   (frame 0 gone, re-apply errors because the upload was deleted, etc.), 4b-0
   has **not** met its acceptance bar and the `finally` change must be
   corrected before sign-off.

   Boundary note: this loop is guaranteed only **within the `uploads/` 2h
   retention window** (the shortest window, and the source `processVideo`
   re-extracts from). Past 2h, drawing may still work (frames persist to 6h) but
   re-apply degrades gracefully to a processing error rather than succeeding —
   this is expected and not a step-6 failure.

### Post-restart frame durability (verifiable on real server)

1. Steps 1–2 above.
2. `pm2 restart masquerade`.
3. `ls temp_extracted/<jobId>/` — frames still on disk. **Frame durability confirmed.**
4. Attempting to re-open the job in the browser will fail because the Job
   record (MemStorage) is lost. **This is expected and accepted.** Full
   restart survival requires Postgres (deferred).

### `global.extractedFrames` removal verification

```sh
grep -rn "extractedFrames" server/
```
Returns zero hits in live code (docs/refactor reports may still reference it
historically).

---

## 12. Deliverables

1. This file (`docs/refactor/PHASE_4B0_PROPOSAL.md`) — the plan.
2. `docs/refactor/PHASE_4B0_REPORT.md` — written after implementation,
   documenting what changed, mirroring existing report format.
