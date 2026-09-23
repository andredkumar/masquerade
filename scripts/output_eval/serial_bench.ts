/**
 * Output Round 1b — step 1 measurement (docs/refactor/OUTPUT_ROUND1B_KICKOFF.md §2): what the crop costs per frame
 * when nothing can hide it behind parallelism.
 *
 * Replays the batch path's per-frame steps (`videoProcessor.processFrameBatch`) STRICTLY ONE FRAME AT A TIME on a job's
 * raw frames, with the server's own functions — `buildApplyMask` (via a VideoProcessor instance), `keepBbox`,
 * `planOutputTransform`, `applyOutputTransform` — and times, per frame:
 *   decode     Sharp(png) → metadata → raw                                   (the batch path's Step 1)
 *   mask       the offsets loop over ALL the masked pixels                    (Step 3 before Round 1b)
 *   mask_f2    the same loop over the offsets inside the crop only             (Round 1b F2: planPrebuiltMask's filter)
 *   enc_old    c909d36's pipeline: Sharp(raw)[.resize(whole frame)].jpeg(q90) (no resize at size 'original')
 *   enc_new    applyOutputTransform(Sharp(raw), plan).jpeg(q90)               (2dea93e: extract/extend fused into the encode)
 *   naive      the wall time of the applyOutputTransform() CALL alone         (what a moved perfSpan boundary would record)
 *   xf_mat     applyOutputTransform(Sharp(raw), plan).raw()                   (the transform executed on its own)
 *   enc_after  Sharp(xf raw).jpeg(q90)                                        (the encode that follows a materialized transform)
 * The four variants rotate order per frame so no variant always runs cold. It also checks that encoding a materialized
 * transform yields the same bytes as the fused pipeline (whether a split instrument would change the output), and that
 * the F2-masked frame encodes to the same bytes as the fully masked one (the pixel-equivalence of F2 on real frames).
 *
 * Serial mode is the environment, not a flag: run with UV_THREADPOOL_SIZE=1 and --concurrency 1 (sharp.concurrency).
 *
 *   UV_THREADPOOL_SIZE=1 npx tsx scripts/output_eval/serial_bench.ts --job <id> --concurrency 1 \
 *       [--server http://localhost:5001] [--size original|512x512] [--mode letterbox|crop] [--frames 348] [--out <md>]
 *       [--mask proposal | keep-rect:x,y,w,h]      (default: the job's auto-mask proposal, i.e. the accepted cone)
 * Reads temp_extracted/<job>/ and, for --mask proposal, the job's auto-mask proposal (the prod P4 row), so run it
 * from the repo root with the sandbox server up. No DB writes; nothing leaves the sandbox.
 */
import path from 'path';
import { promises as fs } from 'fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const JOB = opt('--job')!;
const SERVER = opt('--server', 'http://localhost:5001')!;
const CONC = Number(opt('--concurrency', '1'));
const SIZE = opt('--size', 'original')!;
const MODE = (opt('--mode', 'letterbox') as 'letterbox' | 'crop');
const LIMIT = Number(opt('--frames', '100000'));
const OUT = opt('--out');
const MASK = opt('--mask', 'proposal')!;

type Stat = { mean: number; p50: number; p90: number; n: number };
function stat(xs: number[]): Stat {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: q(0.5), p90: q(0.9), n: xs.length };
}
const f2 = (v: number) => v.toFixed(2);
const since = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;

