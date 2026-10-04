/**
 * Output Round 2 (R1) — the fail-closed apply guard (docs/refactor/OUTPUT_ROUND2_SIGNOFF.md §3.1, §4 "unit").
 *  1. decideApply on 0, 1, total − 1, total.
 *  2. countMaskedPixels equals the count buildApplyMask reports, on 4 masks × 2 sizes (no second threshold).
 *  3. The five bad mask shapes of recon §4.2, each at the bound the table says (1920 × 1080).
 *  4. checkApplyMask: dims_source frame0 / image0 / job, fail-closed `unverifiable`, the PERF lines.
 * Run:  npx tsx server/services/__tests__/applyGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Sharp from 'sharp';

process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';   // the storage import guard; nothing here queries it
import { decideApply, checkApplyMask, REFUSAL_MESSAGES } from '../applyGuard';

const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, info = console.info;
  console.log = () => {}; console.info = () => {};
  return fn().finally(() => { console.log = log; console.info = info; });
};
/** Run fn while capturing the `[PERF]` lines (as parsed objects), silencing everything else. */
async function capturePerf<T>(fn: () => Promise<T>): Promise<{ result: T; perf: any[] }> {
  const perf: any[] = [];
  const log = console.log, info = console.info;
  console.log = (...a: any[]) => { const s = String(a[0]); if (s.startsWith('[PERF] ')) perf.push(JSON.parse(s.slice(7))); };
  console.info = () => {};
  try { return { result: await fn(), perf }; } finally { console.log = log; console.info = info; }
}

async function pngMask(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number] | null) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = paint(x, y); if (p) rgba.set(p, (y * w + x) * 4); }
  return Sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
function canvasMask(png: Buffer, w: number, h: number) {
  return {
    type: 'freeform', coordinates: [0, 0, w, h], opacity: 75, aspectRatioMode: 'letterbox', canvasWidth: w, canvasHeight: h,
    canvasDataUrl: `data:image/png;base64,${png.toString('base64')}`, originalCanvasDimensions: { width: w, height: h },
    imageDimensions: { width: w, height: h }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
}
const RED: [number, number, number, number] = [255, 0, 0, 255];

async function makeVp() {
  const { VideoProcessor } = await import('../videoProcessor');
  return new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any) as any;
}

test('decideApply: the two bounds and everything between', () => {
  const total = 1000;
  assert.equal(decideApply(0, total), 'mask_blanks_nothing');
  assert.equal(decideApply(1, total), null);
  assert.equal(decideApply(total - 1, total), null);
  assert.equal(decideApply(total, total), 'mask_blanks_everything');
});

