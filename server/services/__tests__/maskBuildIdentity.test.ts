/**
 * Output Round 2, commit 1 — buffer identity (docs/refactor/OUTPUT_ROUND2_SIGNOFF.md §2).
 *
 * `createMaskFromBase64` used to push a debug object for every detected pixel (`|| (isDrawn && isRed)`); the change
 * samples the debug array at the interval only. This test proves the mask RGBA buffer is unchanged: the expected
 * buffer is computed straight from the mask predicate (canvas = frame dimensions, `scale: 1`, so there is no
 * resampling to model) and `createMaskRgbaBuffer`'s output must equal it byte for byte.
 *
 * Four masks (a Keep rectangle, a small Remove rectangle, fully transparent, fully red) × two frame sizes.
 * Run:  npx tsx server/services/__tests__/maskBuildIdentity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Sharp from 'sharp';

type Pred = (x: number, y: number, w: number, h: number) => boolean;   // true = the mask blanks this pixel

const MASKS: Record<string, Pred> = {
  // Keep: everything outside a central rectangle is drawn red.
  keep_rectangle: (x, y, w, h) => !(x >= w * 0.25 && x < w * 0.75 && y >= h * 0.2 && y < h * 0.8),
  // Remove: a small drawn rectangle.
  remove_small: (x, y, w, h) => x >= w * 0.1 && x < w * 0.2 && y >= h * 0.1 && y < h * 0.25,
  fully_transparent: () => false,
  fully_red: () => true,
};
const SIZES: Array<[number, number]> = [[400, 240], [1920, 1080]];

async function maskDataFor(pred: Pred, w: number, h: number) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pred(x, y, w, h)) { const o = (y * w + x) * 4; rgba[o] = 255; rgba[o + 3] = 255; }
  const png = await Sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return {
    type: 'freeform', coordinates: [0, 0, w, h], opacity: 75, aspectRatioMode: 'letterbox', canvasWidth: w, canvasHeight: h,
    canvasDataUrl: `data:image/png;base64,${png.toString('base64')}`, originalCanvasDimensions: { width: w, height: h },
    imageDimensions: { width: w, height: h }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
}

function expectedBuffer(pred: Pred, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);   // blanked = (255,255,255,255), kept = (0,0,0,0)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pred(x, y, w, h)) out.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
  return out;
}

test('createMaskRgbaBuffer output equals the predicate-computed buffer, byte for byte', async () => {
  process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';   // the storage import guard; nothing here queries it
  const { VideoProcessor } = await import('../videoProcessor');
  const vp: any = new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any);
  const log = console.log; const info = console.info;
  let cases = 0;
  try {
    console.log = () => {}; console.info = () => {};   // the builder logs a lot per call
    for (const [name, pred] of Object.entries(MASKS)) for (const [w, h] of SIZES) {
      const maskData = await maskDataFor(pred, w, h);
      const got: Buffer = await vp.createMaskRgbaBuffer(maskData, w, h);
      const want = expectedBuffer(pred, w, h);
      assert.equal(got.length, want.length, `${name} ${w}x${h}: length`);
      assert.ok(got.equals(want), `${name} ${w}x${h}: buffer differs`);
      cases++;
    }
  } finally { console.log = log; console.info = info; }
  assert.equal(cases, 8);
});
