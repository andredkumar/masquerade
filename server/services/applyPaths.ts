/**
 * Pure, idempotent path helpers for the Phase 4b-0 raw-frame / apply-time
 * staging layout. Extracted so the path math has a single source of truth and
 * can be unit-tested without ffmpeg, a GPU, or the rest of videoProcessor.
 *
 * Layout (all under temp_extracted/, which is `TEMP_EXTRACTED_DIR`):
 *
 *   temp_extracted/<jobId>/                 ← persistent raw frames (frame_*.png)
 *   temp_extracted/<jobId>/_apply/          ← ISOLATED apply-time re-extraction
 *
 * The `_apply` subdir is sandboxed away from the persistent raw frames because
 * `extractAllFramesSequential` reads back every `frame_*.png` in its output dir
 * to size the frame set; re-extracting at apply time into the raw-frame dir
 * would collide with (and could clobber) the persistent frames.
 *
 * Every function here is a pure string transform of `jobId` — it derives the
 * path fresh from `TEMP_EXTRACTED_DIR` on each call and never reads from or
 * writes any persisted state. Calling `applyStagingDir(jobId)` N times always
 * yields the identical `temp_extracted/<jobId>/_apply` string, so a repeated
 * apply (the redo loop) can never accumulate nested `<jobId>/<jobId>/` levels.
 *
 * The only effectful export is `cleanupApplyStaging`, a deliberately narrow
 * delete that is provably incapable of touching the persistent raw frames.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { TEMP_EXTRACTED_DIR, SPOKE_AI_DIR, safeDelete, resolveWithinRoot } from './cleanup';

/** Subdir name for isolated apply-time frame re-extraction. */
export const APPLY_SUBDIR = '_apply' as const;

/**
 * Tripwire: throw if any two ADJACENT path segments are identical. The Phase
 * 4b-0 corruption symptom was nested `<jobId>/<jobId>/` directories; a server
 * UUID jobId can never legitimately sit directly inside an identically-named
 * dir, so equal-adjacent segments are always a re-suffixing bug. Call this at
 * every mkdir site that joins a jobId/runId so a regression crashes loudly and
 * locally instead of silently corrupting state.
 */
export function assertNoSegmentDoubling(absPath: string): void {
  const segs = absPath.split(path.sep).filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === segs[i - 1]) {
      throw new Error(
        `path-doubling tripwire: '${segs[i]}${path.sep}${segs[i]}' in ${absPath}`,
      );
    }
  }
}

/**
 * Absolute path to a job's PERSISTENT raw-frame directory:
 *   temp_extracted/<jobId>
 *
 * Pure + idempotent: derived fresh from `TEMP_EXTRACTED_DIR` each call.
 */
export function rawFramesDir(jobId: string): string {
  // resolveWithinRoot validates jobId (non-empty, single segment, no traversal)
  // and confirms containment under TEMP_EXTRACTED_DIR. Identical output to
  // path.join(...) for a valid UUID.
  return resolveWithinRoot(TEMP_EXTRACTED_DIR, jobId);
}

/**
 * Absolute path to a job's ISOLATED apply-time staging directory:
 *   temp_extracted/<jobId>/_apply
 *
 * Pure + idempotent. Re-deriving from constants (never from job state) is what
 * guarantees no re-suffixing across repeated applies.
 */
export function applyStagingDir(jobId: string): string {
  // Guarded jobId boundary; APPLY_SUBDIR is a constant single segment.
  return resolveWithinRoot(TEMP_EXTRACTED_DIR, jobId, APPLY_SUBDIR);
}

/**
 * Delete a job's apply-time staging dir (`temp_extracted/<jobId>/_apply`) and
 * nothing else. Hardened so it is *provably* unable to delete the parent
 * raw-frame dir or any `frame_*.png`:
 *
 *   1. The target is derived from `applyStagingDir(jobId)` (not caller input).
 *   2. We assert the resolved target ends with `${sep}_apply` before deleting —
 *      so even a degenerate jobId can't collapse the target onto the parent.
 *   3. The delete is delegated to `safeDelete` bounded to `rawFramesDir(jobId)`,
 *      which independently rejects any target outside that job's own dir.
 *
 * Idempotent (missing dir is a no-op via `safeDelete`'s `force: true`).
 */
export async function cleanupApplyStaging(jobId: string): Promise<void> {
  const target = path.resolve(applyStagingDir(jobId));

  // Guard: the resolved path must be the `_apply` leaf. This is the assertion
  // that makes hitting the parent raw-frame dir impossible.
  if (!target.endsWith(path.sep + APPLY_SUBDIR)) {
    throw new Error(
      `cleanupApplyStaging refused: resolved target ${target} is not an ${APPLY_SUBDIR} dir`,
    );
  }

  // Second, independent bound: target must live inside this job's raw-frame dir.
  await safeDelete(target, rawFramesDir(jobId));
}

/**
 * Prepare a job's apply-time staging dir for a FRESH extraction and return its
 * absolute path. Makes `processVideo` idempotent across re-invocation (the redo
 * loop / a killed-then-retried run):
 *
 *   1. Delete any residue a prior run left in `_apply` (a run interrupted before
 *      its `finally` cleanup completed leaves stale `frame_*.png` here).
 *   2. Recreate `_apply` empty.
 *
 * Without step 1, `extractAllFramesSequential` re-extracts into a dir that still
 * holds the prior run's frames and then `readdir`s the whole dir to size the
 * frame set — reading back stale frames (the corruption vector). Clearing first
 * guarantees the readback contains only this run's frames. The persistent raw
 * frames in the PARENT dir are never touched (the delete is `_apply`-bounded).
 */
export async function prepareCleanApplyStaging(jobId: string): Promise<string> {
  // jobId is validated inside cleanupApplyStaging → applyStagingDir (resolveWithinRoot).
  // Step 1: clear any residue from a prior (possibly interrupted) run. This is
  // the load-bearing line — without it the extractor reads back stale frames.
  await cleanupApplyStaging(jobId);
  // Step 2: recreate the staging dir empty.
  const staging = applyStagingDir(jobId);
  assertNoSegmentDoubling(staging);
  // Tripwire (kickoff §149): log the literal resolved mkdir path so a re-suffixing
  // regression is visible in the run log, not just caught by the assertion above.
  console.log(`🗂️  [apply-staging] mkdir ${path.resolve(staging)}`);
  await fs.mkdir(staging, { recursive: true });
  return staging;
}

/**
 * Absolute path to a single AI run's output dir: `spokes/ai/<jobId>/<runId>`.
 * Pure helper + tripwire — HYGIENE ONLY. The `<jobId>/<runId>` layout was always
 * correct (runId is a distinct UUID, not a doubled jobId); this just gives the
 * AI handler the same doubling tripwire the apply path has.
 */
export function aiRunDir(jobId: string, runId: string): string {
  // resolveWithinRoot validates BOTH jobId and runId (non-empty single segments,
  // no traversal) and confirms containment under SPOKE_AI_DIR.
  const dir = resolveWithinRoot(SPOKE_AI_DIR, jobId, runId);
  assertNoSegmentDoubling(dir);
  return dir;
}
