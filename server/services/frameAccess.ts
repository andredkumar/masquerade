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
import { SPOKE_TEMPLATE_MASK_DIR, TEMP_EXTRACTED_DIR, UPLOADS_DIR, resolveWithinRoot } from './cleanup';

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
 * List the raw extracted frames for a job, sorted and deduped.
 *
 * Raw frames are written to `temp_extracted/<jobId>/frame_NNNNNN.png` by
 * `startBackgroundFrameExtraction` (Phase 4b-0 — replaces the volatile
 * `global.extractedFrames` in-memory store). This is a thin wrapper over
 * `listFrameFiles` that pins the base directory to `TEMP_EXTRACTED_DIR`, so
 * callers don't have to thread the raw-frame root through every read site.
 *
 * The same bounded `resolve + startsWith` guard applies. Returns
 * `{ dir, files: [] }` when the directory doesn't exist (frames swept or never
 * written) — callers should check `files.length`.
 *
 * NOTE: `processVideo`'s apply-time staging lives in the `_apply/` subdirectory
 * of the same job dir; the `.png` filter here ignores that subdirectory, so
 * this never returns transient apply-time frames.
 */
export async function listRawFrameFiles(
  jobId: string,
): Promise<{ dir: string; files: string[] }> {
  return listFrameFiles(jobId, TEMP_EXTRACTED_DIR);
}

/**
 * Content-Type for a frame file, derived from its extension.
 *
 * 2B addendum §A.2: masked frames are `.jpg` by default and `.png` only when
 * the user picked PNG, so the serving routes can no longer hardcode
 * `image/png`. Raw extracted frames are always PNG and unaffected. Unknown
 * extensions fall back to PNG, matching the pre-addendum behavior for the
 * `.png`-named JPEGs written by earlier deploys (browsers sniff content, so
 * those keep rendering for the rest of their retention window).
 */
