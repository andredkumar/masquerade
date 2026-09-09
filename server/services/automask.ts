/**
 * Auto-mask Round 2A — the proposer as a server service (AUTOMASK_ROUND2A_PROPOSAL.md v2 §2.1–2.5).
 *
 * `getOrComputeProposal(jobId)` resolves frame 1 the way the frames endpoint does, reads the DICOM (0018,6011) box from
 * the upload when it is still there, runs the frozen proposer and caches the result as temp_extracted/<jobId>/automask.json,
 * never regenerating it (delete the file to re-propose; the eval's --fresh does that). Flag off (`AUTOMASK` unset/0) →
 * {status:'none', reason:'disabled'} with no disk access. Nothing here touches the spoke, apply, extraction or storage schemas.
 *
 * 2B-1 (AUTOMASK_ROUND2B_RECON_PROPOSAL.md §2): the proposer runs in a worker thread (automaskWorkerClient — 2A ran it
 * inline and prod measured 0.7–1.5 s on the main thread); it is computed at `ready` (`enqueueProposalAtReady`, called
 * after the ready write in videoProcessor and from the image upload handler) with the first-GET compute kept as the lazy
 * fallback; the T0 box is read from temp_extracted/<jobId>/t0.json (captured at upload, automaskT0.ts) before the
 * upload is consulted. Contract v2 + additive fields (`computed_by`, `ms.worker`, `ms.queue`, `info.t0_from`).
 *
 * Dependencies are injectable so the endpoint test runs without a database (the default deps import storage lazily).
 */
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import * as dcmjs from 'dcmjs';

import { rgbToGray, grid, boundToGrid } from '../../shared/automask/geometry';
import { AUTOMASK_CONSTANTS as C, RULES, CONSTANTS_FROZEN } from '../../shared/automask/constants';
import type { ProposalJson, Bound, BoundSource, Grid, Model } from '../../shared/automask/types';
import { listRawFrameFiles, isCompletePng, resolveImageBatchFrame, type ImageBatchEntry } from './frameAccess';
import { TEMP_EXTRACTED_DIR, resolveWithinRoot } from './cleanup';
import { perfMark } from './perf';
import type { Job, VideoJob } from '@shared/schema';
import { defaultWorkerClient, type ProposeInWorker } from './automaskWorkerClient';
import { readT0, boundFromDataset } from './automaskT0';
import { AUTOMASK_FLAG_ENV, automaskEnabled } from './automaskFlag';

export { AUTOMASK_FLAG_ENV, automaskEnabled, boundToGrid };

export type ProposalTrigger = 'ready' | 'lazy';

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
  proposeInWorker: ProposeInWorker;   // 2B-1: the proposer off the main thread (injectable so tests can fault it)
}