(async () => {
  if (!JOB) throw new Error('--job is required');
  process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';   // the storage module's import-time guard; nothing here queries it
  const Sharp = (await import('sharp')).default;
  if (CONC > 0) Sharp.concurrency(CONC);
  const { VideoProcessor } = await import('../../server/services/videoProcessor');
  const { keepBbox, planOutputTransform, applyOutputTransform, offsetsInCrop } = await import('../../server/services/outputTransform');
  const { renderKeepMask } = await import('../../shared/automask/render');
  const vp: any = new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any);

  const dir = path.resolve('temp_extracted', JOB);
  const files = (await fs.readdir(dir)).filter((f) => /^frame_\d+\.png$/.test(f)).sort().slice(0, LIMIT);
  const frame0 = await fs.readFile(path.join(dir, files[0]));
  const meta0 = await Sharp(frame0).metadata();
  const W = meta0.width!, H = meta0.height!;

  // the mask: the accepted auto-mask cone (the prod P4 row) or a drawn Keep rectangle (the prod Keep job's shape);
  // either way red outside the keep, the browser's convention
  let keepGrid: Uint8Array;
  if (MASK === 'proposal') {
    const p = await (await fetch(`${SERVER}/api/jobs/${JOB}/template-mask/proposal`)).json();
    if (p.status !== 'ready' || !p.keep) throw new Error(`no proposal: ${p.status} ${p.reason ?? ''}`);
    keepGrid = renderKeepMask(p.keep, W, H, p.bound, p.margin_px).data;
  } else if (MASK.startsWith('keep-rect:')) {
    const [kx, ky, kw, kh] = MASK.slice(10).split(',').map(Number);
    keepGrid = new Uint8Array(W * H);
    for (let y = ky; y < ky + kh; y++) for (let x = kx; x < kx + kw; x++) keepGrid[y * W + x] = 1;
  } else throw new Error(`--mask ${MASK}?`);
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) if (!keepGrid[i]) { rgba[i * 4] = 255; rgba[i * 4 + 3] = 255; }
  const png = await Sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const maskData = {
    type: 'freeform', coordinates: [0, 0, W, H], opacity: 75, aspectRatioMode: MODE, canvasWidth: W, canvasHeight: H,
    canvasDataUrl: `data:image/png;base64,${png.toString('base64')}`, originalCanvasDimensions: { width: W, height: H },
    imageDimensions: { width: W, height: H }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
  const prebuilt = await vp.buildApplyMask(JOB, frame0, maskData);
  const bbox = keepBbox(prebuilt.maskRgba, W, H);
  const outSize = SIZE === 'original' ? { width: W, height: H } : { width: +SIZE.split('x')[0], height: +SIZE.split('x')[1] };
  const plan = planOutputTransform(bbox, W, H, SIZE, MODE, outSize);
  const offsets: Uint32Array = prebuilt.maskedOffsets;
  const tf = process.hrtime.bigint();
  const offsetsF2 = offsetsInCrop(offsets, W, H, plan.crop);            // what planPrebuiltMask does once per apply
  const filterMs = since(tf);

  const T: Record<string, number[]> = { decode: [], mask: [], mask_f2: [], enc_old: [], enc_new: [], naive: [], xf_mat: [], enc_after: [] };
  let bytesEqual = 0, bytesDiffer = 0, f2Equal = 0, f2Differ = 0;
  const t0all = process.hrtime.bigint();
  for (let fi = 0; fi < files.length; fi++) {
    const buf = await fs.readFile(path.join(dir, files[fi]));
    let t = process.hrtime.bigint();
    const img = Sharp(buf);
    await img.metadata();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    T.decode.push(since(t));
    const dataF2 = Buffer.from(data);                                   // an unmasked copy for the F2 loop (untimed)
    const loops = [
      () => { const t1 = process.hrtime.bigint(); for (let k = 0; k < offsets.length; k++) { const o = offsets[k]; data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; } T.mask.push(since(t1)); },
      () => { const t1 = process.hrtime.bigint(); for (let k = 0; k < offsetsF2.length; k++) { const o = offsetsF2[k]; dataF2[o] = 0; dataF2[o + 1] = 0; dataF2[o + 2] = 0; } T.mask_f2.push(since(t1)); },
    ];
    if (fi % 2) { loops[1](); loops[0](); } else { loops[0](); loops[1](); }
    const raw = { raw: { width: info.width, height: info.height, channels: info.channels as 3 } };
    let fused: Buffer | null = null, split: Buffer | null = null;
    // c909d36's batch path (videoProcessor.ts:1756-1786 at that commit): no resize when the output equals the frame,
    // else resize the WHOLE frame with the mode's fit, lanczos3, black background.
    const oldPipeline = () => {
      const s = Sharp(data, raw);
      if (outSize.width === W && outSize.height === H) return s;
      return s.resize(outSize.width, outSize.height, MODE === 'crop'
        ? { kernel: 'lanczos3', fit: 'cover' }
        : { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } });
    };
    const variants: Array<() => Promise<void>> = [
      async () => { const t1 = process.hrtime.bigint(); await oldPipeline().jpeg({ quality: 90 }).toBuffer(); T.enc_old.push(since(t1)); },
      async () => { const t1 = process.hrtime.bigint(); fused = await applyOutputTransform(Sharp(data, raw), plan).jpeg({ quality: 90 }).toBuffer(); T.enc_new.push(since(t1)); },
      async () => {
        const t1 = process.hrtime.bigint(); const piped = applyOutputTransform(Sharp(data, raw), plan); T.naive.push(since(t1));
        await piped.jpeg({ quality: 90 }).toBuffer();   // executed but not timed: the naive boundary only sees the graph build
      },
      async () => {
        const t1 = process.hrtime.bigint(); const x = await applyOutputTransform(Sharp(data, raw), plan).raw().toBuffer({ resolveWithObject: true }); T.xf_mat.push(since(t1));
        const t2 = process.hrtime.bigint(); split = await Sharp(x.data, { raw: { width: x.info.width, height: x.info.height, channels: x.info.channels as 3 } }).jpeg({ quality: 90 }).toBuffer(); T.enc_after.push(since(t2));
      },
    ];
    for (let k = 0; k < variants.length; k++) await variants[(fi + k) % variants.length]();
    if (fused && split) { if (Buffer.compare(fused, split) === 0) bytesEqual++; else bytesDiffer++; }
    const fusedF2 = await applyOutputTransform(Sharp(dataF2, raw), plan).jpeg({ quality: 90 }).toBuffer();
    if (fused && Buffer.compare(fused, fusedF2) === 0) f2Equal++; else f2Differ++;
  }
  const wallAll = since(t0all);

  const S = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, stat(v)])) as Record<string, Stat>;
  const added = S.enc_new.mean - S.enc_old.mean;
  const lines = [
    `### serial_bench — job ${JOB.slice(0, 8)} ${W}×${H}, ${files.length} frames, ${MODE} · ${SIZE}, sharp.concurrency ${Sharp.concurrency()}, UV_THREADPOOL_SIZE ${process.env.UV_THREADPOOL_SIZE ?? 'default(4)'}`,
    '',
    `mask ${MASK}; keep bbox ${JSON.stringify(bbox)} → crop ${JSON.stringify(plan.crop)} offset ${JSON.stringify(plan.offset)} output ${plan.output.w}×${plan.output.h} resampled ${plan.resampled}; masked px ${prebuilt.maskedPixels} of ${W * H}`,
    `F2: offsets ${offsets.length} → ${offsetsF2.length} inside the crop (filter once per apply: ${f2(filterMs)} ms)`,
    '',
    '| step | mean ms | p50 | p90 |',
    '|---|---|---|---|',
    ...Object.entries(S).map(([k, s]) => `| ${k} | ${f2(s.mean)} | ${f2(s.p50)} | ${f2(s.p90)} |`),
    '',
    `enc_new − enc_old (the crop's added cost inside the fused pipeline): **${f2(added)} ms/frame** (${f2(100 * added / S.enc_old.mean)} % of the old encode)`,
    `xf_mat (the transform executed alone): **${f2(S.xf_mat.mean)} ms/frame**; naive boundary (graph build only): ${f2(S.naive.mean)} ms/frame`,
    `materialized split → encode bytes equal to the fused pipeline on ${bytesEqual}/${bytesEqual + bytesDiffer} frames`,
    `mask − mask_f2 (F2's saving): **${f2(S.mask.mean - S.mask_f2.mean)} ms/frame**; F2-masked frame encodes to the same bytes as the fully masked one on ${f2Equal}/${f2Equal + f2Differ} frames`,
    `wall for the whole run: ${(wallAll / 1000).toFixed(1)} s`,
    '',
  ];
  console.log(lines.join('\n'));
  if (OUT) { await fs.appendFile(path.resolve(OUT), lines.join('\n') + '\n'); console.log(`appended ${OUT}`); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
