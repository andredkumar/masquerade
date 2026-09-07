/**
 * Auto-mask Round 2A — the symmetric trapezoid / rectangle model (port of automask_spike.py `fit_trap_sym`,
 * `render_trap`, `trap_side_angle_deg`). TRAP_DEPTH is frozen at 'refine'; the evaluated-and-rejected variants
 * (`deepest`, `image_rows`, `profile`) are not ported. `band_consistency` is frozen off and not ported.
 */

import { AUTOMASK_CONSTANTS as C, RULES } from './constants';
import type { Grid, TrapShape, Info } from './types';
import { grid, nonzeroYX, rowExtents, fillPoly, roundHalfEven, median, theilSen, linspaceIdx, firstSustained, type Pt } from './geometry';
import { fitScore, iou } from './fan';

export type TrapParams = TrapShape;

export function renderTrap(w: number, h: number, p: TrapParams): Grid {
  const pts: Pt[] = [
    [roundHalfEven(p.cx - p.w_top / 2), roundHalfEven(p.y_top)], [roundHalfEven(p.cx + p.w_top / 2), roundHalfEven(p.y_top)],
    [roundHalfEven(p.cx + p.w_bottom / 2), roundHalfEven(p.y_bottom)], [roundHalfEven(p.cx - p.w_bottom / 2), roundHalfEven(p.y_bottom)],
  ];
  return fillPoly(w, h, pts);
}

