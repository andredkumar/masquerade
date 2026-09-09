/**
 * Auto-mask Round 2B-1 — the worker thread entry (AUTOMASK_ROUND2B_RECON_PROPOSAL.md §2.1).
 *
 * Receives `{ id, jobId, w, h, gray: ArrayBuffer, bound }`, runs the frozen proposer (shared/automask — the same code,
 * the same constants, the same 54/54 fixtures), and posts the result back WITHOUT the `keep` grid. Imports only
 * `worker_threads` and shared/automask, so the bundled worker (package.json `build`, second esbuild entry →
 * dist/automaskWorker.js) is ~50 KB and pulls in neither sharp nor express. Decoding stays on the service side.
 *
 * Under tsx this file is loaded through automaskWorker.boot.mjs (see automaskWorkerClient.ts for why).
 */
import { parentPort } from 'worker_threads';
import { propose } from '../../shared/automask/core';
import { grid, boundToGrid } from '../../shared/automask/geometry';
import type { WorkerRequest, WorkerResponse } from '../services/automaskWorkerClient';   // type-only: erased, nothing of the service is bundled

if (!parentPort) throw new Error('automaskWorker must run as a worker thread');
const port = parentPort;

port.on('message', (m: WorkerRequest) => {
  const t0 = performance.now();
  let reply: WorkerResponse;
  try {
    const gray = grid(m.w, m.h, new Uint8Array(m.gray));
    const r = propose(gray, { bound: m.bound ? boundToGrid(m.bound, m.w, m.h) : null });
    const { keep: _keep, ...result } = r;
    reply = { id: m.id, ok: true, result, workerMs: Math.round((performance.now() - t0) * 10) / 10 };
  } catch (e: unknown) {
    reply = { id: m.id, ok: false, error: (e as Error)?.message ?? String(e) };
  }
  port.postMessage(reply);
});
