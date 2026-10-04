# Output Round 2 — recon (step 1) and one-page plan

**Status:** recon, 2026-10-04, against `main` @ `51289ae` (local = `origin/main`). Answers `OUTPUT_ROUND2_KICKOFF.md` §4 with `file:line`, then the plan and D1–D4. **No code written. Stop for sign-off.**

Measurements below ran on a scratch copy of `server/` + `shared/` in a Linux VM on the Mac (node 22, `UV_THREADPOOL_SIZE=1`, `sharp.concurrency(1)`, median of 5–7). Nothing was installed into the repo tree. Prod figures marked *est.* are scaled from the prod numbers already in `OUTPUT_ROUND1B_STEP1.md`, and need the runbook to confirm them.

## Three findings that change the plan

**F-A. The 500 ms gate fails as specified, and the cause is one debug line.** `createMaskFromBase64` pushes one object (two template strings) into a debug array for **every detected pixel** (`videoProcessor.ts:2417`, `|| (isDrawn && isRed)`); only the first 15 entries are ever logged (`:2460-2461`). In Keep mode that is ~1.7–2 M allocations per build.

| 1920 × 1080 mask | `createMaskRgbaBuffer` as is | with `:2417` sampling at the interval only | buffers |
|---|---|---|---|
| Keep, 600 × 600 kept (1.71 M masked) | 343 ms | 21 ms | identical |
| Keep, dpr-2 canvas export (3840 × 2160 PNG) | 376 ms | 62 ms | identical |
| Remove, 300 × 200 | 19 ms | 11 ms | identical |
| fully transparent | 12 ms | 11 ms | identical |
| fully red | 463 ms | 15 ms | identical |

`buildApplyMask` on the first row is 367 ms in total, so the offsets scan is ~24 ms of it. The 1b docs attributed prod's 1.8 s Keep `apply.mask_build` to "building 2 M offsets"; the offsets are cheap and the debug array is the cost. On prod the validator as specified would add **~1.8 s** to every 1080p Keep apply (*est.*: same function, same mask as today's `apply.mask_build`). With the one-line change it is **~0.3–0.4 s** (*est.*), and Keep `apply.mask_build` drops by the same ~1.5 s, which closes queue item 3 without the in-crop-offsets rework. → **D4.**

**F-B. There is a second apply entry point the backstop would miss.** `POST /api/videos/:jobId/process` (`routes.ts:537-637`) takes `maskData` from the body and starts `processImages` (`:603`) / `processVideo` (`:616`) directly, bypassing `applyTemplateMask`. It is the 7B-1 "believed dead" route with the `[DEADROUTE-HIT]` probe (`:545`), still live. A fail-closed rule that covers one of two doors leaves the class open. → **D5 (new).**

**F-C. The client needs a change: a refused first apply would freeze the spoke.** Two separate things:
1. The toast would read `422: {"success":false,"error":"This mask doesn't…"}`. `throwIfResNotOk` builds `Error("${status}: ${rawBodyText}")` (`queryClient.ts:3-8`), and `onError` shows `error.message` (`ProcessingControls.tsx:108-115`).
2. `handleStartProcessing` calls `onStartProcessing` synchronously right after `mutate()` (`ProcessingControls.tsx:130-131`), so the spoke sets `isProcessing = true` (`template-mask-spoke.tsx:258`) before the response. It is reset only when `templateMask.status` becomes `complete` / `failed` (`:214-219`). A refusal persists nothing, so on a job never applied before the "Processing Started" card (`:439`) stays up and Apply stays disabled (`ProcessingControls.tsx:284`). The same happens today on any 400 / 404 / 500 from apply. → **D6 (new).**

## §4.1 Apply flow and callers

`applyTemplateMask` (`server/handlers/templateMaskApply.ts:32-98`): `apply.request` mark `:42` → 400 if no `maskData`/`outputSettings` `:44` → `getVideoJob` `:54` (404 `:56`) → **persist `maskData` + `outputSettings` `:60`** → `setTemplateMaskState('applying')` `:64-71` → 500 if no `io` `:76` (after persisting) → `new VideoProcessor(io)` `:80` → detached `processImages` `:88-90` or `processVideo` `:92-94` → `{ok:true}` `:97`. It never checks `job.status`.

- One caller: `POST /api/jobs/:jobId/template-mask/apply` (`routes.ts:1786-1803`), which maps `{ok:false,status,error}` to `res.status(status).json({success:false,error})` (`:1792-1794`).
- One client caller: `ProcessingControls.tsx:94`.
- The other starter of `processVideo`/`processImages` with a mask: the legacy route, F-B. No others (`grep` over `server/`, `client/src`, `scripts/`).

## §4.2 The mask builder

