# Backlog item 5 — RGB DICOM extraction: VERIFIED as a live bug (single-frame too)

**Date:** 2026-09-04. **Asked by:** `AUTOMASK_ROUND1_AMENDMENT.md` §6 ("confirm or clear … before 2A, as its own item with its own revert"). **Status:** confirmed; **fix applied 2026-09-04 per `AUTOMASK_2A_DECISIONS.md` §2 — results in `ITEM5_REPORT.md`.** The diff below is what was applied — the DICOM branch is frozen for the automask rounds and this ships as its own commit when Andre says so. **Tree:** `main` @ `dc45954`.

## 1. Verdict in one paragraph
Any DICOM with `SamplesPerPixel = 3` (colour Doppler, RGB export) is extracted wrongly by the path that feeds the canvas and the apply: `extractDicomFrame` sizes a frame as `rows × cols × bytesPerSample`, ignoring `SamplesPerPixel`, so it reads **one third** of the interleaved RGB bytes and the helper writes them out as a mono image. The result is a vertically stretched, line-banded top-third of the picture for "frame 1", the middle third for "frame 2", the bottom third for "frame 3". **It is not only the multiframe case the backlog described: the two real colour-Doppler single-frame files on hand come out garbled too**, because upload-time extraction goes through the same function for frame 0. Prod has shown that garbled frame on the canvas for every colour-Doppler DICOM upload since the DICOM apply-path fix (2026-07-22) made DICOM uploads work at all.

## 2. Evidence (sandbox, `AUTOMASK_SANDBOX_REPORT.md` stack)

No colour-Doppler cine was available, so a 3-frame RGB multiframe was **synthesised from a real GE LOGIQ E9 colour-Doppler single-frame file** (`sandbox/clips/ge_logiq/ge_e9_6193094661.dcm`: 1164×873, `SamplesPerPixel 3`, `PlanarConfiguration 0`, `BitsAllocated 8`, Explicit VR LE `1.2.840.10008.1.2.1`) by `scripts/automask_spike/item5_make_synthetic_rgb_multiframe.py` (frame 2 = R/B swapped, frame 3 = half intensity; patient fields overwritten). Same transfer syntax, same layout a real RGB cine export has.

| run | path exercised | result |
|---|---|---|
| `npx tsx scripts/automask_spike/item5_rgb_dicom_check.ts` | `extractVideoMetadata` → `frames: 3` ✓. `extractFirstFrame` → `extractDicomImage`: 1164×873 PNG that *decodes* to 3 channels but is gray (see the correction in §3 — this path is wrong too, and unused). `extractAllFramesSequential` (DICOM branch `:206-218` → `extractDicomFrame`) | 3 PNGs written; log says `✅ Successfully extracted 1016172 bytes for frame 0/1/2` — **1,016,172 = 873 × 1164 × 1**, one third of the 3,048,516 bytes an RGB frame has. Files 109,743 / 216,372 / 43,459 B. |
| Upload the synthetic through the sandbox server (`POST /api/uploads/video`) | `startBackgroundFrameExtraction` DICOM batch loop (`videoProcessor.ts:1451-1486` → `extractFrameBatch` → `extractDicomFrame`, `frameExtractor.ts:929+`) | `bg_extract.done {frames:3, parity:true, outcome:'ok'}` — **the pipeline reports success.** `GET /frames/0,1,2` → 200. Viewed: frame 1 = top third of the image stretched 3× with horizontal banding (the header + `LOGIQ E9` + top of the trapezoid); frame 2 = middle third (PDI panel, colour box outline, no colour); frame 3 = bottom third (`RT BT LONG`). No colour anywhere — the PNGs are mono content in a 3-channel container. |
| Upload the **real** single-frame colour-Doppler file | same loop, `totalFrames = 1` | `GET /frames/0` → 109,743 B, **byte-identical (md5 `b7af7480…`) to the synthetic's frame 1** — i.e. the garbled top third. This is what the template-mask canvas shows for that file today, and what `tryReuseRawFrames` would feed to Apply. |

Contact: `/tmp/item5/` (synthetic `.dcm`, `first_frame.png` correct, `srv_frame_{0,1,2}.png` garbled, `rgb1_frame0.png`). Temporary; regenerate with the two scripts.

## 3. Root cause (`server/services/frameExtractor.ts`)

