/**
 * Auto-mask Round 2B-2 — the template-mask spoke's proposal session (docs/refactor/AUTOMASK_ROUND2B2_PLAN.md §1, §6).
 *
 *  • `useAutomaskProposal(jobId, active)` — one GET of `/template-mask/proposal` per spoke mount once frame 1 is on
 *    screen; `pending` polls every second for ≤ 60 s, silently; anything but `ready` + `ui_enabled` yields null, which
 *    is today's spoke exactly (B1: blank canvas on withheld / error / flag-off). Errors go to the console, never the UI.
 *  • `sessionReducer` — the proposal state the spoke owns: the fitted shape, the current shape, the mode, which controls
 *    were touched, when the layer first rendered. MaskingCanvas never sees any of this beyond `{shape, bound, margin, mode}`.
 *  • `buildOutcome` / `postOutcome` — the one `automask.outcome` report per job (B5), fire-and-forget: it must never
 *    delay or gate Apply.
 */
import { useEffect, useRef, useState } from "react";
import type { ProposalJson, KeepShape, Model } from "@shared/automask/types";
import { shapeDeltas, withControl, reseed, modelOf, type ControlId, type ShapeKind, type ShapeDeltas } from "@shared/automask/shape";

export const PROPOSAL_POLL_MS = 1000;
export const PROPOSAL_POLL_TIMEOUT_MS = 60_000;

