/**
 * Round 2A — the two NON-PHI fixtures that live in git (AUTOMASK_2A_DECISIONS.md §3.1): a rendered fan and a rendered
 * trapezoid-with-bound at 632×1080, with the furniture the rules exist for (header lines above the arc, a glyph beside
 * it, a label above a trapezoid top, a greyscale bar merging at the left, echo-free bottom corners). Deterministic
 * (LCG speckle), so the PNGs are reproducible byte for byte.
 *
 *   npx tsx scripts/automask_eval/make-synthetic.ts                      # writes server/services/__tests__/fixtures/automask/*.png
 *   python3 scripts/automask_spike/automask_spike.py --propose-png <png> [--bound x0,y0,x1,y1] > <clip>/proposal.json
 *
 * The expected proposal.json comes from the frozen Python spike, never from the TS port.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';

const W = 632, H = 1080;
const outDir = path.resolve(process.cwd(), 'server/services/__tests__/fixtures/automask');

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function speckle(base: number, spread: number): number {
  // log-normal-ish speckle: mean ≈ base, std ≈ spread
  const v = base + spread * (rnd() + rnd() + rnd() - 1.5) * 1.6;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function text(g: Uint8Array, x0: number, y0: number, len: number, value = 220) {
  // text-like: a row of 3-px glyph strokes with 2-px gaps, 12 px tall
  for (let x = x0; x < x0 + len; x++) {
    const inGlyph = ((x - x0) % 8) < 5;
    for (let y = y0; y < y0 + 12; y++) {
      const stroke = inGlyph && (((x - x0) % 8) === 0 || ((x - x0) % 8) === 4 || y === y0 || y === y0 + 11 || y === y0 + 6);
      if (stroke && x >= 0 && x < W && y >= 0 && y < H) g[y * W + x] = value;
    }
  }
}

function fanFrame(): Uint8Array {
  const g = new Uint8Array(W * H);
  const ax = 316, ay = -160, half = (30 * Math.PI) / 180, rIn = 220, rOut = 1100;   // the frozen selector calls this a fan (fan 0.996 vs trap 0.989); at 24°/320 the trapezoid won
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - ax, dy = y - ay, r = Math.hypot(dx, dy), th = Math.atan2(dx, dy);
    if (r >= rIn && r <= rOut && Math.abs(th) <= half) {
      // bright near field, darker far field, a few bright "pleural" bands
      const depth = (r - rIn) / (rOut - rIn);
      const base = 110 - 70 * depth + (Math.abs(depth - 0.12) < 0.02 ? 90 : 0) + (Math.abs(depth - 0.35) < 0.015 ? 50 : 0);
      g[y * W + x] = speckle(base, 28);
    }
  }
  // header lines (device / patient text — the thing the arc rule must not keep), directly above the arc
  text(g, 150, 14, 330); text(g, 190, 34, 250);
  // an orientation glyph beside the arc's left end
  for (let y = 62; y < 78; y++) for (let x = 60; x < 84; x++) if (Math.hypot(x - 72, y - 70) < 8) g[y * W + x] = 200;
  // a depth ruler on the right with tick numbers
  for (let y = 60; y < 1060; y += 2) g[y * W + 612] = 180;
  for (let y = 100; y < 1060; y += 80) { for (let x = 604; x < 620; x++) g[y * W + x] = 200; text(g, 590, y - 16, 12, 200); }
  return g;
}

function trapFrame(): Uint8Array {
  const g = new Uint8Array(W * H);
  // T0 box: x 8..623, y 100..860 — everything outside is the DICOM furniture (dark grey panel with text)
  for (let y = 0; y < 100; y++) for (let x = 0; x < W; x++) g[y * W + x] = 40;
  text(g, 40, 30, 300, 230); text(g, 40, 60, 200, 230);
  const cx = 316, yTop = 168, yBot = 800, wTop = 380, wBot = 600;
  for (let y = yTop; y <= yBot; y++) {
    const f = (y - yTop) / (yBot - yTop), wy = wTop + (wBot - wTop) * f;
    for (let x = Math.round(cx - wy / 2); x <= Math.round(cx + wy / 2); x++) {
      if (x < 0 || x >= W) continue;
      // echo-free bottom corners: fade the outer 30 % of the width to black in the lower half
      const lat = Math.abs(x - cx) / (wy / 2);
      const corner = f > 0.55 && lat > 0.7 ? Math.max(0, 1 - (lat - 0.7) / 0.3 * (f - 0.55) / 0.45 * 2.2) : 1;
      const base = (95 - 55 * f) * corner;
      g[y * W + x] = base < 4 ? 0 : speckle(base, 22);
    }
  }
  text(g, 70, 128, 60, 210);                                      // vendor label 40 px above the image top
  for (let y = 360; y < 560; y++) for (let x = 20; x < 40; x++) g[y * W + x] = 60 + Math.round(((y - 360) / 200) * 160);   // greyscale bar
  for (let y = 880; y < 1080; y++) for (let x = 0; x < W; x++) g[y * W + x] = 0;
  text(g, 200, 900, 200, 230);                                    // caption below the box
  return g;
}

async function writePng(name: string, gray: Uint8Array) {
  await fs.mkdir(path.join(outDir, name), { recursive: true });
  const p = path.join(outDir, name, 'frame.png');
  await sharp(Buffer.from(gray), { raw: { width: W, height: H, channels: 1 } }).png({ compressionLevel: 9 }).toFile(p);
  return p;
}

async function main() {
  const f = await writePng('synthetic_fan', fanFrame());
  const t = await writePng('synthetic_trap', trapFrame());
  console.log(`wrote ${f}\nwrote ${t}\nnow: python3 scripts/automask_spike/automask_spike.py --propose-png ${f} > ${path.dirname(f)}/proposal.json`);
  console.log(`     python3 scripts/automask_spike/automask_spike.py --propose-png ${t} --bound 8,100,623,860 > ${path.dirname(t)}/proposal.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
