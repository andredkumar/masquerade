/**
 * Output Round 1 — every output mode crops to the keep first (docs/refactor/OUTPUT_ROUND1_KICKOFF.md §1,
 * OUTPUT_ROUND1_RECON.md §2, OUTPUT_ROUND1_SIGNOFF.md §3).
 *
 * Pure: `keepBbox` reads the per-apply mask raster the apply already builds (keep = pixels the mask does not blank),
 * `planOutputTransform` turns the bbox + the output settings into one record — what sharp will do AND the traceability
 * transform that lands in manifest.json / metadata.csv — and `applyOutputTransform` is the sharp step both frame paths
 * call. Mapping convention, output → source:  x_src = crop.x + (x_out − offset.x) / scale.x  (y likewise).
 *
 *   letterbox, size 'original' → the keep centred on a black source-sized canvas, NO resampling (Andre's decision);
 *   crop,      size 'original' → identical (the keep always fits its own frame);
 *   letterbox, any other size  → the keep resized to fit inside w × h (contain, lanczos3), black, centred;
 *   crop,      any other size  → the keep resized to cover w × h (cover, lanczos3), centred, edges cut evenly;
 *   'stretch' (stale client)   → letterbox, flagged so the caller logs it once per apply.
 * The trigger for "no resampling" is the string `size === 'original'`, never dimension equality (sign-off §3.1): a
 * custom size that happens to equal the frame is a scale request.
 */
import type { Sharp } from 'sharp';

export interface KeepBbox { x: number; y: number; w: number; h: number }
export type OutputMode = 'letterbox' | 'crop';

export interface OutputTransform {
  mode: OutputMode;
  size: string;                                   // OutputSettings.size as received ('original', '512x512', 'custom', …)
  source: { w: number; h: number };               // the masked frame's dimensions (= the source frame)
  crop: { x: number; y: number; w: number; h: number };   // the keep's bounding box in source px; the full frame when the mask blanks everything
  scale: { x: number; y: number };                // output px per source px (1 when not resampled)
  offset: { x: number; y: number };               // where crop's origin lands in the output; negative under crop mode = cut off
  output: { w: number; h: number };
  resampled: boolean;                             // false only for size 'original'
  bbox_empty: boolean;                            // the mask blanked everything → full-frame fallback (kickoff §1 edge rule)
}

const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };

