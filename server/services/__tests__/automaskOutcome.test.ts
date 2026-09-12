/**
 * Round 2B-2 — the outcome route's pure handler (plan §6): valid → 204 and exactly one `automask.outcome` log line;
 * malformed → 400 and no log; either flag off → the GET's disabled shape and no log; unknown job → 404 in both flag
 * states (mirrors the GET's order). No express, no DB. Run:  npx tsx server/services/__tests__/automaskOutcome.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleOutcome, outcomeSchema, OUTCOME_STAGE, type OutcomeBody } from '../automaskOutcome';
import type { Job } from '@shared/schema';

type LogLine = { jobId: string; stage: string; extra?: Record<string, unknown> };
function deps(env: Record<string, string>, logs: LogLine[]) {
  return {
    getJobV2: async (id: string) => (id === 'unknown' ? undefined : ({ id } as unknown as Job)),
    env: env as NodeJS.ProcessEnv,
    log: (jobId: string, stage: string, extra?: Record<string, unknown>) => { logs.push({ jobId, stage, extra }); },
  };
}
const ON = { AUTOMASK: '1', AUTOMASK_UI: '1' };

const valid: OutcomeBody = {
  outcome: 'edit',
  controls_used: ['half_angle', 'depth', 'position'],
  deltas: { d_half_angle_deg: -2.5, d_apex_px: 12, d_top_px: 0, d_arc_px: 0, d_top_width_px: -4.2, d_depth_px: 30 },
  model_switch: null,
  final_keep: { kind: 'fan', sym: true, ax: 315.4, ay: -137, half_angle: 0.576, r_in: 144, r_out: 1118, th_l: -0.576, th_r: 0.576 },
  fingerprint: null, template: null,
  grade_shown: 'proposed', tier: 'T1', ms_to_decision: 4321,
};

test('valid body → 204 and exactly one automask.outcome line carrying the fields + jobId', async () => {
  const logs: LogLine[] = [];
  const r = await handleOutcome('job-1', valid, deps(ON, logs));
  assert.equal(r.status, 204);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].jobId, 'job-1'); assert.equal(logs[0].stage, OUTCOME_STAGE);
  assert.equal(logs[0].extra?.outcome, 'edit'); assert.deepEqual(logs[0].extra?.controls_used, ['half_angle', 'depth', 'position']);
  assert.equal((logs[0].extra?.deltas as { d_depth_px: number }).d_depth_px, 30);
  assert.equal(logs[0].extra?.fingerprint, null); assert.equal(logs[0].extra?.template, null);
  assert.equal(logs[0].extra?.ms_to_decision, 4321);
});

test('trap ↔ rect switch keeps deltas; a draw_from_scratch with null final_keep is valid', async () => {
  const logs: LogLine[] = [];
  const body: OutcomeBody = { ...valid, outcome: 'accept', model_switch: { from: 'trap_sym', to: 'rect' }, final_keep: { kind: 'rect', sym: true, cx: 314, y_top: 168, y_bottom: 808, w_top: 500, w_bottom: 500 }, tier: 'T0T1', grade_shown: 'check_depth' };
  assert.equal((await handleOutcome('job-2', body, deps(ON, logs))).status, 204);
  const dfs: OutcomeBody = { ...valid, outcome: 'draw_from_scratch', deltas: null, final_keep: null, controls_used: [] };
  assert.equal((await handleOutcome('job-2', dfs, deps(ON, logs))).status, 204);
  assert.equal(logs.length, 2);
});

test('malformed bodies → 400 with zod issues and no log', async () => {
  const bad: unknown[] = [
    {}, null, 'x',
    { ...valid, tier: 'T2' },
    { ...valid, extra_key: 1 },
    { ...valid, ms_to_decision: -1 },
    { ...valid, deltas: { ...valid.deltas, d_depth_px: 'thirty' } },
    { ...valid, final_keep: { kind: 'fan', sym: true, ax: 1 } },
    { ...valid, fingerprint: 'abc' },
    { ...valid, controls_used: new Array(17).fill('x') },
  ];
  for (const b of bad) {
    const logs: LogLine[] = [];
    const r = await handleOutcome('job-1', b, deps(ON, logs));
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(b)?.slice(0, 60)}`);
    assert.ok(r.status === 400 && Array.isArray(r.body.issues) && r.body.issues.length > 0);
    assert.equal(logs.length, 0);
  }
  assert.equal(outcomeSchema.safeParse(valid).success, true);
});

test('either flag off → the disabled shape, no log; unknown job → 404 regardless of the flags', async () => {
  for (const env of [{ AUTOMASK: '1' }, { AUTOMASK_UI: '1' }, {}, { AUTOMASK: '0', AUTOMASK_UI: '1' }]) {
    const logs: LogLine[] = [];
    const r = await handleOutcome('job-1', valid, deps(env, logs));
    assert.equal(r.status, 200);
    assert.deepEqual(r.status === 200 && r.body, { version: 2, status: 'none', reason: 'disabled', jobId: 'job-1', ui_enabled: env.AUTOMASK_UI === '1' });
    assert.equal(logs.length, 0);
  }
  for (const env of [ON, {}]) {
    const logs: LogLine[] = [];
    const r = await handleOutcome('unknown', valid, deps(env, logs));
    assert.equal(r.status, 404); assert.equal(logs.length, 0);
  }
});
