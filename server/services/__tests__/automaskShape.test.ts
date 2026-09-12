/**
 * Round 2B-2 — the spoke's shape math in shared/automask/shape.ts (AUTOMASK_ROUND2B2_PLAN.md §4–§5; kickoff §4 unit row):
 *  1. keepPolygon rasterised at integer pixel coordinates vs propose()'s own renderKeepMask on both synthetic fixtures
 *     (fan without a T0 box, trapezoid with one): IoU ≥ 0.99 — the accepted mask matches the proposer's `keep`;
 *  2. the joint "top width (arc stays)" control keeps the arc's lowest point (ay + r_in), the bottom (ay + r_out) and the
 *     bottom width fixed to 1e-9 across its range, and the readouts come from the CURRENT shape (the PASS2 §4 bug);
 *  3. trapezoid `top` / `bottom` keep the side angle (sides stay put);
 *  4. reseed: fan → trap → fan lands within 2 px / 1° (exact); rect → fan is a valid fan with chord = width and the arc's
 *     lowest point at y_top; all six transitions produce the requested kind;
 *  5. shapeDeltas of an untouched Accept is all-zero; every control is a no-op at its fitted value; clamps hold.
 * No DOM, no DB, no PHI. Run:  npx tsx server/services/__tests__/automaskShape.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { readFileSync } from 'fs';

import {
  keepPolygon, keepPathData, withControl, reseed, readouts, controlSpecs, shapeDeltas, topWidthPx, trapSideAngleDegOf, DEG, type Pt,
} from '../../../shared/automask/shape';
import { renderKeepMask } from '../../../shared/automask/render';
import { iou } from '../../../shared/automask/fan';
import { grid } from '../../../shared/automask/geometry';
import type { KeepShape, Bound, FanShape, TrapShape, Grid } from '../../../shared/automask/types';

const HERE = path.dirname(new URL(import.meta.url).pathname);
interface Fixture { w: number; h: number; bound: Bound | null; margin_px: number; keep: KeepShape }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(path.resolve(HERE, `fixtures/automask/${name}/proposal.json`), 'utf8'));

/** Even-odd scanline fill at integer pixel coordinates — the convention renderFan samples (fan.ts:15-22). */
function rasterise(poly: Pt[], w: number, h: number): Grid {
  const g = grid(w, h), n = poly.length;
  for (let y = 0; y < h; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
      if ((y0 <= y) !== (y1 <= y)) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(w - 1, Math.floor(xs[k + 1])); x++) g.data[y * w + x] = 1;
    }
  }
  return g;
}

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

test('keepPolygon matches propose()\'s keep on both synthetic fixtures (IoU ≥ 0.99)', (t) => {
  for (const name of ['synthetic_fan', 'synthetic_trap']) {
    const f = fixture(name);
    const ref = renderKeepMask(f.keep, f.w, f.h, f.bound, f.margin_px);
    const poly = keepPolygon(f.keep, f.w, f.h, f.bound, f.margin_px);
    assert.ok(poly && poly.length >= 3, `${name}: polygon`);
    const got = rasterise(poly!, f.w, f.h);
    const v = iou(got, ref);
    let extra = 0, missing = 0;
    for (let i = 0; i < ref.data.length; i++) { if (got.data[i] && !ref.data[i]) extra++; if (!got.data[i] && ref.data[i]) missing++; }
    t.diagnostic(`${name}: IoU ${v.toFixed(4)} (polygon ${poly!.length} pts; kept-but-raster-masked ${extra} px, masked-but-raster-kept ${missing} px)`);
    assert.ok(v >= 0.99, `${name}: IoU ${v} < 0.99`);
    // every polygon vertex lies inside the frame and, on bound sides, inside the inset box
    for (const [x, y] of poly!) {
      assert.ok(x >= -0.5 - 1e-6 && x <= f.w - 0.5 + 1e-6 && y >= -0.5 - 1e-6 && y <= f.h - 0.5 + 1e-6, `${name}: vertex ${x},${y} outside the frame`);
      if (f.bound) {
        assert.ok(x >= f.bound.x0 - 0.5 + f.margin_px - 1e-6 && x <= f.bound.x1 + 0.5 - f.margin_px + 1e-6, `${name}: vertex x ${x} not inset from the bound`);
        assert.ok(y >= f.bound.y0 - 0.5 + f.margin_px - 1e-6 && y <= f.bound.y1 + 0.5 - f.margin_px + 1e-6, `${name}: vertex y ${y} not inset from the bound`);
      }
    }
    const d = keepPathData(f.keep, f.w, f.h, f.bound, f.margin_px)!;
    assert.ok(d.startsWith(`M 0 0 L ${f.w} 0 L ${f.w} ${f.h} L 0 ${f.h} Z M `), `${name}: path starts with the frame rectangle`);
    assert.equal((d.match(/ Z/g) ?? []).length, 2, `${name}: two closed subpaths`);
  }
});

