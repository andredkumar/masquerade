#!/usr/bin/env tsx
/**
 * IStorage conformance harness (Phase 5C-1, Decision B = RDS).
 *
 * One behavioral suite, run against TWO IStorage implementations:
 *   • MemStorage — the live runtime; the reference oracle.
 *   • PgStorage  — the Postgres-backed implementation under test.
 *
 * The suite is the contract: if PgStorage matches MemStorage on every case,
 * the storage layer can be swapped without behavioral drift. Coverage spans
 * all 21 IStorage methods, the VideoJob⇄Job dual-record 1:1 fidelity, the
 * VideoJob.status → Job.status mirror, facet independence on delete, the
 * AI-run lifecycle (incl. present-but-empty `ai.runs`), and ai_runs
 * cascade-on-delete.
 *
 * Usage:
 *   tsx scripts/conformance-storage.ts
 *       → runs the suite against MemStorage only.
 *
 *   TEST_DATABASE_URL=postgres://… tsx scripts/conformance-storage.ts
 *       → also runs against PgStorage. The target DB must already have the
 *         0000 baseline migration applied (npm run db:migrate against it).
 *         Tables jobs / ai_runs / frame_processing_batches are TRUNCATEd
 *         between cases, so point this at a DISPOSABLE test database only.
 *
 * Exit code: 0 = all suites passed; 1 = any failure or setup error.
 *
 * MemStorage's live singleton (storage.ts) is never touched — the harness
 * constructs its own fresh instances.
 */

import { MemStorage, mapVideoJobStatusToJobStatus } from '../server/storage.ts';
import type { IStorage } from '../server/storage.ts';
import type {
  InsertVideoJob,
  VideoJob,
  Job,
  AIRun,
  TemplateMaskState,
  MaskData,
  OutputSettings,
} from '../shared/schema.ts';

// ── Tiny assertion framework (no external test dep) ──────────────────────

let currentSuite = '';
let currentTest = '';
const failures: string[] = [];
let assertions = 0;

