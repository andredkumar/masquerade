/**
 * Output Round 1 — the pure output pipeline (server/services/outputTransform.ts; OUTPUT_ROUND1_KICKOFF.md §1, §6):
 *  • keepBbox: all-blanked → null; a known rectangle → its bounds; a keep overhanging the frame is already clipped by
 *    construction (the raster is the frame), and planOutputTransform clips any bbox it is handed;
 *  • planOutputTransform: 'original' centres without scaling (letterbox and crop identical), other sizes contain /
 *    cover with a centred, symmetric offset; the transform's own output→source mapping round-trips a known point;
 *    'stretch' normalises to letterbox and is flagged; a custom size equal to the frame is a scale request;
 *  • applyOutputTransform on a synthetic raw frame: exact output dims, keep centred within 1 px, byte-identical
 *    pixels at 'original' (no resampling), no black at crop;
 *  • the manifest core repeats the ten CSV columns on every row and leaves them blank without a transform.
 * No DB, no PHI. Run:  npx tsx server/services/__tests__/outputTransform.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Sharp from 'sharp';

import { keepBbox, planOutputTransform, applyOutputTransform, normaliseAspectMode, outputToSource, outputTransformCsvValues, OUTPUT_TRANSFORM_CSV_COLUMNS, type OutputTransform } from '../outputTransform';
import { buildPerFrameManifestAndCsv } from '../../handlers/frameManifest';

/** An RGBA mask raster (alpha 255 = blanked) with one kept rectangle. */
function maskWithKeep(w: number, h: number, keep: { x: number; y: number; w: number; h: number } | null): Uint8Array {
  const m = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { m[i * 4] = 255; m[i * 4 + 3] = 255; }
  if (keep) for (let y = keep.y; y < keep.y + keep.h; y++) for (let x = keep.x; x < keep.x + keep.w; x++) { if (x >= 0 && y >= 0 && x < w && y < h) { m[(y * w + x) * 4] = 0; m[(y * w + x) * 4 + 3] = 0; } }
  return m;
}

/** A raw RGB frame whose pixel value encodes its position (so a copy can be checked byte for byte). */
function gradientFrame(w: number, h: number): Buffer {
  const b = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; b[o] = x & 255; b[o + 1] = y & 255; b[o + 2] = (x + y) & 255; }
  return b;
}

async function rawOut(t: OutputTransform, frame: Buffer, w: number, h: number) {
  const img = applyOutputTransform(Sharp(frame, { raw: { width: w, height: h, channels: 3 } }), t);
  return img.raw().toBuffer({ resolveWithObject: true });
}