test('joint top-width control: arc lowest point, bottom and bottom width stay fixed; readouts use the current shape', () => {
  const f = fixture('synthetic_fan');
  const s = f.keep as FanShape;
  const frame = { w: f.w, h: f.h };
  const yArc = s.ay + s.r_in, yOut = s.ay + s.r_out, wBot = 2 * s.r_out * Math.sin(s.half_angle);
  const spec = controlSpecs(s, f.w, f.h).find((c) => c.id === 'top_width')!;
  for (let v = spec.min; v <= spec.max; v += Math.max(1, Math.floor((spec.max - spec.min) / 40))) {
    const s2 = withControl(s, 'top_width', v, frame) as FanShape;
    near(s2.ay + s2.r_in, yArc, 1e-9, `arc y at W=${v}`);
    near(s2.ay + s2.r_out, yOut, 1e-9, `bottom y at W=${v}`);
    near(2 * s2.r_out * Math.sin(s2.half_angle), wBot, 1e-9, `bottom width at W=${v}`);
    near(topWidthPx(s2)!, Math.min(v, 0.98 * wBot), 1e-9, `top width at W=${v}`);
    near(readouts(s2).arc_y, s2.ay + s2.r_in, 1e-9, 'readout arc_y follows the current apex');
    near(readouts(s2).arc_y, yArc, 1e-9, 'readout arc_y has not moved');
  }
  // the fitted value is a no-op (to floating point)
  const same = withControl(s, 'top_width', topWidthPx(s)!, frame) as FanShape;
  near(same.ay, s.ay, 1e-6, 'no-op ay'); near(same.r_in, s.r_in, 1e-6, 'no-op r_in'); near(same.half_angle, s.half_angle, 1e-9, 'no-op half');
});

test('trapezoid top / bottom keep the side angle; side_angle keeps the top edge; rect width keeps both edges', () => {
  const f = fixture('synthetic_trap');
  const s = f.keep as TrapShape, frame = { w: f.w, h: f.h };
  const a0 = trapSideAngleDegOf(s);
  for (const v of [s.y_top - 60, s.y_top + 40]) {
    const s2 = withControl(s, 'top', v, frame) as TrapShape;
    near(s2.y_top, v, 1e-9, 'top set'); near(trapSideAngleDegOf(s2), a0, 1e-9, `side angle after top=${v}`); near(s2.w_bottom, s.w_bottom, 1e-9, 'bottom width untouched');
  }
  for (const v of [s.y_bottom - 100, Math.min(f.h, s.y_bottom + 50)]) {
    const s2 = withControl(s, 'bottom', v, frame) as TrapShape;
    near(s2.y_bottom, v, 1e-9, 'bottom set'); near(trapSideAngleDegOf(s2), a0, 1e-9, `side angle after bottom=${v}`); near(s2.w_top, s.w_top, 1e-9, 'top width untouched');
  }
  const s3 = withControl(s, 'side_angle', 5, frame) as TrapShape;
  near(trapSideAngleDegOf(s3), 5, 1e-9, 'side angle set'); near(s3.w_top, s.w_top, 1e-9, 'top edge fixed'); near(s3.y_top, s.y_top, 1e-9, 'y_top fixed');
  const r = reseed(s, 'rect') as TrapShape;
  const r2 = withControl(r, 'width', 300, frame) as TrapShape;
  assert.equal(r2.w_top, 300); assert.equal(r2.w_bottom, 300); assert.equal(r2.y_top, r.y_top);
});

test('reseed: fan → trap → fan round-trips; rect → fan is valid; all six transitions land on the requested kind', () => {
  const fan = fixture('synthetic_fan').keep as FanShape;
  const trap = reseed(fan, 'trap') as TrapShape;
  assert.equal(trap.kind, 'trap');
  near(trap.w_top, 2 * fan.r_in * Math.sin(fan.half_angle), 1e-9, 'fan→trap top chord');
  near(trap.w_bottom, 2 * fan.r_out * Math.sin(fan.half_angle), 1e-9, 'fan→trap bottom chord');
  const back = reseed(trap, 'fan') as FanShape;
  near(back.ax, fan.ax, 2, 'round-trip ax'); near(back.ay, fan.ay, 2, 'round-trip ay');
  near(back.half_angle * DEG, fan.half_angle * DEG, 1, 'round-trip half-angle'); near(back.r_in, fan.r_in, 2, 'round-trip r_in'); near(back.r_out, fan.r_out, 2, 'round-trip r_out');
  const rect = reseed(trap, 'rect') as TrapShape;
  assert.equal(rect.kind, 'rect'); near(rect.w_top, (trap.w_top + trap.w_bottom) / 2, 1e-9, 'trap→rect mean width'); assert.equal(rect.w_top, rect.w_bottom);
  const rf = reseed(rect, 'fan') as FanShape;
  assert.equal(rf.kind, 'fan'); near(rf.half_angle * DEG, 30, 1e-9, 'rect→fan 30°');
  near(2 * rf.r_in * Math.sin(rf.half_angle), rect.w_top, 1e-9, 'rect→fan chord = width');
  near(rf.ay + rf.r_in, rect.y_top, 1e-9, 'rect→fan arc lowest point at y_top');
  near(rf.ay + rf.r_out, rect.y_bottom, 1e-9, 'rect→fan r_out reaches y_bottom'); assert.ok(rf.r_out > rf.r_in);
  assert.equal(reseed(rect, 'trap').kind, 'trap'); assert.equal((reseed(rect, 'trap') as TrapShape).w_top, (reseed(rect, 'trap') as TrapShape).w_bottom);
  assert.equal(reseed(fan, 'rect').kind, 'rect');
  assert.equal(reseed(fan, 'fan'), fan);
  // parallel-sided trapezoid → the rect rule, never an apex at infinity
  const par: TrapShape = { ...trap, w_bottom: trap.w_top };
  const pf = reseed(par, 'fan') as FanShape;
  assert.ok(Number.isFinite(pf.ay) && Number.isFinite(pf.r_out), 'parallel sides → finite fan');
  // a 3° trapezoid: the side-line apex is ~5000 px up; with the frame given, the rect rule keeps the apex in range
  const shallow: TrapShape = { kind: 'trap', sym: true, cx: 873, y_top: 160, y_bottom: 536, w_top: 574, w_bottom: 616 };
  const far = reseed(shallow, 'fan') as FanShape;
  assert.ok(far.ay < -1000, `without a frame the literal rule applies (ay ${far.ay})`);
  const inRange = reseed(shallow, 'fan', { w: 1400, h: 1050 }) as FanShape;
  near(inRange.half_angle * DEG, 30, 1e-9, 'shallow trap → fan uses the rect rule when the apex would leave the range');
  assert.ok(inRange.ay >= -0.5 * 1050, `apex in range (ay ${inRange.ay})`);
});

