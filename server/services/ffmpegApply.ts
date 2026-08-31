/**
 * Round 2C EXPERIMENT — ffmpeg-driven template-mask apply.
 *
 * Deliberately a separate module, not edits scattered through videoProcessor:
 * `ROUND2C_FFMPEG_APPLY_EXPERIMENT.md` §5 pre-commits to deleting one of the two
 * engines, and if this is the one that loses, deleting it should be `rm` plus
 * one small branch in `processVideo` — not an archaeology exercise.
 *
 * The idea: the sharp loop moves 3.7 MB of raw pixels per frame in and out of
 * Node to zero ~1,500 bytes, 348 times, with 58 stacks queueing on a 4-thread
 * libuv pool. 2B-3b showed what a single multithreaded ffmpeg process does to
 * that shape on this box (45 s → 8 s). So: let one ffmpeg process read the raw
 * PNG sequence, overlay the mask, and write the JPEG sequence.
 *
 * The overlay is the prebuilt mask CROPPED TO ITS BOUNDING BOX, so ffmpeg only
 * touches the drawn region — this is not 2B-3a's full-frame composite, which
 * lost precisely because it did whole-frame arithmetic to change 0.12 % of it.
 * Arbitrary shapes are carried by the overlay's alpha; no rectangle assumption.
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import Sharp from 'sharp';

export type ApplyEngine = 'sharp' | 'ffmpeg';

/**
 * Which engine this process runs. Default is `sharp` — the deployed path —
 * so an unset env is exactly today's behavior.
 */
export function resolveApplyEngine(): ApplyEngine {
  return process.env.APPLY_ENGINE === 'ffmpeg' ? 'ffmpeg' : 'sharp';
}

/** mjpeg `-q:v`. Env-overridable so the operator can calibrate on the box. */
export function resolveQv(): string {
  const raw = process.env.APPLY_FFMPEG_QV;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 31 ? String(n) : '2';
}

export interface BboxMask {
  /** Absolute path of the RGBA PNG handed to ffmpeg as the overlay input. */
  filePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

/**
 * Crop the prebuilt mask to its bounding box and write it as an RGBA PNG:
 * black with alpha 255 where the mask redacts, fully transparent elsewhere.
 *
 * Consumes `buildApplyMask`'s output — the mask is not rebuilt or reinterpreted
 * here, so both engines mask exactly the same pixels by construction.
 *
 * Written to the OS temp dir rather than anywhere under `temp_extracted/` or
 * `spokes/template_mask/`: both of those are listed by extension
 * (`listFrameFiles` / `listRawFrameFiles` match any `.png`), so a stray PNG in
 * either would be picked up as a frame and corrupt the frame count.
 * The path is logged on `apply.engine` so the comparison script can find it,
 * and the file is deliberately NOT deleted after the apply — §4.4 of the
 * experiment doc runs the pixel comparison against it afterwards. It is a few
 * KB in the OS temp dir and goes away on reboot.
 */
export async function writeBboxMask(
  jobId: string,
  frameWidth: number,
  maskedOffsets: Uint32Array,
): Promise<BboxMask | null> {
  if (maskedOffsets.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let k = 0; k < maskedOffsets.length; k++) {
    const idx = maskedOffsets[k] / 3;
    const x = idx % frameWidth;
    const y = (idx - x) / frameWidth;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const rgba = Buffer.alloc(bw * bh * 4); // zeroed = transparent black
  for (let k = 0; k < maskedOffsets.length; k++) {
    const idx = maskedOffsets[k] / 3;
    const x = idx % frameWidth;
    const y = (idx - x) / frameWidth;
    rgba[((y - minY) * bw + (x - minX)) * 4 + 3] = 255; // RGB stays 0 = black
  }

  const filePath = path.join(os.tmpdir(), `masq_mask_bbox_${jobId}.png`);
  await fs.writeFile(
    filePath,
    await Sharp(rgba, { raw: { width: bw, height: bh, channels: 4 } }).png().toBuffer(),
  );

  return { filePath, x: minX, y: minY, width: bw, height: bh, pixels: maskedOffsets.length };
}

export interface FfmpegApplyParams {
  rawDir: string;
  outDir: string;
  mask: BboxMask;
  expectedFrames: number;
  onProgress?: (framesDone: number) => void;
}

/**
 * One ffmpeg process: raw PNG sequence + bbox overlay → JPEG sequence.
 *
 * Returns the number of frames written, or throws. The caller decides whether
 * a mismatch or a throw means "fall back to sharp" — this function never
 * silently substitutes a different result.
 */
export async function runFfmpegApply(params: FfmpegApplyParams): Promise<number> {
  const { rawDir, outDir, mask, onProgress } = params;

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      // `-start_number 1` matches the 1-indexed frame_%06d.png the extractor
      // writes; image2 reads the sequence in order and emits one output per
      // input, which is what preserves the Phase 6 co-indexing invariant.
      .input(path.join(rawDir, 'frame_%06d.png'))
      .inputOptions(['-start_number', '1'])
      .input(mask.filePath)
      .complexFilter(
        `[0:v][1:v]overlay=x=${mask.x}:y=${mask.y}:format=auto[out]`,
        ['out'],
      )
      // `-start_number 0` on the OUTPUT is required, not cosmetic. The experiment
      // doc says the masked output is "frame_%06d.jpg 1-indexed", but the
      // deployed sharp path writes masked frames **0-indexed** —
      // `frame_000000.<ext>` … `frame_000347.<ext>` — because its save loop pads
      // `frameNumber`, which starts at 0. (Only the RAW frames in
      // temp_extracted/ are 1-indexed.) `frameAccess.resolveFramePath` builds a
      // masked-frame name straight from the index, so 1-indexed output would 404
      // frame 0 and serve every other frame off by one through
      // GET /api/jobs/:jobId/frames/:n.png. Matching the deployed convention also
      // makes the two engines produce identical filenames, which is what the
      // comparison in §3 wants.
      .outputOptions(['-q:v', resolveQv(), '-threads', '0', '-start_number', '0'])
      .output(path.join(outDir, 'frame_%06d.jpg'))
      .on('progress', (p: { frames?: number }) => {
        if (onProgress && typeof p.frames === 'number') onProgress(p.frames);
      })
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`ffmpeg apply failed: ${err.message}`)))
      .run();
  });

  const written = (await fs.readdir(outDir)).filter(f => /^frame_\d+\.jpg$/.test(f));
  return written.length;
}
