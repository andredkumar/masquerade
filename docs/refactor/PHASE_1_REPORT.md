# Phase 1 Investigation Report: Hub-and-Spoke Refactor

> Generated for the Masquerade codebase at `masquerade-aws-latest/`.
> No code changes were made during this investigation.

---

## 1. Upload Handlers

Two upload endpoints exist. Both use multer with `dest: 'uploads/'`.

### Video upload

- **Endpoint**: `POST /api/videos/upload` (`server/routes.ts:116`)
- **Multer config**: `server/routes.ts:32-52` -- single file, 500 MB limit, allows mp4/mov/avi/dcm.
- **Creates job via**: `storage.createVideoJob(jobData)` (`server/routes.ts:157` for DICOM, similar for non-DICOM further down).
- **Job fields set at creation**: `filename`, `filePath`, `originalSize`, `duration`, `width`, `height`, `frameRate`, `totalFrames`, `status` ('extracting' for DICOM, 'uploaded' for video), `progress: 0`, `maskData: null`, `outputSettings: null`.
- **First frame**: Extracted synchronously and returned as base64 in the response (`server/routes.ts:136`).
- **Background extraction**: Kicked off via `setImmediate` after the response is sent. Calls `videoProcessor.startBackgroundFrameExtraction()` (`server/services/videoProcessor.ts:1012`).
- **Abort/error cleanup**: `req.on('aborted')` calls `deleteUploadFile(uploadedPath)` (`server/routes.ts:122`). Catch block also calls `deleteUploadFile`.

### Image batch upload

- **Endpoint**: `POST /api/images/upload` (`server/routes.ts:255`)
- **Multer config**: `server/routes.ts:54-75` -- array('images'), 50 MB per image, up to 10,000 files.
- **Creates job via**: `storage.createVideoJob(jobData)` (`server/routes.ts:306`).
- **Job fields set at creation**: Same as video plus `jobType: 'images'`, `fileCount`, `fileList: FileInfo[]`, `status: 'ready'` (images skip background extraction).
- **Abort/error cleanup**: `req.on('aborted')` loops through `uploadedPaths` calling `deleteUploadFile` (`server/routes.ts:260-261`). Catch block does the same (`server/routes.ts:330`).

### What the architecture doc changes

The hub-and-spoke model keeps upload endpoints largely the same but adds a `spoke` field to the job record and new per-spoke state objects (`templateMask?`, `labeling?`, `ai?`). The upload endpoints must populate the initial spoke state, and the disk destination may shift from `uploads/` to a spoke-specific input directory.

---

## 2. Extraction Flow

### Video extraction

1. **Background extraction** starts in the upload handler via `setImmediate` (`server/routes.ts` post-upload block).
2. Calls `videoProcessor.startBackgroundFrameExtraction(jobId, videoPath, totalFrames)` (`server/services/videoProcessor.ts:1012`).
3. This method delegates to `frameExtractor.extractAllFramesSequential()` (`server/services/frameExtractor.ts`) which invokes ffmpeg once to dump all frames to `temp_extracted/<jobId>/`.
4. Job status transitions: `'uploaded'` -> `'extracting'` -> `'ready'`.

### Template-mask processing (triggered later)

1. **Entry point**: `PATCH /internal/mask-processing/:jobId` (`server/index.ts:26`).
2. For video jobs, calls `videoProcessor.processVideo(jobId, filePath, maskData, outputSettings, samplingFps)` (`server/index.ts:129`).
3. `processVideo` (`server/services/videoProcessor.ts:280`):
   - Extracts frames to `temp_extracted/<jobId>/` via `extractAllFramesSequential` (`videoProcessor.ts:312`).
   - Reads all extracted frames into memory as Buffers (`videoProcessor.ts:321-323`).
   - Processes frames in parallel batches via `processFrameBuffersInParallel` (`videoProcessor.ts:361`).
   - Writes processed frames to `temp_processed/<jobId>/` via `TempFolderManager` (`videoProcessor.ts:373-383`).
   - `finally` block deletes `temp_extracted/<jobId>/` and the upload file (`videoProcessor.ts` finally block).

### Image batch processing

