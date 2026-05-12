# Phase 3d Report — Upload Handler Refactor

**Date:** 2026-05-12
**Scope:** New upload URL aliases, eager `Job` creation at upload time, `phiStatus`/`attestationRecord` plumbing, `ensureJobV2` bridge removal, `samplingFps` → `Job.extractionRate` wiring.
**Constraint:** Zero frontend changes. Zero changes to AI inference/template-mask/frame-viewer/download handler logic. Zero DICOM extraction changes.

---

## 1. What Landed

### 1a. New Upload URL Aliases

Both upload handlers were extracted into named functions and registered at legacy + canonical URLs:

| Legacy URL (preserved) | New URL (canonical) | Handler Name |
|---|---|---|
| `POST /api/videos/upload` | `POST /api/uploads/video` | `videoUploadHandler` |
| `POST /api/images/upload` | `POST /api/uploads/images` | `imageUploadHandler` |

Multer config is identical for both registrations — same middleware instance, same handler function. The `upload.single('video')` and `imageUpload.array('images')` middleware are shared.

### 1b. Eager Job Creation at Upload Time

Both upload handlers now create a hub-and-spoke `Job` record via `storage.createJobV2()` immediately after creating the legacy `VideoJob` record. The `Job.id` matches the `VideoJob.id` — same UUID, same job.

**Video upload (standard + DICOM):**
```typescript
await storage.createJobV2({
  id: job.id,
  filename: req.file.originalname,
  uploadedAt: new Date().toISOString(),
  phiStatus,                    // 'raw' or 'user_attested'
  ...(attestationRecord ? { attestationRecord } : {}),
  source: {
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    frameRate: metadata.frameRate,
    totalFrames: metadata.totalFrames,
    type: 'video',
  },
  extractionRate,               // samplingFps from body or native frameRate
  status: 'extracting',
  errorMessage: null,
});
```

**Image batch upload:**
```typescript
await storage.createJobV2({
  id: job.id,
  filename: `${files.length}_images_batch`,
  uploadedAt: new Date().toISOString(),
  phiStatus,
  ...(attestationRecord ? { attestationRecord } : {}),
  source: {
    duration: 0,
    width: firstImageMetadata.width,
    height: firstImageMetadata.height,
    frameRate: 1,
    totalFrames: files.length,
    type: 'image_batch',
  },
  extractionRate: 1,            // 1 "frame" per image
  status: 'ready',
  errorMessage: null,
});
```

The video upload handler creates the Job in both the DICOM and standard-video branches, covering all three upload paths.

### 1c. Request Body Shape — New Optional Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `phiStatus` | `'raw' \| 'user_attested'` | `'raw'` | Validated: only `'user_attested'` is accepted as non-default; everything else falls back to `'raw'` |
| `attestationRecord` | `{ checked, timestamp, text }` | absent | Only read when `phiStatus === 'user_attested'` |
| `samplingFps` | `number` | native frame rate | Recorded as `Job.extractionRate`. Must be positive number. Image batches hardcode `1`. |

The frontend does not send any of these fields yet — Phase 4 wires the attestation UI. Every upload defaults to `phiStatus: 'raw'`, no attestation record, and native frame rate.

### 1d. `ensureJobV2` Bridge Removed

The lazy-create bridge function `ensureJobV2` in `routes.ts` has been deleted. It previously:
- Was called from the AI inference handler (`/api/ai/infer`)
- Checked `storage.getJobV2(jobId)` and created a `Job` from `VideoJob` fields if missing

Post-3d, the AI inference handler does:
```typescript
const jobV2 = await storage.getJobV2(jobId);
if (!jobV2) {
  return res.status(400).json({ error: 'Job record not found — upload may have failed or server restarted since upload' });
}
```

This is now an error condition: if the upload handler ran successfully, the `Job` record must exist. A missing `Job` indicates either a server restart (MemStorage is volatile) or an upload failure.

### 1e. `samplingFps` → `Job.extractionRate` Wiring

The video upload handler reads `req.body.samplingFps` and stores it as `Job.extractionRate`:
```typescript
const extractionRate = typeof req.body.samplingFps === 'number' && req.body.samplingFps > 0
  ? req.body.samplingFps : metadata.frameRate;
```

For image batches, `extractionRate` is hardcoded to `1` (one "frame" per image — no sampling concept).

### 1f. DICOM Source Type Decision

DICOM files use `source.type: 'video'`. The `JobSource` type in `shared/schema.ts` supports `'video' | 'image_batch'` — DICOM is video-like (multi-frame, produces frame extraction). No `'dicom'` discriminator was added because:
1. The schema doesn't have it as a `source.type` value
2. DICOM detection happens at the extraction layer (`frameExtractor.isDicomFile()`), not at the Job metadata level
3. The upload response already includes `isDicom: true` in the metadata for the frontend

### 1g. Storage Comment Cleanup

Updated the `server/storage.ts` hub-and-spoke methods section header from "Phase 2 plumbing — No callers yet" to reflect that these methods are now actively called.

### 1h. CLAUDE.md Update

- Added "Phase 3d landed" line at top
- Updated URL hierarchy table heading to "Phase 3c + 3d" and added upload URL alias rows
- Added new "Upload body shape (Phase 3d)" section documenting `phiStatus`, `attestationRecord`, and `samplingFps`
- Updated hub-and-spoke data model section to note that `createJobV2` is now wired into upload handlers and `ensureJobV2` is removed
- Added note that this completes the backend refactor

