# Masquerade

**Phase 4a landed (May 2026):** Routing scaffolding, upload page, hub page. New routes: `/upload`, `/jobs/:jobId`, `/jobs/:jobId/template-mask`, `/jobs/:jobId/ai`. `/` now redirects to `/upload`. New `GET /api/jobs/:jobId` endpoint returns the `Job` V2 record (hub-and-spoke shape) from `jobsV2` MemStorage — the legacy `GET /api/videos/:jobId` still returns `VideoJob`. `JobContext` provider wraps all `/jobs/:jobId/*` routes, fetching job data and refetching on Socket.IO progress events. Upload page includes PHI attestation (radio group: "No PHI" / "Contains PHI") and sends `phiStatus: 'user_attested'` + `attestationRecord: { attestedAt, choice }` on POST. Hub page shows status strip (filename, PHI badge, source metadata), initializing panel (during extraction), and three spoke tiles (Template Mask, Classify or Label — disabled/"Coming soon", Run AI Models). Spoke pages are hybrid wrappers: they render the existing legacy UI components (`MaskingCanvas`, `MaskingTools`, `ProcessingControls`, `CommandInput`, `TaskSelector`, `FrameViewer`) inside the new route structure. Legacy components continue to read from legacy URLs — canonical URL migration is 4b/4c work. `home.tsx` remains in the codebase, accessible at `/app`; deleted in 4d. `AttestationRecord` type updated to `{ attestedAt: string, choice: 'contains_phi' | 'no_phi' }`.

### Phase 4a landed (2026-05-12)

- New wouter routes: `/upload`, `/jobs/:jobId`, `/jobs/:jobId/template-mask`, `/jobs/:jobId/ai`
- `/` redirects to `/upload`. `/app` preserved as escape hatch to legacy `home.tsx`.
- New `UploadPage` with PHI attestation (radio group: "Contains PHI" / "No PHI")
- New `HubPage` with status strip, initializing panel, three spoke tiles
- Spoke pages (`TemplateMaskSpokePage`, `AiSpokePage`) are hybrid wrappers around legacy components — to be replaced in 4b/4c
- `JobContext` provider on `/jobs/:jobId/*` subtree, exposes `useJob()` hook
- Backend: `GET /api/jobs/:jobId` returns `Job` V2 record (split from legacy `GET /api/videos/:jobId`)
- `AttestationRecord` schema reshaped from `{ checked, timestamp, text }` to `{ attestedAt, choice }`
- `JSON.parse(attestationRecord)` added to upload handlers (multer form-field gap fix from 3d)

### Phase 4a hotfix 1 (2026-05-12)

- `MemStorage.updateVideoJob` now mirrors `VideoJob.status` to `Job.status` via a new `mapVideoJobStatusToJobStatus` helper
- Required because the new hub reads V2 status and tiles never unlocked otherwise
- Status mapping: `uploaded/extracting → extracting`, `ready/masking/processing/completed → ready`, `failed → failed`
- Fix lives entirely in `server/storage.ts`; `videoProcessor.ts` unchanged

### Phase 4a hotfix 2 (2026-05-12)

- Hub spoke-tile navigation switched from absolute paths (`/jobs/${jobId}/template-mask`) to relative paths (`/template-mask`)
- Required because `HubPage` is rendered inside `<Route path="/jobs/:jobId" nest>`, and wouter prepends the nest base to absolute navigates, producing doubled URLs
- Same fix may apply to any "Back to job" links in spoke wrappers; verify when migrating them

