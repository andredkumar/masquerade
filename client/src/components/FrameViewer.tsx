import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronLeft, ChevronRight, AlertTriangle,
  Loader2, ArrowLeft, ArrowRight,
} from "lucide-react";

// ── Types matching the server's inference.json shape ─────────────────────

interface ViewerLabelSummary {
  labelId: string;
  name: string;
  modality: string | null;
  color: string;
  approved: boolean;
  avgConfidence: number;
  frameCount: number;
}

interface ViewerInfo {
  jobId: string;
  totalFrames: number;
  status: string;
  labels: ViewerLabelSummary[];
  hasFrames: boolean;
  hasInference: boolean;
  hasArtifacts: boolean;
}

interface PerFrameLabel {
  labelId: string;
  // 4d-1: the owning AIRun id, supplied by inference.json so the overlay URL
  // can be built in the canonical runId-scoped form. Null only when no run owns
  // the label (never when hasMask is true — see the overlay render filter).
  runId: string | null;
  name: string;
  modality: string | null;
  confidence: number;
  bbox: { x1: number; y1: number; x2: number; y2: number } | null;
  approved: boolean;
  hasMask: boolean;
}

interface InferenceData {
  jobId: string;
  imageWidth: number;
  imageHeight: number;
  outputSettings?: {
    size: string | null;             // 'original' | '512x512' | … | 'custom' | null
    aspectRatioMode: string | null;  // 'letterbox' | 'crop' | 'stretch' | null
  };
  labels: ViewerLabelSummary[];
  frames: Record<string, PerFrameLabel[]>;
}

type ViewMode = 'clean' | 'overlay' | 'bbox';

