/**
 * Auto-mask Round 2A — the proposer as a server service (AUTOMASK_ROUND2A_PROPOSAL.md v2 §2.1–2.5).
 *
 * `getOrComputeProposal(jobId)` resolves frame 1 the way the frames endpoint does, reads the DICOM (0018,6011) box from
 * the upload when it is still there, runs the frozen proposer INLINE (decisions §3.2 — bounded work on a 4× grid), caches
 * the result as temp_extracted/<jobId>/automask.json and never regenerates it (delete the file to re-propose; the eval's
 * --fresh does that). Flag off (`AUTOMASK` unset/0) → {status:'none', reason:'disabled'} with no disk access. Nothing
 * here touches the spoke, apply, extraction or storage schemas.
 *
 * Dependencies are injectable so the endpoint test runs without a database (the default deps import storage lazily).
 */
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import * as dcmjs from 'dcmjs';

import { propose } from '../../shared/automask/core';
import { rgbToGray, grid } from '../../shared/automask/geometry';
import { AUTOMASK_CONSTANTS as C, RULES, CONSTANTS_FROZEN } from '../../shared/automask/constants';
import type { ProposalJson, Bound, BoundSource, Grid, Model } from '../../shared/automask/types';
import { listRawFrameFiles, isCompletePng, resolveImageBatchFrame, type ImageBatchEntry } from './frameAccess';
import { TEMP_EXTRACTED_DIR, resolveWithinRoot } from './cleanup';
import { perfMark } from './perf';
import type { Job, VideoJob } from '@shared/schema';

export const AUTOMASK_FLAG_ENV = 'AUTOMASK';
export function automaskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(env[AUTOMASK_FLAG_ENV] ?? '');
}

/** Grade tunables — exposed in the contract as info.grade_thresholds so 2B telemetry can move them without a contract change. */
export const GRADE_THRESHOLDS = {
  conf_min: 0.70,               // below → status none / withheld
  far_field_stop_frac: 0.70,    // the shape ends before this fraction of the way from its top to the frame / bound bottom → check_depth
  masked_frac_fan: 0.55,        // masked fraction above the family's band → check_depth
  masked_frac_trap: 0.50,
};

export interface AutomaskDeps {
  getJobV2: (jobId: string) => Promise<Job | undefined>;
  getVideoJob: (jobId: string) => Promise<VideoJob | undefined>;
  listRawFrameFiles: typeof listRawFrameFiles;
  isCompletePng: typeof isCompletePng;
  resolveImageBatchFrame: typeof resolveImageBatchFrame;
  tempExtractedDir: string;
  env: NodeJS.ProcessEnv;
  log: (jobId: string, stage: string, extra?: Record<string, unknown>) => void;
  now: () => string;
}

async function defaultDeps(): Promise<AutomaskDeps> {
  const { storage } = await import('../storage');
  return {
    getJobV2: (id) => storage.getJobV2(id),
    getVideoJob: (id) => storage.getVideoJob(id),
    listRawFrameFiles, isCompletePng, resolveImageBatchFrame,
    tempExtractedDir: TEMP_EXTRACTED_DIR, env: process.env, log: perfMark, now: () => new Date().toISOString(),
  };
}

const pending = new Map<string, Promise<ProposalJson>>();

export function cachePath(tempExtractedDir: string, jobId: string): string {
  return resolveWithinRoot(tempExtractedDir, jobId, 'automask.json');
}

function baseJson(jobId: string, now: string): ProposalJson {
  return {
    version: 2, status: 'none', reason: null, withheld: null, flag: null, jobId, frame: null, width: null, height: null, tier: null, model: null,
    keep: null, bound: null, bound_source: 'not_dicom', margin_px: C.MARGIN_PX, confidence: 0, grade: null, rules: { ...RULES },
    info: { constants_frozen: CONSTANTS_FROZEN, grade_thresholds: { ...GRADE_THRESHOLDS } }, ms: { decode: 0, propose: 0, total: 0 }, createdAt: now,
  };
}