test('countMaskedPixels equals buildApplyMask.maskedPixels on 4 masks × 2 sizes', async () => {
  const vp = await makeVp();
  const MASKS: Record<string, (x: number, y: number, w: number, h: number) => boolean> = {
    keep_rect: (x, y, w, h) => !(x >= w * 0.25 && x < w * 0.75 && y >= h * 0.2 && y < h * 0.8),
    remove_small: (x, y, w, h) => x >= w * 0.1 && x < w * 0.2 && y >= h * 0.1 && y < h * 0.25,
    transparent: () => false,
    red: () => true,
  };
  let n = 0;
  for (const [w, h] of [[400, 240], [1920, 1080]] as const) {
    const frame = await Sharp({ create: { width: w, height: h, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
    for (const [name, pred] of Object.entries(MASKS)) {
      const md = canvasMask(await pngMask(w, h, (x, y) => (pred(x, y, w, h) ? RED : null)), w, h);
      const counted = await quiet(() => vp.countMaskedPixels(md, w, h));
      const built = await quiet(() => vp.buildApplyMask('guard-eq', frame, md));
      assert.equal(counted.total, w * h, `${name} ${w}x${h}: total`);
      assert.equal(counted.masked, built.maskedPixels, `${name} ${w}x${h}: masked`);
      n++;
    }
  }
  assert.equal(n, 8);
});

test('the five bad shapes land on the bound the recon table says (1920 × 1080)', async () => {
  const vp = await makeVp();
  const W = 1920, H = 1080;
  const job = { jobType: 'video', width: W, height: H };
  const blackOnTransparent = await pngMask(W, H, (x, y) => (x >= 100 && x < 400 && y >= 100 && y < 300 ? [0, 0, 0, 255] : null));
  const cases: Array<[string, any, 'mask_blanks_nothing' | 'mask_blanks_everything']> = [
    ['no PNG, rectangle, coordinates []', { type: 'rectangle', coordinates: [], opacity: 75 }, 'mask_blanks_nothing'],
    ['no PNG, freeform, opacity 75 (default branch)', { type: 'freeform', coordinates: [0, 0, W, H], opacity: 75 }, 'mask_blanks_everything'],
    ['no PNG, freeform, no opacity', { type: 'freeform', coordinates: [0, 0, W, H] }, 'mask_blanks_nothing'],
    ['malformed PNG', { ...canvasMask(Buffer.from('not a png'), W, H) }, 'mask_blanks_nothing'],
    ['non-data-URL canvasDataUrl', { ...canvasMask(Buffer.from(''), W, H), canvasDataUrl: 'https://example.invalid/mask.png' }, 'mask_blanks_nothing'],
    ['1a shape: black shapes on transparent', canvasMask(blackOnTransparent, W, H), 'mask_blanks_nothing'],
  ];
  for (const [name, md, want] of cases) {
    const { result, perf } = await capturePerf(() => checkApplyMask(vp, `shape-${randomUUID()}`, job, md));
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.equal(result.status, 422, name);
      assert.equal(result.reason, want, name);
      assert.equal(result.error, REFUSAL_MESSAGES[want], name);
    }
    assert.equal(perf.filter(p => p.stage === 'apply.refused').length, 1, `${name}: one apply.refused`);
    assert.equal(perf.filter(p => p.stage === 'apply.validate').length, 1, `${name}: one apply.validate`);
  }
});

test('checkApplyMask accepts a real mask and reads dims from raw frame 0, image 0, or the job record', async () => {
  const vp = await makeVp();
  const w = 400, h = 240;
  const md = canvasMask(await pngMask(w, h, (x, y) => (x < 100 ? RED : null)), w, h);   // 25 % blanked

  // 1. raw frame 0 on disk wins over a wrong job record
  const jobId = `guardtest-${randomUUID()}`;
  const { TEMP_EXTRACTED_DIR } = await import('../cleanup');
  const rawDir = path.join(TEMP_EXTRACTED_DIR, jobId);
  fs.mkdirSync(rawDir, { recursive: true });
  // 2. an uploaded image for the image-batch row
  const upName = `guardtest-${randomUUID()}.png`;
  const upPath = path.join('uploads', upName);
  fs.mkdirSync('uploads', { recursive: true });
  try {
    await Sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(path.join(rawDir, 'frame_000001.png'));
    await Sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(upPath);

    let r = await capturePerf(() => checkApplyMask(vp, jobId, { jobType: 'video', width: 10, height: 10 }, md));
    assert.deepEqual(r.result, { ok: true });
    let v = r.perf.find(p => p.stage === 'apply.validate');
    assert.equal(v.dims_source, 'frame0'); assert.equal(v.w, w); assert.equal(v.h, h);
    assert.equal(v.total_px, w * h); assert.equal(v.masked_px, 100 * h);
    assert.equal(typeof v.ms, 'number');
    assert.equal(r.perf.filter(p => p.stage === 'apply.refused').length, 0);

    r = await capturePerf(() => checkApplyMask(vp, `nofiles-${randomUUID()}`, { jobType: 'images', width: 10, height: 10, fileList: [{ filename: upName }] }, md));
    assert.deepEqual(r.result, { ok: true });
    v = r.perf.find(p => p.stage === 'apply.validate');
    assert.equal(v.dims_source, 'image0'); assert.equal(v.w, w);

    // image 0 gone (uploads reclaimed, backlog 30) → the job record
    r = await capturePerf(() => checkApplyMask(vp, `nofiles-${randomUUID()}`, { jobType: 'images', width: w, height: h, fileList: [{ filename: 'gone.png' }] }, md));
    assert.deepEqual(r.result, { ok: true });
    assert.equal(r.perf.find(p => p.stage === 'apply.validate').dims_source, 'job');

    // video with no raw frames → the job record
    r = await capturePerf(() => checkApplyMask(vp, `nofiles-${randomUUID()}`, { jobType: 'video', width: w, height: h }, md));
    assert.deepEqual(r.result, { ok: true });
    assert.equal(r.perf.find(p => p.stage === 'apply.validate').dims_source, 'job');
  } finally {
    fs.rmSync(rawDir, { recursive: true, force: true });
    fs.rmSync(upPath, { force: true });
  }
});

test('fail closed: no resolvable dims, or a throwing count, refuses `unverifiable` and counts nothing', async () => {
  const vp = await makeVp();
  const md = canvasMask(await pngMask(40, 24, () => RED), 40, 24);

  let r = await capturePerf(() => checkApplyMask(vp, `nodims-${randomUUID()}`, { jobType: 'video', width: 0, height: 0 }, md));
  assert.equal(r.result.ok, false);
  if (!r.result.ok) { assert.equal(r.result.reason, 'unverifiable'); assert.equal(r.result.error, REFUSAL_MESSAGES.unverifiable); assert.equal(r.result.status, 422); }
  assert.equal(r.perf.filter(p => p.stage === 'apply.validate').length, 0);
  const refused = r.perf.find(p => p.stage === 'apply.refused');
  assert.equal(refused.reason, 'unverifiable'); assert.equal(refused.detail, 'no_dimensions');

  const throwing = { countMaskedPixels: async () => { throw new Error('boom'); } };
  r = await capturePerf(() => checkApplyMask(throwing as any, `throws-${randomUUID()}`, { jobType: 'video', width: 40, height: 24 }, md));
  assert.equal(r.result.ok, false);
  if (!r.result.ok) assert.equal(r.result.reason, 'unverifiable');
  assert.match(r.perf.find(p => p.stage === 'apply.refused').detail, /boom/);
});
