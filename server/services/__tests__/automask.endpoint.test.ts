/**
 * Round 2A — the automask service's contract behaviour with mocked storage and frame access
 * (AUTOMASK_ROUND2A_PROPOSAL.md v2 §2.1 `automask.endpoint.test.ts`): flag off → disabled and no disk access;
 * unknown job → null (the route answers 404); frame not yet on disk → pending, not cached; happy path on the
 * synthetic fan fixture → ready, cache written, second call served from the cache; corrupt cache → recomputed and
 * replaced; image batch → frame 0 from uploads/ order. 2B-1: the proposer runs in the real worker (spawned through the
 * tsx bootstrap); `enqueueProposalAtReady` computes once with computed_by 'ready' and a GET is then served from the
 * cache; two enqueues share one compute; a worker failure → none/error, uncached; t0.json wins over the upload
 * (tier T0T1 with no upload on disk); flag off → the enqueue touches nothing. No database, no ffmpeg, no PHI.
 *
 * Run:  npx tsx server/services/__tests__/automask.endpoint.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

import { getOrComputeProposal, enqueueProposalAtReady, automaskEnabled, type AutomaskDeps } from '../automask';
import { defaultWorkerClient } from '../automaskWorkerClient';
import { writeT0 } from '../automaskT0';
import type { Job, VideoJob } from '@shared/schema';

after(async () => { await defaultWorkerClient.terminate(); });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAN_PNG = path.resolve(HERE, 'fixtures/automask/synthetic_fan/frame.png');
const TRAP_PNG = path.resolve(HERE, 'fixtures/automask/synthetic_trap/frame.png');
const TRAP_EXPECTED = path.resolve(HERE, 'fixtures/automask/synthetic_trap/proposal.json');

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, filename: 'synthetic_fan.mp4', status: 'ready', createdAt: new Date().toISOString(), phiStatus: 'raw',
    source: { type: 'video', width: 632, height: 1080, totalFrames: 1, durationSec: 0, frameRate: 1 } as unknown as Job['source'],
    extractionRate: 1, ...over,
  } as unknown as Job;
}

async function makeDeps(tmp: string, over: Partial<AutomaskDeps> = {}): Promise<{ deps: AutomaskDeps; logs: Array<{ jobId: string; stage: string; extra?: Record<string, unknown> }> }> {
  const logs: Array<{ jobId: string; stage: string; extra?: Record<string, unknown> }> = [];
  const deps: AutomaskDeps = {
    getJobV2: async (id) => (id === 'unknown' ? undefined : job(id)),
    getVideoJob: async () => undefined,
    listRawFrameFiles: async (id) => {
      const dir = path.join(tmp, id);
      try { const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort(); return { dir, files }; } catch { return { dir, files: [] }; }
    },
    isCompletePng: async (p) => { try { const b = await fs.readFile(p); return b.subarray(b.length - 8).equals(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])); } catch { return false; } },
    resolveImageBatchFrame: async (list, n) => {
      const entries = (list ?? []) as Array<{ filename: string }>;
      if (n >= entries.length) return { ok: false, kind: 'out_of_range' };
      const absPath = path.join(tmp, 'uploads', entries[n].filename);
      try { await fs.access(absPath); return { ok: true, absPath, contentType: 'image/png' }; } catch { return { ok: false, kind: 'missing_file' }; }
    },
    tempExtractedDir: tmp, env: { AUTOMASK: '1' }, log: (jobId, stage, extra) => logs.push({ jobId, stage, extra }), now: () => '2026-09-06T00:00:00.000Z',
    proposeInWorker: (...a) => defaultWorkerClient.propose(...a),   // the real worker, through the tsx bootstrap
    ...over,
  };
  return { deps, logs };
}

test('automaskEnabled reads the AUTOMASK flag', () => {
  assert.equal(automaskEnabled({}), false);
  assert.equal(automaskEnabled({ AUTOMASK: '0' }), false);
  assert.equal(automaskEnabled({ AUTOMASK: '1' }), true);
  assert.equal(automaskEnabled({ AUTOMASK: 'true' }), true);
});

test('flag off → none/disabled and no disk access', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  const { deps, logs } = await makeDeps(tmp, { env: {} });
  let touched = false;
  deps.listRawFrameFiles = async () => { touched = true; return { dir: tmp, files: [] }; };
  const r = await getOrComputeProposal('j1', deps);
  assert.equal(r?.status, 'none'); assert.equal(r?.reason, 'disabled');
  assert.equal(touched, false);
  assert.equal(logs.length, 0);
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('unknown job → null (route: 404)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  const { deps } = await makeDeps(tmp);
  assert.equal(await getOrComputeProposal('unknown', deps), null);
});

test('frame not on disk yet → pending, nothing cached', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  const { deps } = await makeDeps(tmp);
  const r = await getOrComputeProposal('j2', deps);
  assert.equal(r?.status, 'pending');
  await assert.rejects(fs.access(path.join(tmp, 'j2', 'automask.json')));
});

test('happy path: ready, cached, served from cache, corrupt cache replaced', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'j3'), { recursive: true });
  await fs.copyFile(FAN_PNG, path.join(tmp, 'j3', 'frame_000001.png'));
  const { deps, logs } = await makeDeps(tmp);
  const r = await getOrComputeProposal('j3', deps);
  assert.equal(r?.status, 'ready', JSON.stringify(r));
  assert.equal(r?.model, 'fan_sym');
  assert.equal(r?.keep?.kind, 'fan');
  assert.equal(r?.tier, 'T1'); assert.equal(r?.bound_source, 'not_dicom');
  assert.equal(r?.frame, 'frame_000001.png'); assert.equal(r?.width, 632); assert.equal(r?.height, 1080);
  assert.ok((r?.confidence ?? 0) >= 0.7); assert.ok(['proposed', 'check_depth'].includes(r?.grade ?? ''));
  assert.ok(r?.info.grade_thresholds, 'grade thresholds are exposed as tunables');
  assert.ok(r?.ms.propose > 0 && r?.ms.total >= r?.ms.propose);
  assert.ok((r?.ms.worker ?? 0) > 0 && (r?.ms.worker ?? 0) <= r!.ms.propose, `worker time inside the round trip: ${JSON.stringify(r?.ms)}`);
  assert.equal(r?.computed_by, 'lazy'); assert.equal(r?.info.t0_from, null);
  const cached = JSON.parse(await fs.readFile(path.join(tmp, 'j3', 'automask.json'), 'utf8'));
  assert.deepEqual(cached, r);
  assert.deepEqual(logs.map((l) => l.stage), ['automask.start', 'automask.done']);
  assert.equal(logs[1].extra?.trigger, 'lazy'); assert.ok(typeof logs[1].extra?.worker_ms === 'number');
  // second call → served from cache, no recompute
  const r2 = await getOrComputeProposal('j3', deps);
  assert.deepEqual(r2, r);
  assert.equal(logs[logs.length - 1].stage, 'automask.served');
  // corrupt cache → recomputed and replaced
  await fs.writeFile(path.join(tmp, 'j3', 'automask.json'), '{not json');
  const r3 = await getOrComputeProposal('j3', deps);
  assert.equal(r3?.status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(path.join(tmp, 'j3', 'automask.json'), 'utf8')).status, 'ready');
});

test('image batch: frame 0 is fileList[0] from uploads/', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'uploads'), { recursive: true });
  await fs.copyFile(FAN_PNG, path.join(tmp, 'uploads', 'abc123'));
  const { deps } = await makeDeps(tmp, {
    getJobV2: async (id) => job(id, { filename: 'photo.png', source: { type: 'image_batch', width: 632, height: 1080, totalFrames: 1 } as unknown as Job['source'] }),
    getVideoJob: async () => ({ fileList: [{ filename: 'abc123', originalName: 'photo.png' }] } as unknown as VideoJob),
  });
  const r = await getOrComputeProposal('j4', deps);
  assert.equal(r?.status, 'ready'); assert.equal(r?.frame, 'uploads/abc123');
});

test('withheld frame (white slide) → none/withheld with the gate name, cached', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'j5'), { recursive: true });
  const sharp = (await import('sharp')).default;
  await sharp(Buffer.alloc(320 * 200, 255), { raw: { width: 320, height: 200, channels: 1 } }).png().toFile(path.join(tmp, 'j5', 'frame_000001.png'));
  const { deps } = await makeDeps(tmp);
  const r = await getOrComputeProposal('j5', deps);
  assert.equal(r?.status, 'none'); assert.equal(r?.reason, 'withheld'); assert.equal(r?.withheld, 'background_not_dark');
  assert.equal(JSON.parse(await fs.readFile(path.join(tmp, 'j5', 'automask.json'), 'utf8')).withheld, 'background_not_dark');
});

// ---------------------------------------------------------------- 2B-1 ----------------------------------------------------------------

test('2B-1: enqueue at ready computes once (computed_by ready); GET is then served from the cache', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'r1'), { recursive: true });
  await fs.copyFile(FAN_PNG, path.join(tmp, 'r1', 'frame_000001.png'));
  const { deps, logs } = await makeDeps(tmp);
  await enqueueProposalAtReady('r1', deps);
  assert.deepEqual(logs.map((l) => l.stage), ['automask.start', 'automask.done']);
  assert.equal(logs[0].extra?.trigger, 'ready'); assert.equal(logs[1].extra?.trigger, 'ready');
  const cached = JSON.parse(await fs.readFile(path.join(tmp, 'r1', 'automask.json'), 'utf8'));
  assert.equal(cached.status, 'ready'); assert.equal(cached.computed_by, 'ready');
  const r = await getOrComputeProposal('r1', deps);
  assert.deepEqual(r, cached);
  assert.equal(logs[logs.length - 1].stage, 'automask.served');
  assert.equal(logs[logs.length - 1].extra?.computed_by, 'ready'); assert.equal(logs[logs.length - 1].extra?.trigger, 'lazy');
  assert.equal(logs.filter((l) => l.stage === 'automask.done').length, 1, 'no second compute');
});

test('2B-1: two enqueues for one job share a single compute (in-flight map)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'r2'), { recursive: true });
  await fs.copyFile(FAN_PNG, path.join(tmp, 'r2', 'frame_000001.png'));
  const { deps, logs } = await makeDeps(tmp);
  await Promise.all([enqueueProposalAtReady('r2', deps), enqueueProposalAtReady('r2', deps), getOrComputeProposal('r2', deps)]);
  assert.equal(logs.filter((l) => l.stage === 'automask.done').length, 1);
  assert.equal(logs.filter((l) => l.stage === 'automask.start').length, 1);
});

test('2B-1: flag off → enqueue is a no-op (no lookup, no disk, no log)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  const { deps, logs } = await makeDeps(tmp, { env: {} });
  let looked = false; deps.getJobV2 = async (id) => { looked = true; return job(id); };
  await enqueueProposalAtReady('r3', deps);
  assert.equal(looked, false); assert.equal(logs.length, 0); assert.deepEqual(await fs.readdir(tmp), []);
});

test('2B-1: worker failure → none/error with the detail, not cached; the next GET tries again', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'r4'), { recursive: true });
  await fs.copyFile(FAN_PNG, path.join(tmp, 'r4', 'frame_000001.png'));
  let calls = 0;
  const { deps, logs } = await makeDeps(tmp, { proposeInWorker: async (...a) => { if (++calls === 1) throw new Error('worker_crash: exit 3'); return defaultWorkerClient.propose(...a); } });
  await enqueueProposalAtReady('r4', deps);
  assert.equal(logs[logs.length - 1].stage, 'automask.skipped');
  assert.equal(logs[logs.length - 1].extra?.reason, 'error'); assert.equal(logs[logs.length - 1].extra?.detail, 'worker_crash: exit 3'); assert.equal(logs[logs.length - 1].extra?.trigger, 'ready');
  await assert.rejects(fs.access(path.join(tmp, 'r4', 'automask.json')), 'an error result is never cached');
  const r = await getOrComputeProposal('r4', deps);      // the lazy fallback: a fresh attempt through the worker
  assert.equal(r?.status, 'ready'); assert.equal(r?.computed_by, 'lazy'); assert.equal(calls, 2);
});

test('2B-1: t0.json wins over the upload — T0T1 with no upload on disk, and the fit matches the fixture computed with that box', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'r5'), { recursive: true });
  await fs.copyFile(TRAP_PNG, path.join(tmp, 'r5', 'frame_000001.png'));
  const expected = JSON.parse(await fs.readFile(TRAP_EXPECTED, 'utf8'));
  const bound = expected.bound as { x0: number; y0: number; x1: number; y1: number };
  await writeT0(tmp, 'r5', { bound, bound_source: 'dicom', w: expected.w ?? 632, h: expected.h ?? 1080 });
  const { deps, logs } = await makeDeps(tmp, {
    getJobV2: async (id) => job(id, { filename: 'ge_e9.dcm' }),
    getVideoJob: async () => ({ filePath: path.join(tmp, 'uploads', 'purged-by-restart') } as unknown as VideoJob),   // does not exist
  });
  const r = await getOrComputeProposal('r5', deps);
  assert.equal(r?.status, 'ready', JSON.stringify(r));
  assert.equal(r?.tier, 'T0T1'); assert.equal(r?.bound_source, 'dicom'); assert.deepEqual(r?.bound, bound);
  assert.equal(r?.info.t0_from, 'file');
  assert.ok(['trap', 'rect'].includes(r?.keep?.kind ?? ''), `trapezoid family with the box: ${r?.keep?.kind}`);
  assert.deepEqual(r?.keep, expected.keep, 'the same fit the 2A fixture recorded for this frame + box');
  assert.equal(logs.some((l) => l.stage === 'automask.t0_unavailable'), false, 'the upload was never needed');
  assert.equal(logs.find((l) => l.stage === 'automask.done')?.extra?.t0_from, 'file');
});

test('2B-1: no t0.json and no upload → unavailable (the pre-2B path, unchanged)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automask-'));
  await fs.mkdir(path.join(tmp, 'r6'), { recursive: true });
  await fs.copyFile(TRAP_PNG, path.join(tmp, 'r6', 'frame_000001.png'));
  const { deps, logs } = await makeDeps(tmp, {
    getJobV2: async (id) => job(id, { filename: 'ge_e9.dcm' }),
    getVideoJob: async () => ({ filePath: path.join(tmp, 'uploads', 'purged-by-restart') } as unknown as VideoJob),
  });
  const r = await getOrComputeProposal('r6', deps);
  assert.equal(r?.status, 'ready'); assert.equal(r?.tier, 'T1'); assert.equal(r?.bound_source, 'unavailable'); assert.equal(r?.info.t0_from, null);
  assert.ok(logs.some((l) => l.stage === 'automask.t0_unavailable'));
});
