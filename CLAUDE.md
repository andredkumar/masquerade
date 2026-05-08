# Masquerade

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
`setTemplateMaskState`, `addAiRun`, etc.). Phase 3b wired `createJobV2`,
`addAiRun`, `updateAiRun`, `getAiRun`, `listAiRuns`, `deleteAiRun` into
the AI inference and label endpoints.

The existing `VideoJob`, `MaskData`, `OutputSettings`, and `AiLabel` types
remain the active runtime types until Phase 3 completes the migration.

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
  - `videoProcessor.processVideo` and `processImages` use a
    `try/catch/finally` where `finally` calls `deleteUploadFile(...)` and
    `safeDelete` on `temp_extracted/<jobId>/` once a terminal status is
    reached (success **or** failure).
  - The setImmediate fire-and-forget background tasks have a `.catch`
    that also calls `deleteUploadFile(...)` so a crash before
    `processVideo`'s `finally` is reached doesn't leak the upload.
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
