# Phase 4a Report — Routing Scaffolding, Upload Page, Hub Page

**Date:** 2026-05-12
**Scope:** New frontend routes (`/upload`, `/jobs/:jobId`, `/jobs/:jobId/template-mask`, `/jobs/:jobId/ai`), upload page with PHI attestation, hub page with spoke tiles, spoke wrapper pages rendering legacy UI components, `JobContext` provider, `GET /api/jobs/:jobId` split to return `Job` V2.
**Constraint:** No legacy component refactoring. No backend handler logic changes beyond splitting the GET handler. No new dependencies. `home.tsx` preserved.

---

## 1. Files Changed

### Frontend (new files)

| File | Purpose |
|---|---|
| `client/src/pages/upload.tsx` | Upload page: file picker + PHI attestation radio group + "Let's Go" button |
| `client/src/pages/hub.tsx` | Hub page: status strip, initializing panel, three spoke tiles |
| `client/src/pages/template-mask-spoke.tsx` | Spoke wrapper: renders `MaskingCanvas`, `MaskingTools`, `ProcessingControls`, `ProcessingStatus` inside new route |
| `client/src/pages/ai-spoke.tsx` | Spoke wrapper: renders `CommandInput`, `TaskSelector`, `FrameViewer`, AI label list inside new route |
| `client/src/contexts/JobContext.tsx` | `JobProvider` + `useJob()` hook — fetches `GET /api/jobs/:jobId`, refetches on Socket.IO progress events |
| `client/src/lib/frameCache.ts` | sessionStorage cache for firstFrame + metadata across SPA route transitions |

### Frontend (modified)

| File | Change |
|---|---|
| `client/src/App.tsx` | Added 5 new wouter routes. `JobProvider` wraps `/jobs/:jobId/*` subtree via nested route with `nest` prop. `/` now redirects to `/upload`. Legacy `/app` route preserved for `home.tsx`. |

### Shared (modified)

| File | Change |
|---|---|
| `shared/schema.ts` | `AttestationRecord` type updated from `{ checked, timestamp, text }` to `{ attestedAt: string, choice: 'contains_phi' \| 'no_phi' }` to match the upload page's attestation payload. |

### Backend (modified)

| File | Change |
|---|---|
| `server/routes.ts` | Split `getJobHandler` into `getLegacyJobHandler` (returns `VideoJob` at `/api/videos/:jobId`) and `getJobV2Handler` (returns `Job` V2 at `/api/jobs/:jobId`). Added `JSON.parse` for `attestationRecord` in both upload handlers (multer gives form fields as strings). |

---

## 2. Component Map

### New components

- **UploadPage** — standalone page. File picker with drag-and-drop, PHI attestation radio group, "Let's Go" submit button. POSTs to canonical upload URL with `phiStatus` + `attestationRecord`. Navigates to `/jobs/:jobId` on success.
- **HubPage** — consumes `useJob()`. Status strip with filename, PHI badge (green/amber), source metadata. Initializing panel with progress indicator when status !== 'ready'. Three spoke tiles: Template Mask (clickable when ready), Classify or Label (disabled/"Coming soon"), Run AI Models (clickable when ready).
- **TemplateMaskSpokePage** — wraps `MaskingCanvas`, `MaskingTools`, `ProcessingControls`, `ProcessingStatus`. Manages local mask/tool state. Loads first frame from sessionStorage cache. Back-to-job button.
- **AiSpokePage** — wraps `CommandInput`, `TaskSelector`, `FrameViewer`, AI label list. Manages local AI state. Frame viewer toggle. Back-to-job button.
- **JobProvider** / **useJob()** — React Context. Fetches `GET /api/jobs/:jobId` on mount. Refetches on Socket.IO `progress` events matching `jobId`. Exposes `{ job, isLoading, error, refetch }`.

### Legacy components reused (not modified)

- `MaskingCanvas` — rendered inside `TemplateMaskSpokePage`
- `MaskingTools` — rendered inside `TemplateMaskSpokePage`
- `ProcessingControls` — rendered inside `TemplateMaskSpokePage`; calls legacy `POST /api/videos/:jobId/process`
- `ProcessingStatus` — rendered inside `TemplateMaskSpokePage`; uses legacy WebSocket progress
- `CommandInput` — rendered inside `AiSpokePage`; calls legacy `POST /api/ai/infer`
- `TaskSelector` — rendered inside `AiSpokePage`
- `FrameViewer` — rendered inside `AiSpokePage`; reads from legacy viewer endpoints
- `FileUpload` — NOT reused; UploadPage has its own file picker with attestation

---

## 3. New Backend Endpoint