- `extractDicomFrame` `:396-397`: `const bytesPerFrame = rows * cols * (bitsAllocated / 8); const frameOffset = frameIndex * bytesPerFrame;` — no `SamplesPerPixel`.
- `:529` (and the `tryRawDicomPixelData` twin `:565`): `new Uint8Array(pixelBuffer, frameOffset, bytesPerFrame)` — slices one third of the data.
- `processDicomPixelDataHelper` `:655-675`: `expectedSize = rows * cols`, output `sharp(raw, {channels: 1})` — mono by construction; for 3-sample data it truncates to the first `rows×cols` bytes of interleaved RGB and rasterises them as gray → the stretch and the banding.
- `detectDicomFrameCount` `:122-138`: the size-based estimate (`pixelDataSize / (rows*cols*bytes)`) also ignores `SamplesPerPixel`; it only runs when `NumberOfFrames` is absent, in which case an RGB single-frame would be counted as **3 frames**.
- **Correction (found while verifying the fix):** `extractFirstFrame` → `extractDicomImage` (`:683+`) is **also wrong for RGB** — it writes `channels: 1` too (`:~868`); the `channels: 3` at `:893` belongs to `createPlaceholderImage`, not an RGB path. Its output for the colour-Doppler still is a gray image with the same 50.2 mean as the garbled frame. It has no user impact because nothing consumes that buffer since Phase 4b (the dead base64 `firstFrame`, backlog item 25) and it is only otherwise reached as `extractDicomFrame`'s error fallback. Left untouched per the item 5 scope ("nothing else in `frameExtractor.ts`"); listed as a follow-up in `ITEM5_REPORT.md`. The R2 oracle is therefore **pydicom's decode**, not `extractFirstFrame`.

## 4. Fix (proposed diff — NOT applied)

```ts
// extractDicomFrame (:390-397) and tryRawDicomPixelData (:543+): size a frame by all its samples
const samplesPerPixel = dataset.SamplesPerPixel || 1;
const planar = dataset.PlanarConfiguration || 0;
const bytesPerFrame = rows * cols * (bitsAllocated / 8) * samplesPerPixel;
…
return this.processDicomPixelDataHelper(dataset, framePixelData, rows, cols, bitsAllocated, samplesPerPixel, planar);

// processDicomPixelDataHelper (:599): honour channels
private async processDicomPixelDataHelper(dataset, pixelDataArray, rows, cols, bitsAllocated, samplesPerPixel = 1, planar = 0) {
  …
  if (samplesPerPixel === 3) {
    let rgb = pixelDataArray;                       // 8-bit RGB is the only colour case in DICOM ultrasound
    if (planar === 1) {                             // RRR…GGG…BBB → interleave
      const n = rows * cols, out = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { out[i*3] = rgb[i]; out[i*3+1] = rgb[n+i]; out[i*3+2] = rgb[2*n+i]; }
      rgb = out;
    }
    return sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rows * cols * 3), { raw: { width: cols, height: rows, channels: 3 } }).png().toBuffer();
  }
  // existing mono path unchanged below (expectedSize = rows * cols)
```
Plus `detectDicomFrameCount`: `expectedBytesPerFrame = rows * cols * (bitsAllocated / 8) * (dataset.SamplesPerPixel || 1)`.

Blast radius: DICOM branch only; mono DICOMs take the exact same code path as today (`samplesPerPixel = 1` → `bytesPerFrame` unchanged → helper's mono branch unchanged), so the byte-identical guard from the 2026-07-22 fix holds for them. `tsc` should stay 12 (the 5 deferred `pixelBuffer` errors are in this function; touch only the lines above and re-count).

## 5. Verification plan for the fix (sandbox)
| # | step | pass |
|---|---|---|
| R1 | mono single-frame + mono multiframe (67 f) upload before/after the patch | raw PNGs byte-identical (`cmp` over `temp_extracted/<job>/`) |
| R2 | `item5_rgb_dicom_check.ts` | `extractAllFramesSequential` frames are 3-channel, 1164×873, and frame 1 == **pydicom's decode of the source** pixel-for-pixel; frame 2 shows swapped colours; frame 3 half intensity |
| R3 | upload the real colour-Doppler still | `GET /frames/0` shows the colour Doppler box in colour; canvas paints it |
| R4 | apply a header mask on it, download | masked frame keeps the colour box |
| R5 | `tsc --noEmit` | 12 |
| R6 | a real colour-Doppler cine, when Andre has one | frames in colour, count = `NumberOfFrames`, `parity:true` |

## 6. Interaction with automask
None blocking. The proposer reads whatever PNG is in `temp_extracted/`; on a garbled RGB frame it would fit garbage (the spike's `dcm_single_rgb` result used pydicom's correct frame, not the app's). Ship item 5 before relying on colour-Doppler clips in D5, or exclude them from the seven until then.