1. **Entry point**: Same `PATCH /internal/mask-processing/:jobId` but branches on `job.jobType === 'images'` (`server/index.ts:105`).
2. Calls `videoProcessor.processImages(jobId, imagePaths, maskData, outputSettings)` (`server/index.ts:119`).
3. `processImages` (`server/services/videoProcessor.ts:438`):
   - Reads source images directly from `uploads/` (no extraction step).
   - Processes in volumetric batches of 8 (`videoProcessor.ts:512`).
   - Saves to `temp_processed/<jobId>/` via `TempFolderManager.saveProcessedImage` (`videoProcessor.ts` in the batch loop).
   - `finally` block deletes upload files.

### Key observation for refactor

The extraction step writes to `temp_extracted/<jobId>/` which is separate from the spoke output dir. Under hub-and-spoke, each spoke would have its own output directory under `spokes/<spoke_type>/<jobId>/`. The extraction step itself is spoke-agnostic and could remain shared, but the final write destination must become spoke-aware.

---

## 3. `temp_processed/` Consumers

Every site in the codebase that reads from, writes to, or references `temp_processed/`:

| # | File | Line(s) | Read/Write | What it does |
|---|------|---------|------------|--------------|
| 1 | `server/services/tempFolderManager.ts` | 5 | Config | `TEMP_BASE = path.join(process.cwd(), 'temp_processed')` -- hardcoded base path |
| 2 | `server/services/tempFolderManager.ts` | 10-21 | Write | `createJobTempFolder(jobId)` -- mkdir |
| 3 | `server/services/tempFolderManager.ts` | 26-36 | Write | `cleanupJobTempFolder(jobId)` -- rm -rf |
| 4 | `server/services/tempFolderManager.ts` | 54-56 | Read | `getJobTempFolder(jobId)` -- returns path |
| 5 | `server/services/tempFolderManager.ts` | 61-81 | Write | `saveProcessedImage()` -- writes frame files |
| 6 | `server/services/tempFolderManager.ts` | 86-101 | Read | `getProcessedImages()` -- lists frame files |
| 7 | `server/services/cleanup.ts` | 36 | Config | `TEMP_PROCESSED_DIR = path.resolve(process.cwd(), 'temp_processed')` |
| 8 | `server/services/cleanup.ts` | 41 | Config | `TEMP_PROCESSED_MAX_AGE_MS = 24h` retention |
| 9 | `server/services/cleanup.ts` | 104 | Write | `cleanupJobArtifacts()` -- deletes `temp_processed/<jobId>/` (currently orphan -- no callers) |
| 10 | `server/services/cleanup.ts` | 262 | Write | Hourly cron sweeps `TEMP_PROCESSED_DIR` |
| 11 | `server/services/frameAccess.ts` | 14 | Config | Imports `TEMP_PROCESSED_DIR` from cleanup |
| 12 | `server/services/frameAccess.ts` | 34 | Read | `resolveFramePath()` -- resolves frame file in `TEMP_PROCESSED_DIR/<jobId>/` |
| 13 | `server/services/frameAccess.ts` | 70 | Read | `tempDirExists()` -- checks `TEMP_PROCESSED_DIR/<jobId>/` |
| 14 | `server/services/frameAccess.ts` | 87 | Read | `countFrames()` -- counts frame files in `TEMP_PROCESSED_DIR/<jobId>/` |
| 15 | `server/services/videoProcessor.ts` | 373-383 | Write | `processVideo` saves frames via TempFolderManager |
| 16 | `server/services/videoProcessor.ts` | 468-469 | Write | `processImages` creates/cleans temp folder via TempFolderManager |
| 17 | `server/routes.ts` | 475 | Read | Download endpoint: `path.join(process.cwd(), 'temp_processed', job.id)` |
| 18 | `server/routes.ts` | 476-478 | Read | Download: `fs.existsSync(tempDir)` check |
| 19 | `server/routes.ts` | 483-485 | Read | Download: `fs.readdirSync(tempDir)` to list frames |
| 20 | `server/routes.ts` | 709 | Read | Download: `archive.file(framePath, ...)` reads frame into ZIP |
| 21 | `server/routes.ts` | 805 | Read | AI infer: `path.join(process.cwd(), 'temp_processed', jobId)` |
| 22 | `server/routes.ts` | 807-809 | Read | AI infer: `fs.existsSync(tempDir)`, `fs.readdirSync(tempDir)` |
| 23 | `server/routes.ts` | 857 | Read | AI infer: `fs.readFileSync(framePath)` for each frame |
| 24 | `server/routes.ts` | 1058-1116 | Read | viewer-info endpoint uses `tempDirExists()`, `countFrames()` |
| 25 | `server/routes.ts` | 1129-1165 | Read | frames/:n.png endpoint uses `resolveFramePath()` |
| 26 | `server/routes.ts` | 1183-1278 | Read | inference.json endpoint uses `tempDirExists()`, `countFrames()` |
| 27 | `server/routes.ts` | 1383 | Write | SIGTERM: `sweepDirectory(UPLOADS_DIR, 0)` |
| 28 | `server/routes.ts` | 1384 | Write | SIGTERM: `sweepDirectory(TEMP_EXTRACTED_DIR, 0)` |
| 29 | `server/routes.ts` | 1385 | Write | SIGTERM: `sweepDirectory(TEMP_PROCESSED_DIR, 0)` |
| 30 | `server/index.ts` | 188-189 | Init | `TempFolderManager.initialize()` -- ensures `temp_processed/` exists on boot |
| 31 | `scripts/cleanup-now.ts` | 76 | Write | References `TEMP_PROCESSED_DIR` for manual sweep |
| 32 | `CLAUDE.md` | 17 | Doc | Documents the 24h retention for `temp_processed/` |