/** DICOM (0018,6011) first region → bound, clipped to the frame. null when the file has no region sequence. */
export async function readDicomBound(filePath: string, w: number, h: number): Promise<Bound | null> {
  const buf = await fs.readFile(filePath);
  if (buf.length <= 132 || buf.subarray(128, 132).toString('ascii') !== 'DICM') return null;
  const dataSet = dcmjs.data.DicomMessage.readFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dataSet.dict) as Record<string, unknown>;
  const seq = ds.SequenceOfUltrasoundRegions as Array<Record<string, number>> | Record<string, number> | undefined;
  const first = Array.isArray(seq) ? seq[0] : seq;
  if (!first || first.RegionLocationMinX0 === undefined) return null;
  return {
    x0: Math.max(0, Number(first.RegionLocationMinX0)), y0: Math.max(0, Number(first.RegionLocationMinY0)),
    x1: Math.min(w - 1, Number(first.RegionLocationMaxX1)), y1: Math.min(h - 1, Number(first.RegionLocationMaxY1)),
  };
}

export function boundToGrid(b: Bound, w: number, h: number): Grid {
  const g = grid(w, h);
  for (let y = b.y0; y <= b.y1; y++) g.data.fill(1, y * w + b.x0, y * w + b.x1 + 1);
  return g;
}

export function gradeFor(model: Model, shape: ProposalJson['keep'], conf: number, maskedFrac: number, frameH: number, bound: Bound | null): 'proposed' | 'check_depth' | null {
  if (conf < GRADE_THRESHOLDS.conf_min || !shape) return null;
  const bottomLimit = bound ? bound.y1 : frameH - 1;
  const top = shape.kind === 'fan' ? shape.ay + shape.r_in : shape.y_top;
  const bottom = shape.kind === 'fan' ? shape.ay + shape.r_out : shape.y_bottom;
  const reach = (bottom - top) / Math.max(1, bottomLimit - top);
  const band = model === 'fan_sym' ? GRADE_THRESHOLDS.masked_frac_fan : GRADE_THRESHOLDS.masked_frac_trap;
  return reach < GRADE_THRESHOLDS.far_field_stop_frac || maskedFrac > band ? 'check_depth' : 'proposed';
}

/** Resolve frame 1 for a job. Returns the absolute path + label + source, `pending` while extraction has not produced it, or `no_frame`. */
async function resolveFrame1(jobId: string, jobV2: Job, legacy: VideoJob | undefined, d: AutomaskDeps): Promise<{ kind: 'ok'; absPath: string; label: string; source: 'raw' | 'image_batch' } | { kind: 'pending' } | { kind: 'no_frame' }> {
  if (jobV2.source.type === 'image_batch') {
    const r = await d.resolveImageBatchFrame(legacy?.fileList as ImageBatchEntry[] | undefined, 0);
    if (!r.ok) return { kind: 'no_frame' };
    return { kind: 'ok', absPath: r.absPath, label: `uploads/${path.basename(r.absPath)}`, source: 'image_batch' };
  }
  const { dir, files } = await d.listRawFrameFiles(jobId);
  if (!files.length) return jobV2.status === 'failed' ? { kind: 'no_frame' } : { kind: 'pending' };
  const absPath = path.join(dir, files[0]);
  if (!(await d.isCompletePng(absPath))) return { kind: 'pending' };
  return { kind: 'ok', absPath, label: files[0], source: 'raw' };
}

/**
 * The service. `null` = unknown job (route → 404). Everything else is a contract body (§2.3); only `ready` and
 * withheld `none` results are cached; `pending`, `disabled` and `error` are not.
 */
export async function getOrComputeProposal(jobId: string, depsIn?: AutomaskDeps): Promise<ProposalJson | null> {
  const d = depsIn ?? (await defaultDeps());
  const jobV2 = await d.getJobV2(jobId);          // a job lookup, not disk access: unknown → 404 in both flag states
  if (!jobV2) return null;
  if (!automaskEnabled(d.env)) return { ...baseJson(jobId, d.now()), status: 'none', reason: 'disabled' };
  // cache
  let cpath: string;
  try { cpath = cachePath(d.tempExtractedDir, jobId); } catch { return null; }
  try {
    const cached = JSON.parse(await fs.readFile(cpath, 'utf8')) as ProposalJson;
    if (cached && cached.version === 2 && (cached.status === 'ready' || (cached.status === 'none' && cached.reason === 'withheld'))) {
      d.log(jobId, 'automask.served', { status: cached.status, cached: true });
      return cached;
    }
  } catch { /* no cache or corrupt → recompute below (a corrupt file is overwritten) */ }
  const inflight = pending.get(jobId);
  if (inflight) return inflight;
  const job = compute(jobId, jobV2, d, cpath).finally(() => pending.delete(jobId));
  pending.set(jobId, job);
  return job;
}

