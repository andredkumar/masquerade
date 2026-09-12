/**
 * Auto-mask Round 2A — the JSON contract (AUTOMASK_ROUND2A_PROPOSAL.md v2 §2.3) and the internal grid types.
 *
 * Coordinates: full-resolution pixels unless a name says "small" (the 4× analysis grid). Fan angles in radians,
 * 0 = straight down, positive to the right — identical to the Python spike and bench_static/shape.js.
 */

export interface FanShape {
  kind: 'fan';
  sym: true;
  ax: number;
  ay: number;
  half_angle: number;
  r_in: number;
  r_out: number;
  th_l: number;
  th_r: number;
}

export interface TrapShape {
  kind: 'trap' | 'rect';
  sym: true;
  cx: number;
  y_top: number;
  y_bottom: number;
  w_top: number;
  w_bottom: number;
}

export type KeepShape = FanShape | TrapShape;

export interface Bound { x0: number; y0: number; x1: number; y1: number }

/** A binary or 8-bit image on a row-major Uint8Array. */
export interface Grid { w: number; h: number; data: Uint8Array }

export type Model = 'fan_sym' | 'trap_sym' | 'rect';

export type WithheldReason =
  | 'background_not_dark' | 'no_background' | 'interior_not_ultrasound' | 'masks_too_little'
  | 'support_too_small' | 'no_side_edges' | 'sides_parallel' | 'apex_not_above' | 'no_fit';

export type Info = Record<string, unknown>;

/** What `propose()` returns: the analysis-grid parameters, the full-res shape, the full-res keep mask, diagnostics. */
export interface ProposeResult {
  keep: Grid | null;                 // full-res keep mask (1 = keep), margin eroded, T0 box applied; null when withheld
  shape: KeepShape | null;           // full-res parameters (the contract's `keep`)
  paramsSmall: KeepShape | null;     // the same on the 4× grid (fixture comparisons)
  model: Model | null;
  conf: number;
  withheld: WithheldReason | string | null;
  flag: string | null;
  info: Info;
  ms: number;
}

export type BoundSource = 'dicom' | 'unavailable' | 'not_dicom';

export interface ProposalJson {
  version: 2;
  status: 'ready' | 'none' | 'pending';
  reason: 'disabled' | 'withheld' | 'error' | 'no_frame' | null;
  withheld: string | null;
  flag: string | null;
  jobId: string;
  frame: string | null;
  width: number | null;
  height: number | null;
  tier: 'T1' | 'T0T1' | null;
  model: Model | null;
  keep: KeepShape | null;
  bound: Bound | null;
  bound_source: BoundSource;
  margin_px: number;
  confidence: number;
  grade: 'proposed' | 'check_depth' | null;
  rules: Record<string, boolean>;
  info: Info;
  ms: { decode: number; propose: number; total: number; worker?: number; queue?: number };   // 2B-1: propose = round trip; worker = in-thread; queue = waited behind another job
  createdAt: string;
  error?: string;
  computed_by?: 'ready' | 'lazy';   // 2B-1: what triggered the compute that produced this body
  ui_enabled?: boolean;             // 2B-2: AUTOMASK_UI as seen by the server at serve time (stamped by the route, never cached)
}