async function defaultDeps(): Promise<AutomaskDeps> {
  const { storage } = await import('../storage');
  return {
    getJobV2: (id) => storage.getJobV2(id),
    getVideoJob: (id) => storage.getVideoJob(id),
    listRawFrameFiles, isCompletePng, resolveImageBatchFrame,
    tempExtractedDir: TEMP_EXTRACTED_DIR, env: process.env, log: perfMark, now: () => new Date().toISOString(),
    proposeInWorker: (...a) => defaultWorkerClient.propose(...a),
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
  return boundFromDataset(ds, w, h);   // the same arithmetic the upload-time capture uses (automaskT0.ts)
}

function clipBound(b: Bound, w: number, h: number): Bound {
  return { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(w - 1, b.x1), y1: Math.min(h - 1, b.y1) };
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
export async function getOrComputeProposal(jobId: string, depsIn?: AutomaskDeps, opts: { trigger?: ProposalTrigger } = {}): Promise<ProposalJson | null> {
  const d = depsIn ?? (await defaultDeps());
  const trigger: ProposalTrigger = opts.trigger ?? 'lazy';
  const jobV2 = await d.getJobV2(jobId);          // a job lookup, not disk access: unknown → 404 in both flag states
  if (!jobV2) return null;
  if (!automaskEnabled(d.env)) return { ...baseJson(jobId, d.now()), status: 'none', reason: 'disabled' };
  // cache
  let cpath: string;
  try { cpath = cachePath(d.tempExtractedDir, jobId); } catch { return null; }
  try {
    const cached = JSON.parse(await fs.readFile(cpath, 'utf8')) as ProposalJson;
    if (cached && cached.version === 2 && (cached.status === 'ready' || (cached.status === 'none' && cached.reason === 'withheld'))) {
      d.log(jobId, 'automask.served', { status: cached.status, cached: true, computed_by: cached.computed_by ?? null, trigger });
      return cached;
    }
  } catch { /* no cache or corrupt → recompute below (a corrupt file is overwritten) */ }
  const inflight = pending.get(jobId);
  if (inflight) return inflight;
  const job = compute(jobId, jobV2, d, cpath, trigger).finally(() => pending.delete(jobId));
  pending.set(jobId, job);
  return job;
}

/**
 * 2B-1: compute the proposal the moment a job is `ready` — after the ready write + socket emit in
 * videoProcessor.startBackgroundFrameExtraction (MP4 and DICOM converge there), and from the image upload handler
 * (image batches are ready at upload). Fire-and-forget by design: never rejects, a no-op with the flag off (checked
 * before any job lookup), and dedupes through the same in-flight map a GET uses, so a spoke opened mid-compute joins
 * the promise instead of starting a second proposal.
 */
export function enqueueProposalAtReady(jobId: string, depsIn?: AutomaskDeps): Promise<void> {
  return (async () => {
    const d = depsIn ?? (await defaultDeps());
    if (!automaskEnabled(d.env)) return;
    const r = await getOrComputeProposal(jobId, d, { trigger: 'ready' });
    if (r?.status === 'pending') d.log(jobId, 'automask.skipped', { reason: 'pending_at_ready', trigger: 'ready' });
  })().catch((e: unknown) => {
    try { perfMark(jobId, 'automask.skipped', { reason: 'error', trigger: 'ready', detail: (e as Error)?.message ?? String(e) }); } catch { /* never throw */ }
  });
}

async function compute(jobId: string, jobV2: Job, d: AutomaskDeps, cpath: string, trigger: ProposalTrigger): Promise<ProposalJson> {
  const t0 = process.hrtime.bigint();
  const out = baseJson(jobId, d.now());
  out.computed_by = trigger;
  const legacy = await d.getVideoJob(jobId);
  try {
    const fr = await resolveFrame1(jobId, jobV2, legacy, d);
    if (fr.kind === 'pending') return { ...out, status: 'pending' };
    if (fr.kind === 'no_frame') { d.log(jobId, 'automask.skipped', { reason: 'no_frame' }); return { ...out, status: 'none', reason: 'no_frame' }; }
    const isDicomName = /\.(dcm|dicom)$/i.test(jobV2.filename ?? '');
    d.log(jobId, 'automask.start', { source: fr.source, dicom: isDicomName, trigger });
    // decode
    const tDec = process.hrtime.bigint();
    const { data, info } = await sharp(fr.absPath).raw().toBuffer({ resolveWithObject: true });
    const gray = grid(info.width, info.height, rgbToGray(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels));
    const msDecode = Number(process.hrtime.bigint() - tDec) / 1e6;
    out.frame = fr.label; out.width = info.width; out.height = info.height;
    // T0 box — 2B-1: t0.json captured at upload first (it survives the uploads/ purge), then the 2A read of the upload
    // itself (jobs that predate 2B-1), then `unavailable`.
    let bound: Bound | null = null; let boundSource: BoundSource = 'not_dicom'; let t0From: 'file' | 'upload' | null = null;
    const t0Json = fr.source === 'raw' ? await readT0(d.tempExtractedDir, jobId) : null;
    if (t0Json) {
      bound = t0Json.bound ? clipBound(t0Json.bound, info.width, info.height) : null; boundSource = t0Json.bound_source; t0From = 'file';
    } else if (fr.source === 'raw' && legacy?.filePath) {
      try {
        bound = await readDicomBound(legacy.filePath, info.width, info.height);
        boundSource = bound ? 'dicom' : 'not_dicom'; t0From = 'upload';
      } catch (e: unknown) {
        boundSource = isDicomName ? 'unavailable' : 'not_dicom';
        if (isDicomName) d.log(jobId, 'automask.t0_unavailable', { detail: (e as Error).message, trigger });
      }
    } else if (isDicomName) boundSource = 'unavailable';
    out.bound = bound; out.bound_source = boundSource; out.tier = bound ? 'T0T1' : 'T1'; out.info.t0_from = t0From;
    // propose — in the worker (2B-1). ms.propose is the round trip (queue + transfer + worker); ms.worker the in-thread time.
    const tProp = process.hrtime.bigint();
    const wr = await d.proposeInWorker(gray.data, info.width, info.height, bound, jobId);
    const res = wr.result;
    const msPropose = Number(process.hrtime.bigint() - tProp) / 1e6;
    const infoKeys = ['fit_score', 'fit_iou', 'outside_blob_frac', 'masked_frac', 'interior_mean', 'interior_std', 'bg_level', 'bg_frac', 'th_l_free_deg', 'th_r_free_deg', 'asym_deg', 'axis_tilt_deg',
      'axis', 'rin_rule', 'reseeded', 'trap_band_end', 'trap_depth', 't0_depth', 'union', 'r_out_delta', 'top_edge_frac', 'half_angle_deg', 'trap_side_angle_deg', 'support_edges', 'reason'];
    for (const k of infoKeys) if (k in res.info) out.info[k] = res.info[k];
    out.model = res.model; out.confidence = Math.round(res.conf * 1e4) / 1e4; out.flag = res.flag; out.withheld = res.withheld;
    out.ms = { decode: +msDecode.toFixed(1), propose: +msPropose.toFixed(1), total: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), worker: +wr.workerMs.toFixed(1), queue: +wr.queueMs.toFixed(1) };
    if (res.withheld || !res.shape || res.conf < GRADE_THRESHOLDS.conf_min) {
      out.status = 'none'; out.reason = 'withheld'; out.withheld = res.withheld ?? 'low_confidence'; out.keep = res.shape;
      d.log(jobId, 'automask.skipped', { reason: 'withheld', withheld: out.withheld, conf: out.confidence, ms_total: out.ms.total, worker_ms: out.ms.worker, queue_ms: out.ms.queue, worker_spawned: wr.spawned, trigger, t0_from: t0From });
    } else {
      out.status = 'ready'; out.keep = res.shape;
      out.grade = gradeFor(res.model as Model, res.shape, res.conf, (res.info.masked_frac as number) ?? 0, info.height, bound);
      d.log(jobId, 'automask.done', { tier: out.tier, model: out.model, conf: out.confidence, grade: out.grade, masked_frac: res.info.masked_frac, w: info.width, h: info.height,
        ms_decode: out.ms.decode, ms_propose: out.ms.propose, ms_total: out.ms.total, worker_ms: out.ms.worker, queue_ms: out.ms.queue, worker_spawned: wr.spawned, trigger, t0_from: t0From,
        cached: false, reseeded: res.info.reseeded ?? null, bound_source: boundSource,
        rules_fired: ['axis', 'rin_rule', 'reseeded', 'trap_depth', 't0_depth', 'union'].filter((k) => res.info[k]) });
    }
    await fs.mkdir(path.dirname(cpath), { recursive: true });
    const tmp = cpath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(out));
    await fs.rename(tmp, cpath);
    return out;
  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    d.log(jobId, 'automask.skipped', { reason: 'error', detail: msg, trigger });
    return { ...out, status: 'none', reason: 'error', error: msg, ms: { ...out.ms, total: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) } };
  }
}
