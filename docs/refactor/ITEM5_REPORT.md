# Item 5 — RGB (colour-Doppler) DICOM extraction fix: report

**Date:** 2026-09-04. **Decision:** `AUTOMASK_2A_DECISIONS.md` §1a/§2. **Diagnosis:** `ITEM5_RGB_DICOM_VERIFICATION.md`. **Branch:** `item5-rgb-dicom` off `main` @ `dc45954`, three commits (§5). **Status:** implemented and verified in the sandbox; **not deployed** — stop here for Andre's runbook.

## 1. What changed (one file, four sites, exactly the scoped diff)

`server/services/frameExtractor.ts`:
| site | before | after |
|---|---|---|
| `extractDicomFrame` (`:380-386`, `:401`, `:538`) | `bytesPerFrame = rows·cols·(bits/8)` | reads `SamplesPerPixel` (default 1) and `PlanarConfiguration` (default 0); `bytesPerFrame = rows·cols·(bits/8)·samples`; passes both to the helper |
| `tryRawDicomPixelData` (`:548`, `:566`, `:585`) | same maths | same fix; new optional params default to the old behaviour. (Dead helper — no caller — patched for consistency as scoped.) |
| `processDicomPixelDataHelper` (`:604-624`) | always `channels: 1`, `expectedSize = rows·cols` | **new branch first:** `samplesPerPixel === 3 && bitsAllocated === 8` → de-interleave when `PlanarConfiguration 1`, emit `sharp(raw, {channels: 3}).png()`. **Mono path below is byte-for-byte untouched.** |
| `detectDicomFrameCount` (`:126`) | size estimate ignored samples | `· (SamplesPerPixel ‖ 1)` — only matters when `NumberOfFrames` is absent (an RGB still would have counted as 3 frames) |

Nothing else in the file. `extractDicomImage` (the dead first-frame preview path) is **also wrong for RGB** and was left alone — see §4.

## 2. `tsc` gate — 12 before, 12 after

| | count | `frameExtractor.ts` lines |
|---|---|---|
| before | 12 (5 + 7 `maskWorker.ts`) | 425, 464, 477, 501, 507 — `TS18048 'pixelBuffer' is possibly 'undefined'` |
| after | **12** (5 + 7) | 430, 469, 482, 506, 512 — the same five, shifted +5 by the new lines above them |

No parked narrowing was touched; no new error.

## 3. Verification (R1–R5 done in the sandbox; R6 open)

Harness: `scripts/automask_spike/item5_rgb_dicom_check.ts <dcm> <outDir> [--perf]` runs the app's own `extractFirstFrame` and `extractAllFramesSequential` (DICOM branch → `extractDicomFrame`, the function the upload-time batch loop also calls) and writes every frame. Synthetic inputs: `scripts/automask_spike/item5_make_synthetic_rgb_multiframe.py` (RGB multiframe from the real GE colour-Doppler still; `--frames N --planar 0|1`).

| # | step | result |
|---|---|---|
| R1 | **Mono guard.** `ge_e9_2124113685.dcm` (single, 1164×873) and `ge_e9_4351124429.dcm` (67 f, 1054×802) extracted before and after the patch; `cmp`/`diff -r` of `first.png` and `seq/frame_*.png` | ✅ **byte-identical**: 1 + 1 files and 1 + 67 files, zero differences. The 2026-07-22 DICOM fix is preserved. |
| R2 | **Synthetic RGB multiframe** (3 f, planar 0) | ✅ three 3-channel 1164×873 PNGs; **frame 1 == pydicom's decode of the source, max\|diff\| = 0**; frame 2 mean R/G/B 26.7/27.4/28.0 (R↔B swapped, as built); frame 3 13.9/13.6/13.2 (half). Before the patch: 109 KB / 216 KB / 43 KB gray thirds. |
| R2′ | planar 1 variant (20 f) | ✅ identical pixels to the planar-0 run (de-interleave correct) |
| R3 | **Real colour-Doppler still** uploaded to the sandbox server; `GET /api/jobs/:id/frames/0` | ✅ 291,253 B, mean R/G/B 28.0/27.4/26.7, 17,026 colour pixels — the PDI box in colour (before: 109,743 B gray garble). Viewed. |
| R4 | header mask (top 109 px) applied via the API on that job, ZIP downloaded | ✅ `apply.source reuse 1`, `apply.done 63.6 ms`; masked frame: top band mean 0.0, **15,682 colour pixels retained** below it. Viewed. |
| R5 | `npx tsc --noEmit` | ✅ 12 (§2) |
| R6 | real colour-Doppler cine | **open** — none on hand. The synthetic multiframe (same transfer syntax, same interleaved layout) covers the offset arithmetic; a vendor cine may add a compressed transfer syntax, which is a separate, pre-existing boundary (CLAUDE.md "Known untested boundary"). |

