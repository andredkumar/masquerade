/**
 * Auto-mask Round 2A — the symmetric fan model (port of automask_spike.py `hull_side_edges`, `fit_fan_sym`,
 * `render_fan`, `refine_fan_radii`). Same seed, same rules in the same order, same coordinate descent.
 */

import { AUTOMASK_CONSTANTS as C, RULES } from './constants';
import type { Grid, FanShape, Info } from './types';
import { grid, nonzeroYX, convexHull, approxPolyDP, arcLength, percentile, median, mean, firstSustained, type Pt } from './geometry';

export type FanParams = FanShape;

export function renderFan(w: number, h: number, p: FanParams): Grid {
  const out = grid(w, h);
  const { ax, ay, r_in, r_out, th_l, th_r } = p;
  for (let y = 0; y < h; y++) {
    const dy = y - ay;
    for (let x = 0; x < w; x++) {
      const dx = x - ax;
      const r = Math.hypot(dx, dy);
      if (r < r_in || r > r_out) continue;
      const th = Math.atan2(dx, dy);
      if (th >= th_l && th <= th_r) out.data[y * w + x] = 1;
    }
  }
  return out;
}

export interface SideEdge { L: number; a: Pt; b: Pt }

export function hullSideEdges(support: Grid): { left: SideEdge[]; right: SideEdge[]; poly: Pt[]; ys: Int32Array; xs: Int32Array } {
  const { ys, xs } = nonzeroYX(support);
  const pts: Pt[] = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) pts[i] = [xs[i], ys[i]];
  const hull = convexHull(pts);
  const poly = approxPolyDP(hull, 0.006 * arcLength(hull, true));
  const W = support.w - 1, H = support.h - 1;
  const edges: SideEdge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-6 || Math.abs(dy) < 0.35 * Math.abs(dx)) continue;                        // near-horizontal: arc chord / flat edge
    if ((a[0] <= 1 && b[0] <= 1) || (a[0] >= W - 1 && b[0] >= W - 1) || (a[1] <= 1 && b[1] <= 1) || (a[1] >= H - 1 && b[1] >= H - 1)) continue; // frame border
    edges.push({ L, a, b });
  }
  edges.sort((p, q) => q.L - p.L);
  const cx = mean(xs);
  return { left: edges.filter((e) => (e.a[0] + e.b[0]) / 2 < cx), right: edges.filter((e) => (e.a[0] + e.b[0]) / 2 >= cx), poly, ys, xs };
}

const slopeOf = (a: Pt, b: Pt) => (b[0] - a[0]) / (b[1] - a[1]);          // dx/dy
const xAt = (a: Pt, sl: number, y: number) => a[0] + sl * (y - a[1]);
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export function fitScore(shapeMask: Grid, support: Grid): number {
  let inter = 0, nS = 0, nF = 0;
  for (let i = 0; i < support.data.length; i++) {
    const s = support.data[i] > 0, f = shapeMask.data[i] > 0;
    if (s) nS++; if (f) nF++; if (s && f) inter++;
  }
  const cover = inter / Math.max(1, nS);
  const extra = (nF - inter) / Math.max(1, nF);
  return cover - C.EXTRA_PENALTY * extra;
}

export function iou(a: Grid, b: Grid): number {
  let u = 0, i = 0;
  for (let k = 0; k < a.data.length; k++) {
    const p = a.data[k] > 0, q = b.data[k] > 0;
    if (p || q) u++; if (p && q) i++;
  }
  return u ? i / u : 0;
}

/**
 * fit_fan_sym. Returns [params | null, info]. `notblack` is the raw not-background mask (with dropped blobs removed);
 * `reseed` is the recursion depth of fan_reseed_above_arc (0 = first pass).
 */
