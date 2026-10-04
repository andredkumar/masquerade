/**
 * Output Round 2 — the cost gate of OUTPUT_ROUND2_SIGNOFF.md §4: `apply.validate ms` (the count only), serial, on a
 * 1920 × 1080 Keep mask and on a dpr-2 Keep export (3840 × 2160 PNG → 1920 × 1080), plus real jobs' accepted cones.
 * Runs `checkApplyMask` itself, so the number is the one the server's `[PERF] apply.validate` line carries. Median of 7
 * after one warm-up; also reports `buildApplyMask` on the same mask, for the before/after of commit 1 when pointed at an
 * older tree (run with cwd = a tree root).
 *
 *   UV_THREADPOOL_SIZE=1 npx tsx scripts/output_eval/guard_bench.ts [--job <id> ...] [--server http://localhost:5001]
 * --db-mask <jobId> measures the maskData the browser actually sent for that sandbox job (jobs.mask_data, the last
 * accepted apply) — the real export, dpr and all.
 * Each --job is a sandbox job with raw frames on disk and an auto-mask proposal; its mask is the accepted cone (red outside
 * the keep) and the dims come from its raw frame 0, as in the apply. Nothing is written.
 */
import Sharp from 'sharp';
import { execFileSync } from 'child_process';

Sharp.concurrency(1);
process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';
const args = process.argv.slice(2);
const SERVER = (() => { const i = args.indexOf('--server'); return i >= 0 ? args[i + 1] : 'http://localhost:5001'; })();
const DB_MASKS = args.flatMap((a, i) => (a === '--db-mask' ? [args[i + 1]] : []));
const JOBS = args.flatMap((a, i) => (a === '--job' ? [args[i + 1]] : []));
// The mask builder logs heavily (~200 lines a call). Default: silenced, to time the work; --logs keeps the logging on,
// as in the server (pipe the output to a file to see the cost of the pm2-style sink).
const KEEP_LOGS = args.includes('--logs');
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function maskData(png: Buffer, cw: number, ch: number, w: number, h: number) {
  return {
    type: 'freeform', coordinates: [0, 0, w, h], opacity: 75, aspectRatioMode: 'letterbox', canvasWidth: cw, canvasHeight: ch,
    canvasDataUrl: `data:image/png;base64,${png.toString('base64')}`, originalCanvasDimensions: { width: cw, height: ch },
    imageDimensions: { width: w, height: h }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
}
async function redOutside(cw: number, ch: number, kept: (x: number, y: number) => boolean) {
  const rgba = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (!kept(x, y)) { const o = (y * cw + x) * 4; rgba[o] = 255; rgba[o + 3] = 255; }
  return Sharp(rgba, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
}

(async () => {
  const { VideoProcessor } = await import('../../server/services/videoProcessor');
  const { checkApplyMask } = await import('../../server/services/applyGuard');
  const { renderKeepMask } = await import('../../shared/automask/render');
  const vp: any = new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any);
  const lines: string[] = [];
  const realLog = console.log;

  async function measure(label: string, jobId: string, job: any, md: any, w: number, h: number) {
    const validates: number[] = [], counts: number[] = [], builds: number[] = [];
    let meta: any = null;
    const frame = await Sharp({ create: { width: w, height: h, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
    for (let i = 0; i < 8; i++) {
      console.log = (...a: any[]) => { const s = String(a[0]); if (s.startsWith('[PERF] ') && s.includes('"apply.validate"')) { meta = JSON.parse(s.slice(7)); if (i > 0) validates.push(meta.ms); } };
      await checkApplyMask(vp, jobId, job, md);
      console.log = KEEP_LOGS ? realLog : () => {};
      let t = process.hrtime.bigint(); await vp.countMaskedPixels(md, w, h); if (i > 0) counts.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint(); await vp.buildApplyMask('guard-bench', frame, md); if (i > 0) builds.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    console.log = realLog;
    lines.push(`| ${label} | ${w}×${h} | ${meta.masked_px} (${((meta.masked_px / meta.total_px) * 100).toFixed(1)} %) | ${meta.dims_source} | **${med(validates).toFixed(1)}** | ${med(counts).toFixed(1)} | ${med(builds).toFixed(1)} |`);
  }

  const W = 1920, H = 1080;
  const keepRect = (cw: number, ch: number) => (x: number, y: number) => x >= cw * 0.34 && x < cw * 0.66 && y >= ch * 0.22 && y < ch * 0.78;   // 600 × 600 at 1080p
  await measure('Keep, canvas = frame', 'bench-keep', { jobType: 'video', width: W, height: H }, maskData(await redOutside(W, H, keepRect(W, H)), W, H, W, H), W, H);
  await measure('Keep, dpr-2 canvas export', 'bench-dpr2', { jobType: 'video', width: W, height: H }, maskData(await redOutside(2 * W, 2 * H, keepRect(2 * W, 2 * H)), 2 * W, 2 * H, W, H), W, H);
  await measure('Remove, 300 × 200', 'bench-remove', { jobType: 'video', width: W, height: H }, maskData(await redOutside(W, H, (x, y) => !(x >= 200 && x < 500 && y >= 100 && y < 300)), W, H, W, H), W, H);

  for (const jobId of JOBS) {
    const j: any = await (await fetch(`${SERVER}/api/jobs/${jobId}`)).json();
    const w = j.source.width, h = j.source.height;
    const p: any = await (await fetch(`${SERVER}/api/jobs/${jobId}/template-mask/proposal`)).json();
    if (p.status !== 'ready' || !p.keep) { lines.push(`| job ${jobId.slice(0, 8)} | ${w}×${h} | no proposal (${p.status}) | | | | |`); continue; }
    const grid = renderKeepMask(p.keep, w, h, p.bound, p.margin_px).data;
    await measure(`accepted cone, job ${jobId.slice(0, 8)}`, jobId, { jobType: 'video', width: w, height: h }, maskData(await redOutside(w, h, (x, y) => !!grid[y * w + x]), w, h, w, h), w, h);
  }
  for (const jobId of DB_MASKS) {
    const raw = execFileSync('/opt/homebrew/opt/postgresql@16/bin/psql', ['-h', 'localhost', '-p', '5433', '-U', 'masq', '-d', 'masq', '-tAc', `select mask_data::text from jobs where id='${jobId}'`], { maxBuffer: 1 << 28 }).toString().trim();
    const md = JSON.parse(raw);
    const png = Buffer.from(String(md.canvasDataUrl).split(',')[1], 'base64');
    const m = await Sharp(png).metadata();
    const j: any = await (await fetch(`${SERVER}/api/jobs/${jobId}`)).json();
    await measure(`browser export (PNG ${m.width}×${m.height}, ${(png.length / 1024).toFixed(0)} KB), job ${jobId.slice(0, 8)}`, jobId, { jobType: 'video', width: j.source.width, height: j.source.height }, md, j.source.width, j.source.height);
  }
  console.log('| mask | frame | masked_px | dims_source | apply.validate ms | countMaskedPixels ms | buildApplyMask ms |\n|---|---|---|---|---|---|---|\n' + lines.join('\n'));
})();
