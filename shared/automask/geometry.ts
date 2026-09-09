/**
 * Auto-mask Round 2A — integer-grid image operations, ported to match the OpenCV / numpy calls the Python spike
 * makes (scripts/automask_spike/automask_spike.py). Every deviation from OpenCV's semantics that would move a
 * pixel is called out; the verified conventions (2026-09-06, cv2 4.x):
 *   • cv2.resize INTER_AREA: area average of the source box, rounded half-to-even (cvRound).
 *   • cv2.boxFilter default border: BORDER_REFLECT_101 (numpy 'reflect').
 *   • cv2.floodFill default connectivity: 4.
 *   • MORPH_ELLIPSE footprints for k = 5, 7, 9, 13, 15 — embedded below, bit for bit.
 *   • erode treats pixels outside the image as 1, dilate as 0 (cv2's morphologyDefaultBorderValue).
 * No DOM, no Node — plain typed arrays, so 2B can run the same code in the browser.
 */

import type { Grid, Bound } from './types';

export function grid(w: number, h: number, data?: Uint8Array): Grid {
  return { w, h, data: data ?? new Uint8Array(w * h) };
}

export function count(g: Grid): number {
  let n = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i]) n++;
  return n;
}

/** Round half to even, like cvRound / np.rint. */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** cv2.cvtColor(BGR2GRAY) fixed-point: (R·4899 + G·9617 + B·1868 + 2^13) >> 14. Input is RGB(A) interleaved. */
export function rgbToGray(px: Uint8Array, w: number, h: number, channels: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (channels === 1) { out.set(px.subarray(0, w * h)); return out; }
  for (let i = 0, j = 0; i < w * h; i++, j += channels) {
    out[i] = (px[j] * 4899 + px[j + 1] * 9617 + px[j + 2] * 1868 + 8192) >> 14;
  }
  return out;
}

/**
 * cv2.resize(img, (w // D, h // D), INTER_AREA). When w or h is not a multiple of D the scale is fractional
 * (873/218 = 4.0046): OpenCV averages the fractional source box with partial weights at both ends. Separable.
 */
export function downscaleArea(src: Grid, D: number): Grid {
  const ow = Math.floor(src.w / D), oh = Math.floor(src.h / D);
  const sx = src.w / ow, sy = src.h / oh;
  const weights = (n: number, scale: number, srcLen: number) => {
    const rows: Array<Array<[number, number]>> = [];
    for (let i = 0; i < n; i++) {
      const a = i * scale, b = (i + 1) * scale;
      const cells: Array<[number, number]> = [];
      for (let c = Math.floor(a); c < Math.min(srcLen, Math.ceil(b)); c++) {
        const wgt = Math.min(b, c + 1) - Math.max(a, c);
        if (wgt > 1e-12) cells.push([c, wgt / scale]);
      }
      rows.push(cells);
    }
    return rows;
  };
  const wx = weights(ow, sx, src.w), wy = weights(oh, sy, src.h);
  // horizontal pass into a float buffer of oh? no — vertical first on full width, then horizontal
  const tmp = new Float64Array(oh * src.w);
  for (let y = 0; y < oh; y++) {
    const cells = wy[y];
    for (const [r, wgt] of cells) {
      const row = r * src.w;
      const trow = y * src.w;
      for (let x = 0; x < src.w; x++) tmp[trow + x] += src.data[row + x] * wgt;
    }
  }
  const out = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const trow = y * src.w;
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (const [c, wgt] of wx[x]) s += tmp[trow + c] * wgt;
      out[y * ow + x] = Math.max(0, Math.min(255, roundHalfEven(s)));
    }
  }
  return { w: ow, h: oh, data: out };
}

/** (mode, fraction within ±tol of the mode) — background_stats. */
export function histogramMode(g: Grid, tol: number): { mode: number; frac: number } {
  const hist = new Int32Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  let mode = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[mode]) mode = v;   // argmax → first max (np.argmax)
  let s = 0;
  for (let v = Math.max(0, mode - tol); v <= Math.min(255, mode + tol); v++) s += hist[v];
  return { mode, frac: s / g.data.length };
}

export function threshold(g: Grid, gt: number): Grid {
  const out = grid(g.w, g.h);
  for (let i = 0; i < g.data.length; i++) out.data[i] = g.data[i] > gt ? 1 : 0;
  return out;
}

/**
 * cv2.boxFilter(binary float, ksize k, normalize=True) > dmin, with BORDER_REFLECT_101. Returns the binary region.
 * Counts are exact integers over the reflected padding; the comparison count/k² > dmin never lands on a tie for the
 * frozen k = 11, dmin = 0.35 (42.35).
 */