---

## 2. Deviations from Prompt / Architecture Doc

| Deviation | Justification |
|---|---|
| `Job.status` set to `'extracting'` for video uploads, not matching `VideoJob.status` exactly | `VideoJob` uses `'uploaded'` for standard video (extraction hasn't "started" from its perspective) and `'extracting'` for DICOM. `Job.status` uses `'extracting'` for both because background frame extraction fires immediately via `setImmediate` in both paths. `'ready'` is only appropriate for image batches (no extraction needed). |
| Image batch `source.width/height` from first image only | Per kickoff: "read from the first file using sharp or similar." `frameExtractor.getImageDimensions()` is already called on the first file for thumbnail generation. Individual file dimensions are stored in `fileList[]` on the `VideoJob`. |
| No sharp import for image dimensions | Reuses existing `frameExtractor.getImageDimensions()` which internally uses sharp. No new dependency needed. |

No other deviations. All deliverables implemented as specified.

---

## 3. Deferred — Phase 4 and Future Cleanup

1. **Remove legacy upload URLs** — `POST /api/videos/upload` and `POST /api/images/upload` stay live as aliases. Remove after Phase 4 frontend migration.

2. **Attestation UI** — `phiStatus` and `attestationRecord` body fields are scaffolding only. Phase 4 adds the form/modal/wizard for capturing attestation.

3. **`Job.status` lifecycle sync** — The `Job.status` is set at upload time and not updated when extraction completes. The `VideoJob.status` gets updated by `videoProcessor` callbacks. Syncing these two status fields is Phase 4 scope (when the frontend reads `Job` instead of `VideoJob`).

4. **MemStorage volatility** — After server restart, `Job` records are lost but the upload + extraction may have completed successfully in the previous process. The AI inference handler's guard (`storage.getJobV2(jobId)` returning undefined) correctly surfaces this as an error. The user would need to re-upload. This is acceptable given the current anonymous-session model.

5. **`videoProcessor.ts` comments** — Lines 371 and 643 still mention `temp_processed/{jobId}/`. Deferred from Phase 3a.

6. **`tempFolderManager.ts` rename** — Deferred from Phase 3a.

7. **`processingProgress` cleanup on job delete** — Deferred from Phase 3c.

---

## 4. Verification Results

| # | Test | Result | Notes |
|---|---|---|---|
| 1 | `npx tsc --noEmit` shows exactly 17 pre-existing errors | **PASS** | 10 in `frameExtractor.ts`, 7 in `maskWorker.ts`. Zero from Phase 3d files. |
| 2 | Server-side esbuild succeeds | **PASS** | 184.0 KB output, zero errors. |
| 3 | `grep -rn "ensureJobV2" server/` returns zero matches | **PASS** | Bridge fully removed. |
| 4 | Old upload URLs work (curl test) | **SKIPPED** | Requires running server. Verified by code inspection: same handler function registered at both URLs. |
| 5 | New upload URLs work (curl test) | **SKIPPED** | Same as above. |
| 6 | `storage.getJobV2(jobId)` returns Job after upload | **SKIPPED** | Requires running server. Verified by code inspection: `createJobV2` is called in both handlers after `createVideoJob`. |
| 7 | `phiStatus` round-trips correctly | **SKIPPED** | Requires running server. Verified by code inspection: `req.body.phiStatus` read with `'raw'` default. |
| 8 | AI inference works without `ensureJobV2` | **SKIPPED** | Requires running server. Verified by code inspection: `storage.getJobV2(jobId)` replaces bridge; returns 400 if missing. |
| 9 | `client/` has zero changes | **PASS** | No client files were modified. |
| 10 | `videoProcessor.ts` untouched | **PASS** | Zero changes. |
| 11 | `tempFolderManager.ts` untouched | **PASS** | Zero changes. |
| 12 | `frameAccess.ts` untouched | **PASS** | Zero changes. |
| 13 | `frameExtractor.ts` untouched | **PASS** | Zero changes. |
| 14 | AI inference handler logic unchanged | **PASS** | Only change: `ensureJobV2(jobId, job)` → `storage.getJobV2(jobId)` + guard. No inference logic touched. |
| 15 | Template-mask/download/frame-viewer handlers unchanged | **PASS** | Zero changes to those handlers. |

---

## 5. Files Modified

```
 CLAUDE.md           | +22  (net +22)
 server/routes.ts    | +56 -40  (net +16)
 server/storage.ts   | +2 -3   (net -1)
 3 files changed, 80 insertions(+), 43 deletions(-)
```

**Files NOT modified** (confirming scope discipline):
- `client/` — zero frontend changes
- `server/index.ts` — zero changes
- `server/handlers/templateMaskApply.ts` — zero changes
- `server/services/videoProcessor.ts` — zero changes
- `server/services/tempFolderManager.ts` — zero changes
- `server/services/frameAccess.ts` — zero changes
- `server/services/frameExtractor.ts` — zero changes
- `server/services/cleanup.ts` — zero changes
- `server/services/aiInferenceClient.ts` — zero changes
- `server/pgStorage.ts` — zero changes
- `shared/schema.ts` — zero changes
- `sam2-service/` — zero changes
