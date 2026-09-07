/**
 * Auto-mask parametric shape renderer (browser, no dependencies).
 *
 * Written for the Track 0 bench, carried forward to the Round 2B canvas layer: the same functions render
 * the proposal layer, apply the parametric controls (half-angle / apex / top / depth), and produce the path
 * Accept turns into a fabric object. When it moves into the app it becomes `shared/automask/shape.ts` —
 * keep it free of DOM assumptions beyond a 2D canvas context.
 *
 * Coordinate conventions (identical to the Python spike, `scripts/automask_spike/automask_spike.py`):
 *   • full-resolution frame pixels, origin top-left;
 *   • fan angles th = atan2(dx, dy): 0 = straight down, + = right, in RADIANS;
 *     a fan point is (ax + r·sin th, ay + r·cos th).
 *
 * Shapes (the `keep` object of a proposal) — SYMMETRIC models since tuning pass 1:
 *   { kind: 'fan',  ax, ay, half_angle, r_in, r_out }              th_l = −half_angle, th_r = +half_angle
 *   { kind: 'trap', cx, y_top, y_bottom, w_top, w_bottom }         symmetric about x = cx
 *   { kind: 'rect', cx, y_top, y_bottom, w_top, w_bottom }         w_top === w_bottom
 *   legacy (archived proposals only): { kind: 'poly', pts, top_chain, left, right, y_bottom, y_bottom_fit }
 * Optional `bound: {x0,y0,x1,y1}` (the DICOM (0018,6011) box) is a hard clip in both directions.
 *
 * Controls (addendum §2): `controls(shape, w, h, bound)` lists the editable parameters with ranges;
 * `withParam(shape, key, value)` applies one edit with the model's semantics:
 *   fan  — half_angle (apex fixed, both sides), ax/ay (apex nudge), r_in (top), r_out (depth)
 *   trap — side_angle (top edge fixed, bottom width follows), cx (nudge), y_top (top, sides kept), y_bottom (depth, sides kept)
 *   rect — w (width), cx, y_top, y_bottom
 */
