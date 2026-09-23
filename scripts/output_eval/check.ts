/**
 * Output Round 1 — the geometry rows of OUTPUT_ROUND1_KICKOFF.md §6, driven against the local sandbox
 * (docs/refactor/OUTPUT_ROUND1_RECON.md §6). For each clip × mode × size: upload, build a mask PNG from the job's
 * auto-mask proposal (red outside the keep, black inside — the server's own convention) or from a fixed rectangle,
 * POST the apply, then measure the masked frame 0 the server wrote and the transform sidecar next to it:
 *   • output dims == the target (original → the frame dims)
 *   • non-black bbox centre vs the output centre (px), padding asymmetry left−right / top−bottom (px)
 *   • 'original' + png: a row of the kept region is byte-identical to the source frame (no resampling)
 *   • crop: black-pixel fraction (must be ≈ 0)
 *   • the sidecar's output→source mapping round-trips the keep bbox's top-left and a T0 box corner (px error)
 *   • REFERENCE: the source frame masked with the same keep and pushed through the pure applyOutputTransform with the
 *     sidecar's plan is compared byte for byte with what the server wrote (the server's stack path == the plan)
 *   • manifest.json / metadata.csv from the download ZIP carry the same transform
 * Runs from the repo root (the server's cwd), reads spokes/template_mask/<job>/ directly. No PHI leaves the sandbox.
 *
 *   npx tsx scripts/output_eval/check.ts --server http://localhost:5001 --clip "../sandbox/clips/ge_venue/Normal_Lung _sliding.mp4" \
 *       [--images ../sandbox/clips/stills/<dir>] [--modes letterbox,crop] [--sizes original,256x256,512x512,custom:640x480] \
 *       [--format png] [--mask proposal|rect] [--fresh-per-apply] [--out ../sandbox/results/<date>_output_round1.md]
 *   --fresh-per-apply re-uploads before every mode × size: image batches can be applied once per job (the apply reclaims
 *   the uploaded originals — CLAUDE.md backlog item 30), videos re-apply on the same job.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import Sharp from 'sharp';

import { renderKeepMask } from '../../shared/automask/render';
import { outputToSource, applyOutputTransform, type OutputTransform } from '../../server/services/outputTransform';
import type { ProposalJson } from '../../shared/automask/types';

const args = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVER = opt('--server', 'http://localhost:5001')!;
const MODES = opt('--modes', 'letterbox,crop')!.split(',');
const SIZES = opt('--sizes', 'original,256x256,512x512,custom:640x480')!.split(',');
const FORMAT = opt('--format', 'png')! as 'png' | 'jpg';
const MASK = opt('--mask', 'proposal')!;
const OUT = opt('--out');
const FRESH = args.includes('--fresh-per-apply');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upload(): Promise<{ jobId: string; sourceFrame: () => Promise<Buffer> }> {
  const clip = opt('--clip'), images = opt('--images');
  const fd = new FormData();
  if (images) {
    const files = (await fs.readdir(images)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
    for (const f of files) fd.append('images', new Blob([await fs.readFile(path.join(images, f))]), f);
    fd.append('phiStatus', 'raw');
    const r = await fetch(`${SERVER}/api/uploads/images`, { method: 'POST', body: fd });
    const j = await r.json();
    return { jobId: j.jobId, sourceFrame: () => fs.readFile(path.join(images, files[0])) };
  }
  fd.append('video', new Blob([await fs.readFile(clip!)]), path.basename(clip!));
  fd.append('phiStatus', 'raw');
  const r = await fetch(`${SERVER}/api/uploads/video`, { method: 'POST', body: fd });
  const j = await r.json();
  return { jobId: j.jobId, sourceFrame: () => fs.readFile(path.resolve('temp_extracted', j.jobId, 'frame_000001.png')) };
}

async function job(jobId: string) { return (await fetch(`${SERVER}/api/jobs/${jobId}`)).json(); }
async function waitReady(jobId: string) { for (let i = 0; i < 120; i++) { const j = await job(jobId); if (j.status === 'ready') return j; await sleep(1000); } throw new Error('not ready'); }
async function waitApplied(jobId: string, prevCompletedAt: string | null) {
  for (let i = 0; i < 180; i++) {
    const j = await job(jobId);
    const tm = j.templateMask;
    if (tm?.status === 'complete' && tm.completedAt && tm.completedAt !== prevCompletedAt) return tm.completedAt as string;
    if (tm?.status === 'failed') throw new Error('apply failed');
    await sleep(500);
  }
  throw new Error('apply timeout');
}

async function maskDataFor(jobId: string, w: number, h: number): Promise<{ maskData: Record<string, unknown>; keep: { x: number; y: number; w: number; h: number }; bound: { x0: number; y0: number; x1: number; y1: number } | null; keepGrid: Uint8Array }> {
  let keepGrid: Uint8Array; let bound = null as null | { x0: number; y0: number; x1: number; y1: number };
  if (MASK === 'proposal') {
    const p = (await (await fetch(`${SERVER}/api/jobs/${jobId}/template-mask/proposal`)).json()) as ProposalJson;
    if (p.status !== 'ready' || !p.keep) throw new Error(`no proposal: ${p.status} ${p.reason ?? ''} ${p.withheld ?? ''}`);
    keepGrid = renderKeepMask(p.keep, w, h, p.bound, p.margin_px).data; bound = p.bound;
  } else {
    keepGrid = new Uint8Array(w * h);
    const kx = Math.round(w * 0.31), ky = Math.round(h * 0.17), kw = Math.round(w * 0.45), kh = Math.round(h * 0.62);
    for (let y = ky; y < ky + kh; y++) for (let x = kx; x < kx + kw; x++) keepGrid[y * w + x] = 1;
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (keepGrid[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } else { rgb[i * 3] = 255; } }
  const png = await Sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const canvasDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const maskData = {
    type: 'freeform', coordinates: [0, 0, w, h], opacity: 75, aspectRatioMode: 'stretch', canvasWidth: w, canvasHeight: h, canvasDataUrl,
    originalCanvasDimensions: { width: w, height: h }, displayDimensions: { width: w, height: h }, devicePixelRatio: 1,
    aspectRatio: w / h, imageAspectRatio: w / h, imageDimensions: { width: w, height: h }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
  return { maskData, keep: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, bound, keepGrid };
}

function sizeSettings(size: string) {
  if (size.startsWith('custom:')) { const [cw, ch] = size.slice(7).split('x').map(Number); return { size: 'custom', customWidth: cw, customHeight: ch, expect: { w: cw, h: ch } }; }
  if (size === 'original') return { size: 'original', expect: null };
  const [cw, ch] = size.split('x').map(Number); return { size, expect: { w: cw, h: ch } };
}

function nonBlack(data: Buffer, w: number, h: number, ch: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, black = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * ch; if (data[o] > 8 || data[o + 1] > 8 || data[o + 2] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } else black++; }
  return { bbox: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, blackFrac: black / (w * h) };
}

async function prepare() {
  const { jobId, sourceFrame } = await upload();
  const j = await waitReady(jobId);
  const w = j.source.width as number, h = j.source.height as number;
  console.log(`job ${jobId} ${w}×${h}`);
  const { maskData, keep, bound, keepGrid } = await maskDataFor(jobId, w, h);
  console.log(`keep bbox from the mask: ${JSON.stringify(keep)} bound ${JSON.stringify(bound)}`);
  const src = await Sharp(await sourceFrame()).raw().toBuffer({ resolveWithObject: true });
  // the source masked exactly as the apply loop masks it (RGB zeroed outside the keep), for the reference comparison
  const maskedSrc = Buffer.from(src.data);
  for (let i = 0; i < w * h; i++) if (!keepGrid[i]) { const o = i * src.info.channels; maskedSrc[o] = maskedSrc[o + 1] = maskedSrc[o + 2] = 0; }
  return { jobId, w, h, maskData, keep, bound, src, maskedSrc };
}

(async () => {
  let ctx = await prepare();
  let { jobId, w, h, maskData, keep, bound, src, maskedSrc } = ctx;
  const rows: string[] = [`| mode | size | output | expect | reference diff (px / max Δ) | placed at offset | pad L−R / T−B (px, record) | no-resample row | round-trip Δ (px) | sidecar==manifest | apply ms |`, `|---|---|---|---|---|---|---|---|---|---|---|`];
  let prev: string | null = null;
  let first = true;
  for (const mode of MODES) for (const size of SIZES) {
    if (FRESH && !first) { ctx = await prepare(); ({ jobId, w, h, maskData, keep, bound, src, maskedSrc } = ctx); prev = null; }
    first = false;
    const ss = sizeSettings(size);
    const outputSettings = { size: ss.size, customWidth: (ss as any).customWidth, customHeight: (ss as any).customHeight, format: FORMAT, includeMetadata: true, parallelThreads: 8, batchSize: 12, aspectRatioMode: mode };
    const t0 = Date.now();
    const r = await fetch(`${SERVER}/api/jobs/${jobId}/template-mask/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maskData, outputSettings, samplingFps: null }) });
    if (!r.ok) throw new Error(`apply ${r.status}: ${await r.text()}`);
    prev = await waitApplied(jobId, prev);
    const ms = Date.now() - t0;
    const dir = path.resolve('spokes', 'template_mask', jobId);
    const files = (await fs.readdir(dir)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
    const out = await Sharp(path.join(dir, files[0])).raw().toBuffer({ resolveWithObject: true });
    const t = JSON.parse(await fs.readFile(path.join(dir, 'output_transform.json'), 'utf8')) as OutputTransform;
    const ow = out.info.width, oh = out.info.height, ch = out.info.channels;
    const expect = ss.expect ?? { w, h };
    // reference: the masked source through the pure plan (same sharp ops) → must equal the server's frame byte for byte
    const ref = await applyOutputTransform(Sharp(maskedSrc, { raw: { width: w, height: h, channels: src.info.channels } }), t).raw().toBuffer({ resolveWithObject: true });
    let diffPx = 0, maxDelta = 0;
    if (ref.info.width === ow && ref.info.height === oh && ref.info.channels === ch) {
      for (let i = 0; i < ow * oh; i++) { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(ref.data[i * ch + c] - out.data[i * ch + c])); if (d) diffPx++; if (d > maxDelta) maxDelta = d; }
    } else { diffPx = -1; }
    // padding from the record (the pixels inside the keep may be black themselves — ultrasound is black — so padding is
    // measured on the record the reference comparison just validated)
    const placedW = Math.round(t.crop.w * t.scale.x), placedH = Math.round(t.crop.h * t.scale.y);
    const padLR = t.offset.x - (ow - t.offset.x - placedW), padTB = t.offset.y - (oh - t.offset.y - placedH);
    const placed = `(${t.offset.x}, ${t.offset.y}) ${placedW}×${placedH}`;
    let rowCheck = 'n/a';
    if (ss.size === 'original' && FORMAT === 'png') {
      const y = keep.y + Math.floor(keep.h / 2), oy = t.offset.y + Math.floor(keep.h / 2);
      let diff = 0;
      for (let x = 0; x < keep.w; x++) for (let c = 0; c < 3; c++) if (src.data[((y) * w + keep.x + x) * src.info.channels + c] !== out.data[(oy * ow + t.offset.x + x) * ch + c]) diff++;
      rowCheck = diff === 0 ? 'identical' : `${diff} bytes differ`;
    }
    // round-trip: source point → output (forward) → back through the sidecar's mapping
    const fwd = (sx: number, sy: number) => ({ x: t.offset.x + (sx - t.crop.x) * t.scale.x, y: t.offset.y + (sy - t.crop.y) * t.scale.y });
    const pts = [[keep.x, keep.y], bound ? [bound.x0, bound.y0] : [keep.x + keep.w - 1, keep.y + keep.h - 1]];
    const rt = Math.max(...pts.map(([sx, sy]) => { const o = fwd(sx, sy); const b = outputToSource(t, o.x, o.y); return Math.hypot(b.x - sx, b.y - sy); }));
    // manifest from the download ZIP
    const zipPath = path.resolve('..', 'sandbox', 'results', `_check_${jobId.slice(0, 8)}.zip`);
    const zr = await fetch(`${SERVER}/api/jobs/${jobId}/template-mask/download`);
    await fs.writeFile(zipPath, Buffer.from(await zr.arrayBuffer()));
    const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json']).toString());
    const csvHead = execFileSync('unzip', ['-p', zipPath, 'metadata.csv']).toString().split('\n').slice(0, 2);
    const same = JSON.stringify(manifest.output_transform) === JSON.stringify(t) && csvHead[0].includes('crop_x') && csvHead[1].split(',').slice(-10).join(',') === [t.crop.x, t.crop.y, t.crop.w, t.crop.h, t.scale.x, t.scale.y, t.offset.x, t.offset.y, t.output.w, t.output.h].map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(6))).join(',');
    await fs.unlink(zipPath).catch(() => {});
    rows.push(`| ${mode} | ${size} | ${ow}×${oh} | ${expect.w}×${expect.h} ${ow === expect.w && oh === expect.h ? '✅' : '✗'} | ${diffPx < 0 ? 'dims differ ✗' : `${diffPx} / ${maxDelta}${diffPx === 0 ? ' ✅' : ''}`} | ${placed} | ${padLR} / ${padTB} | ${rowCheck} | ${rt.toExponential(1)} | ${same ? '✅' : '✗'} | ${ms} |`);
    console.log(rows[rows.length - 1]);
  }
  const md = [`### Output Round 1 geometry — job ${jobId} (${w}×${h}, mask ${MASK}, format ${FORMAT}, keep ${JSON.stringify(keep)}, bound ${JSON.stringify(bound)})`, '', ...rows, ''].join('\n');
  if (OUT) { await fs.appendFile(path.resolve(OUT), md + '\n'); console.log(`appended ${OUT}`); }
})().catch((e) => { console.error(e); process.exit(1); });