export function fitFanSym(support: Grid, notblack: Grid | null, reseed = 0): [FanParams | null, Info] {
  let { ys, xs } = nonzeroYX(support);
  if (ys.length < 50) return [null, { reason: 'support_too_small' }];
  const { w, h } = support;
  let yMin = Infinity, yMax = -Infinity, ySum = 0;
  for (let i = 0; i < ys.length; i++) { if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i]; ySum += ys[i]; }
  const yc = ySum / ys.length;
  const { left, right } = hullSideEdges(support);
  if (!left.length && !right.length) return [null, { reason: 'no_side_edges' }];
  const info: Info = {};
  let ax: number, ay: number, half: number;
  if (left.length && right.length) {
    const { a: a1, b: b1 } = left[0], { a: a2, b: b2 } = right[0];
    const sL = slopeOf(a1, b1), sR = slopeOf(a2, b2);
    const thL = Math.atan(sL), thR = Math.atan(sR);
    Object.assign(info, { th_l_free_deg: r2(deg(thL)), th_r_free_deg: r2(deg(thR)), asym_deg: r2(deg(Math.abs(thL) - Math.abs(thR))),
      axis_tilt_deg: r2(deg((thL + thR) / 2)), side_spread_deg: r2(deg(Math.abs(thR - thL))), clipped_side: null });
    if (Math.abs(sL - sR) < 1e-9 || Math.abs(thR - thL) < rad(3.0)) return [null, { ...info, reason: 'sides_parallel' }];
    const xL0 = a1[0] - sL * a1[1], xR0 = a2[0] - sR * a2[1];
    ay = (xR0 - xL0) / (sL - sR);
    ax = 0.5 * (xAt(a1, sL, yc) + xAt(a2, sR, yc));
    half = RULES.fan_wider_side ? Math.max(Math.abs(thL), Math.abs(thR)) : 0.5 * (Math.abs(thL) + Math.abs(thR));
  } else {
    const e = (left.length ? left : right)[0];
    const sl = slopeOf(e.a, e.b), th = Math.atan(sl);
    const lim = yMin + Math.max(2, 0.10 * (yMax - yMin));
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < ys.length; i++) if (ys[i] <= lim) { if (xs[i] < tmin) tmin = xs[i]; if (xs[i] > tmax) tmax = xs[i]; }
    ax = 0.5 * (tmin + tmax);
    half = Math.abs(th);
    const clipped = right.length ? 'left' : 'right';
    if (half < rad(1.5)) return [null, { reason: 'sides_parallel', clipped_side: clipped }];
    ay = Math.abs(Math.tan(th)) > 1e-9 ? e.a[1] - (e.a[0] - ax) / Math.tan(th) : yMin - 1e6;
    Object.assign(info, { th_l_free_deg: null, th_r_free_deg: null, asym_deg: null, axis_tilt_deg: null, side_spread_deg: r2(deg(2 * half)), clipped_side: clipped });
  }
  if (ay > yMin + 0.25 * (yMax - yMin)) return [null, { ...info, reason: 'apex_not_above' }];

  let r = new Float64Array(ys.length);
  const recomputeR = () => { for (let i = 0; i < ys.length; i++) r[i] = Math.hypot(xs[i] - ax, ys[i] - ay); };
  recomputeR();
  let rIn = percentile(r, 0.3);
  let axFrozen = false;

  if (RULES.fan_axis_mid && left.length && right.length) {
    const rOut0 = percentile(r, 99.7);
    const y0 = Math.trunc(ay + rIn) + 2;
    const y1 = Math.trunc(Math.min(h - 1, y0 + 0.25 * (rOut0 - rIn)));
    const mids: number[] = [];
    let prev: [number, number] | null = null;
    for (let y = Math.max(0, y0); y <= y1; y++) {
      let xl = -1, xr = -1;
      for (let x = 0; x < w; x++) if (support.data[y * w + x]) { if (xl < 0) xl = x; xr = x; }
      if (xl < 0) continue;
      if (xl <= 1 || xr >= w - 2) break;
      if (prev && (Math.abs(xl - prev[0]) > C.SIDE_JUMP_PX || Math.abs(xr - prev[1]) > C.SIDE_JUMP_PX)) break;
      mids.push(0.5 * (xl + xr)); prev = [xl, xr];
    }
    info.axis_mid_rows = mids.length;
    if (mids.length >= 6) {
      const axMid = median(mids);
      info.axis_mid_shift = r2(axMid - ax);
      if (Math.abs(axMid - ax) > C.AXIS_MID_MIN_SHIFT) { ax = axMid; axFrozen = true; recomputeR(); }
    }
  }

  let RR: Float64Array | null = null;   // grid radii, kept for the reseed crop
  if (RULES.rin_coverage) {
    const rOutP = percentile(r, 99.7);
    RR = new Float64Array(w * h);
    const TH = new Float64Array(w * h);
    let nb = 0;
    const rbArr = new Int32Array(w * h), abArr = new Int32Array(w * h), inw = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x - ax, dy = y - ay;
      const th = Math.atan2(dx, dy), rr = Math.hypot(dx, dy);
      TH[i] = th; RR[i] = rr;
      if (Math.abs(th) <= half && rr <= rOutP) {
        inw[i] = 1;
        const rb = Math.trunc(rr / 2);
        rbArr[i] = rb; abArr[i] = Math.trunc(((th + half) / (2 * half)) * 23.999);
        if (rb + 1 > nb) nb = rb + 1;
      }
    }
    if (nb) {
      const src = notblack ?? support;
      const tot = new Float64Array(nb * 24), hit = new Float64Array(nb * 24);
      for (let i = 0; i < w * h; i++) if (inw[i]) { const k = rbArr[i] * 24 + abArr[i]; tot[k] += 1; if (src.data[i] > 0) hit[k] += 1; }
      const cov = new Float64Array(nb);
      for (let b = 0; b < nb; b++) {
        let c = 0;
        for (let a = 0; a < 24; a++) { const k = b * 24 + a; const frac = tot[k] > 0 ? hit[k] / Math.max(tot[k], 1) : 0; if (frac >= C.TOP_FILL_MIN) c++; }
        cov[b] = c / 24;
      }
      const ok = new Uint8Array(nb);
      for (let b = 0; b < nb; b++) ok[b] = cov[b] >= C.RIN_COVERAGE ? 1 : 0;
      const first = firstSustained(ok, C.RIN_SUSTAIN);
      if (first >= 0) { rIn = first * 2; info.rin_rule = 'coverage'; }
    }
    if (RULES.fan_reseed_above_arc && reseed === 0 && info.rin_rule) {
      let nAbove = 0;
      for (let i = 0; i < r.length; i++) if (r[i] < rIn - 1) nAbove++;
      if (nAbove > C.RESEED_MIN_FRAC * r.length && r.length - nAbove > 50) {
        const sup2 = grid(w, h, new Uint8Array(support.data));
        for (let i = 0; i < r.length; i++) if (r[i] < rIn - 1) sup2.data[ys[i] * w + xs[i]] = 0;
        let nb2: Grid | null = null;
        if (notblack) {
          nb2 = grid(w, h, new Uint8Array(notblack.data));
          for (let i = 0; i < w * h; i++) if (RR[i] < rIn - 1) nb2.data[i] = 0;
        }
        const [p2, info2] = fitFanSym(sup2, nb2, 1);
        if (p2) {
          info2.reseeded = 'above_arc'; info2.reseed_removed_px = nAbove;
          info2.first_pass = { ax: Math.round(ax * 10) / 10, ay: Math.round(ay * 10) / 10, half_deg: r2(deg(half)), r_in: rIn };
          return [p2, info2];
        }
      }
    }
    if (info.rin_rule) {
      let nKeep = 0;
      for (let i = 0; i < r.length; i++) if (r[i] >= rIn - 1) nKeep++;
      if (nKeep > 50) {
        const sup = grid(w, h, new Uint8Array(support.data));
        const ys2 = new Int32Array(nKeep), xs2 = new Int32Array(nKeep), r2v = new Float64Array(nKeep);
        let k = 0;
        for (let i = 0; i < r.length; i++) {
          if (r[i] >= rIn - 1) { ys2[k] = ys[i]; xs2[k] = xs[i]; r2v[k] = r[i]; k++; }
          else sup.data[ys[i] * w + xs[i]] = 0;
        }
        support = sup; ys = ys2; xs = xs2; r = r2v;
      }
    }
  }

  let p: FanParams = { kind: 'fan', sym: true, ax, ay, half_angle: half, r_in: rIn, r_out: percentile(r, 99.7), th_l: -half, th_r: half };
  let best = fitScore(renderFan(w, h, p), support);
  const ro = p.r_out, ax0 = p.ax, axLim = 0.02 * w;
  const steps: Record<string, number> = { ax: 0.005 * w, ay: 0.02 * ro, half_angle: 0.01, r_in: 0.01 * ro, r_out: 0.01 * ro };
  if (axFrozen) { delete steps.ax; info.axis = 'midpoints'; }
  for (let round = 0; round < 5; round++) {
    let improved = false;
    for (const k of Object.keys(steps)) {
      const st = steps[k];
      for (const sgn of [-1, 1]) {
        const q: FanParams = { ...p };
        (q as unknown as Record<string, number>)[k] = (p as unknown as Record<string, number>)[k] + sgn * st;
        if (k === 'ax' && Math.abs(q.ax - ax0) > axLim) continue;
        if (q.r_in < 0 || q.r_out <= q.r_in || q.half_angle <= rad(1) || q.half_angle >= rad(85)) continue;
        q.th_l = -q.half_angle; q.th_r = q.half_angle;
        const v = fitScore(renderFan(w, h, q), support);
        if (v > best + 1e-4) { best = v; p = q; improved = true; }
      }
    }
    if (!improved) for (const k of Object.keys(steps)) steps[k] /= 2;
  }
  info.fan_sym_score = r4(best);
  info.fan_sym_iou = r4(iou(renderFan(w, h, p), support));
  info.half_angle_deg = r2(deg(p.half_angle));
  return [p, info];
}