(function (root) {
  'use strict';

  const DEPTH_MIN_FRAC = 0.10;
  const DEG = 180 / Math.PI;

  function xOnLine(l, y) {
    if (Math.abs(l.y1 - l.y0) < 1e-9) return l.x0;
    return l.x0 + (y - l.y0) * (l.x1 - l.x0) / (l.y1 - l.y0);
  }

  /** Legacy poly (archived proposals): polygon at a given bottom. */
  function polyPoints(p, yBottom) {
    const fitted = (p.y_bottom_fit !== undefined && p.y_bottom_fit !== null) ? p.y_bottom_fit : p.y_bottom;
    if (yBottom === undefined || yBottom === null) yBottom = p.y_bottom;
    if (Math.abs(yBottom - fitted) < 0.5 && p.pts) return p.pts;
    const top = (p.top_chain || []).filter(v => v[1] < yBottom).slice().sort((a, b) => a[0] - b[0]);
    const right = [xOnLine(p.right, yBottom), yBottom];
    const left = [xOnLine(p.left, yBottom), yBottom];
    if (top.length === 0) {
      const yT = Math.min(...(p.top_chain || [[0, 0]]).map(v => v[1]));
      return [[xOnLine(p.left, yT), yT], [xOnLine(p.right, yT), yT], right, left];
    }
    return top.concat([right, left]);
  }

  function trapPoints(p) {
    return [[p.cx - p.w_top / 2, p.y_top], [p.cx + p.w_top / 2, p.y_top], [p.cx + p.w_bottom / 2, p.y_bottom], [p.cx - p.w_bottom / 2, p.y_bottom]];
  }

  function fanAngles(shape) {
    if (shape.half_angle !== undefined && shape.half_angle !== null) return { th_l: -shape.half_angle, th_r: shape.half_angle };
    return { th_l: shape.th_l, th_r: shape.th_r };
  }

  function isTrapLike(shape) { return (shape.kind === 'trap' || shape.kind === 'rect') && shape.cx !== undefined; }

  /** Implied side angle of a trapezoid, radians from vertical. */
  function trapSideAngle(p) { return Math.atan2((p.w_bottom - p.w_top) / 2, Math.max(1e-6, p.y_bottom - p.y_top)); }

  /** Trace the keep-region path (does not fill/stroke). */
  function tracePath(ctx, shape) {
    ctx.beginPath();
    if (shape.kind === 'fan') {
      const { ax, ay, r_in, r_out } = shape; const { th_l, th_r } = fanAngles(shape);
      const phiL = Math.PI / 2 - th_l, phiR = Math.PI / 2 - th_r;
      ctx.moveTo(ax + r_out * Math.sin(th_l), ay + r_out * Math.cos(th_l));
      ctx.arc(ax, ay, r_out, phiL, phiR, true);
      if (r_in > 0.5) { ctx.lineTo(ax + r_in * Math.sin(th_r), ay + r_in * Math.cos(th_r)); ctx.arc(ax, ay, r_in, phiR, phiL, false); }
      else ctx.lineTo(ax, ay);
      ctx.closePath();
    } else if (isTrapLike(shape)) {
      trapPoints(shape).forEach((v, i) => (i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1])));
      ctx.closePath();
    } else if (shape.kind === 'poly') {
      polyPoints(shape, shape.y_bottom).forEach((v, i) => (i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1])));
      ctx.closePath();
    } else if (shape.kind === 'rect') {
      ctx.rect(shape.x0, shape.y0, shape.x1 - shape.x0 + 1, shape.y1 - shape.y0 + 1);
    }
  }

  function clipToBound(ctx, bound) {
    if (!bound) return;
    ctx.beginPath(); ctx.rect(bound.x0, bound.y0, bound.x1 - bound.x0 + 1, bound.y1 - bound.y0 + 1); ctx.clip();
  }

  /** Proposal layer: everything outside the keep-region tinted (= what would be blanked), keep-region outlined. */
  function drawProposalLayer(ctx, w, h, shape, bound, opts) {
    opts = opts || {};
    ctx.save();
    ctx.fillStyle = opts.tint || 'rgba(30,110,255,0.45)';
    ctx.fillRect(0, 0, w, h);
    // destination-out removes dest × source-alpha: the punch-out must be OPAQUE or the keep-region keeps 55 % of the tint.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.save(); clipToBound(ctx, bound); tracePath(ctx, shape); ctx.fill(); ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.save(); clipToBound(ctx, bound); tracePath(ctx, shape);
    ctx.lineWidth = opts.lineWidth || 2; ctx.strokeStyle = opts.stroke || '#3b82f6'; ctx.stroke(); ctx.restore();
    if (opts.showAxis !== false) {   // the axis of symmetry, so a tilt is visible at a glance
      let x0, y0, y1;
      if (shape.kind === 'fan') { x0 = shape.ax; y0 = Math.max(0, shape.ay); y1 = Math.min(h, shape.ay + shape.r_out); }
      else if (isTrapLike(shape)) { x0 = shape.cx; y0 = shape.y_top; y1 = shape.y_bottom; }
      if (x0 !== undefined) {
        ctx.save(); ctx.setLineDash([4, 6]); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.stroke(); ctx.restore();
      }
      if (shape.kind === 'fan' && shape.ay >= 0 && shape.ay <= h) { ctx.save(); ctx.fillStyle = '#f5c542'; ctx.beginPath(); ctx.arc(shape.ax, shape.ay, 5, 0, 2 * Math.PI); ctx.fill(); ctx.restore(); }
      if (isTrapLike(shape)) { ctx.save(); ctx.fillStyle = '#f5c542'; ctx.beginPath(); ctx.arc(shape.cx, shape.y_top, 5, 0, 2 * Math.PI); ctx.fill(); ctx.restore(); }
    }
    if (bound) { ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(255,220,0,0.8)'; ctx.lineWidth = 1;
      ctx.strokeRect(bound.x0 + 0.5, bound.y0 + 0.5, bound.x1 - bound.x0, bound.y1 - bound.y0); ctx.setLineDash([]); }
    ctx.restore();
  }

  /** The mask the app would apply: red where blanked, transparent where kept, with a `margin` px erosion of the keep. */
  function drawMaskRaster(ctx, w, h, shape, bound, margin) {
    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.save(); clipToBound(ctx, bound); tracePath(ctx, shape); ctx.fill(); ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    if (margin > 0) { ctx.save(); tracePath(ctx, shape); ctx.lineWidth = 2 * margin; ctx.strokeStyle = '#f00'; ctx.stroke(); ctx.restore(); }
    ctx.fillStyle = '#000'; ctx.globalCompositeOperation = 'destination-over'; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * Editable parameters for the review controls. Each: {key, role, label, fitted, min, max, step, unit, display}.
   * roles: angle | nudge_x | nudge_y | top | depth
   */
  function controls(shape, w, h, bound) {
    const bx0 = bound ? bound.x0 : 0, by0 = bound ? bound.y0 : 0, bx1 = bound ? bound.x1 : w - 1, by1 = bound ? bound.y1 : h - 1;
    const deg = v => (v * DEG).toFixed(1) + '°';
    const px = v => Math.round(v) + ' px';
    if (shape.kind === 'fan') {
      const corners = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]];
      const rMax = Math.max(...corners.map(c => Math.hypot(c[0] - shape.ax, c[1] - shape.ay)));
      return [
        { key: 'half_angle', role: 'angle', label: 'half-angle', fitted: shape.half_angle, min: 1 / DEG, max: 85 / DEG, step: 0.1 / DEG, unit: 'deg', display: deg },
        { key: 'ax', role: 'nudge_x', label: 'apex x', fitted: shape.ax, min: -w, max: 2 * w, step: 2, unit: 'px', display: px },
        { key: 'ay', role: 'nudge_y', label: 'apex y', fitted: shape.ay, min: -4 * h, max: h, step: 2, unit: 'px', display: px },
        // joint control (pass 2 §3): change the TOP width while the inner arc's lowest point (ay + r_in) and the
        // bottom width (2·r_out·sin(half)) stay where they are — apex and half-angle move together, radii follow.
        { key: 'top_width_arc', role: 'topwidth', label: 'top width (arc stays)', fitted: 2 * shape.r_in * Math.sin(shape.half_angle),
          min: 4, max: Math.max(8, 2 * shape.r_out * Math.sin(shape.half_angle) * 0.98), step: 1, unit: 'px', display: px },
        { key: 'r_in', role: 'top', label: 'top arc height (r_in, apex fixed)', fitted: shape.r_in, min: 0, max: Math.max(1, shape.r_out - 1), step: 1, unit: 'px',
          // (v, cur): the readout must use the CURRENT apex — after the joint control moves the apex, the fitted
          // shape's ay would report the arc 66 px deeper while it has not moved (bench v4 check, clip14)
          display: (v, cur) => `${Math.round(v)} px (arc at y ${Math.round((cur || shape).ay + v)})` },
        { key: 'r_out', role: 'depth', label: 'depth (r_out)', fitted: shape.r_out, min: Math.round(shape.r_in + DEPTH_MIN_FRAC * (shape.r_out - shape.r_in)), max: Math.round(rMax), step: 1, unit: 'px', display: px },
      ];
    }
    if (isTrapLike(shape)) {
      const isRect = shape.kind === 'rect';
      const list = [];
      if (isRect) list.push({ key: 'w', role: 'angle', label: 'width', fitted: shape.w_top, min: 4, max: 2 * w, step: 2, unit: 'px', display: px });
      else list.push({ key: 'side_angle', role: 'angle', label: 'side angle (top edge fixed)', fitted: trapSideAngle(shape), min: -10 / DEG, max: 60 / DEG, step: 0.1 / DEG, unit: 'deg', display: deg });
      if (!isRect) list.push({ key: 'w_top', role: 'topwidth', label: 'top width (bottom stays)', fitted: shape.w_top, min: 4, max: 2 * w, step: 2, unit: 'px', display: px });
      list.push(
        { key: 'cx', role: 'nudge_x', label: 'axis x', fitted: shape.cx, min: 0, max: w, step: 2, unit: 'px', display: px },
        { key: 'y_top', role: 'nudge_y', label: 'top y', fitted: shape.y_top, min: by0, max: Math.max(by0 + 1, shape.y_bottom - 2), step: 2, unit: 'px', display: px },
        { key: 'y_top', role: 'top', label: 'top (y_top)', fitted: shape.y_top, min: by0, max: Math.max(by0 + 1, shape.y_bottom - 2), step: 1, unit: 'px', display: px },
        { key: 'y_bottom', role: 'depth', label: 'depth (y_bottom)', fitted: shape.y_bottom, min: Math.round(shape.y_top + DEPTH_MIN_FRAC * (shape.y_bottom - shape.y_top)), max: by1, step: 1, unit: 'px', display: px },
      );
      return list;
    }
    if (shape.kind === 'poly') {
      const yTop = Math.min(...(shape.top_chain || shape.pts).map(v => v[1]));
      const fittedY = (shape.y_bottom_fit !== undefined && shape.y_bottom_fit !== null) ? shape.y_bottom_fit : shape.y_bottom;
      return [{ key: 'y_bottom', role: 'depth', label: 'depth (y_bottom)', fitted: fittedY, min: Math.round(yTop + DEPTH_MIN_FRAC * (fittedY - yTop)), max: by1, step: 1, unit: 'px', display: px }];
    }
    return [];
  }

  /** Apply one control edit with the model's semantics; returns a new shape. */
  function withParam(shape, key, value) {
    const s = Object.assign({}, shape);
    if (shape.kind === 'fan') {
      if (key === 'half_angle') { s.half_angle = value; s.th_l = -value; s.th_r = value; }
      else if (key === 'top_width_arc') {
        // W_top = 2(y_arc − ay')sin h', W_bot = 2(y_out − ay')sin h'  →  ay' = (ρ·y_out − y_arc)/(ρ − 1), ρ = W_top/W_bot < 1
        const yArc = shape.ay + shape.r_in, yOut = shape.ay + shape.r_out;
        const wBot = 2 * shape.r_out * Math.sin(shape.half_angle);
        const wTop = Math.min(value, 0.98 * wBot);
        const rho = wTop / wBot;
        const ay2 = (rho * yOut - yArc) / (rho - 1);
        const rOut2 = yOut - ay2, rIn2 = yArc - ay2;
        const sinH = Math.min(0.999, wBot / (2 * rOut2));
        if (rIn2 > 0 && rOut2 > rIn2 && sinH > 0.01) { s.ay = ay2; s.r_in = rIn2; s.r_out = rOut2; s.half_angle = Math.asin(sinH); s.th_l = -s.half_angle; s.th_r = s.half_angle; }
      }
      else s[key] = value;
      return s;
    }
    if (isTrapLike(shape)) {
      const tan = Math.tan(trapSideAngle(shape));
      if (key === 'side_angle') { s.w_bottom = s.w_top + 2 * (s.y_bottom - s.y_top) * Math.tan(value); return s; }
      if (key === 'w') { s.w_top = s.w_bottom = value; return s; }
      if (key === 'w_top') { s.w_top = value; return s; }            // bottom edge stays; side angle follows
      if (key === 'y_top') { s.y_top = value; if (shape.kind === 'trap') s.w_top = shape.w_top + 2 * (shape.y_top - value) * tan; return s; }   // sides stay put
      if (key === 'y_bottom') { s.y_bottom = value; if (shape.kind === 'trap') s.w_bottom = shape.w_top + 2 * (value - shape.y_top) * tan; return s; }
      s[key] = value; return s;
    }
    s[key] = value; return s;
  }

  function depthRange(shape, w, h, bound) {
    const c = controls(shape, w, h, bound).find(x => x.role === 'depth');
    return c ? { key: c.key, fitted: c.fitted, min: c.min, max: c.max, unit: c.unit } : null;
  }

  function withDepth(shape, value) {
    const d = depthRange(shape);
    return d ? withParam(shape, d.key, value) : shape;
  }

  /** Per-parameter deltas between a fitted and a corrected shape (addendum §2 report columns). */
  function deltas(fit, user) {
    if (!fit || !user || fit.kind !== user.kind) return null;
    if (fit.kind === 'fan') return { d_half_angle_deg: (user.half_angle - fit.half_angle) * DEG, d_apex_px: Math.hypot(user.ax - fit.ax, user.ay - fit.ay), d_top_px: user.r_in - fit.r_in,
      d_top_width_px: 2 * user.r_in * Math.sin(user.half_angle) - 2 * fit.r_in * Math.sin(fit.half_angle), d_depth_px: user.r_out - fit.r_out };
    if (isTrapLike(fit)) return { d_half_angle_deg: (trapSideAngle(user) - trapSideAngle(fit)) * DEG, d_apex_px: Math.hypot(user.cx - fit.cx, user.y_top - fit.y_top), d_top_px: user.y_top - fit.y_top,
      d_top_width_px: user.w_top - fit.w_top, d_depth_px: user.y_bottom - fit.y_bottom };
    return { d_depth_px: user.y_bottom - fit.y_bottom };
  }

  /** SVG path data for the keep-region (what Round 2B's Accept feeds into a fabric.Path). */
  function toSvgPath(shape) {
    if (shape.kind === 'fan') {
      const { ax, ay, r_in, r_out } = shape; const { th_l, th_r } = fanAngles(shape);
      const P = (r, th) => `${(ax + r * Math.sin(th)).toFixed(2)} ${(ay + r * Math.cos(th)).toFixed(2)}`;
      const large = (th_r - th_l) > Math.PI ? 1 : 0;
      let d = `M ${P(r_out, th_l)} A ${r_out} ${r_out} 0 ${large} 0 ${P(r_out, th_r)}`;
      if (r_in > 0.5) d += ` L ${P(r_in, th_r)} A ${r_in} ${r_in} 0 ${large} 1 ${P(r_in, th_l)}`;
      else d += ` L ${ax} ${ay}`;
      return d + ' Z';
    }
    const pts = isTrapLike(shape) ? trapPoints(shape)
      : shape.kind === 'poly' ? polyPoints(shape, shape.y_bottom)
      : [[shape.x0, shape.y0], [shape.x1, shape.y0], [shape.x1, shape.y1], [shape.x0, shape.y1]];
    return 'M ' + pts.map(v => `${v[0]} ${v[1]}`).join(' L ') + ' Z';
  }

  root.AutomaskShape = { tracePath, drawProposalLayer, drawMaskRaster, depthRange, controls, withParam, withDepth, deltas, polyPoints, trapPoints, trapSideAngle, toSvgPath, DEG };
})(typeof window !== 'undefined' ? window : globalThis);
