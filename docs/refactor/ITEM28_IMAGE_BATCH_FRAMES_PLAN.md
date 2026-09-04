# Item 28 — image-batch jobs 410 at the canvas (the whole image feature is unreachable)

Found 2026-09-04 while debugging "PNG doesn't upload". **Not PNG-specific and not an upload failure.**
Reproduced in production on job `e5ed44ed-afd6-4539-9aab-9ba0f7c709cf` (7 images, 632×1080).

---

## 1. Diagnosis (confirmed on prod, not inferred)

Image-batch uploads never populate `temp_extracted/`. There is no extraction step for them: multer
writes the files to `uploads/<hash>` and `imageUploadHandler` (`routes.ts:361`) creates the job at
`status: 'ready'` directly, recording the hash names in `fileList[]`.

The template-mask spoke then paints its canvas by fetching `GET /api/jobs/:id/frames/0` with **no
`source` param** (`template-mask-spoke.tsx:63`). That lands in the **raw** branch of the frames
endpoint, which reads only `temp_extracted/<jobId>/` (`listRawFrameFiles`, `frameAccess.ts:160`).
There is no image-batch branch. The directory does not exist and the status is not `extracting`, so
control falls to the trailing guard (`routes.ts:1655`):

```ts
return res.status(410).json({
  error: "Frames are no longer available. The server may have restarted.",
});
```

The spoke maps 410 → `frameStatus = "gone"` → the "Frames are no longer available / The server may
have restarted" panel. **The message is inherited from the video path and is false here** — nothing
restarted and nothing was swept.

### Production evidence

```
$ ls temp_extracted/e5ed44ed-.../            → No such file or directory
$ ls spokes/template_mask/e5ed44ed-.../      → No such file or directory
$ ls -lat uploads/ | head                    → 7 files, ~226 KB each, 22:07  (the images, intact)
$ curl -si localhost:5000/api/jobs/e5ed44ed-.../frames/0 | head -1
HTTP/1.1 410 Gone
$ curl -s localhost:5000/api/jobs/e5ed44ed-...
{"filename":"7_images_batch","source":{"width":632,"height":1080,"totalFrames":7,
 "type":"image_batch"},"status":"ready", …}
```

### Blast radius

The canvas cannot paint, so the user can never draw a mask, so **Apply is unreachable through the
UI for every image batch** — `.jpg` and `.png` alike. Apply itself is fine
(`templateMaskApply.ts:82` handles `jobType === 'images'` and reads `uploads/${filename}`); it is
sitting behind a door that will not open. The AI spoke shows the same copy for these jobs because
its `tempDirExists` check looks at `spokes/template_mask/<jobId>`, which only exists after an Apply.

### Age

Phase 4b (`c66ca4e`), when the spoke stopped painting from the upload response's base64 `firstFrame`
and switched to the frames endpoint. Video jobs kept working because extraction fills
`temp_extracted/`; image jobs never did. This is also *why* backlog item 25 records `firstFrame` as
"dead since Phase 4b" — its consumer moved to an endpoint that does not serve image jobs. The gap
survived because testing has been video and DICOM throughout.

---

## 2. Fix — recommended: serve image-batch frames from `uploads/` (server-only)

Add an image-batch branch to the raw path of `GET /api/jobs/:jobId/frames/:n`, before the
`listRawFrameFiles` call:

- Detect with `jobV2.source.type === 'image_batch'` (the V2 record is already loaded at
  `routes.ts:1595`). Do **not** re-read the legacy `jobType`.
- Resolve frame *n* as `uploads/<fileList[n].filename>` — the `VideoJob` record carries `fileList`.
- `404` when `n >= fileList.length`; `410` when the file is missing from disk (that case **is**
  genuinely "swept", and there the existing message is true).
- Serve the original bytes with `Content-Type` from `fileList[n].type`. No re-encode: the canvas
  only needs pixels, and a Sharp round-trip on a 1-physical-core box is exactly the cost this path
  does not need.
- Route the path through `resolveWithinRoot(UPLOADS_DIR, …)` — same guard every other jobId/filename
  boundary uses (`cleanup.ts`, 5B-1a). The filenames are multer hashes, but the guard is the house
  rule.

### Two traps that will bite a careless implementation

1. **Index by `fileList` order, never by a sorted directory listing.** `uploads/` holds every job's
   files interleaved, and `processImages` masks in `fileList` order (`videoProcessor.ts:831`), so
   masked frame *i* corresponds to `fileList[i]`. Sorting hashes would silently mis-pair the canvas
   with the output — the same class of bug as the 0-indexed/1-indexed trap in the PERF round.