**Phase 3d landed (May 2026):** Upload handlers create `Job` records eagerly. New upload URLs added (`POST /api/uploads/video`, `POST /api/uploads/images`); legacy URLs preserved. `phiStatus` and `attestationRecord` plumbing added (defaults to `'raw'` when frontend doesn't send it). `ensureJobV2` bridge removed. `samplingFps` recorded as `Job.extractionRate`. This completes the backend refactor; Phase 4 is frontend migration.

## Post-refactor cleanup backlog

Items deferred from Phases 1–3d. None are blocking Phase 4; all can be
tackled independently in any order after Phase 4 frontend migration is
verified.

1. **Remove legacy URL aliases** — after Phase 4 frontend migration is verified, delete the old registrations: `POST /api/videos/upload`, `POST /api/images/upload`, `GET /api/videos/:jobId`, `GET /api/videos/:jobId/download`, `PATCH /internal/mask-processing/:jobId`, `POST /api/ai/infer`, `PATCH /api/ai/labels/:jobId/:labelId`, `DELETE /api/ai/labels/:jobId/:labelId`, `GET /api/jobs/:jobId/masks/:labelId/:n.png`, `GET /api/jobs/:jobId/overlays/:labelId/:n.png`.
2. **Remove legacy thin-wrapper from `server/index.ts`** — the `PATCH /internal/mask-processing/:jobId` handler in `index.ts` delegates to the shared function in `server/handlers/templateMaskApply.ts`. After item 1, delete the wrapper from `index.ts`; keep the shared function and the canonical route in `routes.ts`.
3. **Rename `tempFolderManager.ts`** — it manages `spokes/template_mask/`, not `temp_processed/`. Name no longer reflects purpose post-3a.
4. **Remove `temp_processed/` from `SWEEP_TARGETS`** and remove `purgeTempProcessedOnStartup()` once confirmed quiet in production for several days.
5. **Fix path-traversal guard in `TempFolderManager`** — Phase 1 surprise. Security concern: the `resolve + startsWith` check may be bypassable. Audit and harden.
6. **Fix global progress broadcast** — `videoProcessor.ts:999` broadcasts to all connected sockets instead of the job's room. Info leak / scalability issue (Phase 1 surprise).
7. **Remove dead code at `routes.ts:361`** — Phase 1 surprise.
8. **Remove debug endpoints** — `POST /api/test-post` and `POST /test-non-api` (Phase 1 surprise).
9. **Update stale `videoProcessor.ts` comments** — lines 371 and 643 still mention `temp_processed/{jobId}/` (deferred from Phase 3a).
10. **Add `deleteProcessingProgress(jobId)` cleanup on job delete** — `DELETE /api/jobs/:jobId` removes VideoJob and Job records but doesn't clear the processing progress map entry (deferred from Phase 3c).
11. **`PgStorage` stub maintenance** — decide whether to keep throw-stubs vs. remove `PgStorage` entirely. All runtime storage is `MemStorage` (deferred since Phase 2).
12. **Fix 17 pre-existing `tsc` errors** — 10 in `frameExtractor.ts`, 7 in `maskWorker.ts`. Either fix the types or silence with `// @ts-expect-error`.
13. **Address chunks-larger-than-500-kB Vite warning** — code splitting in `landing.tsx` or main bundle to reduce initial load size.
14. **Delete `home.tsx` and any other legacy step containers in 4d** — after 4b/4c migrate spoke contents to canonical URLs, `home.tsx` and the `/app` route can be removed.
15. **Download/ZIP handler has same masked-vs-raw asymmetry** — the `GET /api/jobs/:jobId/template-mask/download` handler reads from `SPOKE_TEMPLATE_MASK_DIR` only. If no template mask was applied, it returns 404. Same pattern as the AI inference handler before hotfix 4 added the raw-frame fallback. Decide whether downloads should also fall back to raw extracted frames (exporting unmasked frames) or whether "no mask applied → no download" is correct UX.

### Raw frames live in-memory, not on disk (`global.extractedFrames`) — RESOLVED in Phase 4b-0

**Discovered:** Phase 4a deploy smoke testing, 2026-05-12.

**Original state:** `startBackgroundFrameExtraction` wrote extracted frames as `Buffer`s into `global.extractedFrames: Map<jobId, Map<frameNumber, Buffer>>`. Nothing wrote to `temp_extracted/<jobId>/` despite that directory existing, being defined as `TEMP_EXTRACTED_DIR` in the code, and being referenced in `UPLOAD_PROCESS_BEFORE_AND_AFTER.md` as the raw-frame target.

**Volatility class (historical):** Same as the pre-3b `maskArtifactStore`. PM2 restart wiped raw frames; jobs in `'ready'` state became un-maskable.

**Resolution (Phase 4b-0, 2026-06-12):**
- `startBackgroundFrameExtraction` now writes raw frames to `temp_extracted/<jobId>/frame_NNNNNN.png` (1-indexed, matching `extractAllFramesSequential`'s naming).
- `GET /api/jobs/:jobId/frames/:n` reads raw frames from disk (positional index into the sorted file list); returns 410 if the directory was swept.
- The AI inference raw-frame fallback reads from disk via `listRawFrameFiles`.
- `global.extractedFrames` and its in-memory `frameStore` Map are removed from live code. The remaining references are historical comments only.
- `processVideo`'s apply-time re-extraction is isolated into `temp_extracted/<jobId>/_apply/` so it never collides with the persistent raw frames (see Phase 4b-0 report for the collision-hazard analysis).

### Phase 4b-0 FIX V2 — `processVideo` re-entrancy post-mortem (2026-06-17)

**Re-entrancy lesson.** `processVideo` was implicitly single-shot: a prior run's
`finally` deleted the upload, so a second run for the same `jobId` crashed at
ffprobe before exercising directory logic. Moving raw frames to disk and
(correctly) preserving the upload for re-apply *unmasked* a latent re-entrancy
bug — the second run re-derived `temp_extracted/<jobId>/_apply/` and then
`readdir`'d it to size the frame set, reading back any frames a prior run had
left there. Lesson: any per-job stage that re-derives a working directory and
then `readdir`s it must **clear that dir first** (or use a per-run unique dir);
never let the cleanup that protects re-entrancy be *conditional* on a flag a
killed process can skip. Tests for re-entrancy MUST leave first-run residue
present before the second run — a test that cleans state between runs proves
nothing.

**Fix.** `prepareCleanApplyStaging(jobId)` (`applyPaths.ts`) runs
`cleanupApplyStaging` (clear `_apply`) then recreates it empty, called
immediately before `extractAllFramesSequential`. This makes `_apply` clean
**unconditionally**, not contingent on the gated `finally`. Persistent raw frames
in the parent dir are never touched (the delete is `_apply`-bounded).

**Tripwire.** Every mkdir site that joins a `jobId`/`runId`
(`videoProcessor` raw + `_apply`, `routes.ts` AI run dir) calls
`assertNoSegmentDoubling()` (throws on equal-adjacent path segments — the
`<jobId>/<jobId>` corruption class) AND logs the literal `path.resolve(...)`
mkdir path. Both the stale-readback fix and the tripwire itself are covered by
red-green tests in `server/services/__tests__/applyPaths.test.ts` (run:
`npx tsx server/services/__tests__/applyPaths.test.ts`).

**Scope caveat (honest).** The current `_apply`-isolated source does not produce
`<jobId>/<jobId>` nesting or persistent-frame deletion from any run-2 op — those
symptoms were the pre-`_apply` whole-dir variant, already replaced. The only
remaining in-code defect was stale-readback count inflation, and only when run 1
is **interrupted** before its `finally`. Because the original symptoms can't be
reproduced from current source, the **live redo loop run twice** is the required
post-deploy verification (see the deploy runbook), and the tripwire is the
standing safety net for the nesting class.

### `ANTHROPIC_API_KEY` invalid in production

**Discovered:** Phase 4a deploy smoke testing, 2026-05-12.

**State:** Server logs show repeated `401 invalid x-api-key` errors from `IntentParser.parseWithClaude`. NLP intent parser fallback non-functional in production. Keyword-rule path still works.

**Fix:** Rotate the key in `~/.env` on `3.136.48.97`. Out of scope for Phase 4 refactor.

### `temp_extracted/` documentation drift — RESOLVED in Phase 4b-0

**Discovered:** Phase 4a deploy smoke testing, 2026-05-12.

**Original state:** `UPLOAD_PROCESS_BEFORE_AND_AFTER.md` claimed raw frames extract to `temp_extracted/<jobId>/`. Code defined `TEMP_EXTRACTED_DIR` and the cleanup module included `temp_extracted/` in `SWEEP_TARGETS`, but nothing actually wrote to that directory — the docs described a disk pipeline that didn't exist.

**Resolution (Phase 4b-0):** Took option 2 (make code match docs). `startBackgroundFrameExtraction` now writes raw frames to `temp_extracted/<jobId>/`, so the directory, the `TEMP_EXTRACTED_DIR` constant, and its `SWEEP_TARGETS` membership all reflect reality. The 6-hour retention window for `temp_extracted/` is now load-bearing.

### Hub job-level download action (deferred)

**Discovered:** Phase 4a smoke testing surfaced that there's no download UI in the AI spoke (legacy `home.tsx` had download as a terminal step).

**Decision:** Per-run downloads land in 4c (AI spoke). Hub job-level "Download all" deferred to 4d or post-Phase-4 cleanup; it's a design call (per-run vs per-job vs both) that doesn't block other work.

### Three extraction paths exist

**Discovered:** Phase 4b reconnaissance pass, 2026-05-12.

**State:** The codebase has three independent frame-extraction implementations:
1. `extractFirstFrame` — pulls just frame 0 at upload time for the response preview
2. `startBackgroundFrameExtraction` → `temp_extracted/<jobId>/frame_NNNNNN.png` — batch-based, on disk (Phase 4b-0; was in-memory `global.extractedFrames`), populates after upload response
3. `processVideo` → `temp_extracted/<jobId>/_apply/` — runs at template-mask apply time, re-extracts from the upload, isolated in the `_apply` subdir so it never collides with path #2's persistent frames

**Implication:** The masking canvas (after 4b) reads frame 0 from path #2. The actual mask application uses path #3. These are independent re-extractions of the same source video. ffmpeg is *usually* deterministic on frame 0 across these paths, but edge cases (encoder quirks, GOP boundaries, seek inaccuracy) could produce different bytes. A user could draw a mask aligned to one frame and have it applied to a subtly different one.

**Severity:** Theoretical for typical ultrasound content. Paths #2 and #3 now share the `temp_extracted/<jobId>/` tree (persistent frames vs `_apply/` staging) but remain independent re-extractions. Full consolidation (single extraction, single source of truth) is still a backlog item — Phase 4b-0 only relocated path #2's storage from memory to disk.

**Future UX consideration:** A planned UX direction is showing the first frame on the upload page immediately while the rest of the video uploads/extracts in the background. Consolidating to a single extraction path supports this cleanly.

**Phase 3c landed (May 2026):** Endpoint URL hierarchy migrated. New `/api/jobs/:jobId/...` URLs added; old URLs preserved as aliases. Four net-new CRUD endpoints: `DELETE /api/jobs/:jobId`, `GET /api/jobs/:jobId/ai/runs`, `PATCH /api/jobs/:jobId/ai/runs/:runId`, `DELETE /api/jobs/:jobId/ai/runs/:runId`. Path C download: `GET /api/jobs/:jobId/ai/runs/:runId/download`. Template-mask apply alias: `POST /api/jobs/:jobId/template-mask/apply`. Frontend still uses old URLs; Phase 4 migrates.

**Phase 3b landed (May 2026):** AI inference now persists mask/overlay PNGs to disk under `spokes/ai/<jobId>/<runId>/`. Each `/api/ai/infer` call creates an `AIRun` record. `maskArtifactStore.ts` deleted — all mask/overlay reads come from disk. Dual-write: every `AiLabel` goes to both `AIRun.labels[]` and `job.aiLabels[]` for backward compat. Zero endpoint URL changes, zero frontend changes.

**Phase 3a landed (May 2026):** Processing writes migrated from `temp_processed/` to `spokes/template_mask/<jobId>/`. Two bypass callsites (download endpoint, AI inference endpoint) now use `frameAccess.ts` helpers. `temp_processed/` is no longer written to; retained as defensive sweep target.

**Phase 2 landed (May 2026):** Schema and storage plumbing for the hub-and-spoke refactor. New `Job`, `TemplateMaskState`, `AIState`, `AIRun` types in `shared/schema.ts`. New MemStorage methods. Spoke directories (`spokes/template_mask/`, `spokes/ai/`, `spokes/labeling/`) created on boot. `temp_processed/` purged on every startup. Generalized cleanup sweep targets.

Project-level notes for engineers and Claude when working on this codebase.

## Hub-and-spoke data model (Phase 2)

The codebase is mid-refactor from a 5-step linear pipeline to a hub-and-spoke
model. The target types live in `shared/schema.ts` (search for "Hub-and-spoke
types"):

- `Job` — the hub: upload metadata + optional per-spoke state
- `TemplateMaskState` — Path A (template mask + export)
- `AIState` / `AIRun` — Path C (AI segmentation, multiple runs per job)
- `LabelingState` — Path B (placeholder, shape TBD)

`MemStorage` in `server/storage.ts` has methods for these types (`getJobV2`,
`setTemplateMaskState`, `addAiRun`, etc.). Phase 3b wired AI run methods
into inference/label endpoints. Phase 3d wired `createJobV2` into upload
handlers — every job now has a `Job` record from the moment it's uploaded.
The `ensureJobV2` bridge is removed.

The existing `VideoJob`, `MaskData`, `OutputSettings`, and `AiLabel` types
remain the active runtime types alongside `Job` until Phase 4 completes
the frontend migration.

## URL hierarchy (Phase 3c + 3d)

New canonical URLs follow a resource hierarchy. Old URLs are preserved as
aliases (same handler, two registrations). Frontend still uses old URLs;
Phase 4 migrates.

| Legacy URL (alias) | Canonical URL | Method | Notes |
|---|---|---|---|
| `POST /api/videos/upload` | `POST /api/uploads/video` | Video upload | |
| `POST /api/images/upload` | `POST /api/uploads/images` | Image batch upload | |
| `GET /api/videos/:jobId` | — | Legacy job state | Returns `VideoJob` + progress |
| — | `GET /api/jobs/:jobId` | Job V2 state | Returns `Job` (hub-and-spoke shape). **Split from legacy in 4a** — these are now separate handlers. |
| `GET /api/videos/:jobId/download` | `GET /api/jobs/:jobId/template-mask/download` | Path A ZIP |
| `PATCH /internal/mask-processing/:jobId` | `POST /api/jobs/:jobId/template-mask/apply` | Path A trigger |
| `POST /api/ai/infer` | `POST /api/jobs/:jobId/ai/runs` | Create AI run |
| `PATCH /api/ai/labels/:jobId/:labelId` | `PATCH /api/jobs/:jobId/ai/runs/:runId/labels/:labelId` | Approve label |
| `DELETE /api/ai/labels/:jobId/:labelId` | `DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId` | Delete label |
| `GET /api/jobs/:jobId/masks/:labelId/:n.png` | `GET /api/jobs/:jobId/ai/runs/:runId/masks/:labelId/:n.png` | Mask PNG |
| `GET /api/jobs/:jobId/overlays/:labelId/:n.png` | `GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png` | Overlay PNG |

Net-new (no legacy alias):

| URL | Method | Purpose |
|---|---|---|
| `GET /api/jobs/:jobId/ai/runs` | GET | List all AI runs |
| `PATCH /api/jobs/:jobId/ai/runs/:runId` | PATCH | Rename/approve a run |
| `DELETE /api/jobs/:jobId/ai/runs/:runId` | DELETE | Delete a run + artifacts |
| `GET /api/jobs/:jobId/ai/runs/:runId/download` | GET | Download run as ZIP |
| `DELETE /api/jobs/:jobId` | DELETE | Delete job + all artifacts |

## Upload body shape (Phase 3d)

Both upload endpoints accept optional `phiStatus` and `attestationRecord`
fields in the request body (multipart form data). The frontend does not
send these yet — Phase 4 wires the attestation UI.

- `phiStatus`: `'raw'` (default) or `'user_attested'`. Defaults to `'raw'`
  when absent.
- `attestationRecord`: `{ attestedAt: string, choice: 'contains_phi' | 'no_phi' }`.
  Only meaningful when `phiStatus === 'user_attested'`. Updated in Phase 4a.
- `samplingFps`: Optional number. Recorded as `Job.extractionRate`. Defaults
  to the video's native frame rate (or 1 for image batches).

## Disk lifecycle

Transient directories live at the project root and hold short-lived data.
All of them are managed by `server/services/cleanup.ts`; nothing else
in the codebase should call `fs.rm` / `fs.unlink` against these paths
directly — go through `safeDelete`, `deleteUploadFile`, or
`cleanupJobArtifacts` instead so deletes stay bounded to their allowed root.

| Directory | Holds | Retention |
|-----------|-------|-----------|
| `uploads/` | Original user uploads (multer dest). Contains PHI. | **2 hours** |
| `temp_extracted/<jobId>/` | Raw frames pulled from a video before template-masking. | **6 hours** |
| `temp_processed/<jobId>/` | **(LEGACY — no longer written to post-3a.)** Retained as defensive sweep target. | **Purged on every boot** + 24h hourly sweep |
| `spokes/template_mask/<jobId>/` | Path A output — **active processing target post-3a.** `tempFolderManager.ts` and `frameAccess.ts` both resolve against this directory. | **24 hours** |
| `spokes/ai/<jobId>/<runId>/` | Path C output — **active post-3b.** One folder per AI run. Contains `mask_<n>.png` and `overlay_<n>.png` per frame. `routes.ts` mask/overlay serving endpoints read from here. | **24 hours** |
| `spokes/labeling/<jobId>/` | Path B reserved (placeholder). | **24 hours** |

`temp_processed/` is fully retired post-Phase 3a — no code writes to it
anymore. It remains as a defensive sweep target in `SWEEP_TARGETS` and is
purged on every server boot (`purgeTempProcessedOnStartup`). Remove from
`SWEEP_TARGETS` once confirmed quiet in production.

`spokes/template_mask/<jobId>/` is **not** deleted post-download. Folders persist
after download to allow the frame viewer to be reopened. Practical effect:
a user who downloads then comes back later sees their session intact for up
to 24h. The hourly retention sweep is the only path that reclaims this dir.

### When does cleanup happen?

- **On every server start**:
  - `purgeUploadsOnStartup()` deletes everything in `uploads/`. Storage is
    in-memory (`server/storage.ts`), so any upload from a previous process
    is orphaned by definition — no live request handler can reference it.
  - `purgeTempProcessedOnStartup()` deletes everything in `temp_processed/`.
    Same MemStorage rationale. (Added in Phase 2.)
  - `ensureSpokeDirectories()` creates `spokes/template_mask/`, `spokes/ai/`,
    `spokes/labeling/` if they don't exist. (Added in Phase 2.)
- **Hourly cron** (minute 0): `startCleanupScheduler()` sweeps all targets
  in the `SWEEP_TARGETS` list (uploads, temp_extracted, temp_processed, and
  all three spoke dirs) for entries older than their retention window.
  Adding a future spoke is a one-line addition to `SWEEP_TARGETS` in
  `cleanup.ts`. Wrapped in try/catch at every layer — cleanup must never
  crash the app.
- **Eager deletes** along the request lifecycle:
  - The video upload handler (`POST /api/videos/upload`) deletes the
    multer file on `req.on('aborted')` and on the catch path.
  - `videoProcessor.processImages` uses a `try/catch/finally` where
    `finally` calls `deleteUploadFile(...)` once a terminal status is
    reached (success **or** failure).
  - `videoProcessor.processVideo` uses a `try/catch/finally` where
    `finally` calls `safeDelete` on its apply-time staging dir
    `temp_extracted/<jobId>/_apply/` only. **Phase 4b-0:** it no longer
    deletes `deleteUploadFile(...)` nor the persistent raw frames at
    `temp_extracted/<jobId>/` — the upload and raw frames must survive so
    the user can redo (re-mask → re-apply) within the `uploads/` 2h window.
  - The setImmediate background **extraction** tasks (`startBackgroundFrameExtraction`)
    have a `.catch` that calls `deleteUploadFile(...)` on failure. An
    extraction failure means the job never becomes applyable, so reclaiming
    the upload there is safe and loses no redo loop.
  - **No post-download hook for `temp_processed/<jobId>/`**: the download
    endpoint deliberately does not delete the masked-frame folder when the
    response finishes. The frame viewer needs it readable after download
    so users can reopen the viewer or re-download. Reclamation happens
    exclusively via the hourly retention sweep (24h).
- **SIGTERM** sweeps all `SWEEP_TARGETS` directories (uploads, temp_extracted,
  temp_processed, and all spoke dirs) with `maxAgeMs = 0` (everything goes),
  then closes the HTTP server. Each step is individually try/wrapped so one
  failure cannot block shutdown.

### Manual cleanup

```sh
# Sweep all dirs (including spoke dirs) respecting retention windows
npm run cleanup

# Show what would be deleted, delete nothing
npm run cleanup -- --dry-run

# Limit to one directory
npm run cleanup -- --dir=uploads
npm run cleanup -- --dir=temp_extracted
npm run cleanup -- --dir=temp_processed
npm run cleanup -- --dir=template_mask
npm run cleanup -- --dir=ai
npm run cleanup -- --dir=labeling

# Delete all artifacts for a specific job (across all directories)
npm run cleanup -- --job=<jobId>

# Override the age threshold (delete everything regardless of age)
npm run cleanup -- --max-age-ms=0
```

`--dry-run` logs every target and the total bytes that *would* be freed
without touching the filesystem. Combine flags freely:
```sh
npm run cleanup -- --dir=temp_processed --dry-run
```

`--job` and `--dir` are mutually exclusive.

### Known limitation: disk pressure

With `temp_processed/` retained for 24h post-completion, expected disk
use scales with sessions/day at roughly ~1 GB per session. Revisit the
retention window or move to per-user expiry when auth lands (Phase 3).

### Future: when authentication lands

The 2h retention window on `uploads/` and the boot-time purge are both
predicated on the current model: **no auth, in-memory storage, anonymous
sessions**. Every restart wipes both the in-memory job index and the
disk. Once Phase 3 (Clerk auth + sessions table) lands:

- The boot-time purge of `uploads/` must be removed or scoped to
  uploads with no associated authenticated session.
- The 2h window will need to extend (probably hours-of-inactivity from
  the owner, not absolute upload age) so authenticated users can leave
  and return to in-progress work.
- `cleanupJobArtifacts` will need to consult the session/job ownership
  table before deleting; right now it deletes blindly because all data
  is anonymous.

The cleanup module is structured so this rework is local to that file
plus the call sites — nothing leaks the retention policy outward.

## Frame viewer

A read-only scrub viewer sits between Step 4 (AI Analysis) and Step 5
(Download) in the sidebar. It is opt-in: the user clicks **Open frame
viewer** in the "Review Frames" sidebar panel, the main canvas area swaps
from `MaskingCanvas` to `FrameViewer`, and the user can leave via either
**Continue to Download** or **Close viewer**. The direct path from Step 4
to Step 5 is preserved — skipping the viewer is allowed.

### Endpoints

All five endpoints are pure read. None write to disk. Every filesystem
path is bounded by `server/services/frameAccess.ts`'s `resolveFramePath`
(or its mask/overlay equivalents) against `TEMP_PROCESSED_DIR`, using
the same `path.resolve + startsWith` pattern the cleanup module uses.

| Method | Path | Cache | Purpose |
|---|---|---|---|
| `GET` | `/api/jobs/:jobId/viewer-info` | none | One-shot summary: `{totalFrames, status, labels, hasFrames, hasInference, hasArtifacts}`. 404 if job missing, 410 if `temp_processed/<jobId>/` swept. |
| `GET` | `/api/jobs/:jobId/frames/:n.png` | `private, max-age=3600` | n-th processed frame PNG (sorted-list position). 400 invalid n, 404 missing, 410 swept. |
| `GET` | `/api/jobs/:jobId/inference.json` | `no-store` | Frame-indexed pivot of `job.aiLabels`: `{imageWidth, imageHeight, outputSettings:{size,aspectRatioMode}, labels[], frames: {n: [{labelId, name, modality, confidence, bbox, hasMask}]}}`. `imageWidth/Height` are SOURCE-VIDEO dimensions (the coord system bbox is stored in), not the temp_processed frame's natural dimensions. No base64 blobs — mask URLs are constructed client-side from labelId. |
| `GET` | `/api/jobs/:jobId/masks/:labelId/:n.png` | `private, max-age=3600` | Reads `mask_<n>.png` from `spokes/ai/<jobId>/<runId>/` via `findRunByLabelId`. **410 with `{reason: "artifacts_lost_on_restart"}`** when no AIRun owns the label (shouldn't happen post-3b). |
| `GET` | `/api/jobs/:jobId/overlays/:labelId/:n.png` | `private, max-age=3600` | Same as masks but serves `overlay_<n>.png` — the GPU's pre-rendered RGBA overlay (green tint on mask region). Used by the viewer's "Overlay" mode. |

### Component

`client/src/components/FrameViewer.tsx`. Props:
```ts
{
  jobId: string;
  onContinueToDownload: () => void;
  onBackToInference?: () => void;
}
```
The viewer fetches `viewer-info` and `inference.json` in parallel on
mount and renders three view modes via a segmented control:

- **Clean** — just the frame PNG.
- **Overlay** — frame + GPU overlay PNG(s) stacked with `mix-blend-mode: lighten`.
  One overlay layer per visible label. We chose `lighten` over `screen`
  because medical imagery preserves contrast better — `lighten` only
  brightens the mask region (where the green tint is the brighter pixel)
  and leaves the rest of the frame identical. Disabled when
  `hasArtifacts === false` (post-restart case) — the toggle button stays
  visible but shows a tooltip explaining why and the user can still use
  Clean and Bbox modes.
- **Bbox** — frame + SVG `<rect>` per visible label. The SVG uses a
  `viewBox` set to `imageWidth × imageHeight` (source-video pixels) with
  `preserveAspectRatio="xMidYMid meet"`, so `<rect>` coords pass through
  as-is and the browser handles all display scaling. No manual measurement
  of the rendered img is needed. Each rect uses the label's deterministic
  color (`colorForLabelId`, FNV-1a → HSL hue with fixed S/L), matching
  the swatch shown in the AI Analysis panel's label list.

Keyboard: ←/→ (±1), Shift+←/→ (±10), Home/End, Space cycles modes
(skips Overlay when artifacts are unavailable).
Slider is the primary scrub control.

Prefetch window is mode-aware: ±10 frames around current, capped at 30
total `<img>` nodes. In Overlay mode the budget is split across the
visible labels' overlay PNGs. Clean and Bbox modes only prefetch frame
PNGs (bboxes already arrived in inference.json). The window is rebuilt
from scratch on every `currentFrame` / `mode` / `visibleLabels` change —
no accumulation.

The viewer is **read-only** in v1 — no per-frame editing, no saving back
to inference state. Per-frame label visibility is the only client-side
mutation, and it's purely UI state (not POSTed anywhere).

### Panel gating

The "Review Frames" sidebar panel is enabled when `jobCompleted` is true
(i.e. `temp_processed/<jobId>/` exists). It is **not** gated on AI labels
existing — a user with completed template-masking but no AI run yet can
still scrub their masked frames to verify quality. In that case the
viewer locks the mode toggle to Clean and shows
"No AI labels yet — run inference to enable overlays" in the labels panel.

### Known limitations

- **Frames remain available for 24 hours post-completion.** Beyond that
  the hourly sweep removes `temp_processed/<jobId>/`, and the viewer
  surfaces a session-expired message via 410 — the same response shape
  it uses on every endpoint when the folder is missing.
- **Large videos (>1000 frames)** may scrub sluggishly on slower laptops.
  Each frame is a separate HTTP fetch; browser cache keeps it manageable
  but the prefetch radius isn't tuned for high frame counts. Not yet
  optimized.
- **Artifacts survive restarts (post-3b)** but MemStorage job metadata
  does not. After `pm2 restart`, mask/overlay PNGs remain on disk under
  `spokes/ai/` but `job.aiLabels` and AIRun records are lost (MemStorage
  is volatile). The viewer detects this via `hasArtifacts: false` (no
  AIRuns in memory) and shows a banner with a re-run-inference shortcut.
- **Bbox display uses sorted-list position as the frame key**. This
  matches the inference loop and the manifest builder. If upstream
  processing changes the file naming convention again, both inference.json
  and the viewer need to be re-aligned.
- **Bbox overlay assumes letterbox or original output mode.** Bbox coords
  are stored in source-video pixel space (`job.width × job.height`), and
  inference.json now reports `imageWidth/imageHeight` in that space so the
  viewer's SVG `viewBox` aligns with the displayed frame for `outputSize=
  'original'` and for any non-original size with `aspectRatioMode='letterbox'`
  (the rendered frame's content area still has source-video aspect inside
  black bars). Crop and stretch modes warp frame geometry but the stored
  bbox doesn't get re-projected, so positions can drift. The viewer detects
  this via the `outputSettings` block in inference.json and shows an inline
  amber warning when bbox mode is active under those conditions. Full fix
  is bbox coordinate transformation at inference time — parked for future
  work.

### Future work parking lot

- Per-frame approval / disapproval (operator marks individual frames as
  "good" or "discard"). Would need a new POST endpoint + a flag on
  `frameResults[n]`.
- Side-by-side Clean + Overlay rendering at the same time, for direct
  visual comparison.
- In-viewer bbox correction with re-inference: drag a corner of a bbox
  to tighten it, click Re-run AI for that one label, replace its
  `frameResults` in place.
- Server-side frame-strip thumbnail for an MP4-style scrubber preview
  along the slider.
- Extracting `FrameViewer.tsx` into smaller pieces (`<ModeToggle>`,
  `<LabelsPanel>`, `<PrefetchLayer>`) once a second viewer-like component
  appears.

## AI Analysis

Step 4 in the linear workflow. The user draws a region of interest (bbox /
circle / polygon / brush) on the first processed frame, types an intent
("segment the pleural line"), and clicks Run. Inference runs on every
frame in `spokes/template_mask/<jobId>/`; results are stored as one `AiLabel`
per Run on `job.aiLabels` (lightweight metadata, dual-written to `AIRun.labels[]`)
plus per-frame mask/overlay PNGs on disk under `spokes/ai/<jobId>/<runId>/`.

### Drawing canvas controls

The drawing toolbar in the AI Analysis sidebar panel has four mode
buttons (Rectangle / Circle / Polygon / Brush) followed by a divider and
two action buttons:

- **Undo last** (Undo2 icon) — single-shape semantics with step-by-step
  revert:
  - **Polygon mid-drafting**: pops the most recently placed vertex.
    Pops the last vertex → discards the shape entirely.
  - **Polygon committed** (post double-click, before Run): discards the
    polygon. Does not revert to drafting; if you want to keep editing,
    don't double-click.
  - **Rect / Circle / Brush** (committed or in-progress): discards the shape.
  - **Nothing to undo**: silent no-op.
- **Clear all** (Eraser icon) — clears the current shape after a
  `window.confirm` if it's a meaningful shape (polygon with >2 vertices,
  brush stroke with >4 points, or any rect/circle). Trivial in-progress
  shapes clear without asking.

Keyboard shortcut: **Cmd/Ctrl+Z** runs Undo when the AI Analysis panel is
visible AND focus is on `<body>` or the canvas (not in the intent input
or any other text field — those keep native undo). Multi-step undo is
supported by the rules above; the shortcut is a silent no-op when there's
nothing to undo.

There is **no multi-bbox composition** — only one shape is ever sent to
the GPU per Run click. Drawing a new shape replaces the previous one.

### Approve vs. delete

Each label in the sidebar list has two distinct controls, deliberately
separated because they have different consequences:

- **Approve toggle** — reversible. Click flips `label.approved`. Visual
  state shows current value: filled green "Approved ✓" when true, gray
  outline "Not approved ✕" when false. Hits `PATCH /api/ai/labels/:jobId/:labelId`
  with `{approved: !current}`. Only approved labels are written into the
  download ZIP's manifest. **Use this when you're not sure yet** — you
  can flip it back later without re-running inference.
- **Delete** (Trash2 icon, red on hover) — permanent. Click prompts
  `window.confirm("Permanently delete label 'foo'? This cannot be undone.")`.
  Confirm hits `DELETE /api/ai/labels/:jobId/:labelId`, which splices the
  label out of `job.aiLabels` AND its `AIRun`, and deletes the run's
  output directory from disk. The mask/overlay artifacts cannot be
  recovered without re-running inference. **Use this when you definitely
  don't want this label.**

A small color swatch leads each row, computed via
`client/src/lib/labelColor.ts` (FNV-1a → HSL). It matches the bbox
stroke color the FrameViewer renders for the same label, so users can
mentally connect rows to overlay rectangles.

### Layout

```
[swatch] [name] [confidence]   [approve toggle] [delete]
```

On narrow widths the name truncates with `truncate`; the toggle and
delete button stay full-size since they're shrink-0.
