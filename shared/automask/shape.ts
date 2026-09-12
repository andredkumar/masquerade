/**
 * Auto-mask Round 2A — shape arithmetic shared with the bench (port of bench_static/shape.js `deltas()` and
 * bench.py `shape_deltas` / `top_width_px`). The controls (`withParam`, the joint top-width control) are 2B's port;
 * they land here so the contract stays one file.
 */

import type { KeepShape, FanShape, TrapShape, Model, Bound } from './types';

export function topWidthPx(shape: KeepShape | null): number | null {
  if (!shape) return null;
  if (shape.kind === 'fan') return 2 * shape.r_in * Math.sin(shape.half_angle);
  return shape.w_top;
}

export function trapSideAngleDegOf(s: { w_top: number; w_bottom: number; y_top: number; y_bottom: number }): number {
  return (Math.atan2((s.w_bottom - s.w_top) / 2, Math.max(1e-6, s.y_bottom - s.y_top)) * 180) / Math.PI;
}

export interface ShapeDeltas {
  d_half_angle_deg: number | null;
  d_apex_px: number | null;
  d_top_px: number | null;        // fans: Δ r_in (the page control); trap/rect: Δ y_top
  d_arc_px: number | null;        // fans: the absolute move of the arc's lowest point (ay + r_in); trap/rect: = d_top_px
  d_top_width_px: number | null;
  d_depth_px: number | null;
}

/**
 * user − fit, so a positive Δ top means the user put the top LOWER than the fit. Null across the fan ↔ trap/rect boundary;
 * trap and rect share TrapShape and keep their deltas (2B-2: a trap ↔ rect model switch still reports each Δ).
 */
