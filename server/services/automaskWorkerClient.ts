/**
 * Auto-mask Round 2B-1 — the proposer off the main thread (AUTOMASK_ROUND2B_RECON_PROPOSAL.md §1.1 / §2.2,
 * sign-off decision 1).
 *
 * Prod measured `ms_propose` 1463 ms cold on 1080p / 701 ms warm on 1164×873 on the main thread (t3.large, one physical
 * core) — a stall of that length freezes every other request once the spoke calls the proposer. This client owns ONE
 * long-lived worker_threads Worker, spawned lazily on the first task, with a FIFO queue and one task in flight at a time
 * (a pool would compete with the main thread and ffmpeg for the same core and buy nothing). The gray frame crosses as a
 * transferred ArrayBuffer (an owned copy, so the caller's buffer is not detached); the result comes back WITHOUT the
 * `keep` grid — the service never reads it, and it would be 2 MB per proposal at 1080p.
 *
 * Failure: a task that exceeds `timeoutMs`, or whose worker errors / exits, rejects with `worker_timeout` /
 * `worker_crash…`; the worker is terminated and the next task spawns a fresh one. The service maps the rejection to the
 * contract's uncached `{status:'none', reason:'error'}`, so the next GET simply tries again.
 *
 * Entry resolution — the part the kickoff assumed already existed and does not (recon §1.1: `maskWorker.ts` is dead,
 * self-spawning and has no build entry): under tsx (`npm run dev`, the sandbox, tests — `import.meta.url` ends in
 * `.ts`) the worker is `../workers/automaskWorker.boot.mjs`, which registers tsx inside the thread and loads the `.ts`
 * entry (a worker thread does not inherit the parent's tsx loader; `execArgv: ['--import','tsx']` was tested and
 * fails on the first extensionless import). Under the esbuild bundle it is `./automaskWorker.js`, the second build
 * entry beside `dist/index.js` (package.json `build`).
 */
import { Worker } from 'worker_threads';
import type { Bound, ProposeResult } from '../../shared/automask/types';
import { perfMark } from './perf';

export type WorkerProposeResult = Omit<ProposeResult, 'keep'>;

export interface WorkerRequest { id: number; jobId: string; w: number; h: number; gray: ArrayBuffer; bound: Bound | null }
export type WorkerResponse =
  | { id: number; ok: true; result: WorkerProposeResult; workerMs: number }
  | { id: number; ok: false; error: string };

export interface WorkerOutcome {
  result: WorkerProposeResult;
  workerMs: number;    // in-thread propose() time
  queueMs: number;     // time spent waiting behind another job
  spawned: boolean;    // this task paid for the worker's spawn (cold)
}

export type ProposeInWorker = (gray: Uint8Array, w: number, h: number, bound: Bound | null, jobId: string) => Promise<WorkerOutcome>;

export const WORKER_TIMEOUT_MS = 20_000;   // ≈ 13× the cold prod number

/** `.ts` client (tsx: dev server, sandbox, tests) → the tsx bootstrap; bundled client → dist/automaskWorker.js. */
export function resolveWorkerEntry(clientUrl: string = import.meta.url): URL {
  return /\.ts$/.test(clientUrl) ? new URL('../workers/automaskWorker.boot.mjs', clientUrl) : new URL('./automaskWorker.js', clientUrl);
}

interface Task {
  id: number; jobId: string; w: number; h: number; gray: Uint8Array; bound: Bound | null;
  enqueuedAt: number; queueMs: number; spawned: boolean; timer: NodeJS.Timeout | null;
  resolve: (o: WorkerOutcome) => void; reject: (e: Error) => void;
}

export interface WorkerClientOptions {
  entry?: URL;                 // tests point this at a fault-injecting worker
  workerData?: unknown;
  timeoutMs?: number;
  log?: (stage: string, extra: Record<string, unknown>) => void;
}

