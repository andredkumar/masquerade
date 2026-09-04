# Item 28 — Proposal (recon + diff plan), image-batch frames at the canvas

Date: 2026-09-04
Source of truth: `docs/refactor/ITEM28_IMAGE_BATCH_FRAMES_PLAN.md` (§2 recommended fix).
Status: **awaiting approval — nothing written yet.**

---

## 1. Recon — what I verified in the tree (the plan's diagnosis holds)

Every claim below was re-read in this working copy, not inferred from the plan.

| Plan claim | Verified at | Result |
|---|---|---|
| `imageUploadHandler` creates the job at `status:'ready'` with no extraction | `server/routes.ts:360-461` | ✅ multer `dest:'uploads/'`; `fileList[]` built in upload order; `createJobV2` with `source.type:'image_batch'`, `status:'ready'` |
| Raw branch reads only `temp_extracted/` | `server/routes.ts:1626` → `listRawFrameFiles` → `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` (`frameAccess.ts:150-154`) | ✅ no image-batch branch anywhere in the endpoint |
| Trailing 410 catches image jobs | `server/routes.ts:1655-1661` | ✅ `!rawFiles.length` → 410 "The server may have restarted." |
| Apply already handles images | `server/handlers/templateMaskApply.ts:82-90` | ✅ `job.jobType === 'images'` → `uploads/${file.filename}` in `fileList` order |
| `processImages` masks in `fileList` order | `server/services/videoProcessor.ts:827-846` | ✅ `frameNumber = volumeStart + index` over `imageFiles` as passed → output frame *i* ⟺ `fileList[i]`. **Co-indexing is a property of the input array order, so serving by `fileList[n]` is exactly correct.** |
| `uploads/` 2 h retention | `server/services/cleanup.ts:43,66` (`UPLOADS_DIR`, `UPLOADS_MAX_AGE_MS`) + boot purge at `cleanup.ts:284-306` | ✅ unchanged by this fix |
| `resolveWithinRoot` is the house guard | `server/services/cleanup.ts:117-142` | ✅ rejects empty / non-string / null-byte / `.` / `..` / separator segments |

### Two things the plan did not mention, both of which change the diff

**A. `fileList` lives on the legacy `VideoJob`, not on `Job` V2.**
`JobSource` (`shared/schema.ts:271-279`) carries only `duration/width/height/frameRate/totalFrames/type`.
`fileList` is a `VideoJob` field (`schema.ts:130`) / `jobs.file_list` column (`schema.ts:65`).
The frames endpoint currently loads **only** `jobV2` (`routes.ts:1596`).
→ The image branch needs a second read, `storage.getVideoJob(jobId)`, purely for `fileList`.
This does **not** violate the plan's "do not re-read the legacy `jobType`": *detection* stays
`jobV2.source.type === 'image_batch'`; `jobType` is never consulted. Read-only, A3 untouched.

**B. `fileList[n].type` is attacker-controlled and must not be reflected verbatim.**
`imageUpload.fileFilter` (`routes.ts:83-96`) accepts a file when the mimetype is allowed **OR** the
filename matches `/\.(png|jpg|jpeg)$/i`. So `image.png` uploaded with `Content-Type: text/html`
passes the filter and is stored with `type: 'text/html'` in `fileList`. Echoing that into the
response header would serve attacker bytes as HTML **from the app's own origin** — stored XSS, in a
PHI application. The plan's "Content-Type from `fileList[n].type`" is right in spirit, wrong to take
literally. Proposed: allowlist `image/png | image/jpeg | image/jpg`, otherwise fall back to the
extension of `originalName` via the existing `mimeForFrameFile`, otherwise `image/png`.
This is the only deliberate deviation from §2, and it is strictly narrowing.

### One scope boundary the kickoff's "server-only" creates

The user-visible "The server may have restarted. Please re-upload your file." is **hardcoded in the
client**, at `client/src/pages/template-mask-spoke.tsx:208` — it is not read from the 410 body. The
spoke maps any 410 → `frameStatus:"gone"` → that panel (`template-mask-spoke.tsx:80-81`).

