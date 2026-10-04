# Output Round 2 — kickoff: the server refuses a mask that blanks nothing; manifest filenames match the ZIP

**Status:** kickoff, 2026-09-23, against `main` @ `51289ae` (Output Round 1, 1a and 1b deployed and verified). **Executor:** Claude Code. **Step 1 is a short recon (§4, `file:line`) with a one-page plan, then stop for sign-off; step 2 builds and stops after `OUTPUT_ROUND2_REPORT.md` for the runbook.** Server only, apart from confirming the client shows the refusal. One commit, one `git revert`. Budget ~1 day.

## 0. Why this round

**Fail-closed on the server.** In one week, two client paths could send a mask that blanks nothing, and the server accepted both. O6: Apply after Clear / Erase All sent `coordinates: []`. 1a: a Remove export after a Keep flip carried black shapes, `masked_px 0`. Both ended as a download of unmasked frames labelled as masked. Both are fixed in the client, but the rule that stops the whole class has to live on the server, because the next client bug will be one nobody has imagined yet. The server should never produce a "masked" output from a mask that masks nothing.

**The manifest points at files that don't exist** (backlog 27). `frames[].filename` is `frame_0000.jpg` (`frameManifest.ts:79`), but the ZIP writes `images/frame_000000.jpg` (`routes.ts:861` whole-job, `:2007` run download): wrong zero-pad, no `images/` prefix, in both `manifest.json` and `metadata.csv`. Since Output Round 1 the manifest also carries `output_transform`, the mapping a loader uses to put labels back on source frames, so a loader that can't find the frames through the manifest is now a real gap for anyone building a dataset from these downloads.

## 1. R1 — refuse an apply whose mask blanks nothing, or everything

**Rule.** Build the mask at the job's frame dimensions with the **same** code the apply uses, and count blanked pixels. Then:
- `masked_px == 0`: refuse, reason `mask_blanks_nothing`.
- `masked_px == total_px`: refuse, reason `mask_blanks_everything` (the output would be pure black: never useful, always a mistake).

Everything else proceeds exactly as today. The rule applies to every apply (hand-drawn Remove, hand-drawn Keep, accepted auto-mask cone); a correct mask never hits either bound.

**Refuse synchronously, before anything is persisted.** Today `applyTemplateMask` (`server/handlers/templateMaskApply.ts`) writes `maskData` + `outputSettings` to the job (`:60`), sets `templateMask.status: 'applying'` (`:64-71`), then starts processing asynchronously and returns 200. An async refusal would surface as `templateMask.status: 'failed'` with no message the user can read, because `TemplateMaskState` stores none. So the check runs **at the top of `applyTemplateMask`, before `:60`**:
- Return `{ ok: false, status: 422, error: <message> }`, where the message tells the user what to do. Suggested copy: "This mask doesn't remove anything. Draw over what should be removed, or switch to Keep and draw what should be kept." and "This mask removes the whole frame. Nothing would be left in the output."
- Nothing written: no job update, no `templateMask` state change, no files.
- One `[PERF] apply.refused {reason, masked_px, total_px, w, h}` line.

On every apply, accepted or refused, emit one `[PERF] apply.validate {ms, masked_px, total_px}` line. It is the backstop's own telemetry, and it makes the old audit grep a one-liner forever.

**Same threshold code, not a copy.** The count must come from `createMaskRgbaBuffer` (`videoProcessor.ts`; PNG → `createTransformedMask` → the `r > 150 && a > 128` threshold). Expose a public wrapper, e.g. `countMaskedPixels(maskData, w, h)`, that calls it and counts alpha > 0. `buildApplyMask`, `createMaskRgbaBuffer` and `createTransformedMask` are **called, not edited**. A second implementation of the threshold in the handler is exactly the drift this round exists to prevent.

**Cost.** This decodes the mask PNG a second time per apply, since the apply still builds its own. Measure it serially (the `CLAUDE.md` working-loop rule): **gate ≤ 500 ms on a 1920 × 1080 Keep mask**. If it's over, stop and report rather than restructuring `buildApplyMask`.

**Client.** `ProcessingControls` already toasts a non-2xx `error.message` (`:108-112`). Recon confirms the 422 body's `error` string reaches that toast verbatim. If it does, no client change; if not, make the smallest change that shows it.

## 2. R2 — `filename` in `manifest.json` and `metadata.csv` is the ZIP entry name

- **Whole-job download:** `frames[i].filename` = the exact name written into the ZIP for frame *i*: `images/frame_%06d.<ext>`, with the **same `ext` the ZIP writer uses** (`routes.ts:859-861`, from the file on disk), never a separately computed `outputFormat`. Suggested design: the wrapper passes the list of entry names into `buildPerFrameManifestAndCsv`; the core stops synthesizing names. Recon may propose better.
- **Run download:** the same `images/frame_%06d.<ext>` name whether or not `images/` is included, plus a top-level `images_included: boolean`, so the schema stays stable and a loader knows whether to expect the files (decision D2).
- **Version:** `masquerade_version` `'1.0'` → `'1.1'` on the whole-job manifest; add `masquerade_version: '1.1'` to the run manifest if it has none. README gets one sentence on what `filename` means.
- This changes manifest bytes on purpose. Phase 6's D1 byte-identity guarantee ends here; say so in the report.