### Refactor impact

All 32 entries above must be retargeted. The abstraction boundary is `frameAccess.ts` + `TempFolderManager` -- if these two modules learn to resolve spoke-specific directories, most consumers above go through them and would not need direct changes. The exceptions are the **download endpoint** (`routes.ts:475`) and the **AI infer endpoint** (`routes.ts:805`), which both hardcode `path.join(process.cwd(), 'temp_processed', ...)` and bypass the abstraction layer.

---

## 4. AI Label Endpoints

### Endpoints

| Method | Path | File:Line | Purpose |
|--------|------|-----------|---------|
| `POST` | `/api/ai/parse-intent` | `routes.ts:746` | NL command -> structured ParsedIntent |
| `POST` | `/api/ai/infer` | `routes.ts:767` | Run inference on all frames for a job |
| `GET` | `/api/ai/labels/:jobId` | `routes.ts:967` | List all labels for a job |
| `PATCH` | `/api/ai/labels/:jobId/:labelId` | `routes.ts:981` | Toggle `approved` on a label |
| `DELETE` | `/api/ai/labels/:jobId/:labelId` | `routes.ts:1009` | Delete a label + evict from maskArtifactStore |
| `GET` | `/api/ai/status` | `routes.ts:936` | Health check for Python AI service |
| `GET` | `/api/ai/models` | `routes.ts:953` | List available models |

### Data flow: `/api/ai/infer`

1. Reads all frames from `temp_processed/<jobId>/` (`routes.ts:805-809`).
2. Parses NL command via `IntentParser` (`routes.ts:792`).
3. Routes to model via `ModelRouter` (`routes.ts:822`).
4. Iterates frames, calling `aiClient.infer()` for each (`routes.ts:851-874`).
5. Emits `'inference-progress'` per frame via `io.to(jobId).emit(...)` (`routes.ts:854`).
6. Writes heavy base64 artifacts to `maskArtifactStore.set(newLabelId, ...)` (`routes.ts:885`).
7. Writes lean metadata (`AiLabel`) to `job.aiLabels` via `storage.updateVideoJob()` (`routes.ts:911-913`).
8. Returns first-frame result + full label to client (`routes.ts:917-926`).

### `maskArtifactStore` shape

Defined in `server/services/maskArtifactStore.ts`:
- `Map<string, LabelArtifacts>` keyed by `labelId` (a UUID).
- `LabelArtifacts`: `{ maskB64?: string, overlayB64?: string, frameResults?: Record<number, { maskB64: string, overlayB64?: string }> }`.
- In-memory only -- lost on PM2 restart. Viewer detects this via `hasArtifacts: false` and shows a re-run banner.

### Refactor impact