## 4. `[PERF] apply.extract_frame` on the RGB path (M4 Pro, one call at a time)

20-frame synthetic RGB cines, 1164×873, 61 MB each; `--perf` arms the apply-path probe (`extractAllFramesSequential`, `perfJobId`).

| layout | `apply.extract_frame` min / median / max | harness ms/frame incl. PNG encode + write |
|---|---|---|
| PlanarConfiguration 0 (interleaved) | 19.8 / **20.5** / 25.6 ms | 22.4 |
| PlanarConfiguration 1 (planar → interleave loop) | 21.5 / **23.0** / 27.4 ms | 24.6 |

The planar de-interleave costs **≈ 2.5 ms per 1 Mpx frame** here (a plain indexed loop over 3 M bytes). Extrapolated to a 318-frame cine: +0.8 s on the M4, perhaps +3 s on the t3.large — on top of a pre-existing cost that dominates: `extractDicomFrame` **re-reads and re-parses the whole file for every frame** (`fs.readFile` + `DicomMessage.readFile` at `:374-376`), so a 318-frame RGB cine (~970 MB) is ~300 GB of reads. That is not new and not item 5's to fix; it is why DICOM extraction at upload is per-frame synchronous (CLAUDE.md, DICOM block). Mono files: R1 shows no change, and the mono ms/frame is unchanged (18.0 → 18.0 single; 18.6 → 19.4 multiframe, noise).

## 5. The batch — three commits on `item5-rgb-dicom`

| commit | files | verification |
|---|---|---|
| `server: only request SO_REUSEPORT on Linux` | `server/index.ts` | already written for the sandbox (`AUTOMASK_SANDBOX_REPORT.md` §3); the server binds on macOS; Linux unchanged |
| `item 5: extract RGB (SamplesPerPixel 3) DICOM frames as RGB` | `server/services/frameExtractor.ts`, `docs/refactor/ITEM5_RGB_DICOM_VERIFICATION.md`, `docs/refactor/ITEM5_REPORT.md`, `scripts/automask_spike/item5_*` | §2–§4 |
| `client: skip PostHog init on localhost or VITE_POSTHOG_DISABLED=1` | `client/src/lib/posthog.ts` | sandbox page on `localhost:5001`: the only `posthog` URLs in the network log are Vite serving the module source; **zero requests to `us.i.posthog.com`**; no console errors. `/@vite/env` carries `VITE_POSTHOG_DISABLED` from `.env.sandbox`. `npm run build` succeeds (guard compiles; prod hostname + unset flag → init as before). |

Each commit reverts alone. The working tree also holds Andre's uncommitted `CLAUDE.md` / `ITEM22_REPORT.md` edits and the untracked automask/sandbox docs and scripts — **deliberately not in these commits**.

## 6. Follow-ups filed (not done here)
1. **`extractDicomImage` is wrong for RGB too** (`frameExtractor.ts:683-880`, `channels: 1` at `:~868`). Unused since Phase 4b except as `extractDicomFrame`'s error fallback; fix = the same RGB branch, or delete with the dead `firstFrame` field (backlog 25). Own item.
2. Per-frame whole-file re-read in `extractDicomFrame` (§4) — parse once, slice per frame. Own item; also what makes DICOM multiframe uploads slow.
3. Compressed DICOM transfer syntaxes (JPEG/J2K/RLE) remain unsupported — unchanged boundary.

## 7. Handoff — what the runbook needs to check on prod
1. Snapshot; deploy the branch (fast-forward `main`); `pm2 restart … --update-env`; `git log -1` on the box matches.
2. `tsc` on the box = 12; boot log unchanged (`serving on port 5000`, `FFmpeg: INSTALLED`).
3. **Mono regression (the guard):** upload one mono multiframe DICOM used before (e.g. the 67-frame `…124429`), draw, Apply, download; compare a masked frame to the pre-deploy ZIP of the same file with the same mask — identical (or run the harness on the box: `npx tsx scripts/automask_spike/item5_rgb_dicom_check.ts <dcm> /tmp/x` before and after, `diff -r`).
4. **The fix:** upload the colour-Doppler still `…094661.dcm`; the canvas shows the PDI box in colour; Apply; the masked frame keeps colour.
5. `reusePort`: no change expected on Linux — confirm the port binds and the `[PERF]` lines flow.
6. PostHog: prod hostname → events still arrive (check one `mask_processing_started` in the PostHog project); no `localhost` events afterwards from sandbox sessions.
7. CLAUDE.md line to add (Andre's tree has uncommitted edits, so not added here): under the DICOM block — *"RGB (SamplesPerPixel 3) DICOM frames extracted as RGB since item 5 (2026-09-04); `extractDicomImage` still mono-only (follow-up)."*