export function boxDensityRegion(bin: Grid, k: number, dmin: number): Grid {
  const r = (k - 1) >> 1;
  const W = bin.w + 2 * r, H = bin.h + 2 * r;
  // reflect-101 index mapping
  const refl = (i: number, n: number) => {
    // period 2(n-1)
    const p = 2 * (n - 1);
    if (n === 1) return 0;
    let m = ((i % p) + p) % p;
    if (m >= n) m = p - m;
    return m;
  };
  const ii = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    const sy = refl(y - r, bin.h);
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      const sx = refl(x - r, bin.w);
      rowSum += bin.data[sy * bin.w + sx];
      ii[(y + 1) * (W + 1) + (x + 1)] = ii[y * (W + 1) + (x + 1)] + rowSum;
    }
  }
  const out = grid(bin.w, bin.h);
  const kk = k * k;
  for (let y = 0; y < bin.h; y++) {
    for (let x = 0; x < bin.w; x++) {
      const y0 = y, y1 = y + k, x0 = x, x1 = x + k;     // in padded coords (top-left of the window)
      const s = ii[y1 * (W + 1) + x1] - ii[y0 * (W + 1) + x1] - ii[y1 * (W + 1) + x0] + ii[y0 * (W + 1) + x0];
      out.data[y * bin.w + x] = s / kk > dmin ? 1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Morphology with cv2.getStructuringElement(MORPH_ELLIPSE, (k, k)) footprints — copied bit for bit from OpenCV.

const ELLIPSE: Record<number, string[]> = {
  3: ['010', '111', '010'],
  5: ['00100', '11111', '11111', '11111', '00100'],
  7: ['0001000', '0111110', '1111111', '1111111', '1111111', '0111110', '0001000'],
  9: ['000010000', '011111110', '011111110', '111111111', '111111111', '111111111', '011111110', '011111110', '000010000'],
  13: ['0000001000000', '0001111111000', '0011111111100', '0111111111110', '1111111111111', '1111111111111', '1111111111111', '1111111111111', '1111111111111', '0111111111110', '0011111111100', '0001111111000', '0000001000000'],
  15: ['000000010000000', '000111111111000', '001111111111100', '011111111111110', '011111111111110', '111111111111111', '111111111111111', '111111111111111', '111111111111111', '111111111111111', '011111111111110', '011111111111110', '001111111111100', '000111111111000', '000000010000000'],
};

function ellipseOffsets(k: number): Array<[number, number]> {
  const rows = ELLIPSE[k];
  if (!rows) throw new Error(`no ellipse footprint for k=${k} (add it from cv2.getStructuringElement)`);
  const r = (k - 1) >> 1;
  const offs: Array<[number, number]> = [];
  for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) if (rows[dy][dx] === '1') offs.push([dx - r, dy - r]);
  return offs;
}

const OFFS_CACHE = new Map<number, Array<[number, number]>>();
function offs(k: number) {
  let o = OFFS_CACHE.get(k);
  if (!o) { o = ellipseOffsets(k); OFFS_CACHE.set(k, o); }
  return o;
}

/** cv2.erode with an ellipse kernel; outside the image counts as 1. */
export function erode(bin: Grid, k: number): Grid {
  const o = offs(k), out = grid(bin.w, bin.h);
  const { w, h, data } = bin;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      let keep = 1;
      for (let i = 0; i < o.length; i++) {
        const xx = x + o[i][0], yy = y + o[i][1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (!data[yy * w + xx]) { keep = 0; break; }
      }
      out.data[y * w + x] = keep;
    }
  }
  return out;
}

