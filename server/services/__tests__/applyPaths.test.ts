/**
 * GPU-free regression test for the Phase 4b-0 apply-time path layout.
 *
 * This is the test the FIX kickoff requires: it exercises the path-resolution
 * and cleanup logic TWICE for a single jobId (simulating the redo loop that
 * was alleged to nest `<jobId>/<jobId>/` and delete the persistent raw frames),
 * using only the real filesystem under a tmp dir — no ffmpeg, no GPU, no Sharp.
 *
 * It pins TEMP_EXTRACTED_DIR to a throwaway tmp directory by setting cwd-derived
 * paths through the module's own constant. Because the helpers derive every path
 * from `TEMP_EXTRACTED_DIR` (resolved at module load from process.cwd()), we run
 * the whole test inside a tmp cwd so the constant points at a sandbox.
 *
 * Run:  npx tsx server/services/__tests__/applyPaths.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

// The cleanup module resolves TEMP_EXTRACTED_DIR from process.cwd() at import
// time. Switch cwd to a fresh tmp dir BEFORE importing so the constant — and
// therefore every helper path — lands inside our sandbox.
const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'masq-applypaths-'));
const originalCwd = process.cwd();
process.chdir(sandboxRoot);

const { rawFramesDir, applyStagingDir, cleanupApplyStaging, prepareCleanApplyStaging, assertNoSegmentDoubling, APPLY_SUBDIR } =
  await import('../applyPaths');
const { TEMP_EXTRACTED_DIR } = await import('../cleanup');

const JOB_ID = 'job-abc-123';
const JOB_ID_RESIDUE = 'job-residue-999';

function frameName(i: number): string {
  return `frame_${String(i).padStart(6, '0')}.png`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test('applyStagingDir is idempotent across repeated applies (no nesting)', () => {
  const first = applyStagingDir(JOB_ID);
  const second = applyStagingDir(JOB_ID);
  const expected = path.join(TEMP_EXTRACTED_DIR, JOB_ID, APPLY_SUBDIR);

  assert.equal(first, expected, 'first call must be temp_extracted/<jobId>/_apply');
  assert.equal(second, first, 'second call must equal the first (idempotent)');

  // It must NOT contain a doubled jobId segment.
  assert.equal(
    first.includes(`${JOB_ID}${path.sep}${JOB_ID}`),
    false,
    'staging path must never contain <jobId>/<jobId>',
  );
});

test('rawFramesDir is the single-level parent of the staging dir', () => {
  const raw = rawFramesDir(JOB_ID);
  const staging = applyStagingDir(JOB_ID);
  assert.equal(raw, path.join(TEMP_EXTRACTED_DIR, JOB_ID));
  assert.equal(path.dirname(staging), raw, '_apply must sit directly under the raw-frame dir');
});

test('twice-run cleanup removes _apply but persistent raw frames survive', async () => {
  const raw = rawFramesDir(JOB_ID);
  const staging = applyStagingDir(JOB_ID);
  const persistentFrame = path.join(raw, 'frame_000001.png');

  // Simulate two full apply cycles.
  for (let run = 1; run <= 2; run++) {
    // Background extractor wrote a persistent raw frame; apply pass staged
    // re-extracted frames into _apply.
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(persistentFrame, `persistent-run-${run}`);
    await fs.writeFile(path.join(staging, 'frame_000001.png'), 'transient');

    await cleanupApplyStaging(JOB_ID);

    // _apply gone, persistent frame intact, raw dir intact, no nesting.
    assert.equal(await exists(staging), false, `run ${run}: _apply must be deleted`);
    assert.equal(await exists(persistentFrame), true, `run ${run}: persistent frame must survive`);
    assert.equal(await exists(raw), true, `run ${run}: raw-frame dir must survive`);
    assert.equal(
      await exists(path.join(raw, JOB_ID)),
      false,
      `run ${run}: no temp_extracted/<jobId>/<jobId> nesting`,
    );
  }
});

test('cleanupApplyStaging never deletes the parent raw-frame dir', async () => {
  const raw = rawFramesDir(JOB_ID);
  await fs.mkdir(raw, { recursive: true });
  const sentinel = path.join(raw, 'frame_000001.png');
  await fs.writeFile(sentinel, 'keep-me');

  // Even with no _apply present, cleanup is a no-op on the parent.
  await cleanupApplyStaging(JOB_ID);
  assert.equal(await exists(sentinel), true, 'parent frame must remain after no-op cleanup');
  assert.equal(await exists(raw), true, 'parent dir must remain after no-op cleanup');
});

test('run-2 re-extraction with run-1 RESIDUE present: readback is run-2 frames only, persistent frames survive, no nesting', async () => {
  const raw = rawFramesDir(JOB_ID_RESIDUE);
  const staging = applyStagingDir(JOB_ID_RESIDUE);

  // ── Run 1 was INTERRUPTED before its finally cleanup completed, so it left a
  //    populated _apply behind (the precondition that the old test never set up).
  //    Stale set is HIGHER (200) than run-2's count so leftover high-numbered
  //    frames are the tell-tale corruption if the readback sees them.
  await fs.mkdir(staging, { recursive: true });
  for (let i = 1; i <= 200; i++) {
    await fs.writeFile(path.join(staging, frameName(i)), `stale-run1-${i}`);
  }
  // Persistent raw frames live in the PARENT dir and must survive re-apply.
  await fs.mkdir(raw, { recursive: true });
  for (let i = 1; i <= 164; i++) {
    await fs.writeFile(path.join(raw, frameName(i)), `persistent-${i}`);
  }

  // ── Run 2: production staging-prep seam under test. ────────────────────────
  const stagingRun2 = await prepareCleanApplyStaging(JOB_ID_RESIDUE);

  // Simulate ffmpeg writing run-2's 164 frames into the prepared staging dir.
  for (let i = 1; i <= 164; i++) {
    await fs.writeFile(path.join(stagingRun2, frameName(i)), `run2-${i}`);
  }

  // Readback EXACTLY as frameExtractor.extractAllFramesSequential does it.
  const all = await fs.readdir(stagingRun2);
  const created = all.filter(f => /^frame_\d+\.png$/.test(f)).sort();

  // (c) The readback must contain ONLY run-2's 164 frames — NOT 200. With stale
  //     residue left in place this is 200 (RED); after clear-before-extract, 164.
  assert.equal(
    created.length,
    164,
    `staging readback must be run-2's 164 frames, got ${created.length} (stale residue leaked in)`,
  );
  assert.equal(
    stagingRun2,
    path.join(TEMP_EXTRACTED_DIR, JOB_ID_RESIDUE, APPLY_SUBDIR),
    'staging path must be temp_extracted/<jobId>/_apply on run 2',
  );

  // (a) No temp_extracted/<jobId>/<jobId> nesting.
  assert.equal(
    await exists(path.join(raw, JOB_ID_RESIDUE)),
    false,
    'no temp_extracted/<jobId>/<jobId> nesting',
  );

  // (b) Persistent raw frames survive run-2 prep AND a subsequent cleanup.
  await cleanupApplyStaging(JOB_ID_RESIDUE);
  for (let i = 1; i <= 164; i++) {
    assert.equal(
      await exists(path.join(raw, frameName(i))),
      true,
      `persistent frame ${i} must survive run-2 cleanup`,
    );
  }
  assert.equal(await exists(staging), false, 'run 2: _apply must be cleaned after cleanup');
});

test('cleanupApplyStaging rejects an empty jobId', async () => {
  await assert.rejects(
    () => cleanupApplyStaging(''),
    /jobId must be a non-empty string/,
  );
});

// ── Tripwire self-test ──────────────────────────────────────────────────────
// The repro test above proves the stale-readback fix; it does NOT exercise the
// nesting symptom (no run-2 op in the current source produces <jobId>/<jobId>).
// The tripwire is the safety net for that class, so it must itself be proven to
// fire. These two tests give it the same red-green treatment: a synthetic
// equal-adjacent-segment path MUST throw; a correct non-doubled path MUST pass.
// (RED: with the assertion neutered, the THROWS case fails. GREEN: intact, both
// pass.)

test('tripwire assertNoSegmentDoubling THROWS on synthetic <jobId>/<jobId> nesting', () => {
  const nested = path.join(TEMP_EXTRACTED_DIR, JOB_ID, JOB_ID, APPLY_SUBDIR);
  // Sanity: the synthetic path really does contain the doubled segment.
  assert.equal(
    nested.includes(`${JOB_ID}${path.sep}${JOB_ID}`),
    true,
    'fixture must contain an equal-adjacent <jobId>/<jobId> pair',
  );
  assert.throws(
    () => assertNoSegmentDoubling(nested),
    /path-doubling tripwire/,
    'tripwire must throw on equal-adjacent path segments',
  );
});

test('tripwire assertNoSegmentDoubling PASSES a correct non-doubled path', () => {
  const correct = path.join(TEMP_EXTRACTED_DIR, JOB_ID, APPLY_SUBDIR);
  assert.doesNotThrow(
    () => assertNoSegmentDoubling(correct),
    'tripwire must accept a well-formed temp_extracted/<jobId>/_apply path',
  );
});

test.after(async () => {
  process.chdir(originalCwd);
  await fs.rm(sandboxRoot, { recursive: true, force: true });
});