Under hub-and-spoke, the AI spoke (`Path C`) would have its own output directory `spokes/ai/<jobId>/<runId>/`. The `/api/ai/infer` endpoint currently reads frames from `temp_processed/<jobId>/` and writes only to memory (`maskArtifactStore`) + `job.aiLabels`. It would need to read from the template-mask spoke's output directory (or a shared staging area) and optionally write mask PNGs to the AI spoke directory instead of holding everything in RAM.

---

## 5. Frame Viewer Coupling to `temp_processed/`

The frame viewer reads frames exclusively through four endpoints defined in `routes.ts:1046-1369`. All four route through the `frameAccess.ts` abstraction layer:

| Endpoint | frameAccess function | Lines |
|----------|---------------------|-------|
| `GET /api/jobs/:jobId/viewer-info` | `tempDirExists()`, `countFrames()` | `routes.ts:1063, 1072` |
| `GET /api/jobs/:jobId/frames/:n.png` | `tempDirExists()`, `resolveFramePath()` | `routes.ts:1139, 1146` |
| `GET /api/jobs/:jobId/inference.json` | `tempDirExists()`, `countFrames()` | `routes.ts:1188, 1241` |
| `GET /api/jobs/:jobId/masks/:labelId/:n.png` | none (reads from maskArtifactStore) | `routes.ts:1304` |
| `GET /api/jobs/:jobId/overlays/:labelId/:n.png` | none (reads from maskArtifactStore) | `routes.ts:1348` |

### `frameAccess.ts` internals

- `resolveFramePath(jobId, frameIndex)` (`frameAccess.ts:26`): Resolves `TEMP_PROCESSED_DIR/<jobId>/frame_NNNNNN.{png,jpg,jpeg}`. Contains path-traversal guard (`frameAccess.ts:39-42`).
- `tempDirExists(jobId)` (`frameAccess.ts:69`): Checks whether `TEMP_PROCESSED_DIR/<jobId>/` is a directory.
- `countFrames(jobId)` (`frameAccess.ts:86`): Counts `.png/.jpg/.jpeg` files in `TEMP_PROCESSED_DIR/<jobId>/`.
- `TEMP_PROCESSED_DIR` is imported from `cleanup.ts:36` and is the single point of truth for the base path.

### What it would take to point FrameViewer at spoke directories

**Minimal change**: Make `frameAccess.ts` functions accept an optional base directory parameter (defaulting to `TEMP_PROCESSED_DIR` for backwards compatibility). Spoke-aware callers would pass the spoke output directory. The path-traversal guard already works with any base directory -- it just needs the `rootWithSep` check to use the passed-in base.

**Client-side impact**: Zero. `FrameViewer.tsx` uses only the `/api/jobs/:jobId/...` URL pattern (`client/src/components/FrameViewer.tsx` throughout). It never touches `temp_processed/` directly. All the routing logic lives server-side.

---

## 6. React Router / Orchestration State

### Current routing: wouter (not react-router-dom)

The app uses **wouter v3.3.5** (confirmed in `package.json`). `react-router-dom` is **not installed**.

`App.tsx:1`:
```ts
import { Switch, Route } from "wouter";
```

Routes defined in `App.tsx:16-22`:
```
/        -> Landing
/app     -> Home
/terms   -> Terms
/privacy -> Privacy
*        -> NotFound
```

### Current step orchestration in `home.tsx`

The 5-step workflow is managed entirely by React state in `home.tsx`. There is no URL-based step navigation. Steps unlock based on computed boolean conditions (`home.tsx:184-187`):

```ts
const step2Enabled = !!currentJob;        // has uploaded
const step3Enabled = !!maskData;          // has drawn a mask
const step4Enabled = jobCompleted;        // processing done
const step5Enabled = jobCompleted;        // processing done
```

The `viewerActive` state (`home.tsx:40`) swaps the main area between `MaskingCanvas` and `FrameViewer`. This is a boolean toggle, not a route.

### What the architecture doc proposes

The architecture doc proposes introducing React Router for spoke navigation. Each spoke (Path A, B, C) would be a separate route under `/app/:jobId/...`. The current conditional rendering based on step state would be replaced by URL-based routing.

### Migration considerations

