/**
 * Auto-mask Round 2B-1 — the T0 box, captured at upload and persisted beside the frames
 * (AUTOMASK_ROUND2B_RECON_PROPOSAL.md §1.3 / §2.4, sign-off decision 2).
 *
 * Why: 2A read the DICOM (0018,6011) region from the upload on first GET. `pm2 restart` purges uploads/ at boot and the
 * 2 h sweep does the same later, so a GE E9 job proposed after either degraded trapezoid → rectangle
 * (`bound_source: 'unavailable'`, prod job 438a9d4f). The dataset is already parsed at upload time
 * (frameExtractor.extractVideoMetadata, `naturalizeDataset` at :50); the box is lifted from it there and written to
 * temp_extracted/<jobId>/t0.json, which lives as long as the frames (6 h sweep, whole job dir at once) and survives a
 * restart (temp_extracted/ is not purged at boot). `.json` files are invisible to the raw-frame count the apply reuse
 * guard does (frameAccess.listFrameFiles matches image extensions), exactly like 2A's automask.json.
 *
 * Not in the job record: A3 is frozen (no column). Not in automask.json: that file is deleted to force a re-proposal.
 */
import path from 'path';
import { promises as fs } from 'fs';
import type { Bound, BoundSource } from '../../shared/automask/types';
import { TEMP_EXTRACTED_DIR, resolveWithinRoot } from './cleanup';
import { perfMark } from './perf';
import { automaskEnabled } from './automaskFlag';

export interface T0Json {
  version: 1;
  bound: Bound | null;
  bound_source: BoundSource;   // the contract's vocabulary, unchanged: dicom | not_dicom | unavailable
  w: number;
  h: number;
  createdAt: string;
}

/** dcmjs naturalised dataset → the first (0018,6011) region as a bound clipped to the frame; null when there is none. */
export function boundFromDataset(ds: Record<string, unknown>, w: number, h: number): Bound | null {
  const seq = ds.SequenceOfUltrasoundRegions as Array<Record<string, number>> | Record<string, number> | undefined;
  const first = Array.isArray(seq) ? seq[0] : seq;
  if (!first || first.RegionLocationMinX0 === undefined) return null;
  return {
    x0: Math.max(0, Number(first.RegionLocationMinX0)), y0: Math.max(0, Number(first.RegionLocationMinY0)),
    x1: Math.min(w - 1, Number(first.RegionLocationMaxX1)), y1: Math.min(h - 1, Number(first.RegionLocationMaxY1)),
  };
}

export function t0Path(tempExtractedDir: string, jobId: string): string {
  return resolveWithinRoot(tempExtractedDir, jobId, 't0.json');
}

export async function writeT0(tempExtractedDir: string, jobId: string, t0: Omit<T0Json, 'version' | 'createdAt'>, now: string = new Date().toISOString()): Promise<T0Json> {
  const p = t0Path(tempExtractedDir, jobId);
  await fs.mkdir(path.dirname(p), { recursive: true });   // ahead of extraction's own recursive mkdir — harmless
  const body: T0Json = { version: 1, ...t0, createdAt: now };
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(body));
  await fs.rename(tmp, p);
  return body;
}

export async function readT0(tempExtractedDir: string, jobId: string): Promise<T0Json | null> {
  try {
    const j = JSON.parse(await fs.readFile(t0Path(tempExtractedDir, jobId), 'utf8')) as Partial<T0Json>;
    if (j && j.version === 1 && typeof j.bound_source === 'string') return j as T0Json;
  } catch { /* absent (pre-2B job) or unreadable → the caller falls back to the upload */ }
  return null;
}

/**
 * Called by the upload handlers right after the job record exists. Flag-gated (flag off = 2A behaviour, byte for
 * byte) and never throws — a T0 write failure must not fail an upload. MP4/MOV/image batches record `not_dicom`;
 * a DICOM whose parse failed at upload records `unavailable` (metadata came back without `ultrasoundBound`).
 */
export async function captureT0AtUpload(
  jobId: string,
  meta: { width: number; height: number; ultrasoundBound?: Bound | null },
  isDicom: boolean,
  tempExtractedDir: string = TEMP_EXTRACTED_DIR,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T0Json | null> {
  if (!automaskEnabled(env)) return null;
  try {
    const bound = isDicom && meta.ultrasoundBound ? meta.ultrasoundBound : null;
    const bound_source: BoundSource = !isDicom ? 'not_dicom' : meta.ultrasoundBound === undefined ? 'unavailable' : bound ? 'dicom' : 'not_dicom';
    const t0 = await writeT0(tempExtractedDir, jobId, { bound, bound_source, w: meta.width, h: meta.height });
    perfMark(jobId, 'automask.t0_captured', { bound_source, w: meta.width, h: meta.height, dicom: isDicom });
    return t0;
  } catch (e: unknown) {
    perfMark(jobId, 'automask.t0_capture_failed', { detail: (e as Error)?.message ?? String(e) });
    return null;
  }
}
