# Item 28 — Report: image-batch jobs now paint the template-mask canvas

Date: 2026-09-04
Plan: `docs/refactor/ITEM28_IMAGE_BATCH_FRAMES_PLAN.md` §2 (recommended fix).
Proposal: `docs/refactor/ITEM28_PROPOSAL.md` — approved with three amendments, all applied.
Status: **implemented and verified.** `tsc --noEmit` = **12** (unchanged baseline). A3 frozen.

---

## 1. What shipped

Four files. §3 (materializing images into `temp_extracted/`) was **not** implemented.

| File | Change | Net |
|---|---|---|
| `server/services/frameAccess.ts` | new `resolveImageBatchFrame()` + `ImageBatchEntry` / `ImageFrameResolution` types + `contentTypeForEntry()` | +96 |
| `server/routes.ts` | image-batch branch in `GET /api/jobs/:jobId/frames/:n`; trailing-410 copy split | +47 |
| `client/src/pages/template-mask-spoke.tsx` | `goneReason` read from the 410 body; panel copy per cause | +33 |
| `server/services/__tests__/imageBatchFrames.test.ts` | new, 6 tests | +136 |

### 1a. `resolveImageBatchFrame` (`frameAccess.ts:172-267`)

Pure resolver, no Express, no writes — the file's read-only contract holds. Returns a discriminated
result the route maps to statuses:

- `{ok:true, absPath, contentType}` → 200, original bytes, no re-encode
- `{ok:false, kind:'out_of_range'}` → 404 — index past the end, or an unusable `fileList` entry
- `{ok:false, kind:'missing_file'}` → 410 — entry exists, bytes are gone (the 2 h `uploads/` sweep)

Indexed strictly by `fileList` order. Path built through `resolveWithinRoot(UPLOADS_DIR, filename)`;
a refusal is caught and downgraded to `out_of_range` so the boundary error never reaches the client.

### 1b. Route branch (`routes.ts:1626-1663`)

Placed **after** the `?source=template_mask` branch — so an applied image job still shows its masked
frame — and **before** `listRawFrameFiles`, which has nothing to offer these jobs. Detection is
`jobV2.source.type === 'image_batch'`; the legacy `jobType` is never consulted.

### 1c. Copy split (`routes.ts:1697-1710` + spoke)

Both 410s now carry a `reason` (`uploads_swept` | `frames_swept`) alongside honest prose. The raw
branch's 410 stopped being a catch-all: it is now reached only by video/DICOM jobs, for which "swept
or restarted" is actually true.

---

## 2. The three amendments from the review

**(1) Option (b) taken — the client change is in.** `template-mask-spoke.tsx` reads `reason` from the
410 body and renders per cause. The hardcoded sentence at the old `:207` is gone as a *default*; it
survives only as the fallback when `reason` is absent (older server, or an unexpected 410), which is
the one case where we genuinely do not know. `uploads_swept` now reads "Uploads are kept for 2
hours"; `frames_swept` names the 6 h window and the mid-extraction restart. The `res.json()` parse is
in a `try` — a parse failure falls back to generic copy and never changes the state machine, matching
the existing 503 `framesReady` handling two branches up.

**(2) Mimetype allowlist kept.** `image/png | image/jpeg | image/jpg` only, with `image/jpg`
normalized to `image/jpeg`; anything else falls back to the extension of `originalName` via the
existing `mimeForFrameFile`. Verified live: a `.png` file declared `text/html` serves as `image/png`,
and `image/svg+xml` on a `.jpg` serves as `image/jpeg`.

**(3) `fileList` survives the round trip through Postgres — confirmed, not assumed.**
`PgStorage.rowToVideoJob` maps `fileList: row.fileList ?? null` at **`server/pgStorage.ts:481`**, from
the `jobs.file_list` `jsonb` column (`shared/schema.ts:65`), and derives `fileCount` from its length
one line above. So the `storage.getVideoJob(jobId)` read the branch adds returns a populated
`fileList` against production Postgres, not only against the retained `MemStorage`. This mattered
enough to check because the whole fix is indexed off that array — had `rowToVideoJob` dropped it, the
branch would have 404'd every frame in prod while passing every test on this box.

---

## 3. Verification

### 3a. Static

`npx tsc --noEmit` → **12 errors**, byte-identical to the pre-change baseline
(`frameExtractor.ts` ×5 `TS18048`, `maskWorker.ts` ×7). No new error, none removed.