So a server-only copy split fixes the *API* and the logs but the *screen* still says "the server may
have restarted" for a >2 h image job. That case is genuinely swept, so the sentence is not false in
the way it was today — but it is still the wrong remedy to show ("re-upload" is in fact correct
here, so it survives). **Recommendation: keep it server-only as instructed** and hand the client
copy to a follow-up; see §5 for the 6-line client change if the reviewer would rather close it now.

---

## 2. The diff — three files, ~70 lines net

### 2a. `server/services/frameAccess.ts` — new pure helper (+~55 lines)

Route stays thin; the index/validation logic goes where it is unit-testable without Express.

```ts
/** One entry of VideoJob.fileList, narrowed from `unknown`. */
export interface ImageBatchEntry { filename: string; originalName?: string; type?: string; }

export type ImageFrameResolution =
  | { ok: true; absPath: string; contentType: string }
  | { ok: false; kind: 'out_of_range' }      // → 404
  | { ok: false; kind: 'missing_file' };     // → 410 (genuinely swept)

/**
 * Resolve image-batch frame `n` to a file in uploads/.
 *
 * Item 28. Image batches never populate temp_extracted/ — multer writes
 * uploads/<hash> and the job goes straight to `ready` — so the raw branch of
 * the frames endpoint has nothing to read. Serve the original bytes instead.
 *
 * Indexed STRICTLY by fileList order, never by a directory listing: uploads/
 * interleaves every job's files, and processImages masks in fileList order
 * (videoProcessor.ts:827-846), so fileList[i] is by construction the source of
 * masked output i. A sorted listing would silently mis-pair the two.
 *
 * No re-encode: the canvas needs pixels, and a Sharp round-trip on a
 * 1-physical-core box is exactly the cost this path does not need.
 */
export async function resolveImageBatchFrame(
  fileList: unknown, frameIndex: number,
): Promise<ImageFrameResolution>
```

Behavior:
- Coerce `fileList` to `ImageBatchEntry[]`; non-array or entry without a string `filename` →
  `out_of_range` (nothing addressable).
- `frameIndex >= list.length` → `out_of_range`.
- `resolveWithinRoot(UPLOADS_DIR, entry.filename)` — throws on a crafted segment, caught → treated
  as `out_of_range` (never leaks the boundary error to the client).
- `frameExists(absPath)` false → `missing_file` (the 2 h sweep; "swept" is *true* here).
- Content-Type per §1B.

Imports `UPLOADS_DIR` + `resolveWithinRoot` from `./cleanup` — `frameAccess.ts` already imports
`SPOKE_TEMPLATE_MASK_DIR, TEMP_EXTRACTED_DIR` from there, so no new module edge. Still read-only:
the file's "nothing here writes to disk" contract holds.

### 2b. `server/routes.ts` — image branch + copy split (+~30 lines)

Inserted at line 1626, **after** the `source === 'template_mask'` branch (so an applied image job can
still show its masked frame) and **before** `listRawFrameFiles`:

```ts
      // ── Image-batch source (originals in uploads/) — item 28 ──────
      // Image batches have no extraction step, so temp_extracted/<jobId>/
      // never exists and the raw branch below would fall through to its
      // trailing 410 for every image job — which is how the entire image
      // feature became unreachable (the canvas could not paint, so Apply
      // could never enable). Detection is the V2 source type; the legacy
      // jobType is deliberately not consulted.
      if (jobV2.source.type === 'image_batch') {
        const legacy = await storage.getVideoJob(jobId);   // fileList lives on VideoJob only
        const resolved = await resolveImageBatchFrame(legacy?.fileList, frameNumber);
        if (!resolved.ok) {
          return resolved.kind === 'out_of_range'
            ? res.status(404).json({ error: "Frame not found" })
            : res.status(410).json({
                reason: 'uploads_swept',
                error: "The uploaded images are no longer on the server. Uploads are kept for 2 hours; please re-upload.",
              });
        }
        res.set("Content-Type", resolved.contentType);
        res.set("Cache-Control", "private, max-age=3600");
        return res.send(await fsPromises.readFile(resolved.absPath));
      }
```

And the copy split at 1655-1661 — the raw 410 stops being a catch-all:

