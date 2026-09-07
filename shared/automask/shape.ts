/**
 * Auto-mask Round 2A — shape arithmetic shared with the bench (port of bench_static/shape.js `deltas()` and
 * bench.py `shape_deltas` / `top_width_px`). The controls (`withParam`, the joint top-width control) are 2B's port;
 * they land here so the contract stays one file.
 */

import type { KeepShape } from './types';

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

/** user − fit, so a positive Δ top means the user put the top LOWER than the fit. Null when the kinds differ. */
export function shapeDeltas(fit: KeepShape | null, user: KeepShape | null): ShapeDeltas | null {
  if (!fit || !user || fit.kind !== user.kind) return null;
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
