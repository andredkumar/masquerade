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

  if (!io) {
    return { ok: false, status: 500, error: 'Socket.IO not available' };
  }

  const videoProcessor = new VideoProcessor(io);

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