/** cv2.dilate with an ellipse kernel; outside the image counts as 0. */
export function dilate(bin: Grid, k: number): Grid {
  const o = offs(k), out = grid(bin.w, bin.h);
  const { w, h, data } = bin;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      for (let i = 0; i < o.length; i++) {
        const xx = x + o[i][0], yy = y + o[i][1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        out.data[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

export const open = (bin: Grid, k: number) => dilate(erode(bin, k), k);
export const close = (bin: Grid, k: number) => erode(dilate(bin, k), k);

// ---------------------------------------------------------------------------------------------------------------------
// Connected components (8-connectivity), numbered in row-major first-appearance order like OpenCV's labels.

export interface CCStats { area: number; left: number; top: number; width: number; height: number }
export interface CC { n: number; labels: Int32Array; stats: CCStats[] }   // stats[0] is the background placeholder

export function connectedComponents(bin: Grid, connectivity: 4 | 8 = 8): CC {
  const { w, h, data } = bin;
  const labels = new Int32Array(w * h);
  const stats: CCStats[] = [{ area: 0, left: 0, top: 0, width: 0, height: 0 }];
  const stack = new Int32Array(w * h);
  let n = 0;
  for (let start = 0; start < w * h; start++) {
    if (!data[start] || labels[start]) continue;
    n++;
    let sp = 0; stack[sp++] = start; labels[start] = n;
    let area = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      area++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      // neighbours
      const left = x > 0, right = x < w - 1, up = y > 0, down = y < h - 1;
      const cand: number[] = [];
      if (left) cand.push(i - 1); if (right) cand.push(i + 1); if (up) cand.push(i - w); if (down) cand.push(i + w);
      if (connectivity === 8) {
        if (up && left) cand.push(i - w - 1); if (up && right) cand.push(i - w + 1);
        if (down && left) cand.push(i + w - 1); if (down && right) cand.push(i + w + 1);
      }
      for (const j of cand) if (data[j] && !labels[j]) { labels[j] = n; stack[sp++] = j; }
    }
    stats.push({ area, left: minx, top: miny, width: maxx - minx + 1, height: maxy - miny + 1 });
  }
  return { n: n + 1, labels, stats };
}

export function largestComponent(bin: Grid): { mask: Grid; area: number } {
  const cc = connectedComponents(bin, 8);
  if (cc.n <= 1) return { mask: grid(bin.w, bin.h), area: 0 };
  let idx = 1;
  for (let i = 2; i < cc.n; i++) if (cc.stats[i].area > cc.stats[idx].area) idx = i;   // np.argmax → first max
  const mask = grid(bin.w, bin.h);
  for (let i = 0; i < cc.labels.length; i++) mask.data[i] = cc.labels[i] === idx ? 1 : 0;
  return { mask, area: cc.stats[idx].area };
}

export function maskFromLabels(cc: CC, labelsToKeep: Set<number>, w: number, h: number): Grid {
  const out = grid(w, h);
  for (let i = 0; i < cc.labels.length; i++) if (labelsToKeep.has(cc.labels[i])) out.data[i] = 1;
  return out;
}

/**
 * fill_holes: flood the background (mask == 0) 4-connected from (0,0) and from border points sampled every
 * w//32 columns / h//32 rows — exactly the spike's seed pattern, quirks included — then everything still
 * background is a hole and becomes 1.
 */
export function fillHoles(mask: Grid): Grid {
  const { w, h, data } = mask;
  // flooded: 1 = background, 0 = mask, 2 = flooded background (or a flooded mask component if the seed sat on mask — the spike does the same)
  const fl = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fl[i] = data[i] === 0 ? 1 : 0;
  const stack = new Int32Array(w * h);
  const flood = (sx: number, sy: number) => {
    const s = sy * w + sx; const v = fl[s];
    if (v === 2) return;
    let sp = 0; stack[sp++] = s; fl[s] = 2;
    while (sp > 0) {
      const i = stack[--sp]; const x = i % w, y = (i - x) / w;
      if (x > 0 && fl[i - 1] === v) { fl[i - 1] = 2; stack[sp++] = i - 1; }
      if (x < w - 1 && fl[i + 1] === v) { fl[i + 1] = 2; stack[sp++] = i + 1; }
      if (y > 0 && fl[i - w] === v) { fl[i - w] = 2; stack[sp++] = i - w; }
      if (y < h - 1 && fl[i + w] === v) { fl[i + w] = 2; stack[sp++] = i + w; }
    }
  };
  flood(0, 0);
  const stepX = Math.max(1, Math.floor(w / 32)), stepY = Math.max(1, Math.floor(h / 32));
  for (let x = 0; x < w; x += stepX) for (const y of [0, h - 1]) if (fl[y * w + x] === 1) flood(x, y);
  for (let y = 0; y < h; y += stepY) for (const x of [0, w - 1]) if (fl[y * w + x] === 1) flood(x, y);
  const out = grid(w, h, new Uint8Array(data));
  for (let i = 0; i < w * h; i++) if (fl[i] === 1) out.data[i] = 1;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry on point sets

export type Pt = [number, number];

/**
 * Convex hull in cv2.convexHull's order: Andrew's monotone chain (collinear points dropped), rotated to start at the
 * point with the largest x (ties: largest y) — OpenCV's Sklansky output starts there and runs the same way round, and
 * approxPolyDP's result depends on pt[0].
 */
export function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  const hull = lower.concat(upper);
  // orientation: cv2's sequence has a positive shoelace sum in image coordinates; flip if ours does not
  let area2 = 0;
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; area2 += a[0] * b[1] - b[0] * a[1]; }
  if (area2 < 0) hull.reverse();
  let s0 = 0;
  for (let i = 1; i < hull.length; i++) if (hull[i][0] > hull[s0][0] || (hull[i][0] === hull[s0][0] && hull[i][1] > hull[s0][1])) s0 = i;
  return hull.slice(s0).concat(hull.slice(0, s0));
}

export function arcLength(poly: Pt[], closed = true): number {
  let L = 0;
  for (let i = 0; i < poly.length - 1; i++) L += Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]);
  if (closed && poly.length > 1) L += Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]);
  return L;
}

