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
| `temp_processed/<jobId>/` | Masked output frames consumed by the ZIP/download builder. | **24 hours** |

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
  - **Post-download hook**: `GET /api/videos/:jobId/download` registers
    `res.on('finish', () => cleanupJobArtifacts(jobId))` so once the user
    has fully received their ZIP, both `temp_extracted/<jobId>/` and
    `temp_processed/<jobId>/` are reclaimed. We use `'finish'` (not
    `'close'`) so aborted downloads do *not* drop the user's data — they
    can re-request the ZIP, and the hourly sweep handles abandoned ones.
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