### 3b. Unit — `npx tsx server/services/__tests__/imageBatchFrames.test.ts` → 6/6 pass

The load-bearing one is **co-indexing**: three files whose names sort `aaa < mmm < zzz` are listed in
`fileList` as `zzz, aaa, mmm`, each carrying a distinguishing trailing byte. An implementation that
read a sorted directory listing returns `aaa` for index 0 and fails. The other five cover past-the-end
→ `out_of_range`, swept-file → `missing_file` (the 404/410 distinction), traversal filenames refused
without throwing, the mimetype allowlist, and malformed `fileList` (`null`/`{}`/`[null]`/`[{filename:7}]`).

Existing suites re-run green and unchanged: `frameAccess` 8/8, `applyPaths` 8/8,
`saveProcessedImage` 11/11.

### 3c. Live HTTP — the real route, real files

This box has no Postgres, and since the Phase 5C-2 cutover `server/storage.ts:297` constructs
`PgStorage` at import, so `npm run dev` cannot boot here (`DATABASE_URL is not set`). **My proposal
§4 was wrong to imply the server would come up for image testing** — it would not.

So the harness (`scratchpad/live-frames.mts`, temporary, not added to the repo) boots the **real**
`registerRoutes(app)` on a real Express server and overrides only `getJobV2` / `getVideoJob` on the
exported `storage` singleton. Everything the branch touches — the route handler, `resolveImageBatchFrame`,
`resolveWithinRoot`, the real `uploads/` directory, real bytes over real HTTP — is production code.

Batch: **7 uniform 632×1080 images** (matching the prod repro job `e5ed44ed`), solid distinct colors,
mixed `.png`/`.jpg`, with `fileList` deliberately **reversed** relative to sorted hash order.

```
frame 0: 200 image/png    4287B  bytes==img_6_grey.png    → true
frame 1: 200 image/jpeg   4350B  bytes==img_5_cyan.jpg    → true
frame 2: 200 image/png    4691B  bytes==img_4_magenta.png → true
frame 3: 200 image/jpeg   4350B  bytes==img_3_yellow.jpg  → true
frame 4: 200 image/png    5368B  bytes==img_2_blue.png    → true
frame 5: 200 image/jpeg   4348B  bytes==img_1_green.jpg   → true
frame 6: 200 image/png    5231B  bytes==img_0_red.png     → true
past the end (7):         404 {"error":"Frame not found"}
swept (uploads purge):    410 {"reason":"uploads_swept","error":"The uploaded images are no longer on the server. Uploads are kept for 2 hours; please re-upload."}
video, no temp_extracted: 410 {"reason":"frames_swept","error":"Frames are no longer available. Extracted frames are kept for 6 hours, …"}
```

Single-image batch, `.jpeg` extension: `frame 0: 200 image/jpeg`, `frames/1` → 404. (Plan §4 row 5.)

**Uniform dimensions were used deliberately**, per the review — see §4.

### 3d. How I verified canvas frame *i* pairs with masked output *i* (plan §4 row 4)

Three independent lines, because this is the trap the plan flagged:

1. **By construction, read in the source.** `processImages` is handed `imagePaths =
   fileList.map(f => 'uploads/'+f.filename)` (`templateMaskApply.ts:85`) and numbers its output
   `frameNumber = volumeStart + index` over that same array (`videoProcessor.ts:827-846`). So masked
   output *i* is `fileList[i]` *by definition of the array it was given*. Serving `fileList[n]` makes
   the canvas read from the identical index of the identical array — the two cannot drift, because
   there is only one ordering.
2. **Mechanically, by a test that fails the wrong implementation** (§3b) — the sorted/`fileList`
   distinction is made observable rather than assumed.
3. **Live, over HTTP** (§3c) — with `fileList` reversed against sorted-hash order, all 7 frames
   returned the byte-exact file at their own `fileList` index. A sorted-listing implementation would
   have returned `img_0_red.png` for frame 0; it returned `img_6_grey.png`, the correct one.

Byte-identity in that table also confirms **no re-encode**: the response body equals the source file
exactly, so nothing went through Sharp on a path that cannot afford it.

### 3e. Not run here, stated plainly

- **Plan §4 rows 2-3 (draw a mask → Apply → `file spokes/template_mask/<jobId>/*`)** — Apply needs
  Postgres and Sharp-through-the-processor; not runnable on this box. The fix does not touch Apply,
  which already handled `jobType === 'images'` before this change and is unmodified.