export function mimeForFrameFile(filenameOrPath: string): string {
  const ext = path.extname(filenameOrPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
}

/**
 * One entry of `VideoJob.fileList`, narrowed from the record's `unknown`.
 *
 * Written by `imageUploadHandler` (routes.ts) from multer's per-file metadata:
 * `filename` is multer's random hash under `uploads/`, `originalName` is what
 * the user's browser called it, `type` is the browser-supplied mimetype.
 */
export interface ImageBatchEntry {
  filename: string;
  originalName?: string;
  type?: string;
}

/** Outcome of {@link resolveImageBatchFrame}; the caller maps kinds to statuses. */
export type ImageFrameResolution =
  | { ok: true; absPath: string; contentType: string }
  | { ok: false; kind: 'out_of_range' }   // → 404: no such frame in this batch
  | { ok: false; kind: 'missing_file' };  // → 410: entry exists, bytes are gone

/**
 * Browser-supplied mimetypes we are willing to echo back as `Content-Type`.
 *
 * `imageUpload.fileFilter` (routes.ts) admits a file when the mimetype is
 * allowed OR the filename ends in .png/.jpg/.jpeg — so `photo.png` uploaded
 * with `Content-Type: text/html` passes the filter and lands in `fileList`
 * with `type: 'text/html'`. Reflecting that verbatim would serve attacker
 * bytes as HTML from this app's own origin. Allowlist, then fall back to the
 * extension.
 */
const SERVABLE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

/**
 * Content-Type for an image-batch entry: the declared mimetype only if it is a
 * real image type, otherwise derived from the original filename's extension.
 */
function contentTypeForEntry(entry: ImageBatchEntry): string {
  const declared = typeof entry.type === 'string' ? entry.type.toLowerCase().trim() : '';
  if (SERVABLE_IMAGE_MIMES.has(declared)) {
    return declared === 'image/jpg' ? 'image/jpeg' : declared;
  }
  return mimeForFrameFile(entry.originalName ?? entry.filename);
}

/**
 * Resolve image-batch frame `frameIndex` to its original file in `uploads/`.
 *
 * Item 28. Image batches have no extraction step — multer writes
 * `uploads/<hash>` and `imageUploadHandler` creates the job at `status:'ready'`
 * — so `temp_extracted/<jobId>/` never exists and the frames endpoint's raw
 * branch has nothing to read. That is why every image job hit the trailing 410
 * and the whole image feature was unreachable: the canvas could not paint, so
 * the user could never draw a mask, so Apply never enabled.
 *
 * Indexed STRICTLY by `fileList` order, never by a directory listing.
 * `uploads/` interleaves every job's files, and `processImages` masks in
 * `fileList` order (videoProcessor.ts:827-846, `frameNumber = volumeStart + i`),
 * so `fileList[i]` IS by construction the source of masked output `i`. Sorting
 * the hashes would silently mis-pair the canvas with the output.
 *
 * The original bytes are served as-is: the canvas needs pixels, and a Sharp
 * round-trip on a 1-physical-core box is exactly the cost this path does not
 * need.
 *
 * `missing_file` is the `uploads/` 2 h retention sweep (UPLOADS_MAX_AGE_MS,
 * cleanup.ts:54 — the shortest window in the system, because it holds PHI).
 * Apply already fails the same way for such a job; this makes the canvas agree
 * with Apply rather than failing at minute zero.
 */
export async function resolveImageBatchFrame(
  fileList: unknown,
  frameIndex: number,
): Promise<ImageFrameResolution> {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) return { ok: false, kind: 'out_of_range' };
  if (!Array.isArray(fileList)) return { ok: false, kind: 'out_of_range' };
  if (frameIndex >= fileList.length) return { ok: false, kind: 'out_of_range' };

  const entry = fileList[frameIndex] as ImageBatchEntry | null | undefined;
  if (!entry || typeof entry.filename !== 'string' || !entry.filename) {
    return { ok: false, kind: 'out_of_range' };
  }

  // House rule for every jobId/filename boundary (cleanup.ts, 5B-1a). The
  // names are multer hashes, but a tampered record must not escape uploads/.
  // A refusal is "no such frame", not a 500 — never surface the boundary error.
  let absPath: string;
  try {
    absPath = resolveWithinRoot(UPLOADS_DIR, entry.filename);
  } catch {
    return { ok: false, kind: 'out_of_range' };
  }

  if (!(await frameExists(absPath))) return { ok: false, kind: 'missing_file' };

  return { ok: true, absPath, contentType: contentTypeForEntry(entry) };
}

/**
 * The 8-byte PNG IEND chunk that terminates every complete PNG file:
 *   length(0x00000000) + type("IEND") + CRC(0xAE426082)
 * A PNG whose write is still in flight has no IEND yet.
 */
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const PNG_IEND_TRAILER = PNG_IEND.subarray(4); // 49 45 4E 44 AE 42 60 82

/**
 * True if `buf` ends with the PNG IEND trailer — i.e. the file is a *complete*
 * PNG, not one caught mid-write.
 *
 * Round 2A race guard. `startBackgroundFrameExtraction` writes each batch's
 * frames with concurrent `fs.writeFile`s, and the frames endpoint may now read
 * `temp_extracted/<jobId>/` while that is still happening, so a read can land on
 * a partially written frame. Serving a truncated PNG would paint a half-frame on
 * the masking canvas; the caller treats "incomplete" as "not ready yet" (503).
 *
 * Buffer form so the route can reuse the read it already performs to serve the
 * body — no second read.
 */
export function isCompletePngBuffer(buf: Buffer): boolean {
  if (buf.length < PNG_IEND_TRAILER.length) return false;
  return buf.subarray(buf.length - PNG_IEND_TRAILER.length).equals(PNG_IEND_TRAILER);
}

/**
 * Path form of {@link isCompletePngBuffer}. Returns false (rather than throwing)
 * when the file is unreadable or gone — an unreadable frame is, for the
 * caller's purposes, simply not ready.
 */
export async function isCompletePng(absPath: string): Promise<boolean> {
  try {
    return isCompletePngBuffer(await fs.readFile(absPath));
  } catch {
    return false;
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
