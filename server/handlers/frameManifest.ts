import type { AiLabel } from "@shared/schema";

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
//   • The frame set is expressed purely as a count; frame numbering is the
//     sorted-list POSITION `i` (0..frameCount-1), the same key inference wrote
//     mask_<i>.png / overlay_<i>.png with.
//   • `filename` is the field-compatible synthesized form `frame_%04d.<fmt>`
//     (nominal, matching the whole-job builder — NOT a literal ZIP path).

export interface PerFrameManifestInput {
  /** Number of frames to enumerate (sorted-list positions 0..frameCount-1). */
  frameCount: number;
  /** Labels to embed per-frame. Callers MUST approval-filter first (D2). */
  labels: AiLabel[];
  /** Output image format for the nominal `filename` field (e.g. 'png'). */
  outputFormat: string;
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
  const { frameCount, labels, outputFormat } = input;

  const frames = Array.from({ length: frameCount }, (_, i) => {
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
      filename: `frame_${String(i).padStart(4, '0')}.${outputFormat}`,
      split: determineSplit(i),
      has_mask: true,
      ai_labels: perFrameLabels,
    };
  });

  // metadata.csv — target/confidence columns are the semicolon-joined label sets.
  const aiTarget = labels.map(l => l.target).join('; ');
  const aiConfidence = labels.map(l => l.confidence !== null ? l.confidence.toString() : '').join('; ');
  const csvHeaders = ['filename', 'frame_number', 'split', 'ai_target', 'ai_confidence'];
  const csvRows = frames.map(f =>
    [f.filename, f.frame_number, f.split, `"${aiTarget}"`, `"${aiConfidence}"`].join(',')
  );
  const csv = [csvHeaders.join(','), ...csvRows].join('\n');

  return { frames, csv };
}
