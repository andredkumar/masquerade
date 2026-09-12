/**
 * Auto-mask Round 2B-2 — B3 nudge ergonomics (docs/refactor/AUTOMASK_ROUND2B2_PLAN.md §7).
 *
 * Tap = one step. Hold: the first repeat at 400 ms, then every 100 ms (10 steps/s) until 1.5 s, then every 25 ms
 * (40 steps/s). Shift multiplies the STEP ×10 and is re-read at every tick, so it changes the size, never the rate.
 * One setTimeout chain (no setInterval); stopped on pointer release / leave / cancel, on the key's keyup, on window
 * blur, and on unmount.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

export const HOLD_FIRST_MS = 400;
export const HOLD_SLOW_MS = 100;
export const HOLD_FAST_AFTER_MS = 1500;
export const HOLD_FAST_MS = 25;
export const SHIFT_MULTIPLIER = 10;

export type Dir = readonly [number, number];

/** Delay until the next repeat, from the time the hold started: 400 ms first, then 100 ms (10/s) until 1.5 s, then 25 ms (40/s). */
export function holdDelay(elapsedMs: number): number {
  return elapsedMs < HOLD_FIRST_MS ? HOLD_FIRST_MS - elapsedMs : elapsedMs < HOLD_FAST_AFTER_MS ? HOLD_SLOW_MS : HOLD_FAST_MS;
}

export function useHoldRepeat(onStep: (dx: number, dy: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t0 = useRef(0);
  const dir = useRef<Dir | null>(null);
  const shift = useRef(false);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dir.current = null;
  }, []);

  const step = useCallback(() => {
    const d = dir.current;
    if (!d) return;
    const m = shift.current ? SHIFT_MULTIPLIER : 1;
    onStepRef.current(d[0] * m, d[1] * m);
  }, []);

  const tick = useCallback(() => {
    timer.current = setTimeout(() => { step(); tick(); }, holdDelay(performance.now() - t0.current));
  }, [step]);

  const start = useCallback((d: Dir, shiftKey?: boolean) => {
    stop();
    if (shiftKey !== undefined) shift.current = shiftKey;
    dir.current = d;
    t0.current = performance.now();
    step();
    tick();
  }, [stop, step, tick]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") shift.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shift.current = false; };
    const blur = () => { shift.current = false; stop(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      stop();
    };
  }, [stop]);

  // One stable object: the caller's effects key on it, and a fresh object per render would re-run them — and their
  // cleanup's stop() — after the very first step, killing every hold (caught by the sandbox nudge row).
  return useMemo(() => ({ start, stop }), [start, stop]);
}
