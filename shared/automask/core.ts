/**
 * Auto-mask Round 2A — model selection, confidence and the top-level `propose()` (port of automask_spike.py
 * `fit_fan`, `fit_support`, `confidence`, `finish_fit`, `tier_t1`, `scale_params`, `keep_fullres` and bench.py
 * `to_page_shape`). The order of gates and steps is the frozen one (CONSTANTS.md).
 */

import { AUTOMASK_CONSTANTS as C, RULES } from './constants';
import type { Grid, Info, KeepShape, FanShape, TrapShape, Model, ProposeResult } from './types';
import { grid, downscaleArea, threshold, connectedComponents, erode, nonzeroYX, rowExtents } from './geometry';
import { backgroundStats, cleanSupport, type BackgroundStats } from './support';
import { fitFanSym, renderFan, refineFanRadii, fitScore, iou } from './fan';
import { fitTrapSym, renderTrap } from './trap';

export { fitScore, iou };

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function renderShape(w: number, h: number, p: KeepShape): Grid {
  return p.kind === 'fan' ? renderFan(w, h, p) : renderTrap(w, h, p);
}

function stripReason(info: Info): Info {
  const out: Info = {};
  for (const k of Object.keys(info)) if (k !== 'reason') out[k] = info[k];
  return out;
}

/** fit_fan — selection among fan_sym | trap_sym | rect. */
export function fitFan(support: Grid, notblack: Grid | null, xlim: [number, number] | null): [KeepShape | null, Info] {
  let n = 0;
  for (let i = 0; i < support.data.length; i++) if (support.data[i]) n++;
  if (n < 50) return [null, { reason: 'support_too_small' }];
  const [pf, infF] = fitFanSym(support, notblack);
  const [pt, infT] = fitTrapSym(support, notblack, xlim);
  const info: Info = { ...stripReason(infF), ...stripReason(infT) };
  if (!pf && !pt) return [null, { ...info, reason: (infF.reason as string) || (infT.reason as string) }];
  const st = pt ? ((infT.rect_score as number | undefined) ?? (infT.trap_sym_score as number | undefined) ?? -1) : -1;
  const sf = pf ? ((infF.fan_sym_score as number | undefined) ?? -1) : -1;
  // top-edge flatness
  const { ys } = nonzeroYX(support);
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < ys.length; i++) { if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i]; }
  const ext = rowExtents(support);
  let maxW = 0;
  const widths: number[] = [];
  for (let y = y0; y <= y1; y++) { const e = ext[y]; const wd = e ? e[1] - e[0] + 1 : 0; widths.push(wd); if (wd > maxW) maxW = wd; }
  let topFrac = 0;
  for (const wd of widths) if (wd >= 0.30 * maxW) { topFrac = wd / support.w; break; }
  info.top_edge_frac = Math.round(topFrac * 1000) / 1000;
  const preferFan = topFrac < C.TOP_FLAT_FRAC;
  const fanWins = !!pf && (preferFan ? sf >= st - C.FAN_PREFERENCE : sf > st + C.FAN_PREFERENCE);
  if (!pt || fanWins) {
    info.model = 'fan_sym'; info.fit_score = r4(sf); info.fit_iou = infF.fan_sym_iou;
    return [pf, info];
  }
  info.model = pt.kind === 'rect' ? 'rect' : 'trap_sym'; info.fit_score = r4(st);
  info.fit_iou = infT.rect_iou ?? infT.trap_sym_iou;
  return [pt, info];
}

/** fit_support — the union rule on top of fitFan. */
export function fitSupport(support: Grid, union: Grid | null, notblack: Grid | null, xlim: [number, number] | null): [KeepShape | null, Info, Grid] {
  let [p, info] = fitFan(support, notblack, xlim);
  if (union) {
    const [pu, iuRaw] = fitFanSym(union, notblack);
    if (pu) {
      const fanU = renderFan(union.w, union.h, pu);
      let nu = 0, inter = 0, nf = 0;
      for (let i = 0; i < union.data.length; i++) { const u = union.data[i] > 0, f = fanU.data[i] > 0; if (u) nu++; if (f) nf++; if (u && f) inter++; }
      const cover = inter / Math.max(1, nu), ratio = nf / Math.max(1, nu);
      const iu: Info = { ...iuRaw, union_cover: Math.round(cover * 1000) / 1000, union_area_ratio: Math.round(ratio * 100) / 100 };
      if (cover >= C.UNION_COVER && ratio <= C.UNION_MAX_RATIO) {
        return [pu, { ...iu, model: 'fan_sym', fit_iou: r4(cover), fit_score: r4(cover), union: true }, union];
      }
      info = { ...info, union_rejected: { union_cover: iu.union_cover, union_area_ratio: iu.union_area_ratio } };
    }
  }
  return [p, info, support];
}