- `private async createMaskRgbaBuffer(maskData, width, height): Promise<Buffer>` (`videoProcessor.ts:2089`). With a `canvasDataUrl` → `createMaskFromBase64` (`:2113`, defined `:2235`); otherwise the coordinate fallback (`:2118-2231`). Side effects: `console.log` only. Needs only `maskData` and dims.
- **Live threshold:** `maskA > 128 && maskR > 150 && maskR > 1.5·G && maskR > 1.5·B` (`:2393-2395`, `:2411-2414`); output alpha is 255 or 0. `buildApplyMask` counts `alpha > 0` (`:653`).
- **Kickoff correction:** `createTransformedMask` (`:173`) and `convertToRgbaBuffer` (`:261`) have no callers. They are dead code carrying a second copy of the threshold (`:277`). Leave them; add to the dead-code queue item.
- **`createMaskFromBase64` swallows every error and returns a fully transparent mask** (`:2495-2501`). A malformed PNG therefore applies as "blank nothing" today: a third member of the class this round exists to stop.
- Other `createMaskRgbaBuffer` callers: `buildApplyMask` `:638`, `processImages` `:819`, per-stack fallback `:1725`, `processFrame` `:1982`.
- **Dims.** Video / DICOM: the apply uses frame 0's own pixel dims (`Sharp(firstFrame).metadata()`, `:630-632`); the job record carries `width`/`height` from the upload probe (`routes.ts:196-197`, `:290-291`). Image batches: `getImageDimensions(imageFiles[0])` (`videoProcessor.ts:794`), which returns `0 × 0` on error (`frameExtractor.ts:1066-1068`); the job record carries image 0's dims (`routes.ts:416-417`).

What each bad mask shape counts as, measured at 1920 × 1080:

| mask | masked_px | refused as |
|---|---|---|
| no PNG, `rectangle`, `coordinates: []` | 0 | nothing |
| no PNG, `freeform`, opacity 75 (default branch `:2219-2227`) | 2 073 600 | everything |
| no PNG, `freeform`, no opacity | 0 | nothing |
| malformed / non-data-URL PNG | 0 | nothing |
| 1a shape: black shapes on transparent | 0 | nothing |

Every known bad shape lands exactly on a bound, so the two-bound rule is sufficient for them.

## §4.3 Client error path

Covered in F-C. Nothing else reads the apply response.

## §4.4 Manifest builders and ZIP names

- Core: `buildPerFrameManifestAndCsv` synthesizes `frame_%04d.<outputFormat>` (`frameManifest.ts:79`); the CSV reuses it (`:92`). Its contract comment says the name is nominal (`:21-22`).
- **Whole-job** (`templateMaskDownloadHandler`, `routes.ts:641`, mounted `:895`): `outputFormat` from `job.outputSettings.format || 'jpg'` (`:732`); core called `:738-743`; `masquerade_version: '1.0'` `:746`; README `:771-804`; ZIP entry `images/frame_%06d.<ext>` with `ext` from the file on disk (`:855-861`).
- **Run download** (`routes.ts:1891`): frame count = this run's `mask_*.png` count (`:1909`, `:1923`); `outputFormat` from `job.outputSettings.format || 'jpg'` (`:1918`); manifest object `:1934-1953` has **no version field** and no README; base frames written only when `includeBaseFrames` (`:1931`, `:1983-2008`) as `images/frame_%06d.<ext>`, `ext` from disk (`:2005-2007`).
- **Extra defect in the run manifest:** for a raw-input run the base frames are PNG, but the manifest names them from the job's output format (default `jpg`). The extension is wrong, on top of the pad width and prefix.
- **Readers of `filename`:** none in `client/src` (FrameViewer reads `inference.json`). `scripts/output_eval/check.ts:171-173` reads `manifest.output_transform` and the CSV's last ten columns only, so it stays green.

## §4.5 Test drivers and effort

- Unit tests are `node:test` files run one at a time with `npx tsx server/services/__tests__/<name>.test.ts` (14 today; `outputF2.test.ts` already reaches `createMaskRgbaBuffer` / `buildApplyMask` through an `any` cast and is the pattern to copy).
- `scripts/output_eval/check.ts` (24 geometry rows, reference diff 0) covers "normal applies unaffected"; `serial_bench.ts` is the serial-timing pattern.
- The `curl` rows need the sandbox server and two crafted PNGs (transparent, fully red): ~15 lines of script.
- **Effort:** still ~1 day. F-C and F-B add about an hour each.

---

## Plan (one page)

**Commit 1 (only if D4 = yes) — stop allocating a debug object per masked pixel.** `videoProcessor.ts:2417`: `if (i % sampleInterval === 0)`. Nothing that writes `resultBuffer` is touched. Proof: a test building 4 masks × 2 sizes and comparing the buffer with an independent reference computed from the mask predicate; `outputF2`, `outputParity`, `check.ts` stay green. Own `git revert`.

