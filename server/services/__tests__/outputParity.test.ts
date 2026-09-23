/**
 * Output Round 1 — parity of the two frame paths (OUTPUT_ROUND1_KICKOFF.md §6 "parity"): `processFrameBatch` (the
 * batch/3D path every video, DICOM and image apply takes) and `processFrame` (the image-batch exception fallback)
 * run the same synthetic frame + mask + settings and must produce byte-identical output — both call the one
 * `applyOutputTransform`, this proves it at the byte level. The processor is constructed with a stub socket server;
 * neither method touches storage (DATABASE_URL is set only so the storage module's import-time guard passes).
 * Run:  npx tsx server/services/__tests__/outputParity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import Sharp from 'sharp';

async function synthetic() {
  const W = 300, H = 180;
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; rgb[o] = (x * 7) & 255; rgb[o + 1] = (y * 5) & 255; rgb[o + 2] = ((x ^ y) * 3) & 255; }
  const frame = await Sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  // mask PNG in the browser's convention: transparent = keep, red = blank; keep a centred 150 × 90 window
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; const keep = x >= 75 && x < 225 && y >= 45 && y < 135; if (!keep) { rgba[o] = 255; rgba[o + 3] = 255; } }
  const maskPng = await Sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const maskData = {
    type: 'freeform', coordinates: [0, 0, W, H], opacity: 75, aspectRatioMode: 'letterbox', canvasWidth: W, canvasHeight: H,
    canvasDataUrl: `data:image/png;base64,${maskPng.toString('base64')}`, originalCanvasDimensions: { width: W, height: H },
    imageDimensions: { width: W, height: H }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
  return { W, H, frame, maskData };
}

test('processFrame and processFrameBatch produce byte-identical output for the same frame, mask and settings', async () => {
  // the storage module's import-time guard needs a DATABASE_URL; nothing here queries it (ESM imports hoist, hence the dynamic import)
  process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';
  const { VideoProcessor } = await import('../videoProcessor');
  const vp: any = new VideoProcessor({ to: () => ({ emit: () => {} }), emit: () => {} } as any);
  const { frame, maskData } = await synthetic();
  const cases = [
    { size: 'original', aspectRatioMode: 'letterbox', outputSize: { width: 300, height: 180 } },
    { size: '128x128', aspectRatioMode: 'letterbox', outputSize: { width: 128, height: 128 } },
    { size: '128x128', aspectRatioMode: 'crop', outputSize: { width: 128, height: 128 } },
    { size: 'custom', customWidth: 200, customHeight: 100, aspectRatioMode: 'letterbox', outputSize: { width: 200, height: 100 } },
  ];
  for (const c of cases) {
    const outputSettings = { size: c.size, customWidth: (c as any).customWidth, customHeight: (c as any).customHeight, format: 'png', includeMetadata: true, parallelThreads: 8, batchSize: 12, aspectRatioMode: c.aspectRatioMode };
    const task = { frameBuffer: frame, maskData, outputSize: c.outputSize, outputSettings, frameNumber: 0 };
    const single = await vp.processFrame(task);
    const [batch] = await vp.processFrameBatch([task]);
    assert.equal(single.success, true, `${c.size}/${c.aspectRatioMode} single`); assert.equal(batch.success, true, `${c.size}/${c.aspectRatioMode} batch`);
    const hs = createHash('sha256').update(single.processedBuffer).digest('hex'), hb = createHash('sha256').update(batch.processedBuffer).digest('hex');
    const meta = await Sharp(batch.processedBuffer).metadata();
    assert.equal(hs, hb, `${c.size}/${c.aspectRatioMode}: per-frame ${hs.slice(0, 12)} vs batch ${hb.slice(0, 12)}`);
    assert.equal(`${meta.width}x${meta.height}`, `${c.outputSize.width}x${c.outputSize.height}`);
  }
});