```ts
      if (!rawFiles.length) {
        // Reached only by video/DICOM jobs now (item 28 moved image batches to
        // their own branch above). For those, an absent temp_extracted/<jobId>/
        // on a non-extracting job really is a sweep or a restart.
        return res.status(410).json({
          reason: 'frames_swept',
          error: "Frames are no longer available. Extracted frames are kept for 6 hours, and are lost if the server restarts mid-extraction.",
        });
      }
```

`reason` is additive; no existing consumer reads the 410 body (`template-mask-spoke.tsx:80` branches
on status alone), so this is backward-compatible and gives the client something to branch on later.

### 2c. `server/services/__tests__/imageBatchFrames.test.ts` — new (+~90 lines)

`node:test` + `tsx`, filesystem only, matching `frameAccess.test.ts`'s house style
(no ffmpeg / Sharp / DB — this box has none; see the local-toolchain memo).

1. **Co-indexing** — three 1×1 PNGs with distinguishable bytes written to a sandbox `uploads/`,
   `fileList` in a *different* order than the sorted filenames; assert `resolveImageBatchFrame(fl,i)`
   returns `fileList[i]`'s bytes for every `i`. This is the trap-1 guard, and it fails against a
   sorted-listing implementation.
2. `frameIndex === length` and `length+1` → `out_of_range`.
3. Entry present, file deleted → `missing_file` (not `out_of_range`) → the 410 path.
4. `filename: '../../etc/passwd'` → `out_of_range`, no throw, no read outside the root.
5. `type: 'text/html'` on a `.png` → contentType `image/png`, never `text/html` (§1B).
6. `fileList: null` / `undefined` / `[]` → `out_of_range`, no crash.

---

## 3. What this does **not** do

- **No §3.** Nothing is written to `temp_extracted/` at upload; no Sharp encode at upload time; no
  second copy of PHI on disk. The deferred alternative stays available.
- **No retention change.** `UPLOADS_MAX_AGE_MS` is untouched. An image job older than 2 h still fails
  — but now the canvas fails *the same way Apply already fails*, with honest copy, instead of
  failing instantly at minute zero. Pre-existing behavior, stated not smuggled.
- **A3 frozen.** `shared/schema.ts`, `storage.ts`, `pgStorage.ts`, `migrations/` untouched. The only
  storage call added is the read-only `storage.getVideoJob`.
- **No client change** (default; see §5).
- **No `firstFrame` revival** (backlog item 25 stays open — but this fix is what makes retiring that
  field safe, since the canvas will finally have a working source).

## 4. Verification I will run and report

`npx tsc --noEmit` — **baseline confirmed at exactly 12 errors** in this tree
(`frameExtractor.ts` ×5, `maskWorker.ts` ×7); must stay 12.
`npx tsx server/services/__tests__/imageBatchFrames.test.ts` + the two existing suites
(`frameAccess`, `applyPaths`) green.

Plan §4 rows 1-3, 5 need a running server with real uploads (ffmpeg-free, so image batches are
actually the *one* thing testable on this box — I can run `npm run dev` and curl a real batch).
Row 4 (co-indexing) is covered mechanically by test 1 above **and** by curl against a live batch of
visually distinct images. Row 6 (MP4/DICOM regression) is code-inspection only here — the raw branch
is untouched for `source.type === 'video'`, and I will say exactly that rather than claim I ran it.
Row 7 is test 3 plus a live check with the file removed from `uploads/`.

## 5. One decision for the reviewer

The plan's "also fix the copy" is only half-closable server-side (§1, scope boundary). Options:

- **(a) Server-only, as the kickoff says** — *my recommendation*. API and logs become honest;
  `reason` lands in the body for a later client change; the screen keeps today's wording.
- **(b) Server + 6-line client change** — `template-mask-spoke.tsx` reads `reason` from the 410 body
  and renders "uploads are kept for 2 hours" vs "frames are kept for 6 hours". Closes the item
  properly at the cost of touching the client, which the kickoff excluded.

Default is (a) unless the reviewer says otherwise.

Second, smaller: §1B (not reflecting `fileList[n].type`) is a deliberate deviation from the letter of
§2. I consider it non-negotiable on security grounds and will implement it either way, but it is
flagged here rather than buried in the diff.
