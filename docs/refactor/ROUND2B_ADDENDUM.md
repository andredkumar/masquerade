# Round 2B addendum — output format decision + two small folds (same deploy as 2B-1/2B-2)

**Decided 2026-08-30 (operator):** masked-frame output **defaults to JPEG**; the user may **select PNG**,
understanding it is larger. Lossless-by-default is off the table; a usage/tier model may gate large
jobs later. This addendum replaces `ROUND2B_PROPOSAL.md` §2B-2 item 2 (the PNG encode change, which
`ROUND2B_REPORT.md` §3 correctly declined).

## A. Honor `outputSettings.format` end to end (the JPEG-in-`.png` fix)

Today (`videoProcessor.ts` ~`:1429`, `processFrameBatch` Step 4) the encoder is unconditionally
`jpeg({ quality: 90 })` while the filename extension comes from `outputSettings.format || 'png'`, so
every masked frame is JPEG bytes in a `.png` file served as `image/png`. Fix:

1. **Encoder follows the format.**
   ```ts
   const fmt = outputSettings.format === 'png' ? 'png' : 'jpeg';      // default jpeg
   const outputBuffer = fmt === 'png'
     ? await processedImage.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer()
     : await processedImage.jpeg({ quality: 90 }).toBuffer();
   ```
   `compressionLevel: 3` is the measured sweet spot from `ROUND2B_REPORT.md` §3 (7 ms, ~332 KB vs
   14 ms / 311 KB at the default). Keep JPEG at `quality: 90` — unchanged bytes for the default path.
2. **Extension follows the encoder.** Default extension becomes `.jpg` (`frame_%06d.jpg`), `.png` only
   when PNG was chosen. Find every place that assumes `.png` for masked frames: the save loop
   (`~:404` region), `listFrameFiles` / `resolveFramePath` in `frameAccess.ts` (accept `.jpg|.jpeg|.png`
   — match by sorted `frame_*` prefix, not by extension), the frames endpoint's `Content-Type`
   (derive from the extension: `image/jpeg` / `image/png`), the `?source=template_mask` branch, the
   AI inference handler's frame reader (it reads bytes and base64s them — make sure the MIME it sends
   to the GPU service, if any, follows the extension), and both ZIP builders. `frames[].filename` in
   the manifest is nominal (`frame_%04d.<outputFormat>` per Phase 6) — now it becomes *true* for the
   default case, which is fine; do not change the manifest schema (D1).
3. **UI.** Wherever output settings are chosen (`ProcessingControls` / output-size panel): the format
   control defaults to **JPEG**, and the PNG option carries one line of copy — *"Lossless. About 3×
   larger files."* If no format control exists in the UI today, add the two-option select there;
   do not add any other output-settings UI.
4. **Sorted-position indexing is unchanged.** Frame *i* is still `sortedFiles[i]` regardless of
   extension; the Phase 6 co-indexing invariant (`frames[].frame_number == mask_<i> == overlay_<i> ==
   images/frame_%06d(i)`) holds because nothing keys on extension — verify that with a grep for
   `'.png'` literals on the masked-frame paths and list every hit in the report.

Regression guard: MP4 apply with default → files are `.jpg`, served as `image/jpeg`, viewer + AI spoke +
ZIP all work; MP4 apply with PNG selected → `.png`, `image/png`, lossless (check one frame decodes to
the same pixels as the raw frame outside the mask). DICOM single + multi with default. AI run on
each. Existing jobs on disk from before this deploy have `.png`-named JPEGs — the extension-agnostic
listing in step 2 keeps them readable for the rest of their 24 h.

## B. Fold in `applyPaths.test.ts` regex fix

`ROUND2B_REPORT.md` §4: the test expects `/jobId must be a non-empty string/`; the code (5B
`resolveWithinRoot`) throws `resolveWithinRoot: empty or non-string path segment`. Update the regex.
Test-only change; 8/8 expected after.

## C. Grayscale — NOT in this deploy, queued for 2B-3

Raw `temp_extracted/` PNGs (~400 KB/frame RGB) are the real disk consumer; B-mode clips are
single-channel. 2B-3's rewrite of the raw extractor should evaluate `-pix_fmt gray` gated on a
per-job chroma check of frame 1 (color Doppler → stay RGB), with the same gray option applied to the
masked PNG path. Not now.

## D. Kickoff message for Claude Code

> Continuing Masquerade (bring CLAUDE.md). 2B-1 + 2B-2 (`ROUND2B_REPORT.md`) are landed, not deployed.
> Before deploy, apply `docs/refactor/ROUND2B_ADDENDUM.md`: (A) honor `outputSettings.format` —
> default **JPEG q90 with `.jpg` extension and `image/jpeg`**, PNG (`compressionLevel: 3`,
> `adaptiveFiltering: false`) only when selected; make masked-frame listing/serving extension-agnostic
> (sorted `frame_*` prefix), derive Content-Type from extension, keep the manifest schema unchanged,
> and add/adjust the UI format select (default JPEG, PNG labeled "Lossless. About 3× larger files.").
> Grep and list every `'.png'` literal on the masked-frame paths. (B) fix the stale regex in
> `applyPaths.test.ts`. No grayscale work. tsc stays at the same 12; A3 frozen; storage untouched.
> Regression guard per addendum §A. Append a "2B-addendum" section to `ROUND2B_REPORT.md` and stop
> before deploying.
