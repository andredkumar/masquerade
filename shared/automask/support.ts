/**
 * Auto-mask Round 2A — background model and the support pipeline (port of automask_spike.py `background_stats`,
 * `clean_support`). Order matters and is the one frozen in CONSTANTS.md "Support pipeline":
 *   not-background → density → open K_OPEN → drop_small_blobs → close K_CLOSE_SMALL → largest component →
 *   close K_CLOSE → fill → open K_CUT → largest → fill  (+ the union candidate, + the bright-blob mask for confidence)
 */

import { AUTOMASK_CONSTANTS as C, RULES } from './constants';
import type { Grid } from './types';
import { grid, boxDensityRegion, open, close, largestComponent, fillHoles, connectedComponents, maskFromLabels, histogramMode, dilate } from './geometry';

export interface BackgroundStats { mode: number; frac: number }

export function backgroundStats(grayS: Grid): BackgroundStats {
  return histogramMode(grayS, C.BG_TOL);
}

export interface SmallBlob { area: number; left: number; top: number; width: number; height: number }

export interface SupportResult {
  support: Grid;          // the cleaned largest component (comp)
  blobs: Grid;            // bright blobs (gray > bg + T_BRIGHT, opened) — confidence's `opened_s`
  area: number;
  union: Grid | null;     // union of large components (a cone split by an echo-free band), or null
  removed: Grid;          // drop_small_blobs: the dropped density components, dilated by K_CLOSE_SMALL (zero grid when none)
  region: Grid;           // the raw density region (before opening) — TOP_FILL_SRC='density' evaluation only
  smallBlobs: SmallBlob[];
}

function thresholdGT(g: Grid, gt: number, remove: Grid | null): Grid {
  const out = grid(g.w, g.h);
  for (let i = 0; i < g.data.length; i++) out.data[i] = g.data[i] > gt && !(remove && remove.data[i]) ? 1 : 0;
  return out;
}

export function cleanSupport(grayS: Grid, bg: number, remove: Grid | null = null): SupportResult {
  const { w, h } = grayS;
  const notblack = thresholdGT(grayS, bg + C.T_LOW, remove);
  const region = boxDensityRegion(notblack, C.K_DENS, C.D_MIN);
  let opened = open(region, C.K_OPEN);
  let removed = grid(w, h);
  const smallBlobs: SmallBlob[] = [];
  if (RULES.drop_small_blobs) {
    const cc = connectedComponents(opened, 8);
    if (cc.n > 2) {
      let amax = 0;
      for (let i = 1; i < cc.n; i++) amax = Math.max(amax, cc.stats[i].area);
      const small = new Set<number>();
      for (let i = 1; i < cc.n; i++) if (cc.stats[i].area < C.BLOB_FRAC * amax) small.add(i);
      if (small.size) {
        removed = maskFromLabels(cc, small, w, h);
        const o2 = grid(w, h, new Uint8Array(opened.data));
        for (let i = 0; i < o2.data.length; i++) if (removed.data[i]) o2.data[i] = 0;
        opened = o2;
        small.forEach((i) => { const s = cc.stats[i]; smallBlobs.push({ area: s.area, left: s.left, top: s.top, width: s.width, height: s.height }); });
      }
    }
  }
  let anyRemoved = false;
  for (let i = 0; i < removed.data.length; i++) if (removed.data[i]) { anyRemoved = true; break; }
  const removedDil = anyRemoved ? dilate(removed, C.K_CLOSE_SMALL) : removed;

  const closedS = close(opened, C.K_CLOSE_SMALL);
  let comp = largestComponent(closedS).mask;
  comp = fillHoles(close(comp, C.K_CLOSE));
  comp = open(comp, C.K_CUT);
  const lc = largestComponent(comp);
  comp = fillHoles(lc.mask);

  // union of every component at least UNION_FRAC of the largest (only used when one fan explains it — fitSupport)
  let union: Grid | null = null;
  const cc2 = connectedComponents(closedS, 8);
  if (cc2.n > 2) {
    let amax = 0;
    for (let i = 1; i < cc2.n; i++) amax = Math.max(amax, cc2.stats[i].area);
    const big = new Set<number>();
    for (let i = 1; i < cc2.n; i++) if (cc2.stats[i].area >= C.UNION_FRAC * amax) big.add(i);
    if (big.size > 1) union = fillHoles(close(maskFromLabels(cc2, big, w, h), C.K_CLOSE));
  }

  const bright = thresholdGT(grayS, bg + C.T_BRIGHT, remove);
  const blobs = open(bright, C.K_OPEN);
  return { support: comp, blobs, area: lc.area, union, removed: removedDil, region, smallBlobs };
}
