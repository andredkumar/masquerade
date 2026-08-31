/**
 * Round 2C — pixel comparison between the sharp and ffmpeg apply engines.
 *
 * The two engines use DIFFERENT JPEG encoders (libjpeg-turbo via libvips vs
 * ffmpeg's mjpeg), so bytes will differ and unmasked pixels will differ within
 * JPEG tolerance. Byte-identity is NOT the bar. This checks the bar that is,
 * from ROUND2C_FFMPEG_APPLY_EXPERIMENT.md §3:
 *
 *   masked pixels   every channel <= 8 on both engines after decode
 *                   (JPEG ringing at the box edge is expected on both);
 *                   interior of the box exactly 0 on both
 *   unmasked pixels mean abs diff <= 2.0, p99.9 <= 16, max <= 32
 *
 * It also reports mean bytes/frame per engine — that is the number to calibrate
 * `-q:v` against (APPLY_FFMPEG_QV), which must be within ~10% before any speed
 * comparison means anything.
 *
 * Usage:
 *   npx tsx scripts/compare-apply-engines.ts \
 *     --sharp  <dir of the sharp-engine apply output> \
 *     --ffmpeg <dir of the ffmpeg-engine apply output> \
 *     --mask   /tmp/masq_mask_bbox_<jobId>.png \
 *     --bbox   <x>,<y> \
 *     [--frames 1,174,348]
 *
 * `--mask` and `--bbox` come straight off the `[PERF] apply.engine` line:
 *   {"stage":"apply.engine","engine":"ffmpeg","bbox":"WxH+X+Y","mask_path":"..."}
 * pass the +X+Y part as `--bbox X,Y`.
 *
 * Copy each job's spokes/template_mask/<jobId>/ aside between the two applies —
 * the second apply overwrites the first.
 */

import path from 'path';
import { promises as fs } from 'fs';
import Sharp from 'sharp';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sharpDir = arg('sharp');
const ffmpegDir = arg('ffmpeg');
const maskPath = arg('mask');
const bboxRaw = arg('bbox');

if (!sharpDir || !ffmpegDir || !maskPath || !bboxRaw) {
  console.error('usage: --sharp <dir> --ffmpeg <dir> --mask <png> --bbox <x>,<y> [--frames 1,174,348]');
  process.exit(2);
}
const [bx, by] = bboxRaw.split(',').map(Number);
const wanted = (arg('frames') ?? '1,174,348').split(',').map(Number);

/** Sorted frame files in a job output dir, positional index = frame number. */
async function frames(dir: string): Promise<string[]> {
  const all = await fs.readdir(dir);
  return all.filter(f => /^frame_\d+\.(png|jpe?g)$/i.test(f)).sort();
}

