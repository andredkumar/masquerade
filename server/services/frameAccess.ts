/**
 * Read-only filesystem helpers for the frame viewer and download/inference
 * endpoints.
 *
 * Every path operation here is bounded against the caller-supplied `baseDir`
 * (defaulting to `SPOKE_TEMPLATE_MASK_DIR`) using the same
 * `path.resolve + startsWith` pattern the cleanup module uses. A tampered
 * jobId or frame index can never escape the allowed directory tree, even via
 * `..` segments or absolute-path injections.
 *
 * Nothing in this file writes to disk. All exports are pure read operations.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { SPOKE_TEMPLATE_MASK_DIR } from './cleanup';

/**
 * Resolve the absolute path of a single processed frame and validate it sits
 * inside `baseDir`. Throws on traversal or invalid frame index.
 *
 * Filename convention matches `processVideo`'s save loop:
 *   spokes/template_mask/<jobId>/frame_NNNNNN.<ext>
 *
 * Since the on-disk extension may be png OR jpg (depends on outputSettings.format),
 * the caller can pass an explicit ext or we'll probe both.
 */
export async function resolveFramePath(
  jobId: string,
  frameIndex: number,
  baseDir: string = SPOKE_TEMPLATE_MASK_DIR,
): Promise<string | null> {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('resolveFramePath: jobId must be a non-empty string');
  }
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error(`resolveFramePath: frameIndex must be a non-negative integer (got ${frameIndex})`);
  }

  const resolvedBase = path.resolve(baseDir);
  const jobDir = path.resolve(resolvedBase, jobId);

  // Path-traversal guard: a maliciously crafted jobId like "../../etc" would
  // resolve outside the allowed root. Reject unless the resolved path is a
  // descendant of the allowed root.
  const rootWithSep = resolvedBase + path.sep;
  if (!jobDir.startsWith(rootWithSep)) {
    throw new Error(`resolveFramePath refused: ${jobDir} is not inside ${resolvedBase}`);
  }

  const padded = String(frameIndex).padStart(6, '0');
  // Try png first (the common case post-rewrite), then jpg for legacy/image-batch jobs.
  for (const ext of ['png', 'jpg', 'jpeg'] as const) {
    const candidate = path.join(jobDir, `frame_${padded}.${ext}`);
    if (await frameExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Probe a path for existence + readability without throwing on ENOENT.
 */
export async function frameExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if spokes/template_mask/<jobId>/ (or `baseDir/<jobId>/`) exists.
 * Used by viewer-info to decide between 410 (retention swept) and 200
 * (frames available).
 */
export async function tempDirExists(
  jobId: string,
  baseDir: string = SPOKE_TEMPLATE_MASK_DIR,
): Promise<boolean> {
  const resolvedBase = path.resolve(baseDir);
  const jobDir = path.resolve(resolvedBase, jobId);
  const rootWithSep = resolvedBase + path.sep;
  if (!jobDir.startsWith(rootWithSep)) return false;
  try {
    const stat = await fs.stat(jobDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Count the frame_*.png/jpg/jpeg files in a job's processed directory.
 * Returns 0 if the directory doesn't exist. Sort + dedupe to match the
 * canonical numbering used by the inference loop and the download route.
 */
export async function countFrames(
  jobId: string,
  baseDir: string = SPOKE_TEMPLATE_MASK_DIR,
): Promise<number> {
  const resolvedBase = path.resolve(baseDir);
  const jobDir = path.resolve(resolvedBase, jobId);
  const rootWithSep = resolvedBase + path.sep;
  if (!jobDir.startsWith(rootWithSep)) return 0;
  try {
    const entries = await fs.readdir(jobDir);
    const filtered = entries.filter(f => /\.(png|jpe?g)$/i.test(f));
    return Array.from(new Set(filtered)).length;
  } catch {
    return 0;
  }
}

/**
 * List all image frame filenames in a job's directory, sorted and deduped.
 *
 * Returns the absolute directory path and the sorted filename list. Used by
 * the download endpoint and AI inference endpoint to enumerate frames without
 * hardcoding a directory path.
 *
 * Returns `{ dir, files: [] }` if the directory doesn't exist (caller
 * should check `files.length`).
 */
export async function listFrameFiles(
  jobId: string,
  baseDir: string = SPOKE_TEMPLATE_MASK_DIR,
): Promise<{ dir: string; files: string[] }> {
  const resolvedBase = path.resolve(baseDir);
  const jobDir = path.resolve(resolvedBase, jobId);
  const rootWithSep = resolvedBase + path.sep;
  if (!jobDir.startsWith(rootWithSep)) return { dir: jobDir, files: [] };
  try {
    const raw = await fs.readdir(jobDir);
    const filtered = raw.filter(f => /\.(png|jpe?g)$/i.test(f));
    const files = Array.from(new Set(filtered)).sort();
    return { dir: jobDir, files };
  } catch {
    return { dir: jobDir, files: [] };
  }
}

/**
 * Deterministic color for a labelId. FNV-1a hash → HSL hue with fixed
 * saturation/lightness so colors stay readable on both light and dark
 * backgrounds. The same labelId always renders the same color across
 * server reloads and across endpoints.
 */
export function colorForLabelId(labelId: string): string {
  let h = 2166136261;
  for (let i = 0; i < labelId.length; i++) {
    h ^= labelId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 72% 52%)`;
}
