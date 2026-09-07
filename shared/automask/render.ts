/**
 * Auto-mask Round 2A — full-resolution rendering of a contract shape and the scorer (port of bench.py
 * `shape_full_mask` and automask_spike.py `score`). Used by the fixture test and the eval; 2B's canvas layer
 * draws the same shapes through shape.ts.
 */

import { AUTOMASK_CONSTANTS as C } from './constants';
import type { Grid, KeepShape, Bound } from './types';
import { grid, erode, dilate } from './geometry';
import { renderFan, iou } from './fan';
import { renderTrap } from './trap';

/** shape_full_mask: render → clip to the T0 box → erode the safety margin. */
export function renderKeepMask(shape: KeepShape, w: number, h: number, bound: Bound | null = null, marginPx: number = C.MARGIN_PX): Grid {
  let m: Grid;
  if (shape.kind === 'fan') m = renderFan(w, h, { ...shape, th_l: -shape.half_angle, th_r: shape.half_angle });
  else m = renderTrap(w, h, shape);
  if (bound) {
    const out = grid(w, h);
    for (let y = Math.max(0, bound.y0); y <= Math.min(h - 1, bound.y1); y++) for (let x = Math.max(0, bound.x0); x <= Math.min(w - 1, bound.x1); x++) out.data[y * w + x] = m.data[y * w + x];
    m = out;
  }
  if (marginPx > 0) m = erode(m, 2 * marginPx + 1);
  return m;
}

export interface Score { iou: number; leak: number; over_blank: number; leak_core6: number; over_core6: number }

/** score(keep, ref): leak = kept where the reference masks; over_blank = masked where the reference keeps; ±BAND_PX core variants. */
export function score(keep: Grid, ref: Grid, bandPx: number = C.BAND_PX): Score {
  let refMasked = 0, refKept = 0, leakN = 0, overN = 0;
  for (let i = 0; i < ref.data.length; i++) {
    const k = keep.data[i] > 0, r = ref.data[i] > 0;
    if (r) refKept++; else refMasked++;
    if (k && !r) leakN++;
    if (!k && r) overN++;
  }
  const k = 2 * bandPx + 1;
  const dil = dilate(ref, k), ero = erode(ref, k);
  let coreMasked = 0, coreKept = 0, leakCore = 0, overCore = 0;
  for (let i = 0; i < ref.data.length; i++) {
    const kk = keep.data[i] > 0;
    if (dil.data[i] === 0) { coreMasked++; if (kk) leakCore++; }
    if (ero.data[i] > 0) { coreKept++; if (!kk) overCore++; }
  }
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  return {
    iou: Math.round(iou(keep, ref) * 1e4) / 1e4,
    leak: r5(refMasked ? leakN / refMasked : 0),
    over_blank: r5(refKept ? overN / refKept : 0),
    leak_core6: r5(leakCore / Math.max(1, coreMasked)),
    over_core6: r5(overCore / Math.max(1, coreKept)),
  };
}
