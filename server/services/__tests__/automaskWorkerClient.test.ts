/**
 * Round 2B-1 — the proposer worker client (AUTOMASK_ROUND2B_RECON_PROPOSAL.md §2.1 test list): a real round trip on the
 * synthetic fan fixture reproduces the in-thread proposer exactly (same shape, same confidence — the worker runs the
 * same frozen code); the first task pays the spawn and the second does not; the fault worker drives crash → respawn →
 * success and hang → timeout → success on one client; a terminated client rejects what it holds. No database, no PHI.
 *
 * Run:  npx tsx server/services/__tests__/automaskWorkerClient.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import sharp from 'sharp';

import { AutomaskWorkerClient, resolveWorkerEntry } from '../automaskWorkerClient';
import { propose } from '../../../shared/automask/core';
import { grid, rgbToGray } from '../../../shared/automask/geometry';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAN_PNG = path.resolve(HERE, 'fixtures/automask/synthetic_fan/frame.png');
const FAULT = new URL('./fixtures/automask/faultWorker.mjs', import.meta.url);

const clients: AutomaskWorkerClient[] = [];
after(async () => { for (const c of clients) await c.terminate(); });

async function fanGray() {
  const { data, info } = await sharp(FAN_PNG).raw().toBuffer({ resolveWithObject: true });
  return { gray: rgbToGray(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels), w: info.width, h: info.height };
}

test('entry resolution: .ts client → tsx bootstrap, bundled client → dist/automaskWorker.js', () => {
  assert.match(resolveWorkerEntry('file:///repo/server/services/automaskWorkerClient.ts').pathname, /\/server\/workers\/automaskWorker\.boot\.mjs$/);
  assert.match(resolveWorkerEntry('file:///repo/dist/index.js').pathname, /\/dist\/automaskWorker\.js$/);
});

test('real worker: same result as the in-thread proposer; spawn paid once', async () => {
  const logs: Array<{ stage: string; extra: Record<string, unknown> }> = [];
  const c = new AutomaskWorkerClient({ log: (stage, extra) => logs.push({ stage, extra }) }); clients.push(c);
  const { gray, w, h } = await fanGray();
  const inThread = propose(grid(w, h, new Uint8Array(gray)));
  const a = await c.propose(gray, w, h, null, 'job-a');
  assert.equal(a.spawned, true);
  assert.ok(a.workerMs > 0, 'in-thread time is reported');
  assert.deepEqual(a.result.shape, inThread.shape);
  assert.equal(a.result.model, inThread.model);
  assert.equal(a.result.conf, inThread.conf);
  assert.equal(a.result.withheld, inThread.withheld);
  assert.equal('keep' in a.result, false, 'the keep grid does not cross the thread boundary');
  assert.equal(gray.byteLength, w * h, "the caller's buffer is not detached");
  const b = await c.propose(gray, w, h, null, 'job-b');
  assert.equal(b.spawned, false, 'second task reuses the worker');
  assert.deepEqual(b.result.shape, inThread.shape);
  assert.equal(c.spawnCount, 1);
  assert.deepEqual(logs.map((l) => l.stage), ['automask.worker_spawned']);
});

test('two tasks at once: FIFO, second one waits (queue_ms > 0), one worker', async () => {
  const c = new AutomaskWorkerClient(); clients.push(c);
  const { gray, w, h } = await fanGray();
  const [a, b] = await Promise.all([c.propose(gray, w, h, null, 'j1'), c.propose(gray, w, h, null, 'j2')]);
  assert.equal(a.spawned, true); assert.equal(b.spawned, false);
  assert.ok(b.queueMs >= a.workerMs * 0.5, `second task waited behind the first (queue ${b.queueMs} ms, first took ${a.workerMs} ms)`);
  assert.equal(c.spawnCount, 1);
});

test('fault worker: crash → worker_crash, respawn, success; hang → worker_timeout, respawn, success', async () => {
  const logs: string[] = [];
  const c = new AutomaskWorkerClient({ entry: FAULT, timeoutMs: 300, log: (stage) => logs.push(stage) }); clients.push(c);
  const gray = new Uint8Array(16 * 8), w = 16, h = 8;
  await assert.rejects(c.propose(gray, w, h, { x0: -1, y0: 0, x1: 0, y1: 0 }, 'crash'), /worker_crash/);
  assert.equal(c.alive, false);
  const ok1 = await c.propose(gray, w, h, null, 'after-crash');
  assert.equal(ok1.spawned, true, 'a fresh worker was spawned after the crash');
  assert.equal(ok1.result.withheld, 'fault_echo'); assert.equal(ok1.result.info.echo_bytes, 128);
  await assert.rejects(c.propose(gray, w, h, { x0: -2, y0: 0, x1: 0, y1: 0 }, 'hang'), /worker_timeout/);
  const ok2 = await c.propose(gray, w, h, null, 'after-timeout');
  assert.equal(ok2.spawned, true);
  assert.equal(c.spawnCount, 3);
  assert.deepEqual(logs, ['automask.worker_spawned', 'automask.worker_failed', 'automask.worker_spawned', 'automask.worker_failed', 'automask.worker_spawned']);
});

test('terminate rejects the task in flight and empties the queue', async () => {
  const c = new AutomaskWorkerClient({ entry: FAULT, timeoutMs: 5000 });
  const gray = new Uint8Array(4), hang = { x0: -2, y0: 0, x1: 0, y1: 0 };
  const p1 = c.propose(gray, 2, 2, hang, 'h1'), p2 = c.propose(gray, 2, 2, null, 'q2');
  const r1 = assert.rejects(p1, /worker_client_terminated/), r2 = assert.rejects(p2, /worker_client_terminated/);   // handlers attached before the rejection fires
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.depth, 2);
  await c.terminate();
  await r1; await r2;
  assert.equal(c.depth, 0); assert.equal(c.alive, false);
});
