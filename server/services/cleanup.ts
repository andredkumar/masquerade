/**
 * Disk-cleanup service for the three transient directories Masquerade writes to:
 *
 *   uploads/         — original user uploads (multer dest). Contain PHI; shortest TTL.
 *   temp_extracted/  — raw frames pulled out of a video before template-masking.
 *   temp_processed/  — masked output frames consumed by the ZIP/download builder.
 *
 * Every write happens at known absolute paths (resolved once at module load), so
 * every delete in this file is bounded by `safeDelete` to its allowed root —
 * a path-traversal attempt cannot reach files outside these three directories.
 *
 * Lifetime:
 *   - On every server start, `purgeUploadsOnStartup()` wipes uploads/ entirely.
 *     Safe because storage is in-memory (server/storage.ts:116 uses MemStorage)
 *     so any upload from a previous process is orphaned.
 *   - `startCleanupScheduler()` runs an hourly cron (minute 0) that sweeps
 *     each directory for entries older than its retention window.
 *   - Request handlers and background tasks delete eagerly via `deleteUploadFile`
 *     and `cleanupJobArtifacts`; the cron is the safety net for anything missed.
 *   - SIGTERM also runs each sweep with maxAgeMs=0 (delete everything).
 *
 * Retention windows are hard-coded constants here so they're easy to tune in
 * one place. The 2h window on uploads/ assumes no auth; once auth lands the
 * window will need to be reworked so authenticated users can keep their work.
 */

import path from 'path';
import { promises as fs } from 'fs';
import * as cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';

// ── Path constants — resolved ONCE at module load ────────────────────────
// All deletes are bounded against these absolute paths.
export const UPLOADS_DIR        = path.resolve(process.cwd(), 'uploads');
export const TEMP_EXTRACTED_DIR = path.resolve(process.cwd(), 'temp_extracted');
export const TEMP_PROCESSED_DIR = path.resolve(process.cwd(), 'temp_processed');