export function useAutomaskProposal(jobId: string, active: boolean): ProposalJson | null {
  const [body, setBody] = useState<ProposalJson | null>(null);
  const startedFor = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    // One fetch sequence per job per mount: `job.status` flips re-run nothing here (kickoff §4 pending row).
    if (!active || !jobId || startedFor.current === jobId) return;
    startedFor.current = jobId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const t0 = Date.now();
    const attempt = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/template-mask/proposal`, { cache: "no-store" });
        if (!mounted.current || !res.ok) return;
        const p = (await res.json()) as ProposalJson;
        if (!mounted.current) return;
        if (p.status === "pending") {
          if (Date.now() - t0 < PROPOSAL_POLL_TIMEOUT_MS) timer = setTimeout(() => { void attempt(); }, PROPOSAL_POLL_MS);
          return;
        }
        if (p.status === "ready" && p.ui_enabled === true && p.keep && p.model && p.width && p.height && p.grade && p.tier) setBody(p);
      } catch (e) {
        console.warn("automask: proposal fetch failed", e);
      }
    };
    void attempt();
    return () => { if (timer) clearTimeout(timer); };
  }, [jobId, active]);

  return body;
}

// ---- session -------------------------------------------------------------------------------------------------------

export interface ProposalSession {
  body: ProposalJson;
  fitted: KeepShape;
  current: KeepShape;
  mode: "proposal" | "accepted";
  controlsUsed: string[];
  tRendered: number | null;
  freehand: boolean;     // a hand stroke was unioned with the accepted cone (sign-off §10-E)
  dismissed: boolean;    // the layer is gone for good: stroke / Clear / Erase All / Draw from scratch
  posted: boolean;       // the one outcome line for this job has been sent (kickoff §3.8)
}

export type SessionAction =
  | { type: "init"; body: ProposalJson }
  | { type: "control"; id: ControlId; value: number }
  | { type: "nudge"; dx: number; dy: number }
  | { type: "switch"; kind: ShapeKind }
  | { type: "accept" }
  | { type: "adjust" }
  | { type: "dismiss" }
  | { type: "freehand" }
  | { type: "rendered"; t: number }
  | { type: "posted" };

function used(list: string[], id: string): string[] { return list.includes(id) ? list : [...list, id]; }

export function sessionReducer(s: ProposalSession | null, a: SessionAction): ProposalSession | null {
  if (a.type === "init") {
    if (!a.body.keep) return s;
    return { body: a.body, fitted: a.body.keep, current: a.body.keep, mode: "proposal", controlsUsed: [], tRendered: null, freehand: false, dismissed: false, posted: false };
  }
  if (!s) return s;
  if (a.type === "posted") return { ...s, posted: true };
  if (a.type === "rendered") return s.tRendered === null ? { ...s, tRendered: a.t } : s;
  if (s.dismissed) return s;
  const frame = { w: s.body.width ?? 0, h: s.body.height ?? 0 };
  switch (a.type) {
    case "control": return s.mode === "proposal" ? { ...s, current: withControl(s.current, a.id, a.value, frame), controlsUsed: used(s.controlsUsed, a.id) } : s;
    case "nudge": return s.mode === "proposal" ? { ...s, current: withControl(s.current, "position", { dx: a.dx, dy: a.dy }, frame), controlsUsed: used(s.controlsUsed, "position") } : s;
    case "switch": return s.mode === "proposal" && a.kind !== s.current.kind ? { ...s, current: reseed(s.current, a.kind, frame) } : s;
    case "accept": return s.mode === "proposal" ? { ...s, mode: "accepted" } : s;
    case "adjust": return s.mode === "accepted" ? { ...s, mode: "proposal", freehand: false } : s;
    case "dismiss": return { ...s, dismissed: true };
    case "freehand": return s.mode === "accepted" ? { ...s, freehand: true } : s;
    default: return s;
  }
}

// ---- outcome (kickoff §2.5) ------------------------------------------------------------------------------------------

export interface OutcomeBody {
  outcome: "accept" | "edit" | "draw_from_scratch";
  controls_used: string[];
  deltas: ShapeDeltas | null;
  model_switch: { from: Model; to: Model } | null;
  final_keep: KeepShape | null;
  fingerprint: null;
  template: null;
  grade_shown: "proposed" | "check_depth";
  tier: "T1" | "T0T1";
  ms_to_decision: number;
}

const EDIT_PX = 0.5, EDIT_DEG = 0.5;

/** `edit` when the family changed, a hand stroke was added, or any |Δ| exceeds 0.5 px / 0.5° (kickoff §3.5); else `accept`. */
export function decideOutcome(s: ProposalSession): "accept" | "edit" {
  if (s.freehand || s.fitted.kind !== s.current.kind) return "edit";
  const d = shapeDeltas(s.fitted, s.current);
  if (!d) return "edit";
  const moved = Math.abs(d.d_half_angle_deg ?? 0) > EDIT_DEG || Math.abs(d.d_apex_px ?? 0) > EDIT_PX || Math.abs(d.d_top_px ?? 0) > EDIT_PX
    || Math.abs(d.d_arc_px ?? 0) > EDIT_PX || Math.abs(d.d_top_width_px ?? 0) > EDIT_PX || Math.abs(d.d_depth_px ?? 0) > EDIT_PX;
  return moved ? "edit" : "accept";
}

export function buildOutcome(s: ProposalSession, outcome: OutcomeBody["outcome"], now: number): OutcomeBody {
  const from = modelOf(s.fitted.kind), to = modelOf(s.current.kind);
  return {
    outcome,
    controls_used: s.freehand ? used(s.controlsUsed, "freehand") : s.controlsUsed,
    deltas: shapeDeltas(s.fitted, s.current),                       // null across fan ↔ trap/rect, kept for trap ↔ rect
    model_switch: from !== to ? { from, to } : null,                 // sign-off §2 I: every family change, trap ↔ rect included
    final_keep: outcome === "draw_from_scratch" ? null : s.current,
    fingerprint: null,
    template: null,
    grade_shown: s.body.grade ?? "proposed",
    tier: s.body.tier ?? "T1",
    ms_to_decision: Math.max(0, Math.round(now - (s.tRendered ?? now))),
  };
}

export function postOutcome(jobId: string, body: OutcomeBody): void {
  try {
    fetch(`/api/jobs/${jobId}/template-mask/proposal/outcome`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true,
    })
      .then((r) => { if (!r.ok) console.warn("automask: outcome rejected", r.status); })
      .catch((e) => console.warn("automask: outcome failed", e));
  } catch (e) {
    console.warn("automask: outcome failed", e);
  }
}
