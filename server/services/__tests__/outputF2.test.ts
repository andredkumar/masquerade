/**
 * Output Round 1b (F2) — pixel-equivalence proof (docs/refactor/OUTPUT_ROUND1B_SIGNOFF.md §4): restricting the masking
 * work to the crop changes no output byte.
 *
 * Reference = the pre-F2 semantics: every pixel the mask blanks is zeroed across the WHOLE frame, then the planned
 * transform + encode. Under test, the three real code paths as they now run:
 *   (a) processFrameBatch with a prebuilt mask whose offsets went through planPrebuiltMask (the once-per-apply F2 filter),
 *   (b) processFrameBatch without one (the per-stack fallback: the alpha scan over the crop rectangle only),
 *   (c) processFrame (the image-batch exception fallback: the same scan).
 * Four masks (a Keep rectangle inside the frame, a Keep rectangle on the left edge, a small Remove rectangle — crop =
 * the whole frame — and a wedge whose bbox corners are masked, so in-crop offsets must survive the filter) × Original /
 * 256 × Letterbox / Crop × JPEG / PNG. A negative control shows the comparison fails when in-crop offsets are dropped.
 * Run:  npx tsx server/services/__tests__/outputF2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Sharp from 'sharp';

import { keepBbox, planOutputTransform, applyOutputTransform, offsetsInCrop, normaliseAspectMode } from '../outputTransform';

const W = 400, H = 240;

async function framePng(): Promise<Buffer> {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; rgb[o] = (x * 5 + y) & 255; rgb[o + 1] = (y * 7) & 255; rgb[o + 2] = ((x ^ y) * 3) & 255; }
  return Sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** The browser's convention: transparent = keep, red = blank. */
async function maskDataFor(isKept: (x: number, y: number) => boolean) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isKept(x, y)) { const o = (y * W + x) * 4; rgba[o] = 255; rgba[o + 3] = 255; }
  const png = await Sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return {
    type: 'freeform', coordinates: [0, 0, W, H], opacity: 75, aspectRatioMode: 'letterbox', canvasWidth: W, canvasHeight: H,
    canvasDataUrl: `data:image/png;base64,${png.toString('base64')}`, originalCanvasDimensions: { width: W, height: H },
    imageDimensions: { width: W, height: H }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
}

const MASKS: Record<string, (x: number, y: number) => boolean> = {
  keep_interior: (x, y) => x >= 150 && x < 240 && y >= 90 && y < 150,
  keep_left_edge: (x, y) => x < 100 && y >= 50 && y < 130,
  remove_small: (x, y) => !(x >= 30 && x < 70 && y >= 20 && y < 50),
  keep_wedge: (x, y) => y >= 20 && y < 220 && Math.abs(x - 200) < (y - 20) * 0.8,
};
const SETTINGS = [
  { size: 'original', outputSize: { width: W, height: H } },
  { size: '256x256', outputSize: { width: 256, height: 256 } },
];

async function encode(img: Sharp.Sharp, fmt: 'jpg' | 'png') {
  return fmt === 'png' ? img.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer() : img.jpeg({ quality: 90 }).toBuffer();
}