export function shapeDeltas(fit: KeepShape | null, user: KeepShape | null): ShapeDeltas | null {
  if (!fit || !user || (fit.kind === 'fan') !== (user.kind === 'fan')) return null;
  const wt = topWidthPx(user), wf = topWidthPx(fit);
  const dw = wt !== null && wf !== null ? wt - wf : null;
  if (fit.kind === 'fan' && user.kind === 'fan') {
    return {
      d_half_angle_deg: ((user.half_angle - fit.half_angle) * 180) / Math.PI,
      d_apex_px: Math.hypot(user.ax - fit.ax, user.ay - fit.ay),
      d_top_px: user.r_in - fit.r_in,
      d_arc_px: (user.ay + user.r_in) - (fit.ay + fit.r_in),
      d_top_width_px: dw,
      d_depth_px: user.r_out - fit.r_out,
    };
  }
  if (fit.kind !== 'fan' && user.kind !== 'fan') {
    return {
      d_half_angle_deg: trapSideAngleDegOf(user) - trapSideAngleDegOf(fit),
      d_apex_px: Math.hypot(user.cx - fit.cx, user.y_top - fit.y_top),
      d_top_px: user.y_top - fit.y_top,
      d_arc_px: user.y_top - fit.y_top,
      d_top_width_px: dw,
      d_depth_px: user.y_bottom - fit.y_bottom,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Round 2B-2 — the spoke's parametric controls, the model switch re-seed, and the keep polygon the proposal layer draws
// (docs/refactor/AUTOMASK_ROUND2B2_PLAN.md §4–§5). `controlSpecs` / `withControl` port bench_static/shape.js
// `controls()` / `withParam()` key by key — the joint "top width (arc stays)" control verbatim (PASS2 report §4).
// Pure: no DOM, no Node. Coordinates are frame-pixel INDICES (a pixel is the point (x, y), the convention renderFan
// samples); `keepPathData` adds the +½ px that turns an index into a canvas pixel centre.


export type ShapeKind = KeepShape['kind'];
export type ControlId = 'half_angle' | 'top_width' | 'top_arc' | 'depth' | 'position' | 'side_angle' | 'top' | 'bottom' | 'width';
export interface ControlSpec { id: Exclude<ControlId, 'position'>; label: string; unit: 'deg' | 'px'; min: number; max: number; step: number }
export type Pt = [number, number];
export interface Frame { w: number; h: number }

export const DEG = 180 / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function modelOf(kind: ShapeKind): Model { return kind === 'fan' ? 'fan_sym' : kind === 'trap' ? 'trap_sym' : 'rect'; }
export function kindOf(model: Model): ShapeKind { return model === 'fan_sym' ? 'fan' : model === 'trap_sym' ? 'trap' : 'rect'; }

function fanRMax(f: FanShape, w: number, h: number): number {
  const corners: Pt[] = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  return Math.max(...corners.map(([x, y]) => Math.hypot(x - f.ax, y - f.ay)));
}

/** Slider ranges (kickoff §3.7 — generous, not tight). `position` is the nudge/drag control and has no slider. */
export function controlSpecs(shape: KeepShape, w: number, h: number): ControlSpec[] {
  if (shape.kind === 'fan') {
    const wBot = 2 * shape.r_out * Math.sin(shape.half_angle);
    return [
      { id: 'half_angle', label: 'half-angle', unit: 'deg', min: 5, max: 85, step: 0.5 },
      { id: 'top_width', label: 'top width (arc stays)', unit: 'px', min: 10, max: Math.max(11, Math.floor(0.98 * wBot)), step: 1 },
      { id: 'top_arc', label: 'top arc height (r_in)', unit: 'px', min: 0, max: Math.max(0, Math.floor(shape.r_out - 10)), step: 1 },
      { id: 'depth', label: 'depth (r_out)', unit: 'px', min: Math.ceil(shape.r_in + 10), max: Math.ceil(fanRMax(shape, w, h)), step: 1 },
    ];
  }
  const list: ControlSpec[] = [];
  if (shape.kind === 'rect') list.push({ id: 'width', label: 'width', unit: 'px', min: 10, max: Math.round(1.5 * w), step: 1 });
  else {
    list.push({ id: 'side_angle', label: 'side angle', unit: 'deg', min: -60, max: 60, step: 0.5 });
    list.push({ id: 'top_width', label: 'top width', unit: 'px', min: 10, max: Math.round(1.5 * w), step: 1 });
  }
  list.push(
    { id: 'top', label: 'top', unit: 'px', min: 0, max: Math.max(0, Math.floor(shape.y_bottom - 10)), step: 1 },
    { id: 'bottom', label: 'bottom', unit: 'px', min: Math.ceil(shape.y_top + 10), max: h, step: 1 },
  );
  return list;
}

/** Readouts from the CURRENT shape (the PASS2 §4 bug: after the joint control moves the apex, `arc_y` must follow it). */
export function readouts(shape: KeepShape): Record<string, number> {
  if (shape.kind === 'fan') {
    return {
      half_angle: shape.half_angle * DEG, top_width: 2 * shape.r_in * Math.sin(shape.half_angle), top_arc: shape.r_in,
      arc_y: shape.ay + shape.r_in, depth: shape.r_out, position_x: shape.ax, position_y: shape.ay,
    };
  }
  return {
    side_angle: trapSideAngleDegOf(shape), top_width: shape.w_top, width: shape.w_top, top: shape.y_top, bottom: shape.y_bottom,
    position_x: shape.cx, position_y: shape.y_top,
  };
}

function setFanHalf(s: FanShape, half: number): FanShape { return { ...s, half_angle: half, th_l: -half, th_r: half }; }
const num = (v: number | { dx: number; dy: number }) => (typeof v === 'number' ? v : 0);
const vec = (v: number | { dx: number; dy: number }) => (typeof v === 'number' ? { dx: 0, dy: 0 } : v);

/** One control edit with the model's semantics; out-of-range values are clamped; unknown ids return the shape unchanged. */
export function withControl(shape: KeepShape, id: ControlId, value: number | { dx: number; dy: number }, frame: Frame): KeepShape {
  const { w, h } = frame;
  if (shape.kind === 'fan') {
    const s = shape;
    switch (id) {
      case 'half_angle': return setFanHalf(s, clamp(num(value), 5, 85) / DEG);      // apex fixed, both sides
      case 'top_width': {
        // bench shape.js:189-199 — W_top = 2(y_arc − ay')sin h', W_bot = 2(y_out − ay')sin h' → ay' = (ρ·y_out − y_arc)/(ρ − 1)
        const yArc = s.ay + s.r_in, yOut = s.ay + s.r_out;
        const wBot = 2 * s.r_out * Math.sin(s.half_angle);
        const wTop = Math.min(Math.max(10, num(value)), 0.98 * wBot);
        const rho = wTop / wBot;
        const ay2 = (rho * yOut - yArc) / (rho - 1);
        const rOut2 = yOut - ay2, rIn2 = yArc - ay2;
        const sinH = Math.min(0.999, wBot / (2 * rOut2));
        if (!(rIn2 > 0 && rOut2 > rIn2 && sinH > 0.01)) return s;
        return { ...setFanHalf(s, Math.asin(sinH)), ay: ay2, r_in: rIn2, r_out: rOut2 };
      }
      case 'top_arc': return { ...s, r_in: clamp(num(value), 0, Math.max(0, s.r_out - 10)) };
      case 'depth': return { ...s, r_out: clamp(num(value), s.r_in + 10, fanRMax(s, w, h)) };
      case 'position': { const d = vec(value); return { ...s, ax: clamp(s.ax + d.dx, 0, w), ay: clamp(s.ay + d.dy, -0.5 * h, h) }; }
      default: return s;
    }
  }
  const s: TrapShape = shape;
  const tan = Math.tan(trapSideAngleDegOf(s) / DEG);
  switch (id) {
    case 'side_angle': {                                                            // top edge fixed, bottom width follows
      if (s.kind !== 'trap') return s;
      const a = clamp(num(value), -60, 60) / DEG;
      return { ...s, w_bottom: Math.max(10, s.w_top + 2 * (s.y_bottom - s.y_top) * Math.tan(a)) };
    }
    case 'top_width': return s.kind === 'trap' ? { ...s, w_top: clamp(num(value), 10, 1.5 * w) } : s;   // bottom edge stays
    case 'width': { if (s.kind !== 'rect') return s; const v = clamp(num(value), 10, 1.5 * w); return { ...s, w_top: v, w_bottom: v }; }
    case 'top': {                                                                   // sides stay put: the top edge slides along them
      const v = clamp(num(value), 0, Math.max(0, s.y_bottom - 10));
      return s.kind === 'trap' ? { ...s, y_top: v, w_top: Math.max(10, s.w_top + 2 * (v - s.y_top) * tan) } : { ...s, y_top: v };
    }
    case 'bottom': {
      const v = clamp(num(value), s.y_top + 10, h);
      return s.kind === 'trap' ? { ...s, y_bottom: v, w_bottom: Math.max(10, s.w_top + 2 * (v - s.y_top) * tan) } : { ...s, y_bottom: v };
    }
    case 'position': {
      const d = vec(value);
      const dy = clamp(d.dy, -s.y_top, h - s.y_bottom);
      return { ...s, cx: clamp(s.cx + d.dx, 0, w), y_top: s.y_top + dy, y_bottom: s.y_bottom + dy };
    }
    default: return s;
  }
}

// ---- re-seed (B7; kickoff §3.6; plan §5) -------------------------------------------------------------------------------

function fanToTrap(f: FanShape): TrapShape {
  const sh = Math.sin(f.half_angle), ch = Math.cos(f.half_angle);
  return { kind: 'trap', sym: true, cx: f.ax, y_top: f.ay + f.r_in * ch, y_bottom: f.ay + f.r_out * ch, w_top: 2 * f.r_in * sh, w_bottom: 2 * f.r_out * sh };
}
function trapToFan(t: TrapShape): FanShape {
  const half = Math.atan2((t.w_bottom - t.w_top) / 2, Math.max(1e-6, t.y_bottom - t.y_top));
  const sh = Math.sin(half), th = Math.tan(half);
  const ay = t.y_top - (t.w_top / 2) / th;
  return { kind: 'fan', sym: true, ax: t.cx, ay, half_angle: half, r_in: (t.w_top / 2) / sh, r_out: (t.w_bottom / 2) / sh, th_l: -half, th_r: half };
}
function trapToRect(t: TrapShape): TrapShape { const w = (t.w_top + t.w_bottom) / 2; return { ...t, kind: 'rect', w_top: w, w_bottom: w }; }
function rectToFan(r: TrapShape): FanShape {
  // kickoff §3.6: half-angle 30°, chord at r_in = the width (2·r_in·sin 30° = w → r_in = w), arc's lowest point at y_top.
  const w = (r.w_top + r.w_bottom) / 2, half = 30 / DEG, r_in = w, ay = r.y_top - r_in;
  return { kind: 'fan', sym: true, ax: r.cx, ay, half_angle: half, r_in, r_out: r.y_bottom - ay, th_l: -half, th_r: half };
}

/**
 * Re-seed the target model from the CURRENT shape so the user lands close (B7 rules verbatim + the two compositions).
 * trap → fan takes the side lines' intersection unless the sides are parallel (< 1°) OR that apex would sit above the
 * position range (`ay < −0.5·frame.h`, kickoff §3.7) — a 3° trapezoid puts it kilometres up, where the half-angle
 * control can no longer do anything useful — in which case the rect → fan rule (30°, apex just above the top) applies.
 */
export function reseed(shape: KeepShape, to: ShapeKind, frame?: Frame): KeepShape {
  if (shape.kind === to) return shape;
  if (shape.kind === 'fan') { const t = fanToTrap(shape); return to === 'trap' ? t : trapToRect(t); }
  if (to === 'fan') {
    if (shape.kind === 'rect' || trapSideAngleDegOf(shape) < 1) return rectToFan(shape);
    const f = trapToFan(shape);
    return frame && f.ay < -0.5 * frame.h ? rectToFan(shape) : f;
  }
  return to === 'rect' ? trapToRect(shape) : { ...shape, kind: 'trap' };
}

// ---- keep polygon (plan §5): shape → clip to frame ∩ T0 box → inset by the margin on every non-frame edge -------------

type EdgeTag = 'shape' | 'bound' | 'frame';
interface TV { p: Pt; tag: EdgeTag }        // tag = the edge LEAVING p

function roundHalfEvenLocal(v: number): number {
  const f = Math.floor(v), d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function arcSegments(r: number, span: number, sagitta = 0.25): number {
  if (r <= sagitta) return 1;
  return Math.max(1, Math.ceil(span / (2 * Math.acos(1 - sagitta / r))));
}

function rawPolygon(shape: KeepShape): Pt[] {
  if (shape.kind !== 'fan') {
    const r = roundHalfEvenLocal;                                     // the same vertices renderTrap rasterises (trap.ts:15-18)
    return [[r(shape.cx - shape.w_top / 2), r(shape.y_top)], [r(shape.cx + shape.w_top / 2), r(shape.y_top)],
            [r(shape.cx + shape.w_bottom / 2), r(shape.y_bottom)], [r(shape.cx - shape.w_bottom / 2), r(shape.y_bottom)]];
  }
  const { ax, ay, r_in, r_out, half_angle: hh } = shape;
  const P = (r: number, th: number): Pt => [ax + r * Math.sin(th), ay + r * Math.cos(th)];
  const pts: Pt[] = [];
  const nOut = arcSegments(r_out, 2 * hh);
  for (let i = 0; i <= nOut; i++) pts.push(P(r_out, -hh + (2 * hh * i) / nOut));
  if (r_in > 0.5) { const nIn = arcSegments(r_in, 2 * hh); for (let i = nIn; i >= 0; i--) pts.push(P(r_in, -hh + (2 * hh * i) / nIn)); }
  else pts.push([ax, ay]);
  return pts;
}

interface Side { k: 0 | 1; min: boolean; v: number; tag: EdgeTag }

function clipHalfPlane(poly: TV[], s: Side): TV[] {
  const inside = (p: Pt) => (s.min ? p[s.k] >= s.v : p[s.k] <= s.v);
  const cross = (a: Pt, b: Pt): Pt => { const t = (s.v - a[s.k]) / (b[s.k] - a[s.k]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
  const out: TV[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % n];
    const ci = inside(cur.p), ni = inside(nxt.p);
    if (ci && ni) out.push(cur);
    else if (ci && !ni) { out.push(cur); out.push({ p: cross(cur.p, nxt.p), tag: s.tag }); }   // the edge from the exit point runs along the clip line
    else if (!ci && ni) out.push({ p: cross(cur.p, nxt.p), tag: cur.tag });                     // the entry point continues the original edge
  }
  return out;
}

function dedupe(poly: TV[]): TV[] {
  const out: TV[] = [];
  for (const v of poly) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.p[0] - v.p[0], last.p[1] - v.p[1]) < 1e-6) continue;
    out.push(v);
  }
  if (out.length > 1 && Math.hypot(out[0].p[0] - out[out.length - 1].p[0], out[0].p[1] - out[out.length - 1].p[1]) < 1e-6) out.pop();
  return out;
}

function insetPoly(poly: TV[], margin: number): Pt[] {
  const n = poly.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) { const a = poly[i].p, b = poly[(i + 1) % n].p; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1;
  const lines = poly.map((v, i) => {
    const a = v.p, b = poly[(i + 1) % n].p;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L, nx = -uy * sgn, ny = ux * sgn;      // inward normal
    const d = v.tag === 'frame' ? 0 : margin;                            // erode counts outside the image as kept (geometry.ts:171)
    return { q: [a[0] + nx * d, a[1] + ny * d] as Pt, u: [ux, uy] as Pt, n: [nx, ny] as Pt, d };
  });
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i], p = poly[i].p;
    const denom = A.u[0] * B.u[1] - A.u[1] * B.u[0];
    let x: Pt;
    if (Math.abs(denom) < 1e-9) x = [p[0] + B.n[0] * B.d, p[1] + B.n[1] * B.d];
    else {
      const wx = B.q[0] - A.q[0], wy = B.q[1] - A.q[1];
      const s = (wx * B.u[1] - wy * B.u[0]) / denom;
      x = [A.q[0] + s * A.u[0], A.q[1] + s * A.u[1]];
    }
    if (Math.hypot(x[0] - p[0], x[1] - p[1]) > 3 * margin + 1) x = [p[0] + B.n[0] * B.d, p[1] + B.n[1] * B.d];   // spike guard
    out.push(x);
  }
  return out;
}

