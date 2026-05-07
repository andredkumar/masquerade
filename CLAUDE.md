# Masquerade

Project-level notes for engineers and Claude when working on this codebase.

## Disk lifecycle

Three transient directories live at the project root and hold short-lived
data. All of them are managed by `server/services/cleanup.ts`; nothing else
in the codebase should call `fs.rm` / `fs.unlink` against these paths
directly — go through `safeDelete`, `deleteUploadFile`, or
`cleanupJobArtifacts` instead so deletes stay bounded to their allowed root.

| Directory | Holds | Retention |
|-----------|-------|-----------|
| `uploads/` | Original user uploads (multer dest). Contains PHI. | **2 hours** |
| `temp_extracted/<jobId>/` | Raw frames pulled from a video before template-masking. | **6 hours** |
| `temp_processed/<jobId>/` | Masked output frames consumed by the ZIP/download builder and the frame viewer. | **24 hours, hourly sweep only** |

`temp_processed/<jobId>/` is **not** deleted post-download. Folders persist
after download to allow the frame viewer to be reopened. Practical effect:
a user who downloads then comes back later sees their session intact for up
to 24h. The hourly retention sweep is the only path that reclaims this dir.

### When does cleanup happen?

- **On every server start**, `purgeUploadsOnStartup()` deletes everything
  in `uploads/`. Storage is in-memory (`server/storage.ts`), so any upload
  from a previous process is orphaned by definition — no live request
  handler can reference it.
- **Hourly cron** (minute 0): `startCleanupScheduler()` sweeps each
  directory for entries older than its retention window. Wrapped in
  try/catch at every layer — cleanup must never crash the app.
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
- **SIGTERM** sweeps all three directories with `maxAgeMs = 0` (everything
  goes), then closes the HTTP server. Each step is individually
  try/wrapped so one failure cannot block shutdown.

### Manual cleanup

```sh
# Sweep all three dirs respecting the configured retention windows
npm run cleanup

# Show what would be deleted, delete nothing
npm run cleanup -- --dry-run

# Limit to one directory
npm run cleanup -- --dir=uploads
npm run cleanup -- --dir=temp_extracted
npm run cleanup -- --dir=temp_processed

# Override the age threshold (delete everything regardless of age)
npm run cleanup -- --max-age-ms=0
```

`--dry-run` logs every target and the total bytes that *would* be freed
without touching the filesystem. Combine flags freely:
```sh
npm run cleanup -- --dir=temp_processed --dry-run
```

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
| `GET` | `/api/jobs/:jobId/inference.json` | `no-store` | Frame-indexed pivot of `job.aiLabels`: `{imageWidth, imageHeight, labels[], frames: {n: [{labelId, name, modality, confidence, bbox, hasMask}]}}`. No base64 blobs — mask URLs are constructed client-side from labelId. |
| `GET` | `/api/jobs/:jobId/masks/:labelId/:n.png` | `private, max-age=3600` | Decodes from `maskArtifactStore` and streams a binary mask PNG. **410 with `{reason: "artifacts_lost_on_restart"}`** when the label exists in `job.aiLabels` but the in-memory store has no entry — the frontend uses this to show a re-run banner. |
| `GET` | `/api/jobs/:jobId/overlays/:labelId/:n.png` | `private, max-age=3600` | Same as masks but serves the GPU's pre-rendered RGBA overlay (green tint on the mask region). Used by the viewer's "Overlay" mode. |

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
- **Bbox** — frame + SVG `<rect>` per visible label, scaled from
  image-pixel coords to display coords using `imageWidth/imageHeight` from
  inference.json. Each rect uses the label's deterministic color
  (`colorForLabelId`, FNV-1a → HSL hue with fixed S/L) so colors stay
  stable across reloads.

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
- **Artifacts are RAM-only**. After a `pm2 restart` the `maskArtifactStore`
  is empty even though `job.aiLabels` is still in MemStorage. The viewer
  detects this via `hasArtifacts: false` and shows a banner with a
  re-run-inference shortcut.
- **Bbox display uses sorted-list position as the frame key**. This
  matches the inference loop and the manifest builder. If upstream
  processing changes the file naming convention again, both inference.json
  and the viewer need to be re-aligned.
- **Image dimensions** in inference.json come from `Sharp(firstFrame).metadata()`.
  If the temp_processed frame dimensions don't match the dimensions the
  GPU saw (which would only happen via an outputSettings re-process path),
  bbox display would be slightly mis-aligned. Not a current issue.

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