test('F2: filtered / crop-scanned masking is byte-identical to whole-frame masking on every path', async () => {
  process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';   // the storage import guard; nothing here queries it
  const { VideoProcessor } = await import('../videoProcessor');
  const vp: any = new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any);
  const frame = await framePng();
  const raw = await Sharp(frame).raw().toBuffer({ resolveWithObject: true });
  let cases = 0;
  for (const [name, isKept] of Object.entries(MASKS)) {
    const maskData = await maskDataFor(isKept);
    const maskRgba: Buffer = await vp.createMaskRgbaBuffer(maskData, W, H);
    for (const s of SETTINGS) for (const mode of ['letterbox', 'crop'] as const) for (const fmt of ['jpg', 'png'] as const) {
      const outputSettings = { size: s.size, format: fmt, includeMetadata: true, parallelThreads: 8, batchSize: 12, aspectRatioMode: mode };
      const plan = planOutputTransform(keepBbox(maskRgba, W, H), W, H, s.size, normaliseAspectMode(mode).mode, s.outputSize);
      // reference: the whole-frame masking every pre-F2 path did
      const ref = Buffer.from(raw.data);
      for (let i = 0; i < W * H; i++) if (maskRgba[i * 4 + 3] > 0) { const o = i * 3; ref[o] = ref[o + 1] = ref[o + 2] = 0; }
      const expected = await encode(applyOutputTransform(Sharp(ref, { raw: { width: W, height: H, channels: 3 } }), plan), fmt);

      const task = { frameBuffer: frame, maskData, outputSize: s.outputSize, outputSettings, frameNumber: 0 };
      const prebuilt = await vp.buildApplyMask(`f2-${name}`, frame, maskData);
      const unfiltered = prebuilt.maskedOffsets.length;
      const t = vp.planPrebuiltMask(`f2-${name}`, prebuilt, outputSettings, s.outputSize);
      assert.deepEqual(t.crop, plan.crop, `${name}: the once-per-apply plan is the same plan`);
      const [a] = await vp.processFrameBatch([task], undefined, prebuilt);
      const [b] = await vp.processFrameBatch([task]);
      const c = await vp.processFrame(task);
      const label = `${name} · ${s.size} · ${mode} · ${fmt} (offsets ${unfiltered} → ${prebuilt.maskedOffsets.length})`;
      assert.ok(a.success && b.success && c.success, label);
      assert.ok(Buffer.compare(a.processedBuffer, expected) === 0, `${label}: batch + filtered prebuilt differs from whole-frame masking`);
      assert.ok(Buffer.compare(b.processedBuffer, expected) === 0, `${label}: batch fallback (crop scan) differs`);
      assert.ok(Buffer.compare(c.processedBuffer, expected) === 0, `${label}: per-frame path (crop scan) differs`);
      if (name.startsWith('keep_')) assert.ok(prebuilt.maskedOffsets.length < unfiltered / 2, `${label}: F2 actually filtered`);
      if (name === 'remove_small') assert.equal(prebuilt.maskedOffsets.length, unfiltered, `${label}: crop = frame → nothing filtered`);
      cases++;
    }
  }
  assert.equal(cases, 32);
});

test('negative control: dropping the in-crop offsets of the wedge IS caught', async () => {
  process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';
  const { VideoProcessor } = await import('../videoProcessor');
  const vp: any = new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any);
  const frame = await framePng();
  const maskData = await maskDataFor(MASKS.keep_wedge);
  const outputSettings = { size: 'original', format: 'png', includeMetadata: true, parallelThreads: 8, batchSize: 12, aspectRatioMode: 'letterbox' };
  const task = { frameBuffer: frame, maskData, outputSize: { width: W, height: H }, outputSettings, frameNumber: 0 };
  const good = await vp.buildApplyMask('f2-neg', frame, maskData);
  vp.planPrebuiltMask('f2-neg', good, outputSettings, { width: W, height: H });
  const [ok] = await vp.processFrameBatch([task], undefined, good);
  const bad = await vp.buildApplyMask('f2-neg', frame, maskData);
  vp.planPrebuiltMask('f2-neg', bad, outputSettings, { width: W, height: H });
  assert.ok(bad.maskedOffsets.length > 0, 'the wedge has masked pixels inside its own bbox');
  bad.maskedOffsets = new Uint32Array(0);                       // the bug the proof must catch: an over-eager filter
  const [leak] = await vp.processFrameBatch([task], undefined, bad);
  assert.notEqual(Buffer.compare(ok.processedBuffer, leak.processedBuffer), 0, 'a filter that drops in-crop offsets leaks pixels and is detected');
});

test('offsetsInCrop: equals a naive filter, preserves order, returns the input when the crop is the frame', () => {
  const w = 37, h = 23;
  const all: number[] = [];
  for (let i = 0; i < w * h; i++) if ((i * 7919) % 5 !== 0) all.push(i * 3);
  const offs = Uint32Array.from(all);
  for (const crop of [{ x: 5, y: 3, w: 10, h: 8 }, { x: 0, y: 0, w: 1, h: 23 }, { x: 36, y: 22, w: 1, h: 1 }, { x: 12, y: 0, w: 25, h: 23 }]) {
    const naive = all.filter((o) => { const p = o / 3, x = p % w, y = Math.floor(p / w); return x >= crop.x && x < crop.x + crop.w && y >= crop.y && y < crop.y + crop.h; });
    assert.deepEqual(Array.from(offsetsInCrop(offs, w, h, crop)), naive, JSON.stringify(crop));
  }
  assert.equal(offsetsInCrop(offs, w, h, { x: 0, y: 0, w, h }), offs, 'full-frame crop → the same array, no copy');
  assert.equal(offsetsInCrop(new Uint32Array(0), w, h, { x: 1, y: 1, w: 2, h: 2 }).length, 0);
});