/**
 * cv2.approxPolyDP(curve, epsilon, closed=True) — a port of OpenCV's approxPolyDP_ for closed curves: three rounds of
 * "farthest point from the current start" to pick the two initial vertices, the recursive split with the test
 * |cross| ≤ eps·|chord| (strict > for the running max, ties → the earlier point), the stack order (start→far first),
 * and the closed-curve clean-up pass (a vertex within eps/√2 of its neighbours' chord, with a non-negative successive
 * inner product, is dropped).
 */
export function approxPolyDP(src: Pt[], eps: number): Pt[] {
  const count = src.length;
  if (count <= 2) return src.slice();
  const eps2 = eps * eps;
  let pos = 0, farOff = 0;
  let leEps = false;
  for (let it = 0; it < 3; it++) {
    let maxDist = 0; farOff = 0;
    pos = (pos + farOff) % count;
    // (pos advanced by the previous round's offset; the first round starts at 0)
    const sp = src[pos];
    for (let j = 1; j < count; j++) {
      const q = src[(pos + j) % count];
      const d = (q[0] - sp[0]) ** 2 + (q[1] - sp[1]) ** 2;
      if (d > maxDist) { maxDist = d; farOff = j; }
    }
    leEps = maxDist <= eps2;
    if (it < 2) pos = (pos + farOff) % count;
  }
  const out: Pt[] = [];
  if (leEps) { out.push(src[pos]); return out; }
  type Slice = { s: number; e: number };
  const stack: Slice[] = [];
  const startIdx = pos % count, endIdx = (farOff + startIdx) % count;
  stack.push({ s: endIdx, e: startIdx });   // right_slice
  stack.push({ s: startIdx, e: endIdx });   // slice — processed first
  while (stack.length) {
    const sl = stack.pop()!;
    const sp = src[sl.s], ep = src[sl.e];
    const n = sl.e > sl.s ? sl.e - sl.s - 1 : sl.e + count - sl.s - 1;
    const dx = ep[0] - sp[0], dy = ep[1] - sp[1];
    let maxDist = 0, farIdx = -1, p = sl.s;
    for (let i = 0; i < n; i++) {
      p = (p + 1) % count;
      const d = Math.abs((src[p][1] - sp[1]) * dx - (src[p][0] - sp[0]) * dy);
      if (d > maxDist) { maxDist = d; farIdx = p; }
    }
    if (maxDist * maxDist <= eps2 * (dx * dx + dy * dy)) out.push(sp);
    else { stack.push({ s: farIdx, e: sl.e }); stack.push({ s: sl.s, e: farIdx }); }
  }
  // clean-up pass (closed curve)
  let dst = out;
  if (dst.length > 2) {
    const res: Pt[] = [];
    let n = dst.length;
    let startPt = dst[n - 1];
    for (let i = 0; i < n && n > 2; i++) {
      const cur = dst[i], endPt = dst[(i + 1) % dst.length];
      const dx = endPt[0] - startPt[0], dy = endPt[1] - startPt[1];
      const dist = Math.abs((cur[0] - startPt[0]) * dy - (cur[1] - startPt[1]) * dx);
      const inner = (cur[0] - startPt[0]) * (endPt[0] - cur[0]) + (cur[1] - startPt[1]) * (endPt[1] - cur[1]);
      if (dist * dist <= 0.5 * eps2 * (dx * dx + dy * dy) && dx !== 0 && dy !== 0 && inner >= 0) { n--; continue; }
      res.push(cur); startPt = cur;
    }
    dst = res;
  }
  return dst;
}

