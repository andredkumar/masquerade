/**
 * Shared handler logic for template-mask/apply.
 *
 * Called from the canonical registration site:
 *   POST /api/jobs/:jobId/template-mask/apply  (routes.ts — canonical URL)
 *
 * (The legacy PATCH /internal/mask-processing/:jobId thin wrapper in index.ts
 *  that also delegated here was removed in Phase 4d-2.)
 *
 * This module is deliberately free of req/res — callers extract params from
 * the request and translate the result into an HTTP response.
 */

import { storage } from '../storage';
import { VideoProcessor } from '../services/videoProcessor';
import { TempFolderManager } from '../services/templateMaskFolderManager';
import { perfMark } from '../services/perf';
import { checkApplyMask } from '../services/applyGuard';

export type TemplateMaskApplyResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string };

/**
 * Validate inputs, persist mask/output settings, and fire off processing.
 *
 * @param jobId      Job to process
 * @param maskData   Mask shape from the drawing canvas
 * @param outputSettings  Output size / format config
 * @param rawSamplingFps  Optional frame-rate override (null = native)
 * @param io         Socket.IO server instance for progress events
 */
export async function applyTemplateMask(
  jobId: string,
  maskData: any,
  outputSettings: any,
  rawSamplingFps: unknown,
  io: any,
): Promise<TemplateMaskApplyResult> {
  // [PERF] Round 1 (§3.2 apply path). `ms_since_bg_extract_done` is omitted:
  // no bg-extraction completion timestamp is persisted on either job record,
  // so it is not derivable here (§3.2 allows omitting it).
  perfMark(jobId, 'apply.request');

  if (!maskData || !outputSettings) {
    return { ok: false, status: 400, error: 'maskData and outputSettings are required' };
  }

  // Sanitize samplingFps: null = native rate, positive number = fps filter.
  const samplingFps: number | null =
    typeof rawSamplingFps === 'number' && isFinite(rawSamplingFps) && rawSamplingFps > 0
      ? rawSamplingFps
      : null;

  const job = await storage.getVideoJob(jobId);
  if (!job) {
    return { ok: false, status: 404, error: 'Job not found' };
  }

  if (!io) {
    return { ok: false, status: 500, error: 'Socket.IO not available' };
  }

  const videoProcessor = new VideoProcessor(io);

  // Output Round 2 (R1): refuse a mask that blanks nothing or everything BEFORE anything is persisted — no job update,
  // no templateMask state, no files. A 422 here reaches the user as a message; an async refusal could not (TemplateMaskState
  // stores none).
  const guard = await checkApplyMask(videoProcessor, jobId, job, maskData);
  if (!guard.ok) {
    return { ok: false, status: guard.status, error: guard.error };
  }

  // Persist mask + output settings on the job
  await storage.updateVideoJob(jobId, { maskData, outputSettings });

  // Write Job.templateMask state so the hub tile shows "applying" immediately.
  // Wrapped in try/catch — must not block the existing flow.
  try {
    await storage.setTemplateMaskState(jobId, {
      status: 'applying',
      maskData,
      outputSettings,
      outputDir: TempFolderManager.getJobTempFolder(jobId),
      completedAt: null,
    });
  } catch (err) {
    console.error('Failed to set templateMask state to applying:', err);
  }

  if (job.jobType === 'images') {
    const fileList = job.fileList as any[];
    if (!fileList || fileList.length === 0) {
      return { ok: false, status: 400, error: 'No image files found in job' };
    }
    const imagePaths = fileList.map((file: any) => `uploads/${file.filename}`);
    videoProcessor
      .processImages(jobId, imagePaths, maskData, outputSettings)
      .catch((error) => console.error('Image processing error:', error));
  } else {
    videoProcessor
      .processVideo(jobId, job.filePath, maskData, outputSettings, samplingFps)
      .catch((error) => console.error('Video processing error:', error));
  }

  return { ok: true, jobId };
}