- **wouter -> react-router-dom**: This is a library swap, not just a configuration change. wouter's `Switch/Route` has a similar API to react-router but differs in nested routing, path params, and navigation hooks. The `Link` component from wouter is used in `landing.tsx`.
- **State that currently lives in `home.tsx` local state**: `currentJob`, `videoMetadata`, `firstFrame`, `maskData`, `isProcessing`, `aiLabels`, `viewerActive`, etc. Under spoke routing, some of this state needs to lift to a context/store or be derived from URL params.
- **No existing state management library**: There is no Redux, Zustand, Jotai, or similar. All state is `useState` in `home.tsx`. The refactor will need either a new context provider or a state management library.

---

## 7. Socket.IO Events

### Server-side events

| Event | Direction | Emitter | File:Line | Scope |
|-------|-----------|---------|-----------|-------|
| `progress` | server -> client | `videoProcessor.updateProgress()` | `videoProcessor.ts:999` | **Global broadcast** (`this.io.emit`, NOT room-scoped) |
| `inference-progress` | server -> client | `/api/ai/infer` handler | `routes.ts:837, 854, 877` | Room-scoped (`io.to(jobId).emit`) |

### Client-side events

| Event | Direction | Emitter | File:Line |
|-------|-----------|---------|-----------|
| `join` | client -> server | `ProcessingStatus` | `ProcessingStatus.tsx:33` |
| `progress` | server -> client (listener) | `ProcessingStatus` | `ProcessingStatus.tsx:41` |
| `connection` | server | Socket.IO built-in | `routes.ts:1033` |
| `disconnect` | server | Socket.IO built-in | `routes.ts:1041` |

### Server setup

- `SocketIOServer` created in `routes.ts:81-86` with `cors: { origin: "*" }`.
- Stored as `(global as any).socketIo = io` (`routes.ts:89`) for cross-module access from `server/index.ts`.
- Room join: client emits `'join'` with `jobId`, server calls `socket.join(jobId)` (`routes.ts:1036-1038`).

### Critical issue: `progress` broadcast is NOT room-scoped

`videoProcessor.updateProgress()` at `videoProcessor.ts:999` uses:
```ts
this.io.emit('progress', { jobId, ...progress });
```

This broadcasts to ALL connected clients, not just the room for `jobId`. The client-side handler in `ProcessingStatus.tsx:36` filters by `jobId`, so functionally it works, but every connected client receives every job's progress events. This is a scalability concern and a minor information leak.

The `inference-progress` event correctly uses `io.to(jobId).emit(...)` (`routes.ts:854`).

### Refactor impact

Hub-and-spoke will likely need spoke-specific progress events (e.g., `'spoke:template-mask:progress'`, `'spoke:ai:progress'`). The `progress` broadcast should be fixed to use room-scoped emit at the same time.

---

## 8. Schema Types Relevant to Refactor

All types are defined in `shared/schema.ts`.

### `VideoJob` (Drizzle table, `schema.ts:6-30`)

Key fields:
- `id` (varchar, PK, UUID)
- `status` (text): `'uploaded' | 'extracting' | 'ready' | 'processing' | 'completed' | 'failed'`
- `jobType` (text): `'video' | 'images'` (`schema.ts:25`)
- `maskData` (jsonb): `MaskData | null` (`schema.ts:18`)
- `outputSettings` (jsonb): `OutputSettings | null` (`schema.ts:19`)
- `aiLabels` (jsonb, default `[]`): `AiLabel[]` (`schema.ts:29`)
- `fileList` (jsonb): `FileInfo[] | null` -- for image batch jobs (`schema.ts:27`)

### `MaskData` (`schema.ts:69-109`)

Template mask definition. Key fields: `type` (rectangle/circle/polygon/freeform), `coordinates`, `opacity`, `canvasDataUrl` (base64 PNG of the drawn mask), `imageDisplayInfo`, `imageDimensions`, `aiLabel`, `aiLabels`.

### `OutputSettings` (`schema.ts:111-122`)

Processing output config: `size` (preset or 'original'/'custom'), `format` ('png'/'jpg'), `aspectRatioMode` ('stretch'/'letterbox'/'crop'), `batchSize`, `parallelThreads`.

### `AiLabel` (`schema.ts:132-147`)

