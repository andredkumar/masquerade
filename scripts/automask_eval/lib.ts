/**
 * Round 2A — shared helpers for the fixture test and the eval CLI (Node only: uses sharp). The browser-safe core lives
 * in shared/automask/.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { propose } from '../../shared/automask/core';
import { renderKeepMask, score, type Score } from '../../shared/automask/render';
import { rgbToGray, grid } from '../../shared/automask/geometry';
import { iou } from '../../shared/automask/fan';
import type { KeepShape, Bound, Grid, ProposeResult } from '../../shared/automask/types';

/** Decode any PNG/JPEG to the spike's grayscale (cv2 BGR2GRAY fixed-point weights). */
export async function loadGray(imagePath: string): Promise<Grid> {
  const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  return grid(info.width, info.height, rgbToGray(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels));
}

export function boundGrid(b: Bound | null | undefined, w: number, h: number): Grid | null {
  if (!b) return null;
  const g = grid(w, h);
  for (let y = Math.max(0, b.y0); y <= Math.min(h - 1, b.y1); y++) g.data.fill(1, y * w + Math.max(0, b.x0), y * w + Math.min(w - 1, b.x1) + 1);
  return g;
}

/** The Python fixture as the frozen spike writes it (bench.py `propose` / `--propose-png`). */
export interface PyProposal {
  clip_id: string; w: number; h: number; bound: Bound | null; keep: KeepShape | null; tier: string | null; model: string | null;
  conf: number; withheld: string | null; flag: string | null; expected: string; margin_px: number; components: Record<string, unknown>;
}

export const FIXTURE_TOL = { iou: 0.98, depthPx: 2, conf: 0.02 } as const;

export interface FixtureCompare {
  clip: string; ok: boolean; reasons: string[];
  py_model: string | null; ts_model: string | null; py_withheld: string | null; ts_withheld: string | null;
  iou: number | null; d_depth: number | null; d_conf: number | null; ms: number;
  py_keep: KeepShape | null; ts_keep: KeepShape | null; rules: Record<string, unknown>;
}

/** Run the TS proposer on a fixture frame and compare with the Python proposal (§3 assertions). */
export function compareToPython(clip: string, gray: Grid, py: PyProposal): FixtureCompare {
  const t0 = performance.now();
  const res: ProposeResult = propose(gray, { bound: boundGrid(py.bound, gray.w, gray.h) });
  const ms = performance.now() - t0;
  const reasons: string[] = [];
  const pyW = py.withheld ?? null, tsW = res.withheld ?? null;
  if ((py.model ?? null) !== (res.model ?? null)) reasons.push(`model ${py.model} → ${res.model}`);
  if (pyW !== tsW) reasons.push(`withheld ${pyW} → ${tsW}`);
  if ((py.flag ?? null) !== (res.flag ?? null)) reasons.push(`flag ${py.flag} → ${res.flag}`);
  let io: number | null = null, dDepth: number | null = null, dConf: number | null = null;
  if (py.keep && res.shape) {
    const mPy = renderKeepMask(py.keep, gray.w, gray.h, py.bound, py.margin_px);
    const mTs = renderKeepMask(res.shape, gray.w, gray.h, py.bound, py.margin_px);
    io = iou(mPy, mTs);
    dDepth = py.keep.kind === 'fan' && res.shape.kind === 'fan' ? res.shape.r_out - py.keep.r_out
      : py.keep.kind !== 'fan' && res.shape.kind !== 'fan' ? res.shape.y_bottom - py.keep.y_bottom : NaN;
    dConf = res.conf - py.conf;
    if (io < FIXTURE_TOL.iou) reasons.push(`IoU ${io.toFixed(4)} < ${FIXTURE_TOL.iou}`);
    if (!(Math.abs(dDepth) <= FIXTURE_TOL.depthPx)) reasons.push(`|Δdepth| ${dDepth.toFixed(1)} > ${FIXTURE_TOL.depthPx}`);
    if (Math.abs(dConf) > FIXTURE_TOL.conf) reasons.push(`|Δconf| ${dConf.toFixed(4)} > ${FIXTURE_TOL.conf}`);
  } else if (!!py.keep !== !!res.shape) reasons.push(`keep ${py.keep ? 'present' : 'absent'} → ${res.shape ? 'present' : 'absent'}`);
  return {
    clip, ok: reasons.length === 0, reasons, py_model: py.model, ts_model: res.model, py_withheld: pyW, ts_withheld: tsW,
    iou: io === null ? null : Math.round(io * 1e4) / 1e4, d_depth: dDepth === null ? null : Math.round(dDepth * 10) / 10, d_conf: dConf === null ? null : Math.round(dConf * 1e4) / 1e4,
    ms: Math.round(ms), py_keep: py.keep, ts_keep: res.shape,
    rules: { axis: res.info.axis ?? null, rin_rule: res.info.rin_rule ?? null, reseeded: res.info.reseeded ?? null, trap_depth: res.info.trap_depth ?? null, t0_depth: res.info.t0_depth ?? null, union: res.info.union ?? null },
  };
}

/** List <dir>/<clip>/{frame1.png|frame.png, proposal.json} fixture folders. */
export async function listFixtures(dir: string): Promise<Array<{ clip: string; frame: string; proposal: string }>> {
  const out: Array<{ clip: string; frame: string; proposal: string }> = [];
  for (const d of (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort()) {
    const proposal = path.join(dir, d, 'proposal.json');
    for (const fname of ['frame1.png', 'frame.png']) {
      const frame = path.join(dir, d, fname);
      try { await fs.access(frame); await fs.access(proposal); out.push({ clip: d, frame, proposal }); break; } catch { /* next */ }
    }
  }
  return out;
}

export function fmtShape(s: KeepShape | null): string {
  if (!s) return '—';
  if (s.kind === 'fan') return `fan ax=${s.ax.toFixed(0)} ay=${s.ay.toFixed(0)} half=${((s.half_angle * 180) / Math.PI).toFixed(2)}° r_in=${s.r_in.toFixed(0)} r_out=${s.r_out.toFixed(0)}`;
  return `${s.kind} cx=${s.cx.toFixed(0)} y_top=${s.y_top.toFixed(0)} y_bot=${s.y_bottom.toFixed(0)} w_top=${s.w_top.toFixed(0)} w_bot=${s.w_bottom.toFixed(0)}`;
}

/** Score a proposal shape against a reference shape (both full-res), the tolerant rule of the tuning passes. */
export function scoreShapes(fit: KeepShape, ref: KeepShape, w: number, h: number, bound: Bound | null): Score & { tolerant: boolean } {
  const s = score(renderKeepMask(fit, w, h, bound), renderKeepMask(ref, w, h, bound));
  return { ...s, tolerant: s.iou >= 0.9 && s.leak_core6 <= 0.01 };
}

/** Decode a canvas data-URL / PNG buffer of the template mask (red > 128 = blanked) into the keep_ref grid. */
export async function keepRefFromMaskPng(pngBuffer: Buffer, w: number, h: number): Promise<Grid> {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const g = grid(w, h);
  if (info.width !== w || info.height !== h) throw new Error(`mask ${info.width}×${info.height} does not match frame ${w}×${h}`);
  for (let i = 0; i < w * h; i++) g.data[i] = data[i * 4] > 128 ? 0 : 1;    // red = blanked → keep is the complement
  return g;
}