function nonBlackBbox(data: Buffer, w: number, h: number, ch: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * ch; if (data[o] || data[o + 1] || data[o + 2]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test('keepBbox: all-blanked → null; a known rectangle → its bounds; a keep beyond the frame is clipped', () => {
  assert.equal(keepBbox(maskWithKeep(40, 30, null), 40, 30), null);
  assert.deepEqual(keepBbox(maskWithKeep(40, 30, { x: 5, y: 7, w: 10, h: 12 }), 40, 30), { x: 5, y: 7, w: 10, h: 12 });
  assert.deepEqual(keepBbox(maskWithKeep(40, 30, { x: 30, y: 20, w: 50, h: 50 }), 40, 30), { x: 30, y: 20, w: 10, h: 10 });
  const t = planOutputTransform({ x: -5, y: -5, w: 100, h: 100 }, 40, 30, 'original', 'letterbox', { width: 40, height: 30 });
  assert.deepEqual(t.crop, { x: 0, y: 0, w: 40, h: 30 });
});

test("planOutputTransform: 'original' centres without scaling (letterbox = crop); other sizes contain / cover; the mapping round-trips", () => {
  const bbox = { x: 100, y: 40, w: 300, h: 200 };
  const lb = planOutputTransform(bbox, 640, 480, 'original', 'letterbox', { width: 640, height: 480 });
  const cr = planOutputTransform(bbox, 640, 480, 'original', 'crop', { width: 640, height: 480 });
  assert.deepEqual({ ...lb, mode: 'x' }, { ...cr, mode: 'x' });
  assert.equal(lb.resampled, false); assert.deepEqual(lb.output, { w: 640, h: 480 }); assert.deepEqual(lb.scale, { x: 1, y: 1 });
  assert.deepEqual(lb.offset, { x: 170, y: 140 });                                        // ⌊(640−300)/2⌋, ⌊(480−200)/2⌋
  assert.deepEqual(outputToSource(lb, 170, 140), { x: 100, y: 40 });                     // the crop's origin
  const c2 = planOutputTransform(bbox, 640, 480, '256x256', 'letterbox', { width: 256, height: 256 });
  assert.equal(c2.resampled, true); assert.deepEqual(c2.output, { w: 256, h: 256 });
  assert.ok(Math.abs(c2.scale.x - 256 / 300) < 1e-9 && Math.abs(c2.scale.y - 256 / 300) < 0.01, 'contain scales by the long side');
  assert.equal(c2.offset.x, 0); assert.equal(c2.offset.y, Math.floor((256 - Math.round(200 * 256 / 300)) / 2));
  const p = outputToSource(c2, c2.offset.x + 128, c2.offset.y + Math.round(200 * 256 / 300) / 2);
  assert.ok(Math.abs(p.x - 250) < 1 && Math.abs(p.y - 140) < 1, `centre round-trips (${p.x}, ${p.y})`);
  const cv = planOutputTransform(bbox, 640, 480, '256x256', 'crop', { width: 256, height: 256 });
  assert.ok(Math.abs(cv.scale.y - 256 / 200) < 1e-9, 'cover scales by the short side');
  assert.equal(cv.offset.y, 0); assert.equal(cv.offset.x, -Math.floor((Math.round(300 * 256 / 200) - 256) / 2));
  // a custom size that equals the frame is a SCALE request (sign-off §3.1), not centre-without-scaling
  const eq = planOutputTransform(bbox, 640, 480, 'custom', 'letterbox', { width: 640, height: 480 });
  assert.equal(eq.resampled, true); assert.ok(eq.scale.x > 1.9, 'the keep is scaled up to fit');
  // empty bbox → full frame, flagged
  const em = planOutputTransform(null, 640, 480, '256x256', 'letterbox', { width: 256, height: 256 });
  assert.equal(em.bbox_empty, true); assert.deepEqual(em.crop, { x: 0, y: 0, w: 640, h: 480 });
});

test("normaliseAspectMode: 'stretch' from a stale client → letterbox, flagged; letterbox / crop / undefined pass", () => {
  assert.deepEqual(normaliseAspectMode('stretch'), { mode: 'letterbox', stale: true });
  assert.deepEqual(normaliseAspectMode('crop'), { mode: 'crop', stale: false });
  assert.deepEqual(normaliseAspectMode('letterbox'), { mode: 'letterbox', stale: false });
  assert.deepEqual(normaliseAspectMode(undefined), { mode: 'letterbox', stale: false });
});

test("applyOutputTransform: exact dims, keep centred, byte-identical at 'original', covered at crop", async () => {
  const W = 320, H = 200, frame = gradientFrame(W, H);
  const keep = { x: 37, y: 61, w: 150, h: 90 };
  const bbox = keepBbox(maskWithKeep(W, H, keep), W, H)!;
  // blank everything outside the keep, as the apply loop does, so the output's non-black region IS the keep
  const masked = Buffer.from(frame);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < keep.x || x >= keep.x + keep.w || y < keep.y || y >= keep.y + keep.h) { const o = (y * W + x) * 3; masked[o] = masked[o + 1] = masked[o + 2] = 0; }
  const orig = planOutputTransform(bbox, W, H, 'original', 'letterbox', { width: W, height: H });
  const o1 = await rawOut(orig, masked, W, H);
  assert.equal(o1.info.width, W); assert.equal(o1.info.height, H);
  const nb = nonBlackBbox(o1.data, W, H, o1.info.channels)!;
  assert.ok(Math.abs((nb.x + nb.w / 2) - W / 2) <= 1 && Math.abs((nb.y + nb.h / 2) - H / 2) <= 1, `centred (${nb.x},${nb.y},${nb.w},${nb.h})`);
  assert.equal(nb.x - 0, orig.offset.x); assert.equal(W - (nb.x + nb.w), W - orig.offset.x - keep.w, 'padding as recorded');
  // no resampling: a row of the keep in the output equals the source row byte for byte (the gradient carries position)
  for (let x = 0; x < keep.w; x++) {
    const so = ((keep.y + 10) * W + keep.x + x) * 3, oo = ((orig.offset.y + 10) * W + orig.offset.x + x) * o1.info.channels;
    assert.equal(o1.data[oo], frame[so]); assert.equal(o1.data[oo + 1], frame[so + 1]); assert.equal(o1.data[oo + 2], frame[so + 2]);
  }
  const lb = planOutputTransform(bbox, W, H, '256x256', 'letterbox', { width: 256, height: 256 });
  const o2 = await rawOut(lb, masked, W, H);
  assert.equal(o2.info.width, 256); assert.equal(o2.info.height, 256);
  const nb2 = nonBlackBbox(o2.data, 256, 256, o2.info.channels)!;
  assert.ok(Math.abs((nb2.y + nb2.h / 2) - 128) <= 1.5, `letterbox centred vertically (${nb2.y}, ${nb2.h})`);
  assert.ok(Math.abs(nb2.y - lb.offset.y) <= 1 && Math.abs((256 - nb2.y - nb2.h) - lb.offset.y) <= 1, 'padding symmetric ±1 px and as recorded');
  const cv = planOutputTransform(bbox, W, H, '256x256', 'crop', { width: 256, height: 256 });
  const o3 = await rawOut(cv, masked, W, H);
  assert.equal(o3.info.width, 256); assert.equal(o3.info.height, 256);
  let black = 0; for (let i = 0; i < 256 * 256; i++) { const o = i * o3.info.channels; if (!o3.data[o] && !o3.data[o + 1] && !o3.data[o + 2]) black++; }
  assert.ok(black < 256 * 256 * 0.005, `crop covers with no black (${black} black px)`);
});

test('manifest core: ten transform columns on every row, blank without a transform; the header is stable', () => {
  const t = planOutputTransform({ x: 10, y: 20, w: 300, h: 200 }, 640, 480, 'original', 'letterbox', { width: 640, height: 480 });
  const withT = buildPerFrameManifestAndCsv({ frameCount: 3, labels: [], outputFormat: 'jpg', outputTransform: t });
  const lines = withT.csv.split('\n');
  assert.equal(lines[0], ['filename', 'frame_number', 'split', 'ai_target', 'ai_confidence', ...OUTPUT_TRANSFORM_CSV_COLUMNS].join(','));
  assert.equal(lines.length, 4);
  for (const row of lines.slice(1)) assert.ok(row.endsWith(',' + outputTransformCsvValues(t).join(',')), row);
  assert.deepEqual(outputTransformCsvValues(t), ['10', '20', '300', '200', '1', '1', '170', '140', '640', '480']);
  const without = buildPerFrameManifestAndCsv({ frameCount: 2, labels: [], outputFormat: 'jpg' });
  for (const row of without.csv.split('\n').slice(1)) assert.ok(row.endsWith(',' + OUTPUT_TRANSFORM_CSV_COLUMNS.map(() => '').join(',')), row);
  assert.deepEqual(without.frames.map((f) => f.frame_number), [0, 1]);
});