Per-run AI inference metadata: `id` (UUID), `intent`, `target`, `modality`, `confidence`, `model`, `timestamp`, `approved`, `bbox` (image pixel coords), `frameResults` (per-frame confidence only -- heavy blobs live in `maskArtifactStore`).

### `ProcessingProgress` (`schema.ts:159-172`)

Real-time progress shape: `jobId`, `stage`, `progress`, `currentFrame`, `totalFrames`, `fps`, `extractionProgress`, `status`, `errorMessage`.

### What the architecture doc changes

The architecture doc proposes adding spoke-specific state to the job:
- `templateMask?: { status, outputDir, ... }`
- `labeling?: { status, labels[], ... }`
- `ai?: { runs: [{ runId, status, ... }] }`

This would either be additional fields on the `videoJobs` table or a new `jobSpokes` JSONB column. The existing `maskData` and `outputSettings` fields become specific to the template-mask spoke. `aiLabels` moves under the `ai` spoke state.

---

## 9. Analytics Events (PostHog)

### Initialization

- `client/src/lib/posthog.ts`: Initializes PostHog with API key, exports `posthog` instance.
- `App.tsx:28`: Calls `initPostHog()` in `useEffect` on mount.

### Events captured

| Event Name | File:Line | Properties |
|------------|-----------|------------|
| `file_uploaded` | `FileUpload.tsx:82` | `file_type`, `file_count`, `job_id` |
| `mask_processing_started` | `ProcessingControls.tsx:125` | `job_id`, `mask_type`, `output_size`, `output_format`, `aspect_ratio_mode` |
| `frames_downloaded` | `ProcessingStatus.tsx:90` | `job_id` |
| `frames_downloaded` | `home.tsx:176` | `job_id`, `includeMasks`, `includeOverlays` |

Note: `frames_downloaded` is fired from two places with different property shapes. `ProcessingStatus.tsx:90` fires it with just `job_id`; `home.tsx:176` fires it with `job_id`, `includeMasks`, `includeOverlays`. This is because there are two download paths: the ProcessingStatus component's download button and the sidebar's download button in home.tsx.

### Refactor impact

Under hub-and-spoke, events should include a `spoke` property to distinguish which path triggered the action. The `file_uploaded` event is spoke-agnostic. The `mask_processing_started` event is template-mask spoke. The `frames_downloaded` event could come from any spoke. Consider a naming convention like `spoke:template_mask:processing_started`.

---

## 10. CLAUDE.md Accuracy Check

`CLAUDE.md` was last updated to reflect the frame viewer and AI analysis additions. Current accuracy:

| Section | Accurate? | Notes |
|---------|-----------|-------|
| Disk lifecycle table | Yes | Matches `cleanup.ts:34-41` retention values |
| `temp_processed/` not deleted post-download | Yes | Confirmed at `routes.ts:673-675` (comment says intentionally not deleting) |
| Boot-time purge of uploads | Yes | `index.ts:194` calls `purgeUploadsOnStartup()` |
| Hourly cron | Yes | `index.ts:195` calls `startCleanupScheduler()` |
| SIGTERM behavior | Yes | `routes.ts:1372-1391` |
| Frame viewer endpoints table | Yes | All 5 endpoints match `routes.ts:1046-1369` |
| Frame viewer component props | Yes | Matches FrameViewer.tsx |
| Three view modes (Clean/Overlay/Bbox) | Yes | Matches FrameViewer.tsx |
| Bbox coord system (source-video pixels) | Yes | `routes.ts:1197-1207` confirms imageWidth/Height from `job.width/height` |
| AI Analysis section | Yes | Approve/delete semantics match `home.tsx:133-168` |
| Known limitation: artifacts lost on restart | Yes | maskArtifactStore is in-memory only (`maskArtifactStore.ts`) |
| `cleanupJobArtifacts` description | Slightly stale | CLAUDE.md says it's called "after successful download" -- in reality it's an **orphan function** with no callers since the post-download hook was removed. The hourly sweep is the only reclamation path. |

### Suggested CLAUDE.md update (for Phase 2)

The `cleanupJobArtifacts` entry in the eager-deletes list should note that it currently has no callers and is retained for future use. This is a documentation-only change.

---