/** refine_fan_radii — far-field completion on the raw not-background mask (recomputed from gray, as the spike does). */
export function refineFanRadii(p: FanParams, grayS: Grid, remove: Grid | null, bg: number): [FanParams, Info] {
  const { w, h } = grayS;
  const pad = 0.15 * (p.th_r - p.th_l);
  const lo = p.th_l + pad, hi = p.th_r - pad;
  let maxRb = 0;
  const rbs = new Int32Array(w * h), inw = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - p.ax, dy = y - p.ay;
    const th = Math.atan2(dx, dy);
    if (th > lo && th < hi) { const i = y * w + x; inw[i] = 1; rbs[i] = Math.trunc(Math.hypot(dx, dy) / 2); if (rbs[i] > maxRb) maxRb = rbs[i]; }
  }
  const nbins = maxRb + 2;
  const tot = new Float64Array(nbins), hit = new Float64Array(nbins);
  for (let i = 0; i < w * h; i++) if (inw[i]) { tot[rbs[i]] += 1; if (grayS.data[i] > bg + C.T_LOW && !(remove && remove.data[i])) hit[rbs[i]] += 1; }
  const prof = new Float64Array(nbins);
  for (let b = 0; b < nbins; b++) prof[b] = tot[b] > 0 ? hit[b] / Math.max(tot[b], 1) : 0;
  const q: FanParams = { ...p };
  let b = Math.trunc(p.r_out / 2);
  while (b + 1 < nbins && prof[b + 1] > C.R_PROFILE_MIN) b++;
  q.r_out = Math.max(p.r_out, (b + 1) * 2);
  b = Math.trunc(p.r_in / 2);
  while (b - 1 >= 0 && prof[b - 1] > C.R_PROFILE_MIN) b--;
  q.r_in = Math.min(p.r_in, Math.max(0, b * 2));
  return [q, { radii_refined: true, r_out_delta: Math.round((q.r_out - p.r_out) * 10) / 10, r_in_delta: Math.round((q.r_in - p.r_in) * 10) / 10 }];
}
