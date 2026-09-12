/**
 * Auto-mask Round 2B-2 — the `automask.outcome` telemetry sink (requirement B5; kickoff §2.5; plan §6).
 *
 * `POST /api/jobs/:jobId/template-mask/proposal/outcome` is the spoke's one report per job: Accept / Edit / Draw from
 * scratch, which controls were used, each Δ, the model switch, the final keep shape. The server validates the body
 * (zod, strict — a drifting client is caught here, not in a pivot), emits exactly ONE `[PERF] automask.outcome` line
 * and stores nothing (2C decides storage). Order mirrors the GET (`automask.ts:127-129`): unknown job → 404 in both
 * flag states; either flag off → the GET's disabled shape and no log; malformed → 400 and no log.
 *
 * Pure apart from the injected deps so the route stays a four-line adapter and the test needs no express.
 */
import { z } from 'zod';
import type { Job } from '@shared/schema';
import { automaskEnabled, automaskUiEnabled } from './automaskFlag';

const finite = z.number().finite();
const nullableFinite = finite.nullable();

const fanShape = z.object({
  kind: z.literal('fan'), sym: z.literal(true),
  ax: finite, ay: finite, half_angle: finite, r_in: finite, r_out: finite, th_l: finite, th_r: finite,
}).strict();
const trapShape = z.object({
  kind: z.enum(['trap', 'rect']), sym: z.literal(true),
  cx: finite, y_top: finite, y_bottom: finite, w_top: finite, w_bottom: finite,
}).strict();
const keepShape = z.union([fanShape, trapShape]);
const model = z.enum(['fan_sym', 'trap_sym', 'rect']);

export const shapeDeltasSchema = z.object({
  d_half_angle_deg: nullableFinite, d_apex_px: nullableFinite, d_top_px: nullableFinite,
  d_arc_px: nullableFinite, d_top_width_px: nullableFinite, d_depth_px: nullableFinite,
}).strict();

export const outcomeSchema = z.object({
  outcome: z.enum(['accept', 'edit', 'draw_from_scratch']),
  controls_used: z.array(z.string().min(1).max(32)).max(16),
  deltas: shapeDeltasSchema.nullable(),                              // shapeDeltas(fitted, final); null when the family changed
  model_switch: z.object({ from: model, to: model }).strict().nullable(),
  final_keep: keepShape.nullable(),                                  // what 2C needs; stored nowhere
  fingerprint: z.null(),                                             // B4 placeholders (2C fills them)
  template: z.null(),
  grade_shown: z.enum(['proposed', 'check_depth']),
  tier: z.enum(['T1', 'T0T1']),
  ms_to_decision: finite.nonnegative(),                             // layer first rendered → Apply click (or → Draw from scratch)
}).strict();

export type OutcomeBody = z.infer<typeof outcomeSchema>;

export interface OutcomeDeps {
  getJobV2: (jobId: string) => Promise<Job | undefined>;
  env: NodeJS.ProcessEnv;
  log: (jobId: string, stage: string, extra?: Record<string, unknown>) => void;
}

export type OutcomeResult =
  | { status: 204 }
  | { status: 200; body: { version: 2; status: 'none'; reason: 'disabled'; jobId: string; ui_enabled: boolean } }
  | { status: 400; body: { error: string; issues: unknown } }
  | { status: 404; body: { error: string } };

export const OUTCOME_STAGE = 'automask.outcome';

export async function handleOutcome(jobId: string, body: unknown, deps: OutcomeDeps): Promise<OutcomeResult> {
  const job = await deps.getJobV2(jobId);
  if (!job) return { status: 404, body: { error: 'Job not found' } };
  if (!automaskEnabled(deps.env) || !automaskUiEnabled(deps.env)) {
    return { status: 200, body: { version: 2, status: 'none', reason: 'disabled', jobId, ui_enabled: automaskUiEnabled(deps.env) } };
  }
  const parsed = outcomeSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: 'invalid outcome', issues: parsed.error.issues } };
  deps.log(jobId, OUTCOME_STAGE, { ...parsed.data, fingerprint: null, template: null });
  return { status: 204 };
}
