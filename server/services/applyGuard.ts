/**
 * Output Round 2 (R1) — the server refuses an apply whose mask blanks nothing, or everything.
 *
 * Two client bugs in one week (O6: Clear / Erase All sent an empty mask; 1a: a Remove export after a Keep flip carried
 * black shapes) produced a "masked" download of unmasked frames, and the server accepted both. This is the rule that
 * stops the class: build the mask at the job's frame dimensions with the SAME code the apply uses
 * (`VideoProcessor.countMaskedPixels` → `createMaskRgbaBuffer`, counting alpha > 0 — the test `buildApplyMask` uses) and
 * refuse the two bounds. Everything in between proceeds exactly as before.
 *
 * Both apply entry points call `checkApplyMask`: `applyTemplateMask` (the canonical route) and the legacy
 * `POST /api/videos/:jobId/process` (guarded until 7B-1 removes it). A refusal persists nothing.
 * See docs/refactor/OUTPUT_ROUND2_SIGNOFF.md §3.1.
 */
import Sharp from 'sharp';
import { listRawFrameFiles } from './frameAccess';
import { FrameExtractor } from './frameExtractor';
import { perfMark } from './perf';
import type { VideoProcessor } from './videoProcessor';

export type RefusalReason = 'mask_blanks_nothing' | 'mask_blanks_everything' | 'unverifiable';
export type DimsSource = 'frame0' | 'image0' | 'job';

export const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  mask_blanks_nothing:
    "This mask doesn't remove anything. Draw over what should be removed, or switch to Keep and draw what should be kept.",
  mask_blanks_everything: 'This mask removes the whole frame. Nothing would be left in the output.',
  unverifiable: "Couldn't check this mask. Reload the page and try again.",
};

export type ApplyCheckResult =
  | { ok: true }
  | { ok: false; status: 422; reason: RefusalReason; error: string };

/** Pure: the accept / refuse decision on the two counts. */
export function decideApply(masked: number, total: number): null | 'mask_blanks_nothing' | 'mask_blanks_everything' {
  if (masked <= 0) return 'mask_blanks_nothing';
  if (masked >= total) return 'mask_blanks_everything';
  return null;
}

type Dims = { w: number; h: number; source: DimsSource };

/**
 * Where the dimensions come from. Video / DICOM: raw frame 0 on disk (a header read; the same frame the apply masks on
 * the reuse path), else the job record. Image batch: image 0, via the same `getImageDimensions` call `processImages`
 * makes, else the job record when that returns 0 × 0 (uploads reclaimed, backlog 30). A mixed-dimension batch
 * (backlog 29) is accepted or refused as a whole on image 0's count.
 */
async function resolveDims(jobId: string, job: any): Promise<Dims | null> {
  const fromJob = (): Dims | null => {
    const w = Number(job?.width), h = Number(job?.height);
    return w > 0 && h > 0 ? { w, h, source: 'job' } : null;
  };

  if (job?.jobType === 'images') {
    const first = Array.isArray(job.fileList) ? job.fileList[0] : null;
    if (first?.filename) {
      const d = await new FrameExtractor().getImageDimensions(`uploads/${first.filename}`);
      if (d.width > 0 && d.height > 0) return { w: d.width, h: d.height, source: 'image0' };
    }
    return fromJob();
  }

  try {
    const { dir, files } = await listRawFrameFiles(jobId);
    if (files.length > 0) {
      const meta = await Sharp(`${dir}/${files[0]}`).metadata();
      if ((meta.width || 0) > 0 && (meta.height || 0) > 0) return { w: meta.width!, h: meta.height!, source: 'frame0' };
    }
  } catch { /* fall through to the job record */ }
  return fromJob();
}

/**
 * Count what the mask would blank at the job's frame dimensions and decide. Emits `[PERF] apply.validate` whenever a
 * count was made and `[PERF] apply.refused` on every refusal. Fails closed: no usable dimensions, or a throwing count,
 * refuses with `unverifiable`.
 */
export async function checkApplyMask(
  vp: Pick<VideoProcessor, 'countMaskedPixels'>,
  jobId: string,
  job: any,
  maskData: any,
): Promise<ApplyCheckResult> {
  const refuse = (reason: RefusalReason, extra: Record<string, unknown>): ApplyCheckResult => {
    perfMark(jobId, 'apply.refused', { reason, ...extra });
    return { ok: false, status: 422, reason, error: REFUSAL_MESSAGES[reason] };
  };

  let dims: Dims | null = null;
  try {
    dims = await resolveDims(jobId, job);
  } catch (err) {
    return refuse('unverifiable', { detail: `dims: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (!dims) return refuse('unverifiable', { detail: 'no_dimensions' });

  const t0 = process.hrtime.bigint();
  let counts: { masked: number; total: number };
  try {
    counts = await vp.countMaskedPixels(maskData, dims.w, dims.h);
  } catch (err) {
    return refuse('unverifiable', { detail: `count: ${err instanceof Error ? err.message : String(err)}` });
  }
  const ms = +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);
  perfMark(jobId, 'apply.validate', {
    ms, masked_px: counts.masked, total_px: counts.total, w: dims.w, h: dims.h, dims_source: dims.source,
  });

  const reason = decideApply(counts.masked, counts.total);
  if (reason) return refuse(reason, { masked_px: counts.masked, total_px: counts.total, w: dims.w, h: dims.h });
  return { ok: true };
}
