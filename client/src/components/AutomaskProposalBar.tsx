/**
 * Auto-mask Round 2B-2 — the proposal bar (requirements B1, B2, B3, B7; docs/refactor/AUTOMASK_ROUND2B2_PLAN.md §1, §7).
 *
 * Renders only while a proposal session exists, so with `AUTOMASK_UI` off (or a withheld / errored proposal) the spoke's
 * DOM is byte for byte today's. Grade words only (kickoff §2.6). The state lives in the spoke's session reducer; this
 * component is presentation plus the nudge scheduler and the keyboard arrows (active in `proposal` mode only).
 */
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Check, Pencil, Undo2 } from "lucide-react";
import type { KeepShape } from "@shared/automask/types";
import { controlSpecs, readouts, type ControlId, type ControlSpec, type ShapeKind } from "@shared/automask/shape";
import { useHoldRepeat, type Dir } from "@/hooks/useHoldRepeat";

export interface AutomaskProposalBarProps {
  fitted: KeepShape;
  current: KeepShape;
  mode: "proposal" | "accepted";
  grade: "proposed" | "check_depth" | null;
  frame: { w: number; h: number };
  onControl: (id: ControlId, value: number) => void;
  onNudge: (dx: number, dy: number) => void;
  onSwitch: (kind: ShapeKind) => void;
  onAccept: () => void;
  onAdjust: () => void;
  onDrawFromScratch: () => void;
}

const ARROWS: Record<string, Dir> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable || el.getAttribute("role") === "slider";
}

const fmt = (v: number | undefined, unit: "deg" | "px"): string => (v === undefined || Number.isNaN(v) ? "—" : unit === "deg" ? `${v.toFixed(1)}°` : `${Math.round(v)}`);
const fmtDelta = (a: number | undefined, b: number | undefined, unit: "deg" | "px"): string => {
  if (a === undefined || b === undefined) return "—";
  const d = b - a;
  const s = unit === "deg" ? d.toFixed(1) : Math.round(d).toString();
  return d > 0 ? `+${s}` : d < 0 ? s : "±0";
};