/** numpy percentile with linear interpolation on a Float64Array (sorted in place — pass a copy if you need the original). */
export function percentile(values: Float64Array, q: number): number {
  const a = values.slice().sort();
  const n = a.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function median(values: number[] | Float64Array): number {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (n === 0) return NaN;
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

export function mean(values: ArrayLike<number>): number {
  let s = 0; for (let i = 0; i < values.length; i++) s += values[i];
  return values.length ? s / values.length : NaN;
}

/**
 * Theil–Sen slope + intercept as the spike does it: median of pairwise slopes over rows with dy > 0
 * (np.triu_indices(n, 1)), intercept = median(x − slope·y). Subsampling (np.linspace(0, n−1, 60).astype(int)) is
 * the caller's responsibility where the spike applies it.
 */
export function theilSen(ys: Float64Array, xs: Float64Array): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) {
    const dy = ys[j] - ys[i];
    if (dy > 0) slopes.push((xs[j] - xs[i]) / dy);
  }
  const slope = slopes.length ? median(slopes) : 0;
  const resid = new Float64Array(ys.length);
  for (let i = 0; i < ys.length; i++) resid[i] = xs[i] - slope * ys[i];
  return { slope, intercept: median(resid) };
}

/** np.linspace(0, n-1, m).astype(int) */
export function linspaceIdx(n: number, m: number): number[] {
  if (n <= m) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < m; i++) out.push(Math.trunc((n - 1) * i / (m - 1)));
  return out;
}

/** np.convolve(ok, ones(k), 'valid') on a 0/1 sequence → the first index where the window sum reaches k, or -1. */
export function firstSustained(ok: ArrayLike<number>, k: number): number {
  let run = 0;
  for (let i = 0; i < ok.length; i++) {
    run = ok[i] ? run + 1 : 0;
    if (run >= k) return i - k + 1;
  }
  return -1;
}

/** Same, but the LAST window (np.nonzero(run >= k)[0][-1]). */
export function lastSustained(ok: ArrayLike<number>, k: number): number {
  let run = 0, last = -1;
  for (let i = 0; i < ok.length; i++) {
    run = ok[i] ? run + 1 : 0;
    if (run >= k) last = i - k + 1;
  }
  return last;
}

/** Row extents of a binary grid: for each row, [first x, last x] or null. */
export function rowExtents(bin: Grid): Array<[number, number] | null> {
  const out: Array<[number, number] | null> = new Array(bin.h).fill(null);
  for (let y = 0; y < bin.h; y++) {
    let a = -1, b = -1;
    const row = y * bin.w;
    for (let x = 0; x < bin.w; x++) if (bin.data[row + x]) { if (a < 0) a = x; b = x; }
    out[y] = a >= 0 ? [a, b] : null;
  }
  return out;
}

export function nonzeroYX(bin: Grid): { ys: Int32Array; xs: Int32Array } {
  const n = count(bin);
  const ys = new Int32Array(n), xs = new Int32Array(n);
  let k = 0;
  for (let y = 0; y < bin.h; y++) for (let x = 0; x < bin.w; x++) if (bin.data[y * bin.w + x]) { ys[k] = y; xs[k] = x; k++; }
  return { ys, xs };
}

/**
 * cv2.fillPoly on integer vertices — FillEdgeCollection + the LINE_8 outline, ported: edges carry x in 16-bit fixed
 * point from their upper vertex, advancing by trunc((Δx << 16) / Δy) per row; on each row y ∈ [y0, y1) the span between
 * paired edges is [ceil(xl), floor(xr)] in pixels; the outline is cv::Line on each edge, i.e. cv::clipLine to the image
 * first and then the LineIterator DDA; the span x is sampled half a row above the scanline (x0 + (y − y0)·dx − dx/2).
 * Verified identical to cv2.fillPoly on 60/60 random trapezoids whose vertices may leave the frame horizontally.
 */