## 11. Surprises / Risks

1. **`cleanupJobArtifacts()` is an orphan** (`cleanup.ts:101`). It is exported and documented but has zero call sites in the codebase. It deletes both `temp_extracted/<jobId>/` and `temp_processed/<jobId>/`, but nothing invokes it. The hourly cron and SIGTERM handler use `sweepDirectory` directly. This function should be either called or removed.

2. **`progress` event broadcast is global** (`videoProcessor.ts:999`). Every connected WebSocket client receives progress updates for every job, not just the job they joined. The client filters by `jobId` (`ProcessingStatus.tsx:36`), but this is still a scalability issue and a minor information leak. The `inference-progress` event correctly uses room-scoped emit.

3. **Download endpoint bypasses `frameAccess.ts`** (`routes.ts:475`). It hardcodes `path.join(process.cwd(), 'temp_processed', job.id)` instead of using the `frameAccess` module. Same for the AI infer endpoint (`routes.ts:805`). This means these two endpoints won't automatically benefit from any refactoring of `frameAccess.ts`.

4. **TempFolderManager has no path-traversal guard** (`tempFolderManager.ts:5-56`). Unlike `frameAccess.ts` and `cleanup.ts`, it does not validate that the resolved path stays inside `TEMP_BASE`. A malicious `jobId` like `../../etc` would resolve outside `temp_processed/`. The cleanup module's `safeDelete` covers the delete path, but `createJobTempFolder` and `saveProcessedImage` write via `fs.mkdir` and `fs.writeFile` without a bounds check.

5. **Duplicate socket.io instance via `global`** (`routes.ts:89`, `server/index.ts:83`). The Socket.IO instance is stored as `(global as any).socketIo` in `routes.ts:89` and retrieved in `server/index.ts:83`. This cross-module communication via untyped global is fragile. The PATCH endpoint in `index.ts` constructs a new `VideoProcessor(io)` on every request (`index.ts:92`), which is wasteful.

6. **`POST /api/videos/:jobId/process` appears to be dead code** (`routes.ts:361-451`). The client uses `PATCH /internal/mask-processing/:jobId` for triggering processing (called from `ProcessingControls.tsx`). The POST endpoint at `routes.ts:361` has an additional status guard (`job.status !== 'uploaded' && job.status !== 'ready'`) that the PATCH endpoint lacks, and it doesn't accept `samplingFps`. It may be legacy.

7. **Two test endpoints in production** (`routes.ts:96-111`). `POST /api/test-post` and `POST /test-non-api` are debug endpoints that log request bodies. They should be removed or gated behind `NODE_ENV === 'development'`.

8. **`maskArtifactStore` memory is unbounded**. There is an `approximateSize()` method (`maskArtifactStore.ts`) that logs the store size, but there is no eviction policy. A user running many AI inference sessions could accumulate significant memory. The store is only cleared when labels are explicitly deleted or the process restarts.

---

## 12. Spec Gaps in the Architecture Doc

1. **No migration strategy for in-flight jobs**. The architecture doc defines the target spoke directory structure (`spokes/template_mask/<jobId>/`, `spokes/ai/<jobId>/<runId>/`) but does not specify what happens to jobs currently in `temp_processed/` when the new code deploys. Should existing jobs be migrated? Should the old path be supported as a fallback?

2. **`maskArtifactStore` persistence is unaddressed**. The architecture doc mentions moving to Postgres but does not discuss the in-memory mask artifact store. Base64 mask/overlay blobs for every frame of every label can be several GB for large jobs. The doc should specify whether these persist to disk (spoke directory), to Postgres (blob column), or remain in-memory with explicit eviction.

3. **`samplingFps` is not mentioned**. The current system supports frame sampling rates (`samplingFps` parameter on `PATCH /internal/mask-processing/:jobId`, `server/index.ts:33`). The architecture doc's spoke design does not account for this parameter. Template-mask spoke needs to know the sampling rate.

4. **Cleanup/retention per spoke is undefined**. The architecture doc defines new spoke directories but does not specify retention windows for each. Currently `temp_processed/` has 24h retention. Should `spokes/template_mask/<jobId>/` have the same? Should `spokes/ai/<jobId>/<runId>/` have different retention since AI artifacts are more expensive to regenerate?