export default function AutomaskProposalBar({ fitted, current, mode, grade, frame, onControl, onNudge, onSwitch, onAccept, onAdjust, onDrawFromScratch }: AutomaskProposalBarProps) {
  const hold = useHoldRepeat(onNudge);
  const active = mode === "proposal";

  // B3 keyboard arrows: only while a proposal is showing; never from a text input, select, textarea or a slider thumb
  // (Radix handles those, Shift ×10 included); never with a browser modifier; preventDefault so the page does not scroll.
  useEffect(() => {
    if (!active) return;
    let held: string | null = null;
    const down = (e: KeyboardEvent) => {
      const d = ARROWS[e.key];
      if (!d) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (e.repeat || held === e.key) return;       // the OS auto-repeat is not our schedule
      held = e.key;
      hold.start(d, e.shiftKey);
    };
    const up = (e: KeyboardEvent) => { if (e.key === held) { held = null; hold.stop(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); hold.stop(); };
  }, [active, hold.start, hold.stop]);

  const gradeWord = grade === "check_depth" ? "Proposed — check the depth" : "Proposed";
  const specs: ControlSpec[] = controlSpecs(current, frame.w, frame.h);
  const now = readouts(current);
  const sameFamily = fitted.kind === current.kind || (fitted.kind !== "fan" && current.kind !== "fan");
  const was = sameFamily ? readouts(fitted) : null;

  const arrow = (d: Dir, Icon: typeof ChevronUp, label: string, testId: string) => (
    <Button
      type="button" variant="outline" size="sm" className="h-7 w-7 p-0" aria-label={label} title={`${label} (hold to accelerate, Shift = ×10)`} data-testid={testId}
      onPointerDown={(e) => { e.preventDefault(); hold.start(d, e.shiftKey); }}
      onPointerUp={hold.stop} onPointerLeave={hold.stop} onPointerCancel={hold.stop}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onNudge(d[0] * (e.shiftKey ? 10 : 1), d[1] * (e.shiftKey ? 10 : 1)); } }}
    >
      <Icon size={14} />
    </Button>
  );

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-3" data-testid="automask-bar">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium" data-testid="automask-grade">{mode === "accepted" ? "Cone accepted" : gradeWord}</span>
        {active && (
          <ToggleGroup type="single" size="sm" variant="outline" value={current.kind} onValueChange={(v) => { if (v) onSwitch(v as ShapeKind); }} aria-label="Model" data-testid="automask-model">
            <ToggleGroupItem value="fan" aria-label="Fan" data-testid="automask-model-fan">Fan</ToggleGroupItem>
            <ToggleGroupItem value="trap" aria-label="Trapezoid" data-testid="automask-model-trap">Trapezoid</ToggleGroupItem>
            <ToggleGroupItem value="rect" aria-label="Rectangle" data-testid="automask-model-rect">Rectangle</ToggleGroupItem>
          </ToggleGroup>
        )}
        <div className="ml-auto flex items-center gap-2">
          {active ? (
            <Button type="button" size="sm" onClick={onAccept} data-testid="automask-accept"><Check size={14} className="mr-1" />Accept</Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={onAdjust} data-testid="automask-adjust"><Undo2 size={14} className="mr-1" />Adjust</Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onDrawFromScratch} data-testid="automask-draw"><Pencil size={14} className="mr-1" />Draw from scratch</Button>
        </div>
      </div>

      {active && (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          {specs.map((c) => (
            <div key={c.id} className="w-48" data-testid={`automask-control-${c.id}`}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate">{c.label}</span>
                <span className="whitespace-nowrap font-mono text-muted-foreground" data-testid={`automask-readout-${c.id}`}>
                  {fmt(was?.[c.id], c.unit)} → {fmt(now[c.id], c.unit)} ({fmtDelta(was?.[c.id], now[c.id], c.unit)}{c.unit === "px" ? " px" : ""})
                  {c.id === "top_arc" && <span className="text-muted-foreground/70"> · arc at y {Math.round(now.arc_y)}</span>}
                </span>
              </div>
              <Slider min={c.min} max={c.max} step={c.step} value={[Math.min(c.max, Math.max(c.min, now[c.id]))]} onValueChange={([v]) => onControl(c.id, v)} aria-label={c.label} />
            </div>
          ))}
          <div className="flex items-center gap-3" data-testid="automask-nudge">
            <div className="grid grid-cols-3 gap-0.5">
              <span />
              {arrow([0, -1], ChevronUp, "Move up", "automask-nudge-up")}
              <span />
              {arrow([-1, 0], ChevronLeft, "Move left", "automask-nudge-left")}
              <span />
              {arrow([1, 0], ChevronRight, "Move right", "automask-nudge-right")}
              <span />
              {arrow([0, 1], ChevronDown, "Move down", "automask-nudge-down")}
              <span />
            </div>
            <div className="text-xs">
              <div>{current.kind === "fan" ? "apex" : "position"}</div>
              <div className="whitespace-nowrap font-mono text-muted-foreground" data-testid="automask-readout-position">
                {was ? `${Math.round(was.position_x)}, ${Math.round(was.position_y)}` : "—"} → {Math.round(now.position_x)}, {Math.round(now.position_y)}
                {was ? ` (${fmtDelta(was.position_x, now.position_x, "px")}, ${fmtDelta(was.position_y, now.position_y, "px")})` : ""}
              </div>
            </div>
          </div>
        </div>
      )}

      {active && (
        <p className="text-xs text-muted-foreground">
          Drag the yellow handle or use the arrow keys to move the whole shape (hold to accelerate, Shift = ×10). Drawing on the canvas replaces the proposal.
        </p>
      )}
    </div>
  );
}