/**
 * The keep region as a polygon in pixel-index coordinates: the shape, clipped to the frame and the T0 box, inset by
 * `marginPx` on shape and bound edges (not on frame edges — `erode` treats outside the image as kept). null when empty.
 */
export function keepPolygon(shape: KeepShape, w: number, h: number, bound: Bound | null, marginPx: number): Pt[] | null {
  let poly: TV[] = rawPolygon(shape).map((p) => ({ p, tag: 'shape' as EdgeTag }));
  const bx0 = bound && bound.x0 > 0, bx1 = bound && bound.x1 < w - 1, by0 = bound && bound.y0 > 0, by1 = bound && bound.y1 < h - 1;
  const sides: Side[] = [
    { k: 0, min: true, v: bx0 ? bound!.x0 - 0.5 : -0.5, tag: bx0 ? 'bound' : 'frame' },
    { k: 0, min: false, v: bx1 ? bound!.x1 + 0.5 : w - 0.5, tag: bx1 ? 'bound' : 'frame' },
    { k: 1, min: true, v: by0 ? bound!.y0 - 0.5 : -0.5, tag: by0 ? 'bound' : 'frame' },
    { k: 1, min: false, v: by1 ? bound!.y1 + 0.5 : h - 0.5, tag: by1 ? 'bound' : 'frame' },
  ];
  for (const s of sides) { poly = dedupe(clipHalfPlane(poly, s)); if (poly.length < 3) return null; }
  // Offsetting can push a vertex past the box where an edge is shorter than the margin (a chord meeting a frame corner over
  // a sub-pixel edge); clipping the inset polygon against the inset box and dropping collinear vertices settles it exactly.
  let out: TV[] = insetPoly(poly, marginPx).map((p) => ({ p, tag: 'shape' as EdgeTag }));
  for (const s of sides) { out = dedupe(clipHalfPlane(out, { ...s, v: s.tag === 'bound' ? (s.min ? s.v + marginPx : s.v - marginPx) : s.v })); if (out.length < 3) return null; }
  const pts = removeCollinear(out.map((v) => v.p));
  return pts.length >= 3 ? pts : null;
}

function removeCollinear(poly: Pt[]): Pt[] {
  let pts = poly.slice();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-6) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts;
}

/** SVG path data for one `fabric.Path` with `fillRule:'evenodd'`: the frame rectangle, then the keep polygon (canvas pixels). */
export function keepPathData(shape: KeepShape, w: number, h: number, bound: Bound | null, marginPx: number): string | null {
  const poly = keepPolygon(shape, w, h, bound, marginPx);
  if (!poly) return null;
  const inner = poly.map(([x, y]) => `${(x + 0.5).toFixed(2)} ${(y + 0.5).toFixed(2)}`).join(' L ');
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z M ${inner} Z`;
}