interface FrameViewerProps {
  jobId: string;
  onContinueToDownload: () => void;
  onBackToInference?: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────

const PREFETCH_RADIUS = 10;     // ±N frames around current
const PREFETCH_HARD_CAP = 30;   // never exceed this many <img> nodes total

// Mix-blend-mode for overlay stacking. Tested both:
//   'lighten' — picks brighter pixel per channel. Multiple green overlays
//     union cleanly because the unmasked pixels (original image) are
//     identical across overlays so they don't interfere.
//   'screen' — softer blend, slightly washes out the underlying image.
// 'lighten' wins for medical imagery where preserving original contrast matters.
const OVERLAY_BLEND: React.CSSProperties['mixBlendMode'] = 'lighten';

// ── Component ────────────────────────────────────────────────────────────

export default function FrameViewer({ jobId, onContinueToDownload, onBackToInference }: FrameViewerProps) {
  const [viewerInfo, setViewerInfo] = useState<ViewerInfo | null>(null);
  const [inferenceData, setInferenceData] = useState<InferenceData | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [mode, setMode] = useState<ViewMode>('clean');
  const [visibleLabels, setVisibleLabels] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // We no longer measure the rendered img size. The SVG overlay uses a
  // viewBox in IMAGE pixel coords (= source-video coords on the wire) and
  // sits absolutely over the img in an inline-block wrapper, so the
  // browser handles all scaling. See bbox <svg> below.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ── Initial fetch (parallel) ────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    Promise.all([
      fetch(`/api/jobs/${jobId}/viewer-info`).then(async r => {
        if (r.status === 410) throw new Error('frames_swept');
        if (!r.ok) throw new Error(`viewer-info failed: ${r.status}`);
        return r.json() as Promise<ViewerInfo>;
      }),
      fetch(`/api/jobs/${jobId}/inference.json`).then(async r => {
        if (r.status === 410) throw new Error('frames_swept');
        // 404 here is OK — means no inference yet (fresh post-Step-3 job).
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`inference.json failed: ${r.status}`);
        return r.json() as Promise<InferenceData>;
      }),
    ]).then(([info, inf]) => {
      if (cancelled) return;
      setViewerInfo(info);
      setInferenceData(inf);
      // Default visible: all approved labels
      const initial = new Set<string>();
      for (const l of info.labels) {
        if (l.approved) initial.add(l.labelId);
      }
      setVisibleLabels(initial);
      // Per C: lock to Clean when no labels exist
      if (info.labels.length === 0) {
        setMode('clean');
      }
      setLoading(false);
    }).catch((err: Error) => {
      if (cancelled) return;
      if (err.message === 'frames_swept') {
        setLoadError("This session's frames are no longer available. Please re-run inference.");
      } else {
        setLoadError(err.message || 'Failed to load frame data');
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [jobId]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────

  useEffect(() => {
    if (!viewerInfo) return;
    const total = viewerInfo.totalFrames;
    if (total <= 0) return;

    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const step = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          setCurrentFrame(f => Math.max(0, f - step));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setCurrentFrame(f => Math.min(total - 1, f + step));
          break;
        case 'Home':
          e.preventDefault();
          setCurrentFrame(0);
          break;
        case 'End':
          e.preventDefault();
          setCurrentFrame(total - 1);
          break;
        case ' ':
          // Cycle Clean → Overlay → Bbox → Clean
          // Skip Overlay if artifacts unavailable.
          e.preventDefault();
          setMode(m => {
            const canOverlay = !!viewerInfo.hasArtifacts;
            const seq: ViewMode[] = canOverlay
              ? ['clean', 'overlay', 'bbox']
              : ['clean', 'bbox'];
            const idx = seq.indexOf(m);
            return seq[(idx + 1) % seq.length];
          });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewerInfo]);

  // ── Slider scrub (debounced) ────────────────────────────────────────

  const sliderTimerRef = useRef<number | null>(null);
  const onSliderChange = useCallback((vals: number[]) => {
    const v = vals[0] ?? 0;
    // Update immediately so the slider feels responsive; the prefetch effect
    // throttles itself separately.
    if (sliderTimerRef.current !== null) {
      window.clearTimeout(sliderTimerRef.current);
    }
    sliderTimerRef.current = window.setTimeout(() => {
      setCurrentFrame(v);
      sliderTimerRef.current = null;
    }, 16);
  }, []);

  // ── Per-frame label data for current frame ──────────────────────────

  const currentFrameLabels: PerFrameLabel[] = useMemo(() => {
    if (!inferenceData) return [];
    return inferenceData.frames[String(currentFrame)] || [];
  }, [inferenceData, currentFrame]);

  // ── Visible label projection (filters out hidden / unapproved) ──────

  const visiblePerFrameLabels = useMemo(() => {
    return currentFrameLabels.filter(l => l.approved && visibleLabels.has(l.labelId));
  }, [currentFrameLabels, visibleLabels]);

  // ── URL builders (always keyed by labelId, never by array index) ────

  const frameUrl = useCallback(
    (n: number) => `/api/jobs/${jobId}/frames/${n}.png`,
    [jobId]
  );
  // 4d-1: canonical runId-scoped overlay URL only. The legacy labelId-only alias
  // is never constructed here — runId comes from the per-frame label payload.
  const overlayUrl = useCallback(
    (runId: string, labelId: string, n: number) =>
      `/api/jobs/${jobId}/ai/runs/${runId}/overlays/${labelId}/${n}.png`,
    [jobId]
  );

  // ── Aspect-mode warning gate ────────────────────────────────────────
  // Bbox coords are stored in source-video pixel space. When outputSize is
  // 'original' OR aspectRatioMode is 'letterbox', the displayed frame's
  // content area still has the source-video aspect ratio (with possible
  // black bars), so the SVG viewBox aligns. With 'crop' or 'stretch', the
  // frame is geometrically warped and bbox positions can drift.
  const aspectMaybeOff = useMemo(() => {
    const os = inferenceData?.outputSettings;
    if (!os) return false;
    const size = os.size || 'original';
    const mode = os.aspectRatioMode || 'letterbox';
    return size !== 'original' && mode !== 'letterbox';
  }, [inferenceData?.outputSettings]);

  // ── Mode-aware prefetch window ──────────────────────────────────────
  // Render hidden <img> nodes for currentFrame ± PREFETCH_RADIUS to warm
  // the browser cache. Frame URLs are always in the window; overlay URLs
  // only if mode === 'overlay'. We rebuild from scratch on every change
  // (mode, current frame, visibleLabels), capped at PREFETCH_HARD_CAP nodes.

  const prefetchUrls = useMemo(() => {
    if (!viewerInfo) return [];
    const urls: string[] = [];
    const total = viewerInfo.totalFrames;
    const r = Math.min(PREFETCH_RADIUS, Math.floor((PREFETCH_HARD_CAP - 1) / 2));

    const includeOverlays = mode === 'overlay' && viewerInfo.hasArtifacts;
    const visibleArr = Array.from(visibleLabels);

    // Frames first (essential for clean and bbox modes too)
    for (let d = -r; d <= r; d++) {
      const n = currentFrame + d;
      if (n < 0 || n >= total) continue;
      if (n === currentFrame) continue; // visible img handles this
      urls.push(frameUrl(n));
      if (urls.length >= PREFETCH_HARD_CAP) break;
    }

    if (includeOverlays) {
      // Tighter radius for overlays since each visible label adds another asset
      const overlayBudget = PREFETCH_HARD_CAP - urls.length;
      const overlayRadius = Math.max(1, Math.floor(overlayBudget / Math.max(1, visibleArr.length) / 2));
      for (let d = -overlayRadius; d <= overlayRadius; d++) {
        const n = currentFrame + d;
        if (n < 0 || n >= total) continue;
        for (const lid of visibleArr) {
          // Only prefetch if this frame actually has a mask for this label.
          // Use the per-frame label's runId for the canonical overlay URL.
          const frameLabels = inferenceData?.frames[String(n)] || [];
          const match = frameLabels.find(l => l.labelId === lid && l.hasMask && l.runId);
          if (!match || !match.runId) continue;
          urls.push(overlayUrl(match.runId, lid, n));
          if (urls.length >= PREFETCH_HARD_CAP) break;
        }
        if (urls.length >= PREFETCH_HARD_CAP) break;
      }
    }
    return urls;
  }, [viewerInfo, inferenceData, currentFrame, mode, visibleLabels, frameUrl, overlayUrl]);

  // ── Render ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading frames…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-md mx-auto mt-12 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <div className="flex items-start gap-2 text-destructive">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Frame data unavailable</p>
            <p className="mt-1 text-muted-foreground">{loadError}</p>
            {onBackToInference && (
              <Button size="sm" variant="outline" className="mt-3" onClick={onBackToInference}>
                <ArrowLeft size={14} className="mr-1" />
                Back to AI Analysis
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!viewerInfo) return null;
  const totalFrames = viewerInfo.totalFrames;

  // Disabled-state hints for the mode toggle
  const overlayDisabled = !viewerInfo.hasArtifacts;
  const noLabels = viewerInfo.labels.length === 0;

  return (
    <div ref={containerRef} className="flex flex-col h-full p-6 gap-3">
      {/* Banner: artifact store empty (post-restart) */}
      {viewerInfo.hasInference && !viewerInfo.hasArtifacts && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="flex-1">
            <p className="font-medium text-amber-600 dark:text-amber-400">
              Overlays unavailable for this session (server restarted since inference).
            </p>
            <p className="text-muted-foreground mt-0.5">
              Frames and bbox prompts are still available.
              {onBackToInference && (
                <button onClick={onBackToInference} className="ml-1 underline hover:text-foreground">
                  Re-run inference
                </button>
              )}
              {' '}to restore.
            </p>
          </div>
        </div>
      )}

      {/* Banner: no labels yet */}
      {!viewerInfo.hasInference && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No AI labels yet — run inference to enable overlays. You can still scrub the masked frames here.
        </div>
      )}

      {/* Banner: bbox alignment may be inaccurate (crop/stretch + non-original size) */}
      {aspectMaybeOff && mode === 'bbox' && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="viewer-aspect-warning"
        >
          Bbox positions may be inaccurate when output size differs from source with crop/stretch aspect mode. Use letterbox or original for precise overlay.
        </div>
      )}

      {/* Frame display + overlays.
          Wrapper is `inline-block` and sized to the img content (img has its
          own max-w/max-h constraints). Both the overlay PNG and the bbox SVG
          are absolute-positioned and `inset-0`; because the wrapper hugs the
          img, inset-0 = the painted image area. The bbox <svg> uses a viewBox
          in IMAGE pixel coords (= source-video coords) so the browser handles
          all scaling — no manual displaySize math required. */}
      <div className="flex-1 flex items-center justify-center min-h-0 overflow-hidden bg-black rounded-md">
        <div className="relative inline-block max-w-[80vw] max-h-[70vh]">
          <img
            src={frameUrl(currentFrame)}
            alt={`Frame ${currentFrame}`}
            className="block max-w-full max-h-[70vh] object-contain select-none"
            draggable={false}
            loading="eager"
            onError={() => setLoadError("Frame failed to load. The session may have expired.")}
            data-testid="viewer-frame"
          />

          {/* Overlay PNGs stacked with mix-blend-mode (only in 'overlay' mode) */}
          {mode === 'overlay' && viewerInfo.hasArtifacts && visiblePerFrameLabels
            .filter(l => l.hasMask && l.runId)
            .map(l => (
              <img
                key={l.labelId}
                src={overlayUrl(l.runId as string, l.labelId, currentFrame)}
                alt=""
                aria-hidden
                className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
                style={{ mixBlendMode: OVERLAY_BLEND }}
                draggable={false}
              />
            ))
          }

          {/* SVG bbox layer (only in 'bbox' mode). viewBox = source-video
              pixel space; preserveAspectRatio matches the img's object-contain
              behavior so the SVG content area aligns with the visible image
              content area (including any letterboxing inside the wrapper). */}
          {mode === 'bbox' && inferenceData && inferenceData.imageWidth > 0 && inferenceData.imageHeight > 0 && (
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox={`0 0 ${inferenceData.imageWidth} ${inferenceData.imageHeight}`}
              preserveAspectRatio="xMidYMid meet"
              data-testid="viewer-bbox-svg"
            >
              {visiblePerFrameLabels.map(l => {
                if (!l.bbox) return null;
                const labelSummary = inferenceData.labels.find(x => x.labelId === l.labelId);
                const color = labelSummary?.color || 'rgba(34, 211, 238, 0.95)';
                const x1 = Math.min(l.bbox.x1, l.bbox.x2);
                const y1 = Math.min(l.bbox.y1, l.bbox.y2);
                const w = Math.abs(l.bbox.x2 - l.bbox.x1);
                const h = Math.abs(l.bbox.y2 - l.bbox.y1);
                // Stroke / font scale with image natural dims so the rect is
                // visible whether the image is 512px wide or 1920px wide.
                const stroke = Math.max(2, inferenceData.imageWidth / 400);
                const fontSize = Math.max(11, inferenceData.imageWidth / 60);
                const tagH = fontSize * 1.5;
                return (
                  <g key={l.labelId}>
                    <rect
                      x={x1} y={y1} width={w} height={h}
                      fill={color}
                      fillOpacity={0.15}
                      stroke={color}
                      strokeWidth={stroke}
                    />
                    {/* Label tag above the box (clamped to top edge) */}
                    <rect
                      x={x1}
                      y={Math.max(0, y1 - tagH)}
                      width={Math.min(inferenceData.imageWidth - x1, (l.name.length + 5) * fontSize * 0.6)}
                      height={tagH}
                      fill={color}
                      fillOpacity={0.95}
                    />
                    <text
                      x={x1 + fontSize * 0.4}
                      y={Math.max(fontSize, y1 - fontSize * 0.4)}
                      fontSize={fontSize}
                      fill="white"
                      fontFamily="system-ui, sans-serif"
                    >
                      {l.name} {(l.confidence * 100).toFixed(0)}%
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>

      {/* Frame counter + slider */}
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground text-center">
          Frame <span className="font-mono text-foreground">{currentFrame + 1}</span>
          {' / '}
          <span className="font-mono">{totalFrames}</span>
        </div>
        <Slider
          min={0}
          max={Math.max(0, totalFrames - 1)}
          step={1}
          value={[currentFrame]}
          onValueChange={onSliderChange}
          disabled={totalFrames <= 1}
          data-testid="viewer-slider"
        />
      </div>

      {/* Prev / Mode / Next */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCurrentFrame(f => Math.max(0, f - 1))}
          disabled={currentFrame === 0}
          data-testid="viewer-prev"
        >
          <ChevronLeft size={14} className="mr-1" />
          Prev
        </Button>

        {/* 3-state segmented mode toggle */}
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'clean'}
            onClick={() => setMode('clean')}
            className={`px-3 py-1.5 ${mode === 'clean' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            data-testid="viewer-mode-clean"
          >
            Clean
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'overlay'}
            onClick={() => !overlayDisabled && !noLabels && setMode('overlay')}
            disabled={overlayDisabled || noLabels}
            title={
              noLabels ? 'Run inference first to enable overlays'
                : overlayDisabled ? 'Overlays unavailable — server restarted since inference'
                : undefined
            }
            className={`px-3 py-1.5 border-l border-border ${
              mode === 'overlay' ? 'bg-primary text-primary-foreground'
                : (overlayDisabled || noLabels) ? 'opacity-40 cursor-not-allowed'
                : 'hover:bg-muted'
            }`}
            data-testid="viewer-mode-overlay"
          >
            Overlay
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'bbox'}
            onClick={() => !noLabels && setMode('bbox')}
            disabled={noLabels}
            title={noLabels ? 'Run inference first to enable bbox view' : undefined}
            className={`px-3 py-1.5 border-l border-border ${
              mode === 'bbox' ? 'bg-primary text-primary-foreground'
                : noLabels ? 'opacity-40 cursor-not-allowed'
                : 'hover:bg-muted'
            }`}
            data-testid="viewer-mode-bbox"
          >
            Bbox
          </button>
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={() => setCurrentFrame(f => Math.min(totalFrames - 1, f + 1))}
          disabled={currentFrame >= totalFrames - 1}
          data-testid="viewer-next"
        >
          Next
          <ChevronRight size={14} className="ml-1" />
        </Button>
      </div>

      {/* Labels panel */}
      {viewerInfo.labels.length > 0 ? (
        <div className="rounded-md border border-border p-2 max-h-40 overflow-y-auto space-y-1.5">
          {viewerInfo.labels.map(l => {
            const isVisible = visibleLabels.has(l.labelId);
            const onCurrentFrame = currentFrameLabels.find(c => c.labelId === l.labelId);
            return (
              <label
                key={l.labelId}
                className={`flex items-center gap-2 text-xs cursor-pointer ${l.approved ? '' : 'opacity-50'}`}
                title={l.approved ? '' : 'Unapproved label — hidden from download'}
              >
                <Checkbox
                  checked={isVisible}
                  onCheckedChange={(checked) => {
                    setVisibleLabels(prev => {
                      const next = new Set(prev);
                      if (checked) next.add(l.labelId); else next.delete(l.labelId);
                      return next;
                    });
                  }}
                  disabled={!l.approved}
                />
                <span
                  className="inline-block w-3 h-3 rounded-sm shrink-0"
                  style={{ backgroundColor: l.color }}
                  aria-hidden
                />
                <span className="font-medium">{l.name}</span>
                {l.modality && (
                  <span className="text-muted-foreground">· {l.modality}</span>
                )}
                <span className="text-muted-foreground ml-auto tabular-nums">
                  {onCurrentFrame
                    ? `${(onCurrentFrame.confidence * 100).toFixed(0)}% on this frame`
                    : `${(l.avgConfidence * 100).toFixed(0)}% avg`}
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground text-center">
          No AI labels yet — run inference to see overlays here.
        </div>
      )}

      {/* Footer nav: back / continue */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
        {onBackToInference ? (
          <Button size="sm" variant="ghost" onClick={onBackToInference} data-testid="viewer-back">
            <ArrowLeft size={14} className="mr-1" />
            Back to AI Analysis
          </Button>
        ) : <span />}
        <Button size="sm" onClick={onContinueToDownload} data-testid="viewer-continue">
          Continue to Download
          <ArrowRight size={14} className="ml-1" />
        </Button>
      </div>

      {/* Hidden prefetch nodes — never rendered visibly. Browser caches the
          fetched bytes and the visible <img> picks them up instantly when
          the user scrubs into them. */}
      <div aria-hidden style={{ display: 'none' }}>
        {prefetchUrls.map(u => (
          <img key={u} src={u} alt="" loading="lazy" />
        ))}
      </div>
    </div>
  );
}