/** The keep's bounding box (alpha == 0 pixels of the RGBA mask raster the apply loop blanks alpha > 0 from); null when nothing is kept. */
export function keepBbox(maskRgba: Uint8Array, w: number, h: number): KeepBbox | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let rowMin = -1, rowMax = -1;
    for (let x = 0; x < w; x++) {
      if (maskRgba[(row + x) * 4 + 3] === 0) { if (rowMin < 0) rowMin = x; rowMax = x; }
    }
    if (rowMin >= 0) {
      if (rowMin < x0) x0 = rowMin;
      if (rowMax > x1) x1 = rowMax;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 'stretch' from a stale client → letterbox (kickoff §1 table); the caller logs `stale` once per apply. */
export function normaliseAspectMode(mode: string | undefined | null): { mode: OutputMode; stale: boolean } {
  if (mode === 'crop') return { mode: 'crop', stale: false };
  if (mode === 'letterbox' || mode === undefined || mode === null) return { mode: 'letterbox', stale: false };
  return { mode: 'letterbox', stale: true };
}

function clipToFrame(b: KeepBbox, w: number, h: number): KeepBbox {
  const x = Math.max(0, Math.min(w - 1, b.x)), y = Math.max(0, Math.min(h - 1, b.y));
  const x1 = Math.max(x, Math.min(w - 1, b.x + b.w - 1)), y1 = Math.max(y, Math.min(h - 1, b.y + b.h - 1));
  return { x, y, w: x1 - x + 1, h: y1 - y + 1 };
}

export function planOutputTransform(
  bbox: KeepBbox | null,
  frameW: number,
  frameH: number,
  size: string,
  mode: OutputMode,
  outputSize: { width: number; height: number },
): OutputTransform {
  const empty = !bbox || bbox.w <= 0 || bbox.h <= 0;
  const crop = empty ? { x: 0, y: 0, w: frameW, h: frameH } : clipToFrame(bbox!, frameW, frameH);
  const source = { w: frameW, h: frameH };
  if (size === 'original') {
    const left = Math.floor((frameW - crop.w) / 2), top = Math.floor((frameH - crop.h) / 2);
    return { mode, size, source, crop, scale: { x: 1, y: 1 }, offset: { x: left, y: top }, output: { w: frameW, h: frameH }, resampled: false, bbox_empty: empty };
  }
  const ow = Math.max(1, Math.round(outputSize.width)), oh = Math.max(1, Math.round(outputSize.height));
  if (mode === 'letterbox') {
    const s = Math.min(ow / crop.w, oh / crop.h);
    const sw = Math.max(1, Math.round(crop.w * s)), sh = Math.max(1, Math.round(crop.h * s));
    return { mode, size, source, crop, scale: { x: sw / crop.w, y: sh / crop.h }, offset: { x: Math.floor((ow - sw) / 2) + 0, y: Math.floor((oh - sh) / 2) + 0 }, output: { w: ow, h: oh }, resampled: true, bbox_empty: empty };
  }
  const s = Math.max(ow / crop.w, oh / crop.h);
  const sw = Math.max(1, Math.round(crop.w * s)), sh = Math.max(1, Math.round(crop.h * s));
  return { mode, size, source, crop, scale: { x: sw / crop.w, y: sh / crop.h }, offset: { x: -Math.floor((sw - ow) / 2) + 0, y: -Math.floor((sh - oh) / 2) + 0 }, output: { w: ow, h: oh }, resampled: true, bbox_empty: empty };
}

/** The sharp steps for one frame: extract the keep, then centre-without-scaling (extend) or contain / cover. Encoding stays the caller's. */
export function applyOutputTransform(image: Sharp, t: OutputTransform): Sharp {
  let img = image.extract({ left: t.crop.x, top: t.crop.y, width: t.crop.w, height: t.crop.h });
  if (!t.resampled) {
    const right = t.output.w - t.crop.w - t.offset.x, bottom = t.output.h - t.crop.h - t.offset.y;
    if (t.offset.x || t.offset.y || right || bottom) img = img.extend({ left: t.offset.x, top: t.offset.y, right, bottom, background: BLACK });
    return img;
  }
  return img.resize(t.output.w, t.output.h, { fit: t.mode === 'letterbox' ? 'contain' : 'cover', position: 'centre', background: BLACK, kernel: 'lanczos3' });
}

/**
 * Output Round 1b (F2) — the masked offsets that can reach the output: those whose pixel lies inside the crop. Every
 * other masked pixel is discarded by the `extract` a step later, so zeroing it is wasted work (in Keep mode ~98 % of the
 * frame). Offsets are the apply mask's byte offsets `(y·frameW + x)·3`; order is preserved. A crop covering the whole
 * frame returns the input array itself (the Remove-mode common case costs nothing).
 */
export function offsetsInCrop(offsets: Uint32Array, frameW: number, frameH: number, crop: KeepBbox): Uint32Array {
  const x0 = crop.x, x1 = crop.x + crop.w, y0 = crop.y, y1 = crop.y + crop.h;
  if (x0 <= 0 && y0 <= 0 && x1 >= frameW && y1 >= frameH) return offsets;
  const inside = (o: number) => { const p = o / 3, x = p % frameW, y = (p - x) / frameW; return x >= x0 && x < x1 && y >= y0 && y < y1; };
  let n = 0;
  for (let k = 0; k < offsets.length; k++) if (inside(offsets[k])) n++;
  const out = new Uint32Array(n);
  let j = 0;
  for (let k = 0; k < offsets.length; k++) if (inside(offsets[k])) out[j++] = offsets[k];
  return out;
}

/** Output → source, the record's own convention (used by the eval and the manifest README). */
export function outputToSource(t: OutputTransform, xOut: number, yOut: number): { x: number; y: number } {
  return { x: t.crop.x + (xOut - t.offset.x) / t.scale.x, y: t.crop.y + (yOut - t.offset.y) / t.scale.y };
}

/** The ten scalar columns metadata.csv carries per row (blank when there is no transform). */
export const OUTPUT_TRANSFORM_CSV_COLUMNS = ['crop_x', 'crop_y', 'crop_w', 'crop_h', 'scale_x', 'scale_y', 'offset_x', 'offset_y', 'output_w', 'output_h'] as const;
export function outputTransformCsvValues(t: OutputTransform | null | undefined): string[] {
  if (!t) return OUTPUT_TRANSFORM_CSV_COLUMNS.map(() => '');
  const r = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6));
  return [t.crop.x, t.crop.y, t.crop.w, t.crop.h, t.scale.x, t.scale.y, t.offset.x, t.offset.y, t.output.w, t.output.h].map(r);
}
