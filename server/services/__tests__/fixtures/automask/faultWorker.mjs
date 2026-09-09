// Fault-injecting stand-in for server/workers/automaskWorker.ts (2B-1 client tests). Mode is chosen per message from
// the `bound` field so one client instance can be driven through crash → respawn → success without env vars:
//   bound.x0 === -1 → the thread dies (exit code 3)      bound.x0 === -2 → never replies (timeout path)
//   otherwise       → a synthetic "withheld" result that echoes w*h, so the test can prove the payload crossed intact.
import { parentPort } from 'worker_threads';

parentPort.on('message', (m) => {
  const x0 = m.bound ? m.bound.x0 : null;
  if (x0 === -1) process.exit(3);
  if (x0 === -2) return;
  const bytes = new Uint8Array(m.gray).length;
  parentPort.postMessage({
    id: m.id, ok: true, workerMs: 0.1,
    result: { shape: null, paramsSmall: null, model: null, conf: 0, withheld: 'fault_echo', flag: null, info: { echo_bytes: bytes, echo_w: m.w, echo_h: m.h }, ms: 0 },
  });
});