2. **`uploads/` has a 2-hour retention** (`UPLOADS_MAX_AGE_MS`, `cleanup.ts:54`) and is purged at
   boot — the shortest window in the system, because it holds PHI. An image job older than 2 h will
   410 at the canvas *and* fail at Apply, which reads the same directory. That is pre-existing
   behavior for Apply, and this fix does not change it; it just makes the canvas agree with Apply
   instead of failing immediately. Say so in the report rather than quietly extending retention.

### Also fix the copy

The trailing 410 in the raw branch says "The server may have restarted" for every cause. Split it:
genuinely-swept keeps that text; anything else gets a message that doesn't send the operator
looking at PM2. This is the line that cost an hour of debugging today.

## 3. Deferred alternative — materialize images into `temp_extracted/` at upload

Write each uploaded image to `temp_extracted/<jobId>/frame_%06d.png` in `imageUploadHandler`, so
every downstream path treats image batches as ordinary jobs. Cleaner in principle, and it would let
Apply read from the same place as everything else. Costs: a Sharp encode per image at upload time on
the small box, a second copy of every image on disk, and a change to the 2 h/6 h retention story for
PHI-bearing data. **Not now** — it is a bigger change than the bug requires, and the recommended fix
does not block it later.

## 4. Verification

1. Upload a mixed batch (`.jpg`, `.jpeg`, `.png`) → the spoke canvas paints the first image. This is
   the whole bug.
2. Draw a mask → Apply enables → apply completes.
3. `file spokes/template_mask/<jobId>/*` — this is also the first time item 22's naming fix becomes
   observable in production (see below).
4. Frame *n* co-indexing: with a batch of visually distinct images, confirm the canvas frame at
   index *i* is the same source image as masked output *i*.
5. Single-image batch, and a 7-image batch matching the repro job.
6. Regression: MP4 and DICOM canvases unchanged (`apply.source {mode:"reuse"}` still fires).
7. An image job left >2 h: canvas 410s with the corrected copy, not a false restart claim.

## 5. Sequencing consequence

**This outranks the item 22 deploy.** Item 22 corrects the naming of output from a code path users
cannot currently reach, and §5 of `ITEM22_DEPLOY_RUNBOOK.md` (rows I1–I8, the entire image-batch
test matrix) **cannot be executed until item 28 ships**. Options:

- Ship item 28 first, then deploy item 22 and run its runbook intact. Cleanest.
- Or deploy item 22 now (harmless, video/DICOM regressions still verify) and leave it open until
  item 28 lands. Do not mark item 22 verified on the strength of the video rows alone.

## 6. Proposed `CLAUDE.md` backlog entry

> **28. Image-batch jobs 410 at the template-mask canvas — the image feature is unreachable.**
> The spoke paints from `GET /api/jobs/:id/frames/0` (raw branch), which reads only
> `temp_extracted/<jobId>/`; image batches never populate it (no extraction — multer writes
> `uploads/<hash>`, job goes straight to `ready`), so every image job hits the trailing 410 and
> shows "Frames are no longer available. The server may have restarted." — false on both counts.
> Apply is fine (`templateMaskApply.ts:82`) but unreachable. Broken since Phase 4b (`c66ca4e`)
> when the spoke stopped using the upload response's base64 `firstFrame` (= why item 25 lists that
> field as dead). Confirmed in prod on job `e5ed44ed` 2026-09-04. Fix + traps:
> `docs/refactor/ITEM28_IMAGE_BATCH_FRAMES_PLAN.md`.

## 7. Kickoff prompt

> Read `docs/refactor/ITEM28_IMAGE_BATCH_FRAMES_PLAN.md` first — the diagnosis is confirmed in
> production, do not re-derive it. Implement §2: an image-batch branch in the raw path of
> `GET /api/jobs/:jobId/frames/:n` that serves frame *n* from `uploads/<fileList[n].filename>`,
> detected via `jobV2.source.type === 'image_batch'`, with 404 past the end, 410 for a missing
> file, Content-Type from `fileList[n].type`, no re-encode, and `resolveWithinRoot(UPLOADS_DIR, …)`
> on the path. Index strictly by `fileList` order — never a sorted directory listing — and say in
> your report how you verified canvas frame *i* pairs with masked output *i*. Also split the
> trailing 410's message so "the server may have restarted" is only claimed when a file was
> actually swept. Do not implement §3. Server-only; `tsc --noEmit` stays at 12; A3 frozen
> (`shared/schema.ts`, `storage.ts`, `pgStorage.ts`, `migrations/` untouched). Propose the diff
> before writing it.