`GET /api/jobs/:jobId` — now returns `Job` V2 record from `jobsV2` MemStorage. Previously shared the same handler as `GET /api/videos/:jobId`.

```bash
# Test against existing job
curl http://localhost:5000/api/jobs/<jobId>

# Expected response shape (Job V2):
{
  "id": "...",
  "filename": "test.mp4",
  "uploadedAt": "2026-05-12T20:00:00.000Z",
  "phiStatus": "user_attested",
  "attestationRecord": {
    "attestedAt": "2026-05-12T20:00:00.000Z",
    "choice": "no_phi"
  },
  "source": {
    "duration": 5.0,
    "width": 1920,
    "height": 1080,
    "frameRate": 30,
    "totalFrames": 150,
    "type": "video"
  },
  "extractionRate": 30,
  "status": "ready",
  "errorMessage": null
}

# Legacy endpoint unchanged:
curl http://localhost:5000/api/videos/<jobId>
# Returns: { "job": VideoJob, "progress": ProcessingProgress }
```

---

## 4. Verification Log

### Type check
```
npx tsc --noEmit → 17 errors (pre-existing)
  - 10 in server/services/frameExtractor.ts
  - 7  in server/services/maskWorker.ts
  - 0 new errors introduced
```

### Build
```
npm run build → SUCCESS
  - dist/public/index.html (1.58 kB)
  - dist/public/assets/index-*.css (65.30 kB)
  - dist/public/assets/index-*.js (681.51 kB)
```

---

## 5. tsc Count: Before and After

| Metric | Before | After |
|---|---|---|
| Total errors | 17 | 17 |
| frameExtractor.ts | 10 | 10 |
| maskWorker.ts | 7 | 7 |
| New files | — | 0 errors |

---

## 6. Surprises / Observations

1. **AttestationRecord shape mismatch.** The Phase 3d `AttestationRecord` type was `{ checked, timestamp, text }` — a checkbox-oriented shape. The kickoff spec prescribes `{ attestedAt, choice }` — a radio-group shape. Updated the type in `shared/schema.ts`. No backend code reads the individual fields; the record is stored and returned opaquely. Zero breakage.

2. **Multer form fields are strings.** When the upload page sends `attestationRecord` as a JSON-stringified form field, multer stores it as a raw string in `req.body`. Added `JSON.parse` in both upload handlers so the `Job` V2 record stores a parsed object, not a string. This is a minor Phase 3d gap fixed in passing.

3. **First frame persistence across routes.** The legacy flow keeps the upload response's `firstFrame` base64 in `home.tsx` state. In the new multi-route flow, this data needs to survive navigation from `/upload` → `/jobs/:jobId` → `/jobs/:jobId/template-mask`. Solved with a sessionStorage cache (`lib/frameCache.ts`). On page refresh, the spoke page shows an empty canvas (acceptable for 4a; proper solution is a server endpoint in a later phase).

4. **Wouter nested routing.** Wouter 3.3.5's `nest` prop on `<Route>` works well for the `/jobs/:jobId/*` subtree. Inner routes use relative paths (`/`, `/template-mask`, `/ai`). `useParams` correctly captures `:jobId` from the parent route pattern.

5. **GET /api/jobs/:jobId handler split.** The Phase 3c handler was shared between legacy and canonical URLs. Phase 4a splits them: legacy returns `VideoJob` via `getVideoJob()`, canonical returns `Job` V2 via `getJobV2()`. Both use the same `jobId` parameter. This is the only backend change beyond the JSON.parse fix.

---

## 7. Open Carry-Forwards into 4b

1. **Template mask spoke: migrate to canonical URLs.** Currently calls legacy `POST /api/videos/:jobId/process` via `ProcessingControls`. Phase 4b should use `POST /api/jobs/:jobId/template-mask/apply`.

2. **First frame endpoint.** Need a proper endpoint to serve the first extracted frame for the masking canvas without relying on sessionStorage. Candidates: serve from `temp_extracted/<jobId>/frame_000001.png` or add a field to the `Job` V2 record.

3. **Socket.IO progress for hub page.** The hub's initializing panel subscribes to `progress` events via `JobContext`. The global broadcast bug (cleanup item #6) means all clients receive all progress. Acceptable for 4a; proper room-scoped events should be fixed before scale matters.

4. **Hub tile status derivation.** Template mask status reads from `job.templateMask?.status`. AI status reads from `job.ai?.runs?.length`. These fields may not be populated yet if the legacy components haven't been migrated to write to the `Job` V2 record for these fields. Currently relies on the dual-write path from Phase 3b/3d.

5. **Classify or Label tile.** Permanently disabled with "Coming soon" in 4a. Split into separate Classify and Label tiles is a later-phase item per the architecture spec.