export class AutomaskWorkerClient {
  private worker: Worker | null = null;
  private queue: Task[] = [];
  private current: Task | null = null;
  private seq = 0;
  private spawns = 0;
  private readonly entry: URL;
  private readonly timeoutMs: number;
  private readonly workerData: unknown;
  private readonly log: (stage: string, extra: Record<string, unknown>) => void;

  constructor(opts: WorkerClientOptions = {}) {
    this.entry = opts.entry ?? resolveWorkerEntry();
    this.timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS;
    this.workerData = opts.workerData;
    this.log = opts.log ?? ((stage, extra) => perfMark(String(extra.jobId ?? '-'), stage, extra));
  }

  propose: ProposeInWorker = (gray, w, h, bound, jobId) => new Promise<WorkerOutcome>((resolve, reject) => {
    this.queue.push({ id: ++this.seq, jobId, w, h, gray, bound, enqueuedAt: performance.now(), queueMs: 0, spawned: false, timer: null, resolve, reject });
    this.pump();
  });

  /** tasks waiting + in flight */
  get depth(): number { return this.queue.length + (this.current ? 1 : 0); }
  get alive(): boolean { return this.worker !== null; }
  get spawnCount(): number { return this.spawns; }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const t = this.queue.shift()!;
    this.current = t;
    t.queueMs = performance.now() - t.enqueuedAt;
    let worker: Worker;
    try {
      worker = this.ensureWorker(t);
    } catch (e: unknown) {
      this.current = null;
      t.reject(new Error(`worker_spawn_failed: ${(e as Error)?.message ?? String(e)}`));
      this.pump();
      return;
    }
    t.timer = setTimeout(() => this.fail(t, 'worker_timeout'), this.timeoutMs);
    const gray = t.gray.slice();                       // an owned copy: transferable without detaching the caller's frame
    const req: WorkerRequest = { id: t.id, jobId: t.jobId, w: t.w, h: t.h, gray: gray.buffer, bound: t.bound };
    worker.postMessage(req, [gray.buffer]);
  }

  private ensureWorker(t: Task): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.entry, { workerData: this.workerData });
    w.unref();   // an idle worker must not keep a test or script alive; in prod the HTTP server holds the loop
    w.on('message', (m: WorkerResponse) => { if (this.worker === w) this.settle(m); });
    w.on('error', (e: Error) => { if (this.worker === w) this.fail(this.current, `worker_crash: ${e.message}`); });
    w.on('exit', (code: number) => {
      if (this.worker !== w) return;                   // we terminated it ourselves
      this.worker = null;
      if (this.current) this.fail(this.current, `worker_crash: exit ${code}`);
    });
    this.worker = w;
    this.spawns++;
    t.spawned = true;
    this.log('automask.worker_spawned', { jobId: t.jobId, entry: this.entry.pathname.split('/').pop() ?? '', spawn: this.spawns });
    return w;
  }

  private settle(m: WorkerResponse): void {
    const t = this.current;
    if (!t || m.id !== t.id) return;
    if (t.timer) clearTimeout(t.timer);
    this.current = null;
    if (m.ok) t.resolve({ result: m.result, workerMs: m.workerMs, queueMs: t.queueMs, spawned: t.spawned });
    else t.reject(new Error(m.error));
    this.pump();
  }

  private fail(t: Task | null, reason: string): void {
    if (!t || this.current !== t) return;
    if (t.timer) clearTimeout(t.timer);
    this.current = null;
    const w = this.worker;
    this.worker = null;                                 // before terminate(), so its exit event is ignored
    if (w) void w.terminate().catch(() => { /* already gone */ });
    this.log('automask.worker_failed', { jobId: t.jobId, reason });
    t.reject(new Error(reason));
    this.pump();
  }

  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    for (const t of this.queue.splice(0)) t.reject(new Error('worker_client_terminated'));
    if (this.current) { const t = this.current; this.current = null; if (t.timer) clearTimeout(t.timer); t.reject(new Error('worker_client_terminated')); }
    if (w) await w.terminate();
  }
}

/** The process-wide client the service uses. Nothing is spawned until the first proposal. */
export const defaultWorkerClient = new AutomaskWorkerClient();