- **Plan §4 row 6 (MP4 / DICOM regression)** — code inspection only, no ffmpeg here. The raw branch is
  untouched for `source.type === 'video'`; the new branch is gated behind an equality check on the V2
  source type, and the live run's last line exercises that gate: flipping the same job to
  `type:'video'` fell through to the raw path and produced `frames_swept`, as before. The only
  behavior change reaching video jobs is the 410's wording and the additive `reason` field.
- **The 410 fallback copy** (no `reason` in body) is exercised by inspection only — no live server
  omits the field after this change.

---

## 4. Filed, not fixed: mixed-dimension image batches

Per the review, the live batch was uniform 632×1080. The reason is a real defect that this fix does
not touch and must not be confounded with:

**The template mask is a single set of absolute pixel coordinates captured against image 0 and
applied unchanged to every frame** (`videoProcessor.ts:1895` — `{x, y, width, height}` used directly,
"ABSOLUTE PIXEL COORDINATES - No transformation required"). In a batch where images differ in size,
the same rectangle lands in a different place on each one — off the burned-in identifier it was drawn
over, or off the canvas entirely. **This is a PHI-leak shape, not a cosmetic one.**

It was invisible until now only because the canvas never painted, so no mask could be drawn at all.
Item 28 makes it reachable. Backlog entry drafted in §6 below.

## 5. Not changed

- **No §3.** Nothing written to `temp_extracted/` at upload; no Sharp encode at upload; no second
  copy of PHI on disk.
- **No retention change.** `UPLOADS_MAX_AGE_MS` untouched. An image job older than 2 h still fails —
  but now the canvas fails *the same way Apply already fails*, with copy that names the real cause,
  instead of failing at minute zero with a false restart claim.
- **A3 frozen.** `shared/schema.ts`, `storage.ts`, `pgStorage.ts`, `migrations/` untouched. The only
  storage call added is the read-only `storage.getVideoJob`.
- **Backlog item 25 (`firstFrame`) still open** — but this fix is what makes retiring that field safe,
  since the canvas finally has a working source.

## 6. Backlog entries

Replace the drafted item 28 with:

> **28. ~~Image-batch jobs 410 at the template-mask canvas~~ — FIXED 2026-09-04.**
> `GET /api/jobs/:id/frames/:n` now serves image batches from `uploads/<fileList[n].filename>`,
> detected via `jobV2.source.type === 'image_batch'` and indexed strictly by `fileList` order (the
> same order `processImages` masks in, so canvas frame *i* is provably masked output *i*'s source).
> Broken since Phase 4b (`c66ca4e`). The trailing 410 no longer claims a server restart for causes
> that are not one — both 410s now carry a `reason` and the spoke renders copy per cause.
> `docs/refactor/ITEM28_REPORT.md`. **Unblocks the item 22 deploy runbook §5 (rows I1-I8).**

New:

> **29. Mixed-dimension image batches mask the wrong region on every frame but the first.**
> The template mask is one set of absolute pixel coordinates drawn against image 0 and applied
> unchanged to all frames (`videoProcessor.ts:1895`). In a batch of differing sizes the rectangle
> lands elsewhere on each image — possibly off the burned-in identifier, possibly off the canvas.
> PHI-leak shape. Latent since the absolute-coordinate rewrite; unreachable until item 28 made the
> canvas paint. Needs a per-image transform, or a uniform-dimension guard at upload.
> Found 2026-09-04 while verifying item 28 (`ITEM28_REPORT.md` §4).

## 7. Sequencing

Plan §5 resolves to the clean option: **item 28 has shipped, so item 22 can now be deployed and its
runbook run intact** — §5 rows I1-I8, the entire image-batch matrix, are executable for the first
time. Use a **uniform-dimension** batch for them until item 29 is addressed, or I1-I8 will be
measuring two bugs at once.

## 8. Follow-up worth considering (not done)

The AI spoke shows the same "no longer available" copy for image jobs, because its `tempDirExists`
check looks at `spokes/template_mask/<jobId>`, which exists only after an Apply (plan §1). That is a
different endpoint with a different (correct) predicate — it is genuinely reporting "no masked
frames yet", just with copy inherited from the video path. Out of scope here; worth a look when
someone next touches that spoke.
