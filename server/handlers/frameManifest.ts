import type { AiLabel } from "@shared/schema";
import { OUTPUT_TRANSFORM_CSV_COLUMNS, outputTransformCsvValues, type OutputTransform } from "../services/outputTransform";

// ── Phase 6 (b)-lite: shared per-frame manifest + CSV core ───────────────────
//
// The whole-job download (template-mask spoke) and the run-scoped download had
// two divergent copies of the per-frame `frames[]` assembly + `metadata.csv`
// derivation. This module holds the ONE shared core; each download path keeps
// its own thin wrapper that (a) picks its frame set, (b) picks + approval-filters
// its label set, then (c) calls this core and wraps the result with its own
// job-/run-level metadata.
//
// Precedent for the extract-the-drifting-core shape: `templateMaskApply.ts` (3c).
//
// Contract:
//   • Callers MUST approval-filter labels before calling (D2 is enforced by the
//     caller, never here — this core embeds exactly the labels it is handed).
//   • The frame set is the list of ZIP entry names, one per frame in order; frame numbering is the
//     sorted-list POSITION `i` (0..filenames.length-1), the same key inference wrote
//     mask_<i>.png / overlay_<i>.png with.
//   • `filename` is `filenames[i]`, verbatim: the exact path of frame i INSIDE the ZIP (Output Round 2, backlog 27).
//     The wrappers build that list once (`imageEntryName`) and use it for both this core and `archive.file`, so the
//     manifest can never name a file the ZIP does not contain. This core synthesizes no names.

/** The ZIP entry for frame `i`: `images/frame_%06d.<ext>`. The one place the name is built. */
export function imageEntryName(i: number, ext: string): string {
  return `images/frame_${String(i).padStart(6, '0')}.${ext}`;
}

export interface PerFrameManifestInput {
  /**
   * One ZIP entry name per frame, in order (sorted-list positions 0..length-1). Becomes `frames[i].filename` and the
   * CSV `filename` column unchanged.
   */
  filenames: string[];
  /** Labels to embed per-frame. Callers MUST approval-filter first (D2). */
  labels: AiLabel[];
  /**
   * Output Round 1: the per-job output transform (crop → centre / contain / cover) the apply recorded beside the
   * frames, or null for jobs applied before this round / raw-frame runs. Repeated on every CSV row as ten scalar
   * columns (blank when null) so a pandas user never parses JSON out of a cell.
   */
  outputTransform?: OutputTransform | null;
}

// Derive split assignment from frame index (80/10/10 train/val/test).
function determineSplit(n: number): 'train' | 'val' | 'test' {
  const mod = n % 10;
  if (mod <= 7) return 'train';
  if (mod === 8) return 'val';
  return 'test';
}

// This frame's individual confidence for a label, falling back to the label's
// top-level confidence when no per-frame result exists. Lookup keyed by sorted
// position `i` — the same key the inference loop wrote with.
function getLabelFrameConfidence(label: AiLabel, frameIdx: number): number | null {
  const r = label.frameResults?.[frameIdx];
  if (r && typeof r.confidence === 'number') return r.confidence;
  return label.confidence ?? null;
}

/**
 * Build the per-frame `frames[]` array and the `metadata.csv` string shared by
 * both download paths. Returns them; the caller embeds `frames` into its own
 * manifest object and appends `csv` to its ZIP.
 */
export function buildPerFrameManifestAndCsv(input: PerFrameManifestInput) {
  const { filenames, labels, outputTransform = null } = input;

  const frames = filenames.map((filename, i) => {
    // Each approved label carries THIS frame's individual confidence (from that
    // label's own frameResults), so multi-label exports show distinct scores
    // per label per frame rather than a shared value.
    const perFrameLabels = labels.map(l => ({
      intent: l.intent,
      target: l.target,
      modality: l.modality || null,
      confidence: getLabelFrameConfidence(l, i),
      model: l.model,
      approved: l.approved,
      bbox: l.bbox || null,
    }));
    return {
      frame_number: i,
      filename,
      split: determineSplit(i),
      has_mask: true,
      ai_labels: perFrameLabels,
    };
  });

  // metadata.csv — target/confidence columns are the semicolon-joined label sets.
  const aiTarget = labels.map(l => l.target).join('; ');
  const aiConfidence = labels.map(l => l.confidence !== null ? l.confidence.toString() : '').join('; ');
  const csvHeaders = ['filename', 'frame_number', 'split', 'ai_target', 'ai_confidence', ...OUTPUT_TRANSFORM_CSV_COLUMNS];
  const transformCells = outputTransformCsvValues(outputTransform);
  const csvRows = frames.map(f =>
    [f.filename, f.frame_number, f.split, `"${aiTarget}"`, `"${aiConfidence}"`, ...transformCells].join(',')
  );
  const csv = [csvHeaders.join(','), ...csvRows].join('\n');

  return { frames, csv };
}
