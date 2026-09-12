/**
 * Round 2B-2 — the B3 hold-repeat schedule (client/src/hooks/useHoldRepeat.ts) measured with real Node timers, which
 * nothing throttles: the Browser pane the sandbox matrix runs in is a hidden tab to Chrome, whose timer throttling
 * (a 25 ms timeout measured at 999 ms) makes any in-page number meaningless. The chain here is the hook's own
 * `setTimeout(step + tick, holdDelay(elapsed))`, driven exactly as the hook drives it.
 * Run:  npx tsx server/services/__tests__/automaskHold.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { holdDelay, HOLD_FIRST_MS, HOLD_SLOW_MS, HOLD_FAST_AFTER_MS, HOLD_FAST_MS } from '../../../client/src/hooks/useHoldRepeat';

test('holdDelay: 400 ms to the first repeat, 100 ms until 1.5 s, 25 ms after', () => {
  assert.equal(holdDelay(0), HOLD_FIRST_MS);
  assert.equal(holdDelay(150), HOLD_FIRST_MS - 150);
  assert.equal(holdDelay(400), HOLD_SLOW_MS);
  assert.equal(holdDelay(1499), HOLD_SLOW_MS);
  assert.equal(holdDelay(1500), HOLD_FAST_MS);
  assert.equal(holdDelay(5000), HOLD_FAST_MS);
});

test('real timers: ≈ 6 steps in the first 800 ms, ≈ 40 steps/s after 1.5 s, nothing after release', async (t) => {
  const steps: number[] = [];
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = true;
  const step = () => { if (held) steps.push(performance.now() - t0); };
  const tick = () => { timer = setTimeout(() => { step(); tick(); }, holdDelay(performance.now() - t0)); };
  step(); tick();                                                   // = start(): one step at once, then the chain
  await new Promise((r) => setTimeout(r, 3000));
  held = false; if (timer) clearTimeout(timer);                     // = stop()
  const nAfterRelease = steps.length;
  await new Promise((r) => setTimeout(r, 300));
  const in800 = steps.filter((s) => s <= 800 + 5).length;
  const s2to3 = steps.filter((s) => s > 2000 && s <= 3000).length;
  const first = steps[1];
  t.diagnostic(`first repeat at ${first?.toFixed(0)} ms · ${in800} steps in the first 800 ms · ${s2to3} steps between 2 s and 3 s · ${steps.length} total`);
  assert.ok(first >= 395 && first <= 430, `first repeat at ${first} ms`);
  assert.ok(in800 >= 5 && in800 <= 7, `${in800} steps in 800 ms`);
  assert.ok(s2to3 >= 35 && s2to3 <= 42, `${s2to3} steps/s after 1.5 s`);
  assert.equal(steps.length, nAfterRelease, 'no steps after release');
});