function supportEdgesTouched(support: Grid): number {
  const { w, h, data } = support;
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let x = 0; x < w && !(top && bottom); x++) { if (data[x] || data[w + x]) top = 1; if (data[(h - 1) * w + x] || data[(h - 2) * w + x]) bottom = 1; }
  for (let y = 0; y < h && !(left && right); y++) { if (data[y * w] || data[y * w + 1]) left = 1; if (data[y * w + w - 1] || data[y * w + w - 2]) right = 1; }
  return top + bottom + left + right;
}

/** confidence — the components are returned so the thresholds can be tuned from 2B telemetry. */
export function confidence(fanS: Grid, supportS: Grid, openedS: Grid, grayS: Grid, fitOverride: number | null, bg: BackgroundStats): Info {
  const fit = fitOverride ?? fitScore(fanS, supportS);
  let fanArea = 0;
  for (let i = 0; i < fanS.data.length; i++) if (fanS.data[i]) fanArea++;
  fanArea = Math.max(1, fanArea);
  const outsideMask = grid(fanS.w, fanS.h);
  let outsideAllN = 0;
  for (let i = 0; i < fanS.data.length; i++) if (openedS.data[i] > 0 && fanS.data[i] === 0) { outsideMask.data[i] = 1; outsideAllN++; }
  const outsideAll = outsideAllN / fanArea;
  let outsideBlob = outsideAll;
  if (RULES.conf_bbox && fanArea > 1) {
    const { ys, xs } = nonzeroYX(fanS);
    let miny = Infinity, maxy = -Infinity, minx = Infinity, maxx = -Infinity;
    for (let i = 0; i < ys.length; i++) { if (ys[i] < miny) miny = ys[i]; if (ys[i] > maxy) maxy = ys[i]; if (xs[i] < minx) minx = xs[i]; if (xs[i] > maxx) maxx = xs[i]; }
    const my = Math.trunc(0.05 * (maxy - miny + 1)), mx = Math.trunc(0.05 * (maxx - minx + 1));
    const by0 = Math.max(0, miny - my), by1 = Math.min(fanS.h, maxy + my + 1), bx0 = Math.max(0, minx - mx), bx1 = Math.min(fanS.w, maxx + mx + 1);
    const cc = connectedComponents(outsideMask, 8);
    const touching = new Set<number>();
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) { const l = cc.labels[y * fanS.w + x]; if (l) touching.add(l); }
    let n = 0;
    for (let i = 0; i < cc.labels.length; i++) if (touching.has(cc.labels[i])) n++;
    outsideBlob = n / fanArea;
  }
  const comp: Info = { fit_iou: r4(iou(fanS, supportS)), fit_score: r4(fit), outside_blob_frac: r4(outsideBlob), outside_blob_frac_all: r4(outsideAll) };
  let conf = fit - 0.5 * outsideBlob;
  const fracMasked = 1 - fanArea / fanS.data.length;
  comp.masked_frac = r4(fracMasked);
  comp.bg_level = bg.mode; comp.bg_frac = r4(bg.frac);
  if (bg.mode > C.BG_MAX_LEVEL) { conf = 0; comp.withheld = 'background_not_dark'; }
  else if (bg.frac < C.BG_MIN_FRAC) { conf = 0; comp.withheld = 'no_background'; }
  // interior statistics over the kept region
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < fanS.data.length; i++) if (fanS.data[i]) { const v = grayS.data[i]; s += v; s2 += v * v; n++; }
  const mean = n ? s / n : 0, std = n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0;
  comp.interior_mean = r1(mean); comp.interior_std = r1(std);
  const borderline = mean > 120 || std < 25;
  if ((mean > 150 || std < 15) && !('withheld' in comp)) { conf = 0; comp.withheld = 'interior_not_ultrasound'; }
  if (fracMasked < C.MIN_MASK_FRAC && !('withheld' in comp)) {
    const edges = supportEdgesTouched(supportS); comp.support_edges = edges;
    if (borderline || edges < 2) { conf = 0; comp.withheld = 'masks_too_little'; }
    else comp.flag = 'nothing_much_to_mask';
  }
  comp.conf = r4(Math.max(0, Math.min(1, conf)));
  return comp;
}

export function scaleParams(p: KeepShape, f: number): KeepShape {
  if (p.kind === 'fan') return { ...p, ax: p.ax * f, ay: p.ay * f, r_in: p.r_in * f, r_out: p.r_out * f };
  return { ...p, cx: p.cx * f, y_top: p.y_top * f, y_bottom: p.y_bottom * f, w_top: p.w_top * f, w_bottom: p.w_bottom * f };
}

/** to_page_shape — full-resolution parameters, the contract's `keep`. */
export function toPageShape(pSmall: KeepShape): KeepShape {
  const q = scaleParams(pSmall, C.DOWN);
  if (q.kind === 'fan') { const f = q as FanShape; return { kind: 'fan', sym: true, ax: f.ax, ay: f.ay, half_angle: f.half_angle, r_in: f.r_in, r_out: f.r_out, th_l: -f.half_angle, th_r: f.half_angle }; }
  const t = q as TrapShape;
  return { kind: t.kind, sym: true, cx: t.cx, y_top: t.y_top, y_bottom: t.y_bottom, w_top: t.w_top, w_bottom: t.w_bottom };
}

