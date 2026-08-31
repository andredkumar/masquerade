/**
 * [PERF] instrumentation helper — Round 1 (measurement only).
 *
 * See docs/refactor/TEMPLATE_MASK_APPLY_PERF_ROUND1.md.
 *
 * Every probe emits exactly one line: the fixed `[PERF] ` prefix followed by a
 * single JSON object, so the whole round can be pulled out of `pm2 logs` with a
 * grep and pivoted with a dependency-free Node one-liner.
 *
 * No env flag by design (§3.1): these are cheap and this round wants them
 * unconditionally on. Remove them — or gate on PERF_LOG=1 — in a later round.
 */

export function perfMark(jobId: string, stage: string, extra: Record<string, unknown> = {}) {
  console.log(`[PERF] ${JSON.stringify({ t: Date.now(), jobId, stage, ...extra })}`);
}

export function perfSpan(jobId: string, stage: string, extra: Record<string, unknown> = {}) {
  const t0 = process.hrtime.bigint();
  return (more: Record<string, unknown> = {}) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`[PERF] ${JSON.stringify({ t: Date.now(), jobId, stage, ms: +ms.toFixed(1), ...extra, ...more })}`);
    return ms;
  };
}