export function fillPoly(w: number, h: number, pts: Pt[]): Grid {
  const out = grid(w, h);
  const n = pts.length;
  if (n < 3) return out;
  const set = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < w && y < h) out.data[y * w + x] = 1; };
  type Edge = { y0: number; y1: number; x0: bigint; dx: bigint };
  const edges: Edge[] = [];
  const SH = BigInt(16), HALF_UP = BigInt(65535);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ax = Math.round(a[0]), ay = Math.round(a[1]), bx = Math.round(b[0]), by = Math.round(b[1]);
    const cl = clipLine(w, h, ax, ay, bx, by);
    if (cl) line8(cl[0], cl[1], cl[2], cl[3], set);
    if (ay === by) continue;
    const [x0, y0, x1, y1] = ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay];
    const dx = (BigInt(x1 - x0) << SH) / BigInt(y1 - y0);       // BigInt division truncates toward zero like C++
    edges.push({ y0, y1, x0: BigInt(x0) << SH, dx });
  }
  if (!edges.length) return out;
  let ymin = Infinity, ymax = -Infinity;
  for (const e of edges) { ymin = Math.min(ymin, e.y0); ymax = Math.max(ymax, e.y1); }
  const xs: bigint[] = [];
  for (let y = Math.max(0, ymin); y <= Math.min(h - 1, ymax); y++) {
    xs.length = 0;
    for (const e of edges) if (e.y0 <= y && y < e.y1) xs.push(e.x0 + BigInt(y - e.y0) * e.dx - e.dx / BigInt(2));   // the edge is sampled half a row above the scanline (FillEdgeCollection); BigInt / truncates like C++
    if (xs.length < 2) continue;
    xs.sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xl = Number((xs[k] + HALF_UP) >> SH), xr = Number(xs[k + 1] >> SH);
      if (xl < w && xr >= 0) for (let x = Math.max(0, xl); x <= Math.min(w - 1, xr); x++) out.data[y * w + x] = 1;
    }
  }
  return out;
}

/** cv::clipLine(Size, Point&, Point&) — integer Cohen–Sutherland with C truncating division; null when fully outside. */
export function clipLine(w: number, h: number, x1: number, y1: number, x2: number, y2: number): [number, number, number, number] | null {
  const right = w - 1, bottom = h - 1;
  const code = (x: number, y: number) => (x < 0 ? 1 : 0) + (x > right ? 2 : 0) + (y < 0 ? 4 : 0) + (y > bottom ? 8 : 0);
  const tdiv = (a: number, b: number) => Math.trunc(a / b);
  let c1 = code(x1, y1), c2 = code(x2, y2);
  if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
    if (c1 & 12) { const a = c1 < 8 ? 0 : bottom; x1 += tdiv((a - y1) * (x2 - x1), y2 - y1); y1 = a; c1 = (x1 < 0 ? 1 : 0) + (x1 > right ? 2 : 0); }
    if (c2 & 12) { const a = c2 < 8 ? 0 : bottom; x2 += tdiv((a - y2) * (x2 - x1), y2 - y1); y2 = a; c2 = (x2 < 0 ? 1 : 0) + (x2 > right ? 2 : 0); }
    if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
      if (c1) { const a = c1 === 1 ? 0 : right; y1 += tdiv((a - x1) * (y2 - y1), x2 - x1); x1 = a; c1 = 0; }
      if (c2) { const a = c2 === 1 ? 0 : right; y2 += tdiv((a - x2) * (y2 - y1), x2 - x1); x2 = a; c2 = 0; }
    }
  }
  return (c1 | c2) === 0 ? [x1, y1, x2, y2] : null;
}

/** cv::LineIterator(connectivity 8, left_to_right) — OpenCV's own DDA, including its tie-breaking. */
export function line8(x1: number, y1: number, x2: number, y2: number, set: (x: number, y: number) => void): void {
  let dx = x2 - x1, dy = y2 - y1;
  if (dx < 0) { dx = -dx; dy = -dy; x1 = x2; y1 = y2; }
  const ystep = dy < 0 ? -1 : 1;
  dy = Math.abs(dy);
  let x = x1, y = y1;
  if (dx >= dy) {
    let err = dx - 2 * dy;
    const count = dx + 1;
    for (let i = 0; i < count; i++) {
      set(x, y);
      const mask = err < 0 ? -1 : 0;
      err += -(2 * dy) + ((2 * dx) & mask);
      x += 1;
      if (mask) y += ystep;
    }
  } else {
    let err = dy - 2 * dx;
    const count = dy + 1;
    for (let i = 0; i < count; i++) {
      set(x, y);
      const mask = err < 0 ? -1 : 0;
      err += -(2 * dx) + ((2 * dy) & mask);
      y += ystep;
      if (mask) x += 1;
    }
  }
}

/** The T0 box as a full-res 0/1 grid. 2B-1: shared by the service (contract) and the worker (the fit), so it lives here. */
export function boundToGrid(b: Bound, w: number, h: number): Grid {
  const g = grid(w, h);
  for (let y = b.y0; y <= b.y1; y++) g.data.fill(1, y * w + b.x0, y * w + b.x1 + 1);
  return g;
}