function fail(msg: string): void {
  failures.push(`[${currentSuite}] ${currentTest}: ${msg}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

const j = (v: unknown) => JSON.stringify(v);

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  assertions++;
  if (!deepEqual(actual, expected)) {
    fail(`${msg} — expected ${j(expected)}, got ${j(actual)}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  assertions++;
  if (!cond) fail(`${msg} — expected true`);
}

function assertUndefined(actual: unknown, msg: string): void {
  assertions++;
  if (actual !== undefined) fail(`${msg} — expected undefined, got ${j(actual)}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeInsertVideoJob(overrides: Partial<InsertVideoJob> = {}): InsertVideoJob {
  return {
    filename: 'scan.mp4',
    filePath: '/uploads/scan.mp4',
    originalSize: 1024,
    duration: 12.5,
    width: 640,
    height: 480,
    frameRate: 30,
    totalFrames: 375,
    ...overrides,
  };
}

function makeMaskData(): MaskData {
  return { type: 'rectangle', coordinates: [0, 0, 10, 10], opacity: 0.8 };
}

function makeOutputSettings(): OutputSettings {
  return {
    size: '224x224',
    format: 'png',
    includeMetadata: false,
    parallelThreads: 2,
    batchSize: 8,
    aspectRatioMode: 'stretch',
  };
}

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    filename: 'scan.mp4',
    uploadedAt: '2026-06-29T00:00:00.000Z',
    phiStatus: 'raw',
    source: {
      duration: 12.5,
      width: 640,
      height: 480,
      frameRate: 30,
      totalFrames: 375,
      type: 'video',
    },
    extractionRate: 1,
    status: 'extracting',
    errorMessage: null,
    ...overrides,
  };
}

function makeAiRun(id: string, overrides: Partial<AIRun> = {}): AIRun {
  return {
    id,
    name: `run-${id}`,
    inputSource: 'extracted',
    modality: 'cardiac',
    bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
    target: 'pleural effusion',
    outputDir: `spokes/ai/job/${id}/`,
    labels: [],
    approved: false,
    createdAt: `2026-06-29T00:00:0${id}.000Z`,
    ...overrides,
  };
}

function makeTemplateMaskState(): TemplateMaskState {
  return {
    status: 'idle',
    maskData: makeMaskData(),
    outputSettings: makeOutputSettings(),
    outputDir: 'spokes/template_mask/job/',
    completedAt: null,
  };
}

// ── The suite: an ordered list of (name, fn) over a fresh IStorage ───────

type TestFn = (s: IStorage) => Promise<void>;
interface TestCase {
  name: string;
  fn: TestFn;
}

const tests: TestCase[] = [
  // ── VideoJob facet ────────────────────────────────────────────────
  {
    name: 'createVideoJob returns a fully-defaulted record',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      assertTrue(typeof vj.id === 'string' && vj.id.length > 0, 'id minted');
      assertEqual(vj.status, 'uploaded', 'default status');
      assertEqual(vj.progress, 0, 'default progress');
      assertEqual(vj.jobType, 'video', 'default jobType');
      assertEqual(vj.fileCount, 1, 'default fileCount');
      assertEqual(vj.maskData, null, 'default maskData null');
      assertEqual(vj.outputSettings, null, 'default outputSettings null');
      assertEqual(vj.outputZipPath, null, 'default outputZipPath null');
      assertEqual(vj.fileList, null, 'default fileList null');
      assertEqual(vj.aiLabels, null, 'default aiLabels null');
      assertEqual(vj.completedAt, null, 'completedAt null');
      assertEqual(vj.errorMessage, null, 'errorMessage null');
      assertTrue(typeof vj.createdAt === 'string', 'createdAt set');
    },
  },
  {
    name: 'getVideoJob returns the created record 1:1',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob({ filename: 'a.mp4' }));
      const got = await s.getVideoJob(vj.id);
      assertEqual(got, vj, 'getVideoJob 1:1');
    },
  },
  {
    name: 'getVideoJob on missing id → undefined',
    fn: async (s) => {
      assertUndefined(await s.getVideoJob('no-such-id'), 'missing getVideoJob');
    },
  },
  {
    name: 'updateVideoJob merges and persists',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      const updated = await s.updateVideoJob(vj.id, { progress: 50, maskData: makeMaskData() });
      assertTrue(updated !== undefined, 'update returns record');
      assertEqual(updated!.progress, 50, 'progress merged');
      assertEqual(updated!.maskData, makeMaskData(), 'maskData merged');
      assertEqual(updated!.filename, vj.filename, 'untouched field preserved');
      const got = await s.getVideoJob(vj.id);
      assertEqual(got, updated, 'persisted update 1:1');
    },
  },
  {
    name: 'updateVideoJob on missing id → undefined',
    fn: async (s) => {
      assertUndefined(await s.updateVideoJob('no-such-id', { progress: 1 }), 'missing update');
    },
  },

  // ── Dual-record (VideoJob + Job share one id, independent) ─────────
  {
    name: 'dual-record: both facets coexist 1:1 on one id',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      const job = makeJob(vj.id);
      await s.createJobV2(job);
      assertEqual(await s.getVideoJob(vj.id), vj, 'VideoJob facet intact');
      assertEqual(await s.getJobV2(vj.id), job, 'Job facet intact');
    },
  },
  {
    name: 'createJobV2 / getJobV2 round-trips 1:1',
    fn: async (s) => {
      const job = makeJob('jid-1', { phiStatus: 'user_attested' });
      const created = await s.createJobV2(job);
      assertEqual(created, job, 'createJobV2 returns input');
      assertEqual(await s.getJobV2('jid-1'), job, 'getJobV2 1:1');
    },
  },
  {
    name: 'getJobV2 on missing id → undefined',
    fn: async (s) => {
      assertUndefined(await s.getJobV2('no-such-id'), 'missing getJobV2');
    },
  },
  {
    name: 'getJobV2 when only the VideoJob facet exists → undefined',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      assertUndefined(await s.getJobV2(vj.id), 'no Job facet → undefined');
    },
  },

  // ── Status mirror ──────────────────────────────────────────────────
  {
    name: 'status mirror: updateVideoJob(ready) → getJobV2.status=ready',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      await s.createJobV2(makeJob(vj.id, { status: 'extracting' }));
      await s.updateVideoJob(vj.id, { status: 'ready' });
      const v2 = await s.getJobV2(vj.id);
      assertEqual(v2!.status, mapVideoJobStatusToJobStatus('ready'), 'mirror to ready');
      assertEqual(v2!.status, 'ready', 'mirror value');
    },
  },
  {
    name: 'status mirror: maps completed → ready',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      await s.createJobV2(makeJob(vj.id));
      await s.updateVideoJob(vj.id, { status: 'completed' });
      assertEqual((await s.getJobV2(vj.id))!.status, 'ready', 'completed → ready');
    },
  },
  {
    name: 'status mirror: failed → failed',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      await s.createJobV2(makeJob(vj.id));
      await s.updateVideoJob(vj.id, { status: 'failed' });
      assertEqual((await s.getJobV2(vj.id))!.status, 'failed', 'failed → failed');
    },
  },
  {
    name: 'status mirror: unknown status leaves Job.status unchanged',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      await s.createJobV2(makeJob(vj.id, { status: 'extracting' }));
      await s.updateVideoJob(vj.id, { status: 'weird-unmapped' });
      assertEqual((await s.getJobV2(vj.id))!.status, 'extracting', 'unmapped no-op');
    },
  },
  {
    name: 'status mirror: no Job facet → update succeeds, nothing to mirror',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      const updated = await s.updateVideoJob(vj.id, { status: 'ready' });
      assertEqual(updated!.status, 'ready', 'VideoJob status set');
      assertUndefined(await s.getJobV2(vj.id), 'still no Job facet');
    },
  },

  // ── PHI ────────────────────────────────────────────────────────────
  {
    name: 'setPhiStatus with attestation record',
    fn: async (s) => {
      await s.createJobV2(makeJob('phi-1'));
      const rec = { attestedAt: '2026-06-29T01:00:00.000Z', choice: 'no_phi' as const };
      const updated = await s.setPhiStatus('phi-1', 'user_attested', rec);
      assertEqual(updated!.phiStatus, 'user_attested', 'phiStatus updated');
      assertEqual(updated!.attestationRecord, rec, 'attestationRecord set');
      assertEqual((await s.getJobV2('phi-1'))!.attestationRecord, rec, 'persisted');
    },
  },
  {
    name: 'setPhiStatus without record leaves prior record intact',
    fn: async (s) => {
      const rec = { attestedAt: '2026-06-29T01:00:00.000Z', choice: 'contains_phi' as const };
      await s.createJobV2(makeJob('phi-2', { attestationRecord: rec }));
      const updated = await s.setPhiStatus('phi-2', 'raw');
      assertEqual(updated!.phiStatus, 'raw', 'phiStatus updated');
      assertEqual(updated!.attestationRecord, rec, 'prior record preserved');
    },
  },
  {
    name: 'setPhiStatus on missing Job facet → undefined',
    fn: async (s) => {
      assertUndefined(await s.setPhiStatus('no-such', 'raw'), 'missing setPhiStatus');
    },
  },

  // ── Template-mask spoke ────────────────────────────────────────────
  {
    name: 'setTemplateMaskState / getTemplateMaskState round-trip',
    fn: async (s) => {
      await s.createJobV2(makeJob('tm-1'));
      const state = makeTemplateMaskState();
      const updated = await s.setTemplateMaskState('tm-1', state);
      assertEqual(updated!.templateMask, state, 'templateMask on Job');
      assertEqual(await s.getTemplateMaskState('tm-1'), state, 'getTemplateMaskState 1:1');
    },
  },
  {
    name: 'getTemplateMaskState before set → undefined',
    fn: async (s) => {
      await s.createJobV2(makeJob('tm-2'));
      assertUndefined(await s.getTemplateMaskState('tm-2'), 'unset templateMask');
    },
  },
  {
    name: 'setTemplateMaskState on missing Job facet → undefined',
    fn: async (s) => {
      assertUndefined(
        await s.setTemplateMaskState('no-such', makeTemplateMaskState()),
        'missing setTemplateMaskState',
      );
    },
  },

  // ── AI-run lifecycle ──────────────────────────────────────────────
  {
    name: 'addAiRun initializes ai.runs and getJobV2 reflects it',
    fn: async (s) => {
      await s.createJobV2(makeJob('ai-1'));
      const run = makeAiRun('1');
      await s.addAiRun('ai-1', run);
      const v2 = await s.getJobV2('ai-1');
      assertTrue(v2!.ai !== undefined, 'ai present');
      assertEqual(v2!.ai!.runs, [run], 'runs contains the added run');
    },
  },
  {
    name: 'addAiRun on missing Job facet → undefined',
    fn: async (s) => {
      assertUndefined(await s.addAiRun('no-such', makeAiRun('1')), 'missing addAiRun');
    },
  },
  {
    name: 'listAiRuns preserves insertion order',
    fn: async (s) => {
      await s.createJobV2(makeJob('ai-2'));
      const r1 = makeAiRun('1');
      const r2 = makeAiRun('2');
      const r3 = makeAiRun('3');
      await s.addAiRun('ai-2', r1);
      await s.addAiRun('ai-2', r2);
      await s.addAiRun('ai-2', r3);
      assertEqual(await s.listAiRuns('ai-2'), [r1, r2, r3], 'ordered runs');
    },
  },
  {
    name: 'getAiRun returns one run; missing → undefined',
    fn: async (s) => {
      await s.createJobV2(makeJob('ai-3'));
      const run = makeAiRun('1');
      await s.addAiRun('ai-3', run);
      assertEqual(await s.getAiRun('ai-3', '1'), run, 'getAiRun 1:1');
      assertUndefined(await s.getAiRun('ai-3', 'nope'), 'missing run');
    },
  },
  {
    name: 'updateAiRun merges fields and returns the updated run',
    fn: async (s) => {
      await s.createJobV2(makeJob('ai-4'));
      await s.addAiRun('ai-4', makeAiRun('1'));
      const updated = await s.updateAiRun('ai-4', '1', { approved: true, name: 'renamed' });
      assertEqual(updated!.approved, true, 'approved merged');
      assertEqual(updated!.name, 'renamed', 'name merged');
      assertEqual(updated!.target, 'pleural effusion', 'untouched field preserved');
      assertEqual((await s.getAiRun('ai-4', '1'))!.approved, true, 'persisted');
    },
  },
  {
    name: 'updateAiRun on missing run → undefined',
    fn: async (s) => {
      await s.createJobV2(makeJob('ai-5'));
      assertUndefined(await s.updateAiRun('ai-5', 'nope', { approved: true }), 'missing updateAiRun');
    },
  },
  {
    name: 'deleteAiRun returns true then false; ai stays present-but-empty',
    fn: async (s) => {
      await s.createJobV2(makeJob('ai-6'));
      await s.addAiRun('ai-6', makeAiRun('1'));
      assertEqual(await s.deleteAiRun('ai-6', '1'), true, 'first delete true');
      assertEqual(await s.deleteAiRun('ai-6', '1'), false, 'second delete false');
      const v2 = await s.getJobV2('ai-6');
      assertTrue(v2!.ai !== undefined, 'ai still present after emptying');
      assertEqual(v2!.ai!.runs, [], 'present-but-empty runs');
    },
  },
  {
    name: 'createJobV2 with seeded runs surfaces them',
    fn: async (s) => {
      const r1 = makeAiRun('1');
      const r2 = makeAiRun('2');
      const job = makeJob('ai-7', { ai: { runs: [r1, r2] } });
      await s.createJobV2(job);
      assertEqual(await s.listAiRuns('ai-7'), [r1, r2], 'seeded runs listed');
      assertEqual((await s.getJobV2('ai-7'))!.ai!.runs, [r1, r2], 'getJobV2 shows seeded runs');
    },
  },

  // ── Frame batches ──────────────────────────────────────────────────
  {
    name: 'frame batch create / get / update',
    fn: async (s) => {
      const job = makeJob('fb-1');
      await s.createJobV2(job);
      const batch = await s.createFrameBatch({
        jobId: 'fb-1',
        batchNumber: 0,
        startFrame: 0,
        endFrame: 99,
      });
      assertEqual(batch.status, 'pending', 'default batch status');
      const list = await s.getFrameBatches('fb-1');
      assertEqual(list.length, 1, 'one batch listed');
      assertEqual(list[0].id, batch.id, 'batch id matches');
      const upd = await s.updateFrameBatch(batch.id, { status: 'completed' });
      assertEqual(upd!.status, 'completed', 'batch status updated');
    },
  },

  // ── Processing progress (ephemeral) ────────────────────────────────
  {
    name: 'progress update creates defaults, get reflects, delete clears',
    fn: async (s) => {
      await s.updateProcessingProgress('pp-1', { progress: 42, stage: 'extracting' });
      const got = await s.getProcessingProgress('pp-1');
      assertEqual(got!.progress, 42, 'progress set');
      assertEqual(got!.stage, 'extracting', 'stage set');
      assertEqual(got!.currentFrame, 0, 'default currentFrame');
      await s.deleteProcessingProgress('pp-1');
      assertUndefined(await s.getProcessingProgress('pp-1'), 'progress cleared');
    },
  },

  // ── Deletion + facet independence ──────────────────────────────────
  {
    name: 'deleteVideoJob returns true when present, false when absent',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      assertEqual(await s.deleteVideoJob(vj.id), true, 'delete present true');
      assertUndefined(await s.getVideoJob(vj.id), 'gone after delete');
      assertEqual(await s.deleteVideoJob(vj.id), false, 'delete absent false');
    },
  },
  {
    name: 'deleteVideoJob preserves the Job facet on the same id',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      const job = makeJob(vj.id);
      await s.createJobV2(job);
      assertEqual(await s.deleteVideoJob(vj.id), true, 'VideoJob deleted');
      assertUndefined(await s.getVideoJob(vj.id), 'VideoJob gone');
      assertEqual(await s.getJobV2(vj.id), job, 'Job facet survives');
    },
  },
  {
    name: 'deleteJobV2 returns true when present, false when absent',
    fn: async (s) => {
      await s.createJobV2(makeJob('dj-1'));
      assertEqual(await s.deleteJobV2('dj-1'), true, 'delete present true');
      assertUndefined(await s.getJobV2('dj-1'), 'gone after delete');
      assertEqual(await s.deleteJobV2('dj-1'), false, 'delete absent false');
    },
  },
  {
    name: 'deleteJobV2 preserves the VideoJob facet on the same id',
    fn: async (s) => {
      const vj = await s.createVideoJob(makeInsertVideoJob());
      await s.createJobV2(makeJob(vj.id));
      assertEqual(await s.deleteJobV2(vj.id), true, 'Job facet deleted');
      assertUndefined(await s.getJobV2(vj.id), 'Job facet gone');
      assertEqual(await s.getVideoJob(vj.id), vj, 'VideoJob facet survives');
    },
  },
  {
    name: 'deleteJobV2 cascades ai_runs',
    fn: async (s) => {
      await s.createJobV2(makeJob('dj-casc'));
      await s.addAiRun('dj-casc', makeAiRun('1'));
      await s.addAiRun('dj-casc', makeAiRun('2'));
      assertEqual(await s.deleteJobV2('dj-casc'), true, 'job deleted');
      assertEqual(await s.listAiRuns('dj-casc'), [], 'ai_runs cascaded away');
      assertUndefined(await s.getAiRun('dj-casc', '1'), 'run 1 gone');
    },
  },
];

// ── Backends ─────────────────────────────────────────────────────────────

interface Backend {
  label: string;
  fresh: () => Promise<IStorage>;
}

async function runBackend(backend: Backend): Promise<number> {
  currentSuite = backend.label;
  const before = failures.length;
  let ran = 0;
  for (const t of tests) {
    currentTest = t.name;
    let s: IStorage;
    try {
      s = await backend.fresh();
    } catch (err) {
      fail(`fresh() threw: ${(err as Error).message}`);
      continue;
    }
    try {
      await t.fn(s);
      ran++;
    } catch (err) {
      fail(`threw: ${(err as Error).stack ?? (err as Error).message}`);
    }
  }
  const suiteFailures = failures.length - before;
  console.log(
    `  ${backend.label}: ${ran}/${tests.length} cases ran, ` +
      `${suiteFailures === 0 ? 'PASS' : `${suiteFailures} assertion failure(s)`}`,
  );
  return suiteFailures;
}

async function main(): Promise<void> {
  console.log('IStorage conformance harness\n');

  const backends: Backend[] = [
    { label: 'MemStorage', fresh: async () => new MemStorage() },
  ];

  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    // PgStorage's module imports ./db, which reads DATABASE_URL at load time.
    // Point it at the disposable test DB before the dynamic import.
    process.env.DATABASE_URL = testUrl;
    try {
      const { PgStorage } = await import('../server/pgStorage.ts');
      const { db } = await import('../server/db.ts');
      const { sql } = await import('drizzle-orm');
      const pg = new PgStorage();
      // Probe + per-case reset: TRUNCATE all three tables (CASCADE clears the
      // ai_runs / frame_processing_batches FKs in one shot).
      const truncate = async () => {
        await db.execute(
          sql`TRUNCATE TABLE jobs, ai_runs, frame_processing_batches CASCADE`,
        );
      };
      await truncate(); // fail fast if the schema isn't migrated
      backends.push({
        label: 'PgStorage',
        fresh: async () => {
          await truncate();
          return pg;
        },
      });
    } catch (err) {
      console.error(
        '\nPgStorage backend setup failed. Ensure TEST_DATABASE_URL points at a\n' +
          'reachable Postgres with the 0000 baseline migration applied\n' +
          '(npm run db:migrate against that DB first).\n',
      );
      console.error((err as Error).message);
      process.exit(1);
    }
  } else {
    console.log('  (TEST_DATABASE_URL unset — skipping PgStorage backend)\n');
  }

  let totalFailures = 0;
  for (const backend of backends) {
    totalFailures += await runBackend(backend);
  }

  console.log(`\n${assertions} assertions across ${backends.length} backend(s).`);
  if (totalFailures === 0) {
    console.log('ALL SUITES PASSED');
    process.exit(0);
  } else {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('conformance harness crashed:', err);
  process.exit(1);
});