// ── Retention windows ────────────────────────────────────────────────────
export const UPLOADS_MAX_AGE_MS        = 2  * 60 * 60 * 1000;   // 2h  — PHI, shortest
export const TEMP_EXTRACTED_MAX_AGE_MS = 6  * 60 * 60 * 1000;   // 6h
export const TEMP_PROCESSED_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 24h — user may still be downloading

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Validate that `absPath` is inside `allowedRoot` and delete it (file or dir).
 *
 * Path traversal protection: both inputs are passed through `path.resolve`
 * to canonicalize (eliminate `..` segments and symlink-relative parts that
 * resolve()` can normalize). The resolved absPath must start with the
 * resolved allowedRoot + path.sep (or equal allowedRoot itself).
 *
 * Idempotent: a missing target is treated as success (force: true).
 */
export async function safeDelete(absPath: string, allowedRoot: string): Promise<void> {
  const resolvedTarget = path.resolve(absPath);
  const resolvedRoot = path.resolve(allowedRoot);

  // Allow the root itself, or any descendant. Use path.sep to avoid the
  // `/foo/bar-evil` ⊂ `/foo/bar` confusion (`/foo/bar-evil`.startsWith(`/foo/bar`) === true).
  const isRoot = resolvedTarget === resolvedRoot;
  const isDescendant = resolvedTarget.startsWith(resolvedRoot + path.sep);
  if (!isRoot && !isDescendant) {
    throw new Error(
      `safeDelete refused: ${resolvedTarget} is not inside ${resolvedRoot}`
    );
  }

  await fs.rm(resolvedTarget, { recursive: true, force: true });
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Delete an uploaded file by its on-disk path. Idempotent.
 *
 * Accepts the path that was stored in `req.file.path` / `job.filePath`. Routes
 * the delete through `safeDelete` bounded to UPLOADS_DIR, so a tampered
 * `job.filePath` can never escape the uploads/ tree.
 *
 * Errors are logged but never re-thrown — call sites use this in finally
 * blocks and catch-handlers; cleanup must never break the user's request.
 */
export async function deleteUploadFile(uploadPath: string | null | undefined): Promise<void> {
  if (!uploadPath) return;
  try {
    await safeDelete(uploadPath, UPLOADS_DIR);
  } catch (err) {
    console.warn(`⚠️  deleteUploadFile failed for ${uploadPath}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Delete both the staging dir (temp_extracted/<jobId>/) and the masked-output
 * dir (temp_processed/<jobId>/) for a given job. Idempotent.
 *
 * Called after the user successfully downloads the ZIP, and from background
 * task `.catch` handlers. Each delete is bounded to its respective allowed
 * root so a tampered jobId cannot break out of the directory tree.
 */
export async function cleanupJobArtifacts(jobId: string): Promise<void> {
  if (!jobId) return;
  const extractedPath = path.join(TEMP_EXTRACTED_DIR, jobId);
  const processedPath = path.join(TEMP_PROCESSED_DIR, jobId);

  try {
    await safeDelete(extractedPath, TEMP_EXTRACTED_DIR);
  } catch (err) {
    console.warn(`⚠️  cleanupJobArtifacts(${jobId}) failed on temp_extracted:`, err instanceof Error ? err.message : err);
  }

  try {
    await safeDelete(processedPath, TEMP_PROCESSED_DIR);
  } catch (err) {
    console.warn(`⚠️  cleanupJobArtifacts(${jobId}) failed on temp_processed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Sweep `dir` for immediate children whose mtime is older than `maxAgeMs`.
 *
 * - Each delete is wrapped individually in try/catch so a single bad entry
 *   doesn't abort the rest of the sweep.
 * - `maxAgeMs === 0` means "delete everything regardless of age" (used by
 *   SIGTERM and by /scripts/cleanup-now.ts when the operator wants a full wipe).
 * - If `dir` itself doesn't exist, the sweep is a no-op (returns zero counters).
 *
 * Returns counters useful for logging and for the dry-run flag.
 */
export async function sweepDirectory(
  dir: string,
  maxAgeMs: number,
  opts: { dryRun?: boolean } = {}
): Promise<{ scanned: number; deleted: number; freedBytes: number; errors: number }> {
  const dryRun = !!opts.dryRun;
  const counters = { scanned: 0, deleted: 0, freedBytes: 0, errors: 0 };

  const resolvedDir = path.resolve(dir);
  let entries: string[];
  try {
    entries = await fs.readdir(resolvedDir);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return counters; // dir doesn't exist — nothing to sweep
    counters.errors += 1;
    console.warn(`⚠️  sweepDirectory(${resolvedDir}) readdir failed:`, err instanceof Error ? err.message : err);
    return counters;
  }

  const now = Date.now();
  for (const name of entries) {
    counters.scanned += 1;
    const entryPath = path.join(resolvedDir, name);
    try {
      const st = await fs.stat(entryPath);
      const ageMs = now - st.mtimeMs;
      if (maxAgeMs > 0 && ageMs < maxAgeMs) continue;

      // Compute approximate freed bytes (best effort — for directories we
      // walk one level deep; deeper sizes are skipped to keep this cheap).
      let bytes = 0;
      if (st.isFile()) {
        bytes = st.size;
      } else if (st.isDirectory()) {
        try {
          const children = await fs.readdir(entryPath);
          for (const c of children) {
            try {
              const cs = await fs.stat(path.join(entryPath, c));
              if (cs.isFile()) bytes += cs.size;
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }

      if (dryRun) {
        console.log(`[dry-run] would delete ${entryPath} (age ${(ageMs / 1000 / 60).toFixed(1)}min, ~${bytes} bytes)`);
        counters.deleted += 1;
        counters.freedBytes += bytes;
        continue;
      }

      await safeDelete(entryPath, resolvedDir);
      counters.deleted += 1;
      counters.freedBytes += bytes;
    } catch (err) {
      counters.errors += 1;
      console.warn(`⚠️  sweepDirectory: failed to delete ${entryPath}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `🧹 sweepDirectory ${path.basename(resolvedDir)} — ` +
    `scanned: ${counters.scanned}, deleted: ${counters.deleted}, freed: ${(counters.freedBytes / 1024).toFixed(1)} KB, errors: ${counters.errors}` +
    (dryRun ? ' (dry-run)' : '')
  );
  return counters;
}

/**
 * Wipe uploads/ entirely on every boot.
 *
 * MemStorage (server/storage.ts) holds zero job records on a fresh process,
 * so every file at this path is orphaned by definition — no live request
 * handler can reference it. Deleting them all on startup prevents the
 * accumulation pattern the audit identified.
 */
export async function purgeUploadsOnStartup(): Promise<void> {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
  } catch {
    // mkdir failures are non-fatal — the dir might already exist
  }

  let entries: string[];
  try {
    entries = await fs.readdir(UPLOADS_DIR);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      console.log('🧹 Startup purge: uploads/ does not exist yet, nothing to remove');
      return;
    }
    console.warn('⚠️  purgeUploadsOnStartup readdir failed:', err instanceof Error ? err.message : err);
    return;
  }

  let removed = 0;
  let errors = 0;
  for (const name of entries) {
    const entryPath = path.join(UPLOADS_DIR, name);
    try {
      await safeDelete(entryPath, UPLOADS_DIR);
      removed += 1;
    } catch (err) {
      errors += 1;
      console.warn(`⚠️  purgeUploadsOnStartup: failed to delete ${entryPath}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `🧹 Startup purge: removed ${removed} files from uploads/` +
    (errors > 0 ? ` (${errors} failed)` : '')
  );
}

/**
 * Register the hourly cleanup cron. The job runs at minute 0 of every hour
 * and never throws — every step is individually try/wrapped so a transient
 * filesystem error cannot propagate up and crash the Node process.
 *
 * Returns the scheduled cron task so callers can cancel it for tests.
 */
export function startCleanupScheduler(): ScheduledTask {
  console.log('🧹 Cleanup scheduler armed (runs every hour at :00)');
  const task = cron.schedule('0 * * * *', async () => {
    try {
      console.log('🧹 Hourly sweep starting…');
      try { await sweepDirectory(UPLOADS_DIR, UPLOADS_MAX_AGE_MS); }
      catch (err) { console.warn('⚠️  hourly sweep uploads failed:', err instanceof Error ? err.message : err); }

      try { await sweepDirectory(TEMP_EXTRACTED_DIR, TEMP_EXTRACTED_MAX_AGE_MS); }
      catch (err) { console.warn('⚠️  hourly sweep temp_extracted failed:', err instanceof Error ? err.message : err); }

      try { await sweepDirectory(TEMP_PROCESSED_DIR, TEMP_PROCESSED_MAX_AGE_MS); }
      catch (err) { console.warn('⚠️  hourly sweep temp_processed failed:', err instanceof Error ? err.message : err); }
    } catch (err) {
      console.warn('⚠️  hourly cleanup job failed at top level:', err instanceof Error ? err.message : err);
    }
  });
  return task;
}