test('untouched Accept: all deltas zero; every control is a no-op at its fitted value; position clamps', () => {
  for (const name of ['synthetic_fan', 'synthetic_trap']) {
    const f = fixture(name), s = f.keep, frame = { w: f.w, h: f.h };
    const d = shapeDeltas(s, s)!;
    for (const [k, v] of Object.entries(d)) assert.equal(v, 0, `${name}: ${k}`);
    const r = readouts(s);
    for (const c of controlSpecs(s, f.w, f.h)) {
      const s2 = withControl(s, c.id, r[c.id], frame);
      const d2 = shapeDeltas(s, s2)!;
      for (const [k, v] of Object.entries(d2)) near(v as number, 0, 1e-6, `${name}: ${c.id} at its fitted value moves ${k}`);
    }
    const moved = withControl(s, 'position', { dx: 7, dy: -3 }, frame);
    const dm = shapeDeltas(s, moved)!;
    near(dm.d_apex_px!, Math.hypot(7, 3), 1e-9, `${name}: position Δ`);
    const far = withControl(s, 'position', { dx: 1e6, dy: -1e6 }, frame);
    const rr = readouts(far);
    assert.ok(rr.position_x <= f.w && rr.position_y >= -0.5 * f.h, `${name}: position clamped (${rr.position_x}, ${rr.position_y})`);
  }
  // deltas are null across families, non-null for trap ↔ rect
  const fan = fixture('synthetic_fan').keep, trap = fixture('synthetic_trap').keep;
  assert.equal(shapeDeltas(fan, reseed(fan, 'trap')), null);
  assert.notEqual(shapeDeltas(trap, reseed(trap, 'rect')), null);
});

test('clip: an apex above the frame and a fan wider than the frame stay inside; a T0 box insets on its sides only', () => {
  const s: FanShape = { kind: 'fan', sym: true, ax: 300, ay: -400, half_angle: 60 / DEG, r_in: 500, r_out: 1400, th_l: -60 / DEG, th_r: 60 / DEG };
  const w = 600, h = 800;
  const poly = keepPolygon(s, w, h, null, 2)!;
  assert.ok(poly.length >= 3);
  for (const [x, y] of poly) assert.ok(x >= -0.5 - 1e-6 && x <= w - 0.5 + 1e-6 && y >= -0.5 - 1e-6 && y <= h - 0.5 + 1e-6, `vertex ${x},${y}`);
  const b: Bound = { x0: 0, y0: 50, x1: w - 1, y1: 700 };   // x sides coincide with the frame → no inset there; y sides are bound sides → inset
  const pb = keepPolygon(s, w, h, b, 2)!;
  const minX = Math.min(...pb.map((p) => p[0])), maxX = Math.max(...pb.map((p) => p[0]));
  const minY = Math.min(...pb.map((p) => p[1])), maxY = Math.max(...pb.map((p) => p[1]));
  near(minX, -0.5, 1e-6, 'frame-coincident bound side is not inset'); near(maxX, w - 0.5, 1e-6, 'frame-coincident bound side is not inset');
  near(minY, b.y0 - 0.5 + 2, 1e-6, 'bound top inset by the margin'); near(maxY, b.y1 + 0.5 - 2, 1e-6, 'bound bottom inset by the margin');
  assert.equal(keepPolygon(s, w, h, { x0: 10, y0: 10, x1: 12, y1: 12 }, 2), null, 'a box smaller than the inset → empty');
});