async function meanBytes(dir: string, files: string[]): Promise<number> {
  let total = 0;
  for (const f of files) total += (await fs.stat(path.join(dir, f))).size;
  return files.length ? total / files.length : 0;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const aFiles = await frames(sharpDir);
  const bFiles = await frames(ffmpegDir);
  console.log(`sharp  : ${aFiles.length} frames, ${(await meanBytes(sharpDir, aFiles) / 1024).toFixed(1)} KB/frame mean`);
  console.log(`ffmpeg : ${bFiles.length} frames, ${(await meanBytes(ffmpegDir, bFiles) / 1024).toFixed(1)} KB/frame mean`);
  const sizeRatio = (await meanBytes(ffmpegDir, bFiles)) / Math.max(await meanBytes(sharpDir, aFiles), 1);
  console.log(`size ratio ffmpeg/sharp = ${sizeRatio.toFixed(3)}  ${Math.abs(sizeRatio - 1) <= 0.10 ? 'OK (within 10%)' : 'ADJUST APPLY_FFMPEG_QV — not within 10%'}`);
  console.log(`names  : first=${bFiles[0]} last=${bFiles[bFiles.length - 1]}`);
  if (aFiles.length !== bFiles.length) {
    console.log(`FRAME COUNT MISMATCH ${aFiles.length} vs ${bFiles.length} — FAIL`);
  }

  // The overlay: alpha > 0 marks a redacted pixel, positioned at (bx, by).
  const m = await Sharp(maskPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mw = m.info.width, mh = m.info.height, mc = m.info.channels;

  let anyFail = false;
  for (const n of wanted) {
    const idx = n - 1; // reported frame numbers are 1-based
    if (idx < 0 || idx >= aFiles.length || idx >= bFiles.length) {
      console.log(`\nframe ${n}: out of range, skipped`);
      continue;
    }
    const A = await Sharp(path.join(sharpDir, aFiles[idx])).raw().toBuffer({ resolveWithObject: true });
    const B = await Sharp(path.join(ffmpegDir, bFiles[idx])).raw().toBuffer({ resolveWithObject: true });
    if (A.info.width !== B.info.width || A.info.height !== B.info.height || A.info.channels !== B.info.channels) {
      console.log(`\nframe ${n}: SHAPE MISMATCH ${A.info.width}x${A.info.height}x${A.info.channels} vs ${B.info.width}x${B.info.height}x${B.info.channels} — FAIL`);
      anyFail = true;
      continue;
    }
    const W = A.info.width, H = A.info.height, C = A.info.channels;

    // masked[] over the full frame, plus an eroded interior (>=2 px inside the
    // drawn shape) where JPEG ringing cannot reach and both engines must be 0.
    const masked = new Uint8Array(W * H);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (m.data[(y * mw + x) * mc + (mc - 1)] > 0) {
          const fx = x + bx, fy = y + by;
          if (fx >= 0 && fx < W && fy >= 0 && fy < H) masked[fy * W + fx] = 1;
        }
      }
    }
    const interior = new Uint8Array(W * H);
    const R = 2;
    for (let y = R; y < H - R; y++) {
      for (let x = R; x < W - R; x++) {
        if (!masked[y * W + x]) continue;
        let all = true;
        for (let dy = -R; dy <= R && all; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (!masked[(y + dy) * W + (x + dx)]) { all = false; break; }
          }
        }
        if (all) interior[y * W + x] = 1;
      }
    }

    let maskedMaxA = 0, maskedMaxB = 0, interiorMaxA = 0, interiorMaxB = 0, nInterior = 0;
    let sumAbs = 0, nUnmasked = 0, maxUnmasked = 0;
    const diffs: number[] = [];
    for (let i = 0; i < W * H; i++) {
      const p = i * C;
      if (masked[i]) {
        for (let c = 0; c < 3; c++) {
          if (A.data[p + c] > maskedMaxA) maskedMaxA = A.data[p + c];
          if (B.data[p + c] > maskedMaxB) maskedMaxB = B.data[p + c];
        }
        if (interior[i]) {
          nInterior++;
          for (let c = 0; c < 3; c++) {
            if (A.data[p + c] > interiorMaxA) interiorMaxA = A.data[p + c];
            if (B.data[p + c] > interiorMaxB) interiorMaxB = B.data[p + c];
          }
        }
      } else {
        nUnmasked++;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(A.data[p + c] - B.data[p + c]);
          sumAbs += d;
          if (d > maxUnmasked) maxUnmasked = d;
          diffs.push(d);
        }
      }
    }
    diffs.sort((x, y) => x - y);
    const mean = sumAbs / Math.max(diffs.length, 1);
    const p999 = pct(diffs, 99.9);

    const okMasked = maskedMaxA <= 8 && maskedMaxB <= 8;
    const okInterior = interiorMaxA === 0 && interiorMaxB === 0;
    const okUnmasked = mean <= 2.0 && p999 <= 16 && maxUnmasked <= 32;
    if (!(okMasked && okInterior && okUnmasked)) anyFail = true;

    console.log(`\nframe ${n}  (${W}x${H}x${C}, ${nUnmasked} unmasked px, ${nInterior} interior px)`);
    console.log(`  masked   max sharp=${maskedMaxA} ffmpeg=${maskedMaxB}   (<=8 both)   ${okMasked ? 'PASS' : 'FAIL'}`);
    console.log(`  interior max sharp=${interiorMaxA} ffmpeg=${interiorMaxB}   (==0 both)   ${okInterior ? 'PASS' : 'FAIL'}`);
    console.log(`  unmasked mean=${mean.toFixed(3)} (<=2.0)  p99.9=${p999} (<=16)  max=${maxUnmasked} (<=32)   ${okUnmasked ? 'PASS' : 'FAIL'}`);
  }

  console.log(`\n=== §3 equivalence: ${anyFail ? 'FAIL' : 'PASS'} ===`);
  process.exit(anyFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