async function compute(jobId: string, jobV2: Job, d: AutomaskDeps, cpath: string): Promise<ProposalJson> {
  const t0 = process.hrtime.bigint();
  const out = baseJson(jobId, d.now());
  const legacy = await d.getVideoJob(jobId);
  try {
    const fr = await resolveFrame1(jobId, jobV2, legacy, d);
    if (fr.kind === 'pending') return { ...out, status: 'pending' };
    if (fr.kind === 'no_frame') { d.log(jobId, 'automask.skipped', { reason: 'no_frame' }); return { ...out, status: 'none', reason: 'no_frame' }; }
    const isDicomName = /\.(dcm|dicom)$/i.test(jobV2.filename ?? '');
    d.log(jobId, 'automask.start', { source: fr.source, dicom: isDicomName });
    // decode
    const tDec = process.hrtime.bigint();
    const { data, info } = await sharp(fr.absPath).raw().toBuffer({ resolveWithObject: true });
    const gray = grid(info.width, info.height, rgbToGray(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels));
    const msDecode = Number(process.hrtime.bigint() - tDec) / 1e6;
    out.frame = fr.label; out.width = info.width; out.height = info.height;
    // T0 box
    let bound: Bound | null = null; let boundSource: BoundSource = 'not_dicom';
    if (fr.source === 'raw' && legacy?.filePath) {
      try {
        bound = await readDicomBound(legacy.filePath, info.width, info.height);
        boundSource = bound ? 'dicom' : 'not_dicom';
      } catch (e: unknown) {
        boundSource = isDicomName ? 'unavailable' : 'not_dicom';
        if (isDicomName) d.log(jobId, 'automask.t0_unavailable', { detail: (e as Error).message });
      }
    } else if (isDicomName) boundSource = 'unavailable';
    out.bound = bound; out.bound_source = boundSource; out.tier = bound ? 'T0T1' : 'T1';
    // propose
    const tProp = process.hrtime.bigint();
    const res = propose(gray, { bound: bound ? boundToGrid(bound, info.width, info.height) : null });
    const msPropose = Number(process.hrtime.bigint() - tProp) / 1e6;
    const infoKeys = ['fit_score', 'fit_iou', 'outside_blob_frac', 'masked_frac', 'interior_mean', 'interior_std', 'bg_level', 'bg_frac', 'th_l_free_deg', 'th_r_free_deg', 'asym_deg', 'axis_tilt_deg',
      'axis', 'rin_rule', 'reseeded', 'trap_band_end', 'trap_depth', 't0_depth', 'union', 'r_out_delta', 'top_edge_frac', 'half_angle_deg', 'trap_side_angle_deg', 'support_edges', 'reason'];
    for (const k of infoKeys) if (k in res.info) out.info[k] = res.info[k];
    out.model = res.model; out.confidence = Math.round(res.conf * 1e4) / 1e4; out.flag = res.flag; out.withheld = res.withheld;
    out.ms = { decode: +msDecode.toFixed(1), propose: +msPropose.toFixed(1), total: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) };
    if (res.withheld || !res.shape || res.conf < GRADE_THRESHOLDS.conf_min) {
      out.status = 'none'; out.reason = 'withheld'; out.withheld = res.withheld ?? 'low_confidence'; out.keep = res.shape;
      d.log(jobId, 'automask.skipped', { reason: 'withheld', withheld: out.withheld, conf: out.confidence, ms_total: out.ms.total });
    } else {
      out.status = 'ready'; out.keep = res.shape;
      out.grade = gradeFor(res.model as Model, res.shape, res.conf, (res.info.masked_frac as number) ?? 0, info.height, bound);
      d.log(jobId, 'automask.done', { tier: out.tier, model: out.model, conf: out.confidence, grade: out.grade, masked_frac: res.info.masked_frac, w: info.width, h: info.height,
        ms_decode: out.ms.decode, ms_propose: out.ms.propose, ms_total: out.ms.total, cached: false, reseeded: res.info.reseeded ?? null, bound_source: boundSource,
        rules_fired: ['axis', 'rin_rule', 'reseeded', 'trap_depth', 't0_depth', 'union'].filter((k) => res.info[k]) });
    }
    await fs.mkdir(path.dirname(cpath), { recursive: true });
    const tmp = cpath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(out));
    await fs.rename(tmp, cpath);
    return out;
  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    d.log(jobId, 'automask.skipped', { reason: 'error', detail: msg });
    return { ...out, status: 'none', reason: 'error', error: msg, ms: { ...out.ms, total: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) } };
  }
}