**Commit 2 — Output Round 2.**
1. `VideoProcessor.countMaskedPixels(maskData, w, h)` (public): calls `createMaskRgbaBuffer`, counts `alpha > 0` (the `:653` test). No second threshold.
2. `server/services/applyGuard.ts` (new, pure): `decideApply(masked, total)` → `null | 'mask_blanks_nothing' | 'mask_blanks_everything'`, plus the two messages.
3. `templateMaskApply.ts`: move the `io` check and `new VideoProcessor(io)` above `:60`; resolve dims; count; emit `apply.validate`; on a bound emit `apply.refused` and return 422. Nothing persisted before that point.
4. Same guard on the legacy route (D5).
5. Client, `ProcessingControls.tsx` only (D6): show the body's `error` string in the toast; call `onStartProcessing` from `onSuccess`.
6. Manifest: the wrappers build the ZIP entry-name list once and use it for both `archive.file` and the core; the core stops synthesizing names. Run wrapper lists base files whether or not they are included. `masquerade_version: '1.1'` in both; one README sentence; fix the `frameManifest.ts:21-22` and `routes.ts:733-735` comments.
7. Tests per kickoff §5, plus the buffer-identity test and a legacy-route `curl` row.

### Decisions

| # | recommendation |
|---|---|
| **D1** | Synchronous 422 after `getVideoJob`, before `:60`, as you proposed. Two additions: (a) dims come from raw frame 0 on disk when present (header read, the same frame the reuse path masks), else the job record's `width`/`height`, with `dims_source` on the `apply.validate` line; (b) if dims cannot be resolved or the count throws, **refuse** (422, reason `unverifiable`, "Couldn't check this mask. Reload the page and try again.") instead of letting the apply through. |
| **D2** | ZIP-convention name + top-level `images_included`. Two refinements: `ext` comes from the base-file listing (so raw-input runs say `.png`), falling back to `run.inputSource` (`raw` → `png`, else the job's format) when the frames are already swept; and `images_included` reports what was written, so a request for base frames that finds none on disk says `false`. |
| **D3** | Count at image 0's dims via the same `getImageDimensions(imageFiles[0])` call `processImages` makes; if that returns 0 × 0 (uploads already reclaimed, backlog 30) fall back to the job record. A mixed-dimension batch is accepted or refused as a whole on image 0's count. Both bounds are dimension-independent in practice (transparent stays 0, fully red stays total at any size). |
| **D4** | **Your call, and the main one.** The gate is unreachable without touching `createMaskFromBase64`. Options: **(a) recommended:** the one-line debug change as its own commit in the same deploy; gate passes (~0.3–0.4 s prod *est.*) and every Keep apply gets ~1.5 s faster. (b) Ship the validator on the function as is and accept ~+1.8 s on 1080p Keep applies, gate failed. (c) Build the mask once in the handler and pass it into `processVideo`; this edits `buildApplyMask`'s contract and is the restructuring the kickoff ruled out. |
| **D5 (new)** | Legacy `POST /api/videos/:jobId/process`: **recommended:** call the same guard there (about five lines) and leave its deletion to 7B-1 with the log evidence. Alternative: make it return 410 now and keep the probe line. Leaving it unguarded is the option I would not take. |
| **D6 (new)** | Client change, `ProcessingControls.tsx` only: parse the JSON body for the toast; move `onStartProcessing` into `onSuccess`. Side effect to accept: the 2B-2 `automask.outcome` line and `lastProcessedSettings` are then recorded only for applies the server accepted (a few ms later than today). `apiRequest` is shared and stays untouched. |

### Risks and notes

- **The UI "everything" row may not trip.** A rectangle dragged over the whole frame lands on `total_px` only if the export covers every pixel after resampling. If it lands at `total − k` it is, correctly, not refused. The `curl` rows are the proof; treat the UI rows as the user-facing check of the message.
- **Pre-existing, out of scope:** on a re-apply of an already-`complete` job, the `:214-219` effect clears `isProcessing` immediately because the status is still `complete` until the refetch lands. Unchanged by this round.
- **Invariants:** `tsc` 12; A3 untouched; `buildApplyMask`, `createMaskRgbaBuffer`, extraction, reuse guard, `automask*.ts`, `outputTransform.ts` not edited. `createMaskFromBase64` edited only under D4(a), one line, no arithmetic.
- **Working tree:** `CLAUDE.md` and `docs/refactor/ITEM22_REPORT.md` are modified and uncommitted; `OUTPUT_ROUND2_KICKOFF.md` and `UI_SIMPLIFICATION_NOTE.md` are untracked. They should go in with (or before) this round's commit so prod's tree matches.