export function trapSideAngleDeg(p: TrapParams): number {
  return (Math.atan2((p.w_bottom - p.w_top) / 2, Math.max(1e-6, p.y_bottom - p.y_top)) * 180) / Math.PI;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function rowMean(bin: Grid, y: number, x0: number, x1: number): number {
  if (x1 < x0) return 0;
  let s = 0;
  const row = y * bin.w;
  for (let x = x0; x <= x1; x++) s += bin.data[row + x];
  return s / (x1 - x0 + 1);
}

/** fit_trap_sym. `xlim` = [x0, x1] of the T0 box on the analysis grid (null = the frame). */
export function fitTrapSym(support: Grid, notblack: Grid | null, xlim: [number, number] | null): [TrapParams | null, Info] {
  const { w, h } = support;
  let { ys, xs } = nonzeroYX(support);
  if (ys.length < 50) return [null, { reason: 'support_too_small' }];
  let yTop = Infinity, yBottom = -Infinity;
  for (let i = 0; i < ys.length; i++) { if (ys[i] < yTop) yTop = ys[i]; if (ys[i] > yBottom) yBottom = ys[i]; }
  let ext = rowExtents(support);
  const widthAt = (y: number) => { const e = ext[y]; return e ? e[1] - e[0] + 1 : 0; };
  let maxW = 0;
  for (let y = yTop; y <= yBottom; y++) maxW = Math.max(maxW, widthAt(y));
  if (RULES.top60) {
    const ok = new Uint8Array(yBottom - yTop + 1);
    for (let y = yTop; y <= yBottom; y++) {
      let o = widthAt(y) >= C.TOP_WIDE_FRAC * maxW;
      if (o && notblack) { const e = ext[y]; const fill = e ? rowMean(notblack, y, e[0], e[1]) : 0; o = fill >= C.TOP_FILL_MIN; }
      ok[y - yTop] = o ? 1 : 0;
    }
    const first = firstSustained(ok, C.TOP_SUSTAIN);
    if (first >= 0) {
      yTop = yTop + first;
      const sup = grid(w, h, new Uint8Array(support.data));
      for (let y = 0; y < yTop; y++) sup.data.fill(0, y * w, (y + 1) * w);
      support = sup;
      ({ ys, xs } = nonzeroYX(support));
      ext = rowExtents(support);
    }
  } else {
    for (let y = yTop; y <= yBottom; y++) if (widthAt(y) >= 0.30 * maxW) { yTop = y; break; }
  }
  const bandLim = yTop + Math.max(2, Math.trunc(0.03 * (yBottom - yTop)));
  let xL = Infinity, xR = -Infinity;
  for (let i = 0; i < ys.length; i++) if (ys[i] >= yTop && ys[i] <= bandLim) { if (xs[i] < xL) xL = xs[i]; if (xs[i] > xR) xR = xs[i]; }
  let cx = 0.5 * (xL + xR);
  const wTopMeas = xR - xL;
  const [x0, x1] = xlim ?? [0, w - 1];

  // the clean near-field band
  let rowsBoth: number[] = [], hwBoth: number[] = [], mids: number[] = [];
  const rowsOne: number[] = [], hwOne: number[] = [];
  let prev: [number, number] | null = null, bandEnd = yTop;
  const skip = 3;
  for (let y = yTop; y <= yBottom; y++) {
    const e = ext[y];
    if (!e) continue;
    const [xl, xr] = e;
    const vl = xl > Math.max(1, x0 + 1), vr = xr < Math.min(w - 2, x1 - 1);
    if (prev && y - yTop > skip && (Math.abs(xl - prev[0]) > C.SIDE_JUMP_PX || Math.abs(xr - prev[1]) > C.SIDE_JUMP_PX)) break;
    if (!(vl && vr)) {
      if (vl || vr) { rowsOne.push(y - yTop); hwOne.push(vl ? cx - xl : xr - cx); }
      if (y - yTop > skip) break;
      continue;
    }
    rowsBoth.push(y - yTop); hwBoth.push(0.5 * (xr - xl)); mids.push(0.5 * (xl + xr)); prev = [xl, xr]; bandEnd = y;
  }
  const info: Info = { trap_rows_both: rowsBoth.length, trap_rows_one: rowsOne.length, trap_band_end: bandEnd };
  if (rowsBoth.length >= 6) cx = median(mids);
  const [rowsY, hw] = rowsBoth.length >= 6 ? [rowsBoth, hwBoth] : [rowsOne, hwOne];
  let wTopSeed: number, wBottomSeed: number;
  if (rowsY.length >= 6) {
    let ry = Float64Array.from(rowsY), rh = Float64Array.from(hw);
    if (ry.length > 60) { const idx = linspaceIdx(ry.length, 60); ry = Float64Array.from(idx, (i) => ry[i]); rh = Float64Array.from(idx, (i) => rh[i]); }
    const { slope, intercept: a0 } = theilSen(ry, rh);
    wTopSeed = 2 * Math.max(a0, (wTopMeas / 2) * 0.5);
    wBottomSeed = 2 * (a0 + slope * (yBottom - yTop));
    info.trap_seed = 'top_edge+max_side' + (rowsBoth.length >= 6 ? '' : '(one-sided)');
  } else {
    wTopSeed = wTopMeas; wBottomSeed = wTopSeed; info.trap_seed = 'top_edge_only';
  }
  let p: TrapParams = { kind: 'trap', sym: true, cx, y_top: yTop, y_bottom: yBottom, w_top: Math.max(4, wTopSeed), w_bottom: Math.max(4, wBottomSeed) };

  const useBand = RULES.top60 && rowsBoth.length >= 6 && bandEnd > yTop + 8;
  let supFit = support;
  const yFitBottom = bandEnd;
  if (useBand) {
    const sf = grid(w, h, new Uint8Array(support.data));
    for (let y = bandEnd + 1; y < h; y++) sf.data.fill(0, y * w, (y + 1) * w);
    supFit = sf;
    p.w_bottom = p.w_top + ((wBottomSeed - wTopSeed) * (bandEnd - yTop)) / Math.max(1, yBottom - yTop);
    p.y_bottom = yFitBottom;
    info.trap_seed = String(info.trap_seed ?? '') + '+clean_band';
  }
  let best = fitScore(renderTrap(w, h, p), supFit);
  const steps: Record<string, number> = { cx: 0.005 * w, y_top: 0.01 * h, y_bottom: 0.01 * h, w_top: 0.01 * w, w_bottom: 0.01 * w };
  if (useBand) delete steps.y_bottom;
  for (let round = 0; round < 5; round++) {
    let improved = false;
    for (const k of Object.keys(steps)) {
      const st = steps[k];
      for (const sgn of [-1, 1]) {
        const q: TrapParams = { ...p };
        (q as unknown as Record<string, number>)[k] = (p as unknown as Record<string, number>)[k] + sgn * st;
        if (q.y_bottom <= q.y_top + 2 || q.w_top < 4 || q.w_bottom < 4) continue;
        const v = fitScore(renderTrap(w, h, q), supFit);
        if (v > best + 1e-4) { best = v; p = q; improved = true; }
      }
    }
    if (!improved) for (const k of Object.keys(steps)) steps[k] /= 2;
  }
  if (useBand) {
    const slope = (p.w_bottom - p.w_top) / Math.max(1, p.y_bottom - p.y_top);
    const along = (q: TrapParams, yb: number): TrapParams => ({ ...q, y_bottom: yb, w_bottom: Math.max(4, q.w_top + slope * (yb - q.y_top)) });
    p = along(p, yBottom); best = fitScore(renderTrap(w, h, p), support);
    if (C.TRAP_DEPTH === 'refine') {
      let st = 0.01 * h;
      for (let round = 0; round < 6; round++) {
        let improved = false;
        for (const sgn of [-1, 1]) {
          const q = along(p, p.y_bottom + sgn * st);
          if (q.y_bottom <= q.y_top + 2 || q.y_bottom > yBottom + 1) continue;
          const v = fitScore(renderTrap(w, h, q), support);
          if (v > best + 1e-4) { best = v; p = q; improved = true; }
        }
        if (!improved) st /= 2;
      }
      info.trap_depth = 'refined_along_sides';
    }
  }
  info.trap_sym_score = r4(best); info.trap_sym_iou = r4(iou(renderTrap(w, h, p), support)); info.trap_side_angle_deg = r2(trapSideAngleDeg(p));

  if (trapSideAngleDeg(p) < 3.0) {
    const wm = 0.5 * (p.w_top + p.w_bottom);
    let pr: TrapParams = { ...p, kind: 'rect', w_top: wm, w_bottom: wm };
    const ybFull = pr.y_bottom;
    if (useBand) pr.y_bottom = yFitBottom;
    let bestR = fitScore(renderTrap(w, h, pr), supFit);
    const stepsR: Record<string, number> = { cx: 0.005 * w, y_top: 0.01 * h, y_bottom: 0.01 * h, w: 0.01 * w };
    if (useBand) delete stepsR.y_bottom;
    for (let round = 0; round < 4; round++) {
      let improved = false;
      for (const k of Object.keys(stepsR)) {
        const st = stepsR[k];
        for (const sgn of [-1, 1]) {
          const q: TrapParams = { ...pr };
          if (k === 'w') { q.w_top = q.w_bottom = pr.w_top + sgn * st; } else (q as unknown as Record<string, number>)[k] = (pr as unknown as Record<string, number>)[k] + sgn * st;
          if (q.y_bottom <= q.y_top + 2 || q.w_top < 4) continue;
          const v = fitScore(renderTrap(w, h, q), supFit);
          if (v > bestR + 1e-4) { bestR = v; pr = q; improved = true; }
        }
      }
      if (!improved) for (const k of Object.keys(stepsR)) stepsR[k] /= 2;
    }
    if (useBand) { pr.y_bottom = ybFull; bestR = fitScore(renderTrap(w, h, pr), support); }
    info.rect_score = r4(bestR); info.rect_iou = r4(iou(renderTrap(w, h, pr), support));
    return [pr, info];
  }
  return [p, info];
}