/** keep_fullres — render the scaled shape at full resolution and erode the safety margin. */
export function keepFullres(pSmall: KeepShape, W: number, H: number): Grid {
  let m = renderShape(W, H, scaleParams(pSmall, C.DOWN));
  if (C.MARGIN_PX > 0) m = erode(m, 2 * C.MARGIN_PX + 1);
  return m;
}

/** finish_fit — far-field completion (fan only) → confidence. */
export function finishFit(p: KeepShape, info: Info, g: Grid, support: Grid, opened: Grid, bg: BackgroundStats): [KeepShape, Info, Grid] {
  let q = p;
  if (q.kind === 'fan') {
    const [rq, rinfo] = refineFanRadii(q, g, null, bg.mode);
    q = { ...rq, th_l: -rq.half_angle, th_r: rq.half_angle };
    info = { ...info, ...rinfo };
  }
  const fanS = renderShape(g.w, g.h, q);
  const comp = confidence(fanS, support, opened, g, info.union ? (info.fit_score as number) : null, bg);
  return [q, { ...info, ...comp }, fanS];
}

export interface ProposeOptions { bound?: Grid | null }

/** tier_t1 — the whole proposer on one full-resolution grayscale frame. `bound` is the T0 box as a full-res 0/1 grid. */
export function propose(grayFull: Grid, opts: ProposeOptions = {}): ProposeResult {
  const t0 = performance.now();
  const bound = opts.bound ?? null;
  const W = grayFull.w, H = grayFull.h;
  let gf = grayFull;
  if (bound) { gf = grid(W, H, new Uint8Array(grayFull.data)); for (let i = 0; i < gf.data.length; i++) if (!bound.data[i]) gf.data[i] = 0; }
  const g = downscaleArea(gf, C.DOWN);
  const bg = backgroundStats(downscaleArea(grayFull, C.DOWN));       // measured on the UNBOUNDED frame
  const bgInfo: Info = { bg_level: bg.mode, bg_frac: r4(bg.frac) };
  const done = (partial: Partial<ProposeResult>): ProposeResult => ({
    keep: null, shape: null, paramsSmall: null, model: null, conf: 0, withheld: null, flag: null, info: {}, ms: performance.now() - t0, ...partial,
  });
  if (bg.mode > C.BG_MAX_LEVEL) return done({ withheld: 'background_not_dark', info: { ...bgInfo, withheld: 'background_not_dark' } });
  if (bg.frac < C.BG_MIN_FRAC) return done({ withheld: 'no_background', info: { ...bgInfo, withheld: 'no_background' } });

  const sr = cleanSupport(g, bg.mode);
  const notblack = threshold(g, bg.mode + C.T_LOW);
  for (let i = 0; i < notblack.data.length; i++) if (sr.removed.data[i]) notblack.data[i] = 0;   // dropped furniture is not "image" for the rules either
  let xlim: [number, number] | null = null;
  if (bound) {
    let bx0 = -1, bx1 = -1;
    for (let x = 0; x < W && bx0 < 0; x++) for (let y = 0; y < H; y++) if (bound.data[y * W + x]) { bx0 = x; break; }
    for (let x = W - 1; x >= 0 && bx1 < 0; x--) for (let y = 0; y < H; y++) if (bound.data[y * W + x]) { bx1 = x; break; }
    if (bx0 >= 0) xlim = [Math.trunc(bx0 / C.DOWN), Math.trunc(bx1 / C.DOWN)];
  }
  const [p0, info0, support] = fitSupport(sr.support, sr.union, notblack, xlim);
  if (!p0) return done({ withheld: (info0.reason as string) || 'no_fit', info: { ...info0, ...bgInfo } });
  let p = p0;
  const info: Info = { ...info0 };
  if (RULES.t0_depth_rect && bound && p.kind === 'rect') {
    let byMax = -1;
    for (let y = H - 1; y >= 0 && byMax < 0; y--) for (let x = 0; x < W; x++) if (bound.data[y * W + x]) { byMax = y; break; }
    if (byMax >= 0) { p = { ...p, y_bottom: byMax / C.DOWN }; info.t0_depth = 'bound_bottom'; }
  }
  const [pf, infoF] = finishFit(p, info, g, support, sr.blobs, bg);
  const conf = (infoF.conf as number) ?? 0;
  const withheld = (infoF.withheld as string | undefined) ?? null;
  if (withheld || conf <= 0) {
    return done({ paramsSmall: pf, shape: toPageShape(pf), model: infoF.model as Model, conf, withheld: withheld ?? 'no_fit', flag: (infoF.flag as string) ?? null, info: { ...infoF, ...bgInfo } });
  }
  let keep = keepFullres(pf, W, H);
  if (bound) for (let i = 0; i < keep.data.length; i++) if (!bound.data[i]) keep.data[i] = 0;
  return done({ keep, paramsSmall: pf, shape: toPageShape(pf), model: infoF.model as Model, conf, withheld: null, flag: (infoF.flag as string) ?? null, info: { ...infoF, ...bgInfo } });
}