5. **Job type handling (video vs. images) under spokes**. The architecture doc focuses on the hub-and-spoke model generically but does not discuss how `jobType: 'images'` jobs (which skip extraction) interact with spokes. Image batch jobs go directly from upload to processing with no extraction step.

6. **DICOM-specific handling**. The upload handler has special DICOM detection and optimized first-frame extraction (`routes.ts:130-133`). The architecture doc does not mention DICOM-specific spoke behavior or whether the DICOM workflow maps differently to spokes.

7. **`/internal/mask-processing/:jobId` endpoint placement**. This endpoint is registered in `server/index.ts:26` BEFORE the main routes to avoid Vite dev-server interception. The architecture doc proposes new spoke-specific endpoints but does not address this registration-order concern. Any new spoke trigger endpoints may face the same Vite interception issue.

8. **Client-side state management for multi-spoke UI**. The architecture doc proposes React Router for spoke navigation but does not specify how shared state (current job, video metadata, etc.) flows between spoke pages. Currently everything is local state in `home.tsx`. The doc should specify whether to use React Context, URL params, or a state management library.

---

## 13. Files Inspected

| # | Path | Lines | Role |
|---|------|-------|------|
| 1 | `server/routes.ts` | 1395 | All HTTP endpoints + Socket.IO + SIGTERM handler |
| 2 | `server/index.ts` | 233 | Boot sequence + PATCH /internal/mask-processing endpoint |
| 3 | `server/storage.ts` | 117 | MemStorage class (in-memory Maps) |
| 4 | `server/services/cleanup.ts` | 271 | Disk cleanup: safeDelete, sweep, cron, retention constants |
| 5 | `server/services/frameAccess.ts` | 114 | Read-only frame resolution + path traversal guards |
| 6 | `server/services/videoProcessor.ts` | ~1050 | processVideo, processImages, updateProgress |
| 7 | `server/services/frameExtractor.ts` | ~951 | ffmpeg frame extraction, DICOM handling |
| 8 | `server/services/tempFolderManager.ts` | 121 | temp_processed/ folder CRUD |
| 9 | `server/services/maskArtifactStore.ts` | 63 | In-memory base64 mask/overlay store |
| 10 | `shared/schema.ts` | 173 | Drizzle tables, TypeScript interfaces |
| 11 | `client/src/App.tsx` | 42 | Wouter routing, PostHog init |
| 12 | `client/src/pages/home.tsx` | ~657 | 5-step orchestrator, all local state |
| 13 | `client/src/pages/landing.tsx` | ~small | Landing page with Link from wouter |
| 14 | `client/src/components/FrameViewer.tsx` | ~623 | Read-only frame viewer, 3 view modes |
| 15 | `client/src/components/ProcessingControls.tsx` | ~299 | Output settings form, PATCH trigger |
| 16 | `client/src/components/ProcessingStatus.tsx` | ~256 | Progress display, Socket.IO listener, download |
| 17 | `client/src/components/FileUpload.tsx` | ~170+ | Upload form, multer POST |
| 18 | `client/src/components/CommandInput.tsx` | ~large | AI command input, bbox drawing |
| 19 | `client/src/lib/posthog.ts` | 13 | PostHog initialization |
| 20 | `scripts/cleanup-now.ts` | 121 | Manual CLI cleanup |
| 21 | `CLAUDE.md` | ~296 | In-repo orientation doc |
| 22 | `package.json` | - | Dependencies: wouter, socket.io, sharp, etc. |
| 23 | `files/MASQUERADE_STATUS.md` | - | Current state documentation |
| 24 | `files/MASQUERADE_ARCHITECTURE.md` | - | Target architecture document |
| 25 | `server/services/intentParser.ts` | - | NL intent parsing (referenced, not read in detail) |
| 26 | `server/services/aiInferenceClient.ts` | - | GPU inference client (referenced, not read in detail) |
| 27 | `server/services/modelRouter.ts` | - | Model routing logic (referenced, not read in detail) |
| 28 | `client/src/lib/labelColor.ts` | - | FNV-1a color for labelId (referenced) |
| 29 | `client/src/hooks/useWebSocket.ts` | - | Socket.IO client hook (referenced) |
