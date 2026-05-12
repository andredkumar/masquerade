/**
 * Lightweight session cache for upload response data (firstFrame, videoMetadata).
 *
 * The upload response includes a base64-encoded first frame that the template
 * mask spoke needs as a canvas background. This cache persists across SPA route
 * changes and survives same-tab refreshes via sessionStorage.
 */

const FRAME_PREFIX = "masq_firstFrame_";
const META_PREFIX = "masq_meta_";

export function cacheUploadData(jobId: string, firstFrame: string, metadata: Record<string, unknown>) {
  try {
    sessionStorage.setItem(FRAME_PREFIX + jobId, firstFrame);
    sessionStorage.setItem(META_PREFIX + jobId, JSON.stringify(metadata));
  } catch {
    // sessionStorage full or unavailable — degrade gracefully
  }
}

export function getCachedFirstFrame(jobId: string): string | null {
  try {
    return sessionStorage.getItem(FRAME_PREFIX + jobId);
  } catch {
    return null;
  }
}

export function getCachedMetadata(jobId: string): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(META_PREFIX + jobId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
