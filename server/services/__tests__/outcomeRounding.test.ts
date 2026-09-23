/**
 * Output Round 1 (O5) — the automask.outcome line carries 2-decimal deltas (client/src/hooks/useAutomaskProposal.ts
 * `roundDeltas` / `buildOutcome`): an untouched control is exactly 0, a nudged one a 2-decimal value; null survives.
 * Run:  npx tsx server/services/__tests__/outcomeRounding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { roundDeltas, buildOutcome, sessionReducer } from '../../../client/src/hooks/useAutomaskProposal';
import type { ProposalJson } from '../../../shared/automask/types';

test('roundDeltas: 3.9e-14 → 0 (not -0), 2 decimals, null preserved', () => {
  const r = roundDeltas({ d_half_angle_deg: 3.9e-14, d_apex_px: -1e-13, d_top_px: 1.23456, d_arc_px: null, d_top_width_px: -0.004, d_depth_px: 2.5 })!;
  assert.equal(Object.is(r.d_half_angle_deg, 0), true);
  assert.equal(Object.is(r.d_apex_px, 0), true);
  assert.equal(r.d_top_px, 1.23); assert.equal(r.d_arc_px, null); assert.equal(Object.is(r.d_top_width_px, 0), true); assert.equal(r.d_depth_px, 2.5);
  assert.equal(roundDeltas(null), null);
});

test('buildOutcome on an untouched Accept carries all-zero deltas', () => {
  const body = {
    version: 2, status: 'ready', reason: null, withheld: null, flag: null, jobId: 'j', frame: null, width: 632, height: 1080, tier: 'T1',
    model: 'fan_sym', keep: { kind: 'fan', sym: true, ax: 315.39, ay: -136.98, half_angle: 0.5760947268786616, r_in: 144, r_out: 1088, th_l: -0.576, th_r: 0.576 },
    bound: null, bound_source: 'not_dicom', margin_px: 2, confidence: 0.98, grade: 'proposed', rules: {}, info: {}, ms: { decode: 0, propose: 0, total: 0 }, createdAt: '', ui_enabled: true,
  } as unknown as ProposalJson;
  const s = sessionReducer(sessionReducer(null, { type: 'init', body }), { type: 'accept' })!;
  const out = buildOutcome(s, 'accept', 1000);
  for (const [k, v] of Object.entries(out.deltas!)) assert.equal(Object.is(v, 0), true, `${k} = ${v}`);
  const nudged = sessionReducer(sessionReducer(null, { type: 'init', body }), { type: 'nudge', dx: 3, dy: 0 })!;
  assert.equal(buildOutcome(nudged, 'edit', 1000).deltas!.d_apex_px, 3);
});
