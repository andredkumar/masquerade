// Placement evidence for the proposal: how long does the T1 *front half* take in-process with sharp
// (PNG decode -> 4x downscale -> gray raw) plus a plain-JS density/CC pass, on one thread?
import sharp from 'sharp';
import fs from 'fs';
sharp.concurrency(1);
const files = process.argv.slice(2);
for (const f of files) {
  const buf = fs.readFileSync(f);
  const t0 = process.hrtime.bigint();
  const meta = await sharp(buf).metadata();
  const w = Math.floor(meta.width / 4), h = Math.floor(meta.height / 4);
  const { data } = await sharp(buf).resize(w, h, { kernel: 'lanczos3' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const t1 = process.hrtime.bigint();
  // not-black -> 11x11 box density (integral image) -> threshold -> largest 8-connected component (BFS)
  const nb = new Uint8Array(w * h); for (let i = 0; i < nb.length; i++) nb[i] = data[i] > 3 ? 1 : 0;
  const ii = new Uint32Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) { let row = 0; for (let x = 1; x <= w; x++) { row += nb[(y - 1) * w + (x - 1)]; ii[y * (w + 1) + x] = ii[(y - 1) * (w + 1) + x] + row; } }
  const R = 5, reg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(w, x + R + 1), y1 = Math.min(h, y + R + 1);
    const s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
    reg[y * w + x] = s / ((x1 - x0) * (y1 - y0)) > 0.35 ? 1 : 0;
  }
  const lab = new Int32Array(w * h).fill(-1); let best = 0, bestN = 0, n = 0; const q = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) { if (!reg[s] || lab[s] >= 0) continue; let qh = 0, qt = 0; q[qt++] = s; lab[s] = n; let cnt = 0;
    while (qh < qt) { const p = q[qh++]; cnt++; const px = p % w, py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const t = ny * w + nx; if (reg[t] && lab[t] < 0) { lab[t] = n; q[qt++] = t; } } }
    if (cnt > bestN) { bestN = cnt; best = n; } n++; }
  const t2 = process.hrtime.bigint();
  console.log(JSON.stringify({ file: f.split('/').slice(-2).join('/'), size: `${meta.width}x${meta.height}`, decode_resize_ms: Number(t1 - t0) / 1e6, js_density_cc_ms: Number(t2 - t1) / 1e6, largest_cc_px: bestN, components: n }));
}
