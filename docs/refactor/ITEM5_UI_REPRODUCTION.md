# Item 5 — reproduction through the real UI (pre-step to Round 2A, `AUTOMASK_2A_GO.md` §1)

**Date:** 2026-09-06. **Branch:** `item5-rgb-dicom` (three commits: `19dce35` reusePort, `2a5be5a` item 5, `5a7526a` PostHog guard). **Sandbox:** Postgres 5433, dev server `:5001`, log `sandbox/results/server_2026-09-06_105016.log`. **Result: nothing failed.** Both DICOMs went upload → hub → Template Mask canvas → header rectangle → Apply → download ZIP → ZIP opened, with zero browser-console errors and zero non-`[PERF]` lines in the server log. `tsc` 12. R1 (mono guard) re-run: byte-identical to the pre-patch outputs.

## 1. How the UI was driven (and the one step that could not be)

The in-app browser cannot open the OS file picker, and Claude in Chrome was not connected, so the DICOM was handed to the page's **own** `<input type=file>` by script (fetched from the local bench server, wrapped in a `File`, set via `DataTransfer`, `change` dispatched). From that event on everything is the real React path: the dropzone accepted the file, the PHI radio was clicked with the mouse, "Let's Go" posted `multipart/form-data` to `POST /api/uploads/video` with `phiStatus=user_attested` and the attestation record, the hub polled `GET /api/jobs/:id`, the Template Mask tile opened the spoke, the rectangle was drawn with a mouse drag on the canvas, "Apply Mask to All" posted the `canvasDataUrl`, "Download ZIP" called `window.open(…/template-mask/download)`. The in-app browser blocks downloads (`net::ERR_ABORTED` on the navigation it opens), so the identical `GET` was replayed with `curl` and the ZIP unzipped — the server returned `200`, `application/zip`, `Content-Disposition: attachment` both times.

## 2. Path A — real colour-Doppler still, `ge_e9_6193094661.dcm` (1164×873, RGB, 1 frame)

| step | observed |
|---|---|
| upload | `POST /api/uploads/video 200` in 55 ms; `upload.job_created path:dicom`; hub: "1164×873 · 1.0s · 1 frames", PHI badge |
| extraction | `bg_extract.start totalFrames:1` → `bg_extract.first_frame_on_disk 28 ms` → **`bg_extract.done 1/1 parity:true path:dicom-batch outcome:ok`** — the same line Andre saw |
| canvas | `GET …/frames/0 200` in 7 ms; the frame renders **in colour** (PDI box red/orange), 1164×873 canvas at 75 % |
| rectangle + Apply | `apply.source reuse frames:1` · `apply.mask_build 47 ms, masked_px 114 642` · `apply.frame decode 3.3 / mask 1 / encode 4.7 ms fmt:jpeg` · **`apply.done 81.6 ms outcome:completed`**; UI: "Status: complete · 100 %", toast "Processing Started", Download ZIP button |
| ZIP | `processed_ge_e9_6193094661.dcm.zip` 106 KB: `README.txt`, `images/frame_000000.jpg`, `manifest.json` (1 frame, `output_format: jpg`), `metadata.csv` |
| masked frame | JPEG **RGB 873×1164×3**; masked band rows 6–109 mean **0.27** (0.00 in the left/centre, 0.02 at the right where the grey header box was); **10 649 strongly coloured pixels** retained below the band (the Doppler flow); the top 4 rows read 107–110 because my drag started 5 px below the frame top — the mask was where I drew it, not a defect |
| AI spoke on the same job | `/jobs/:id/ai` loads the masked frame (`frames/0?source=template_mask`) in colour, `ai/runs 200`, no console error; Run AI was not exercised (external GPU service) |

## 3. Path B — synthetic 3-frame RGB multiframe (built from the same still; `item5_make_synthetic_rgb_multiframe.py`, planar 0)

| step | observed |
|---|---|
| upload / extraction | hub "1164×873 · 3.0s · 3 frames"; `bg_extract.done 3/3 parity:true path:dicom-batch` in 56 ms |
| canvas | frame 0 in colour |
| Apply | `apply.source reuse frames:3`, three `apply.frame` lines (decode 2.5–3.0 ms, encode 4.5–5.9 ms), **`apply.done 105.6 ms frames:3 completed`** |
| ZIP | 287 KB, `images/frame_000000..2.jpg`, manifest `total_frames 3`, 3 frame rows |
| frames | all RGB 3-channel; band means 0.27 / 0.28 / 0.15; below-band mean R/G/B **22.7/21.7/20.7 · 20.7/21.7/22.7 · 11.3/10.8/10.3** — frame 2 has R↔B swapped and frame 3 is at half brightness, exactly as the synthetic was built (R2 in `ITEM5_REPORT.md`), so per-frame offsets and channel order are right through the *UI* path too |

## 4. The mono guard (R1) and `tsc`

- `npx tsx scripts/automask_spike/item5_rgb_dicom_check.ts` on `ge_e9_2124113685.dcm` (1 frame) and `ge_e9_4351124429.dcm` (67 frames) with the branch code, `diff -rq` against the pre-patch outputs kept from 2026-09-04 (`/tmp/item5/before/…`): **IDENTICAL — 2 + 68 files, zero differences.**
- `npx tsc --noEmit` → **12** (5 `frameExtractor.ts` pixelBuffer + 7 `maskWorker.ts`), unchanged.

## 5. Since nothing failed — the other paths Andre could have taken, and what each does today

1. **A `.dcm` selected together with images** (or dropped into an image batch): the upload page refuses before any request — red toast **"Mixed file types — Upload either videos OR images, not both."** (reproduced, screenshot in the session). The server side agrees: the image multer `fileFilter` accepts only PNG/JPG (`routes.ts:84–96`), so a stray `.dcm` in `/api/uploads/images` would be `Invalid file type`. A red toast after picking a colour-Doppler file plus screenshots is the most likely match for "an error after a colour-Doppler upload".
2. **Download ZIP in a browser that blocks pop-ups** — the button uses `window.open(…, '_blank')` (`ProcessingStatus.tsx:123`); a blocked pop-up looks like "download did nothing". The request itself is fine (200, `attachment`). Pre-existing, not item 5.
3. **Re-opening the job after the `uploads/` sweep (2 h)** — the canvas still paints (raw frames live 6 h in `temp_extracted/`) and Apply reuses them (`apply.source reuse`), so this path also works for DICOM; it would only fail if `temp_extracted/` were gone too (6 h), which shows the existing "frames swept" copy.
4. **AI spoke → Run AI** on the colour job — needs the external GPU endpoint; in the sandbox it fails for that reason regardless of item 5. Not exercised.
5. **A colour-Doppler cine with a compressed transfer syntax** (JPEG / J2K / RLE) — the known untested boundary (CLAUDE.md, DICOM block); `dcmjs` would not decode it and the upload would fail at extraction, i.e. *before* `bg_extract.done`, which does not match Andre's description.

If Andre remembers a red toast, (1) is it; a "nothing happened on download", (2). Anything else would need the exact console/server line.

## 6. Ship it

Item 5 is unchanged by this pre-step: no code edited. Deploy per `ITEM5_DEPLOY_RUNBOOK.md` (this session). Round 2A does not wait for it — only runbook row **A6** (DICOM colour-Doppler still through the proposer) is conditional on the deploy.

Artifacts kept out of git: `sandbox/bench/_item5/` (the two DICOMs staged for the page's fetch; PHI), the two ZIPs and their unpacked frames in the session scratchpad.
