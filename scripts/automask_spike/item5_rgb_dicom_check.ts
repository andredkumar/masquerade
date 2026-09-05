// Backlog item 5 repro / verification harness (docs/refactor/ITEM5_RGB_DICOM_VERIFICATION.md, ITEM5_REPORT.md).
//
//   npx tsx scripts/automask_spike/item5_rgb_dicom_check.ts <file.dcm> <outDir> [--perf]
//
// Runs the app's own DICOM paths on one file and writes what they produce:
//   <outDir>/first.png   ← extractFirstFrame (→ extractDicomImage; the path that already handled RGB)
//   <outDir>/seq/        ← extractAllFramesSequential (DICOM branch → extractDicomFrame; the canvas/apply path)
// and prints, per frame: size, channels, byte length, mean R/G/B of the decoded pixels, and whether frame 1's
// decoded pixels equal first.png's. With --perf the apply-path `[PERF] apply.extract_frame` probe is armed.
// Pure read of the input; safe to run before and after a patch and `cmp -r` the two outDirs (R1).
import { FrameExtractor } from '../../server/services/frameExtractor';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const [, , file, outDir, ...flags] = process.argv;
if (!file || !outDir) { console.error('usage: item5_rgb_dicom_check.ts <file.dcm> <outDir> [--perf]'); process.exit(2); }
const perf = flags.includes('--perf');
const fx = new FrameExtractor();
await fs.mkdir(path.join(outDir, 'seq'), { recursive: true });

const t0 = Date.now();
const meta = await fx.extractVideoMetadata(file);
console.log('metadata', JSON.stringify({ w: meta.width, h: meta.height, frames: meta.totalFrames, isDicom: meta.isDicom }));

const first = await fx.extractFirstFrame(file);
await fs.writeFile(path.join(outDir, 'first.png'), first);
const firstRaw = await sharp(first).raw().toBuffer({ resolveWithObject: true });
console.log('extractFirstFrame →', firstRaw.info.width, firstRaw.info.height, 'channels', firstRaw.info.channels);

const t1 = Date.now();
const paths = await fx.extractAllFramesSequential(file, path.join(outDir, 'seq'), meta.duration, path.basename(file), null, meta.frameRate, perf ? 'item5' : undefined);
const t2 = Date.now();
console.log(`extractAllFramesSequential → ${paths.length} files in ${t2 - t1} ms (${((t2 - t1) / Math.max(1, paths.length)).toFixed(1)} ms/frame incl. PNG encode + write)`);

for (const [i, p] of paths.entries()) {
  const buf = await fs.readFile(p);
  const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  const sums = [0, 0, 0, 0]; const n = width * height;
  for (let k = 0; k < n; k++) for (let c = 0; c < channels; c++) sums[c] += raw.data[k * channels + c];
  const means = sums.slice(0, channels).map(s => (s / n).toFixed(1)).join('/');
  const sameAsFirst = i === 0 && channels === firstRaw.info.channels && Buffer.compare(raw.data, firstRaw.data) === 0;
  if (i < 4 || i === paths.length - 1) {
    console.log(`  ${path.basename(p)} ${width}x${height} ch=${channels} bytes=${buf.length} mean(${channels === 3 ? 'R/G/B' : 'gray'})=${means}${i === 0 ? ` frame1==first.png:${sameAsFirst}` : ''}`);
  }
}
console.log(`total ${Date.now() - t0} ms`);