## 3. Decisions for sign-off (recon recommends; I decide)

| # | question |
|---|---|
| D1 | Refusal point: synchronous 422 in `applyTemplateMask` before `:60` (my preference, for the reasons in §1), or something recon shows is safer. |
| D2 | Run-download `filename` when `images/` is omitted: the ZIP-convention name + `images_included`, or `null`. |
| D3 | Image batches: which dimensions the count uses (image 0's, matching the apply's own mask build?). Mixed-dimension batches (backlog 29) are out of scope; say what happens to them. |
| D4 | Anything recon finds that makes the 500 ms gate unreachable without touching `buildApplyMask`. |

## 4. Recon (answer with `file:line`, then a one-page plan, then stop)

1. The full `applyTemplateMask` flow, and every caller of it: is it the only apply entry point, and does anything else start `processVideo` / `processImages` with a mask?
2. `createMaskRgbaBuffer`: its signature, what it needs (dims, `maskData`), where the job's frame dims come from for video, DICOM and image jobs, and whether it has side effects (logging aside).
3. The client path from a non-2xx apply response to the toast (`apiRequest` / `ProcessingControls` `onError`): what reaches `error.message`?
4. The manifest builders: `buildPerFrameManifestAndCsv` (`frameManifest.ts`), the whole-job wrapper (`routes.ts` ~`:740-870`), the run wrapper (~`:1920-2010`); where `ext` comes from at each ZIP write; whether the run manifest has a version field; every place `filename` is read (the FrameViewer? the eval scripts?).
5. The test drivers for §5, and effort against ~1 day.

## 5. Test matrix (runbook rows; sandbox unless marked)

| axis | rows |
|---|---|
| backstop without the client | `curl` the apply endpoint with a crafted **fully transparent** mask PNG → 422 `mask_blanks_nothing`, `apply.refused` line, job record byte-identical before/after (GET the job), no files under `spokes/template_mask/<job>/`. Same with a fully red PNG → 422 `mask_blanks_everything`. **This is the row that matters: the backstop must hold when the client is wrong.** |
| backstop through the UI | Keep + a rectangle over the whole frame → toast with the message, Apply stays available, nothing changes; Remove + a rectangle over the whole frame → the "whole frame" toast |
| normal applies unaffected | Remove, Keep, accepted cone on the fan MP4, the E9 DICOM and an image batch → proceed; one `apply.validate` each, no `apply.refused`; `check.ts` 24 geometry rows, reference diff 0 (output bytes unchanged) |
| unit | the accept/refuse decision on counts (0, 1, total − 1, total); `countMaskedPixels` equals the count `buildApplyMask` reports on the same mask (4 masks × 2 sizes) |
| cost | `apply.validate ms`, serial, 1920 × 1080 Keep: ≤ 500 ms (report the number); fan MP4 and E9 numbers alongside |
| manifest | whole-job ZIP: every `frames[].filename` is a ZIP entry, and the CSV `filename` column equals the manifest's; run ZIP with and without base frames: same names, `images_included` correct, entries present iff included; `masquerade_version` `'1.1'` in both |
| invariants | `tsc` 12; all Output Round 1/1a/1b and automask tests green; `buildApplyMask`, `createMaskRgbaBuffer`, `createTransformedMask`, extraction, reuse guard, `automask*.ts`, `outputTransform.ts` untouched; `output_transform` sidecar unchanged; both `dist/` files |

## 6. Constraints
`tsc` 12 · A3 frozen (no column for refusal reasons: the refusal persists nothing) · masking arithmetic untouched (called, not edited) · no new dependencies · no flag (a correct mask can never be refused, so there is nothing to gate) · one commit, one `git revert` · nothing PHI-bearing committed.

## 7. Out of scope
Keep-mode `apply.mask_build` cost; mixed-dimension image batches (backlog 29); image re-open after apply (backlog 30); UI simplification (its own conversation, next); auto-mask 2C.

---
> Continuing Masquerade (bring `CLAUDE.md`). Output Round 1, 1a and 1b are deployed (`51289ae`). New round: **Output Round 2** per `OUTPUT_ROUND2_KICKOFF.md`. (1) The server refuses an apply whose mask blanks nothing or everything: a synchronous 422 at the top of `applyTemplateMask`, before anything is persisted, counting with the existing `createMaskRgbaBuffer` through a public wrapper (no second threshold implementation), with `apply.validate` / `apply.refused` PERF lines, a ≤ 500 ms gate on a 1080p Keep mask, and a `curl` row with a crafted transparent PNG proving it holds without the client. (2) `manifest.json` / `metadata.csv` `filename` equals the ZIP entry `images/frame_%06d.<ext>` in both downloads, `masquerade_version` 1.1. Step 1 is recon §4 with `file:line` plus a one-page plan answering D1–D4, then stop for my sign-off. `tsc` 12, A3 frozen, masking arithmetic called not edited.
