import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Loader2, Sparkles, AlertTriangle, CheckCircle2, X,
  Square as IconSquare, Circle as IconCircle, Hexagon as IconHexagon, Paintbrush as IconBrush,
} from "lucide-react";
import { useWebSocket } from "@/hooks/useWebSocket";

interface VideoMetadata {
  width?: number;
  height?: number;
}

export type Modality = 'cardiac' | 'lung' | 'abdominal' | 'other';

interface CommandInputProps {
  jobId: string | null;
  currentFrame: number;
  firstFrameBase64: string | null;
  videoMetadata?: VideoMetadata | null;
  modality: Modality | null;
  onModalityChange: (m: Modality | null) => void;
  onMaskGenerated: (maskBase64: string, aiLabel?: { intent: string; target: string; confidence: number | null; model: string }) => void;
  onLabelAdded?: () => void;
  selectedTask?: string;
}

const MODALITY_OPTIONS: Array<{ id: Modality; emoji: string; label: string }> = [
  { id: 'cardiac',   emoji: '🫀', label: 'Cardiac' },
  { id: 'lung',      emoji: '🫁', label: 'Lung' },
  { id: 'abdominal', emoji: '🫃', label: 'Abdominal' },
  { id: 'other',     emoji: '🔬', label: 'Something Else' },
];

const TASK_PLACEHOLDERS: Record<string, string> = {
  segment: 'e.g. segment the pleural effusion',
  classify: 'e.g. classify this view',
  detect: 'e.g. detect all b-lines',
  label: 'e.g. label the pleural line',
  export: 'e.g. export all labeled effusions',
};

type Stage = 'idle' | 'parsing' | 'inferring' | 'done' | 'error' | 'clarify';

type DrawMode = 'rect' | 'circle' | 'polygon' | 'brush';

interface Pt { x: number; y: number; }
interface DisplayBox { x1: number; y1: number; x2: number; y2: number; }

// Discriminated union describing the user's freehand annotation. Regardless of
// shape, the bbox we send to MedSAM2 is the axis-aligned bounding box of the shape.
type Shape =
  | { type: 'rect'; start: Pt; end: Pt; completed: boolean }
  | { type: 'circle'; center: Pt; edge: Pt; completed: boolean }
  | { type: 'polygon'; points: Pt[]; completed: boolean }
  | { type: 'brush'; points: Pt[]; completed: boolean };

function shapeBbox(shape: Shape): DisplayBox | null {
  switch (shape.type) {
    case 'rect':
      return {
        x1: Math.min(shape.start.x, shape.end.x),
        y1: Math.min(shape.start.y, shape.end.y),
        x2: Math.max(shape.start.x, shape.end.x),
        y2: Math.max(shape.start.y, shape.end.y),
      };
    case 'circle': {
      const rx = Math.abs(shape.edge.x - shape.center.x);
      const ry = Math.abs(shape.edge.y - shape.center.y);
      return {
        x1: shape.center.x - rx,
        y1: shape.center.y - ry,
        x2: shape.center.x + rx,
        y2: shape.center.y + ry,
      };
    }
    case 'polygon':
    case 'brush': {
      if (shape.points.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of shape.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x1: minX, y1: minY, x2: maxX, y2: maxY };
    }
  }
}

const CYAN_FILL = 'rgba(34, 211, 238, 0.20)';
const CYAN_STROKE = 'rgba(34, 211, 238, 0.95)';
const CYAN_DASH = 'rgba(34, 211, 238, 0.85)';

export default function CommandInput({ jobId, currentFrame, firstFrameBase64, videoMetadata, modality, onModalityChange, onMaskGenerated, onLabelAdded, selectedTask = 'segment' }: CommandInputProps) {
  const [command, setCommand] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);

  // Drawing state
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<DrawMode>('rect');
  const [shape, setShape] = useState<Shape | null>(null);
  const [isDragging, setIsDragging] = useState(false);        // drag-based modes (rect/circle/brush)
  const [polygonHover, setPolygonHover] = useState<Pt | null>(null); // ghost segment for polygon
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [overlayDataUrl, setOverlayDataUrl] = useState<string | null>(null);

  // Per-frame inference progress (pushed from the server via Socket.IO)
  const { socket } = useWebSocket();
  useEffect(() => {
    if (!socket || !jobId) return;
    socket.emit('join', jobId);
    const onInferProgress = (data: { jobId: string; current: number; total: number; done?: boolean }) => {
      if (data.jobId !== jobId) return;
      if (data.done) return;
      setStatusMessage(`Analyzing frame ${data.current} of ${data.total}...`);
    };
    socket.on('inference-progress', onInferProgress);
    return () => { socket.off('inference-progress', onInferProgress); };
  }, [socket, jobId]);

  // -------------- drawing helpers --------------

  const redraw = useCallback((s: Shape | null, hover: Pt | null, w: number, h: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!s) return;

    ctx.fillStyle = CYAN_FILL;
    ctx.strokeStyle = CYAN_STROKE;
    ctx.lineWidth = 2;

    switch (s.type) {
      case 'rect': {
        const rx = Math.min(s.start.x, s.end.x);
        const ry = Math.min(s.start.y, s.end.y);
        const rw = Math.abs(s.end.x - s.start.x);
        const rh = Math.abs(s.end.y - s.start.y);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx + 1, ry + 1, Math.max(0, rw - 2), Math.max(0, rh - 2));
        break;
      }
      case 'circle': {
        const rx = Math.abs(s.edge.x - s.center.x);
        const ry = Math.abs(s.edge.y - s.center.y);
        if (rx < 1 && ry < 1) break;
        ctx.beginPath();
        ctx.ellipse(s.center.x, s.center.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'polygon': {
        if (s.points.length === 0) break;
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        if (s.completed) {
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.stroke();
          // ghost segment from last vertex to hover point
          if (hover) {
            const last = s.points[s.points.length - 1];
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(hover.x, hover.y);
            ctx.stroke();
            ctx.restore();
          }
        }
        // vertex dots
        ctx.fillStyle = CYAN_STROKE;
        for (const p of s.points) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'brush': {
        if (s.points.length < 2) break;
        ctx.save();
        ctx.lineWidth = 12;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)';
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        ctx.stroke();
        ctx.restore();
        break;
      }
    }

    // After completion, draw the computed bbox as a dashed cyan rectangle
    if (s.completed) {
      const bb = shapeBbox(s);
      if (bb) {
        const bw = bb.x2 - bb.x1;
        const bh = bb.y2 - bb.y1;
        if (bw > 0 && bh > 0) {
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = CYAN_DASH;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bb.x1 + 0.5, bb.y1 + 0.5, bw, bh);
          ctx.restore();
        }
      }
    }
  }, []);

  const syncCanvasSize = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const rect = img.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === 0 || h === 0) return;
    canvas.width = w;
    canvas.height = h;
    setDisplaySize({ w, h });
    redraw(shape, polygonHover, w, h);
  }, [shape, polygonHover, redraw]);

  useEffect(() => {
    syncCanvasSize();
    window.addEventListener('resize', syncCanvasSize);
    return () => window.removeEventListener('resize', syncCanvasSize);
  }, [syncCanvasSize]);

  useEffect(() => {
    redraw(shape, polygonHover, displaySize.w, displaySize.h);
  }, [shape, polygonHover, displaySize.w, displaySize.h, redraw]);

  // Reset when job / base frame changes, and when switching mode
  useEffect(() => {
    setOverlayDataUrl(null);
    setShape(null);
    setPolygonHover(null);
    setIsDragging(false);
  }, [jobId, firstFrameBase64]);

  const handleModeChange = (m: DrawMode) => {
    setMode(m);
    setShape(null);
    setPolygonHover(null);
    setIsDragging(false);
  };

  const clearShape = () => {
    setShape(null);
    setPolygonHover(null);
    setIsDragging(false);
  };

  const pointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>): Pt | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    };
  };

  // -------------- mouse handlers (mode-dispatched) --------------

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === 'polygon') return; // polygon uses onClick / onDoubleClick
    const p = pointFromEvent(e);
    if (!p) return;
    setIsDragging(true);
    if (mode === 'rect') setShape({ type: 'rect', start: p, end: p, completed: false });
    else if (mode === 'circle') setShape({ type: 'circle', center: p, edge: p, completed: false });
    else if (mode === 'brush') setShape({ type: 'brush', points: [p], completed: false });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e);
    if (!p) return;
    if (mode === 'polygon') {
      if (shape && shape.type === 'polygon' && !shape.completed) {
        setPolygonHover(p);
      }
      return;
    }
    if (!isDragging || !shape) return;
    if (shape.type === 'rect') setShape({ ...shape, end: p });
    else if (shape.type === 'circle') setShape({ ...shape, edge: p });
    else if (shape.type === 'brush') setShape({ ...shape, points: [...shape.points, p] });
  };

  const onMouseUp = () => {
    if (mode === 'polygon') return;
    if (!isDragging || !shape) return;
    setIsDragging(false);

    // Reject tiny shapes (accidental clicks)
    const bb = shapeBbox(shape);
    if (!bb || (bb.x2 - bb.x1) < 4 || (bb.y2 - bb.y1) < 4) {
      setShape(null);
      return;
    }
    setShape({ ...shape, completed: true } as Shape);
  };

  const onClickCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'polygon') return;
    const p = pointFromEvent(e);
    if (!p) return;
    if (!shape || shape.type !== 'polygon') {
      setShape({ type: 'polygon', points: [p], completed: false });
    } else if (!shape.completed) {
      setShape({ ...shape, points: [...shape.points, p] });
    }
  };

  const onDoubleClickCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'polygon') return;
    if (!shape || shape.type !== 'polygon' || shape.completed) return;
    if (shape.points.length < 3) {
      setShape(null);
      setPolygonHover(null);
      return;
    }
    const bb = shapeBbox(shape);
    if (!bb || (bb.x2 - bb.x1) < 4 || (bb.y2 - bb.y1) < 4) {
      setShape(null);
      setPolygonHover(null);
      return;
    }
    setShape({ ...shape, completed: true });
    setPolygonHover(null);
  };

  // -------------- coord scaling + submit --------------

  const toImagePixelBox = (bb: DisplayBox): { x1: number; y1: number; x2: number; y2: number } | null => {
    const imgW = videoMetadata?.width;
    const imgH = videoMetadata?.height;
    if (!imgW || !imgH || displaySize.w === 0 || displaySize.h === 0) return null;
    const sx = imgW / displaySize.w;
    const sy = imgH / displaySize.h;
    return {
      x1: Math.max(0, Math.min(imgW, Math.round(bb.x1 * sx))),
      y1: Math.max(0, Math.min(imgH, Math.round(bb.y1 * sy))),
      x2: Math.max(0, Math.min(imgW, Math.round(bb.x2 * sx))),
      y2: Math.max(0, Math.min(imgH, Math.round(bb.y2 * sy))),
    };
  };

  const handleSubmit = async () => {
    if (!command.trim() || !jobId) return;

    try {
      setStage('parsing');
      setStatusMessage('Parsing command...');
      setConfidence(null);
      setModelUsed(null);

      const parseRes = await fetch('/api/ai/parse-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.trim() }),
      });

      if (!parseRes.ok) {
        const err = await parseRes.json();
        throw new Error(err.error || 'Failed to parse command');
      }

      const parsed = await parseRes.json();

      if (parsed.intent === 'clarify') {
        setStage('clarify');
        setStatusMessage(parsed.clarifyPrompt || 'Could you rephrase that?');
        return;
      }

      setStage('inferring');
      setStatusMessage(`Running ${parsed.intent} on "${parsed.target}"...`);

      // Only use completed shapes as a prompt (half-drawn shapes fall back to auto-prompt)
      const displayBB = shape && shape.completed ? shapeBbox(shape) : null;
      const pixelBox = displayBB ? toImagePixelBox(displayBB) : null;

      const inferRes = await fetch('/api/ai/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          command: command.trim(),
          frameBase64: firstFrameBase64?.replace('data:image/png;base64,', ''),
          bbox: pixelBox,
          useAutoPrompt: pixelBox == null,
          modality,
        }),
      });

      if (!inferRes.ok) {
        const err = await inferRes.json();
        throw new Error(err.error || 'Inference failed');
      }

      const result = await inferRes.json();

      if (result.maskBase64) {
        onMaskGenerated(result.maskBase64, {
          intent: parsed.intent,
          target: parsed.target || 'unknown',
          confidence: result.confidence ?? null,
          model: result.modelUsed || 'unknown',
        });
      }

      if (result.overlayBase64) {
        setOverlayDataUrl(`data:image/png;base64,${result.overlayBase64}`);
      } else {
        setOverlayDataUrl(null);
      }

      setConfidence(result.confidence);
      setModelUsed(result.modelUsed);
      setStage('done');
      setStatusMessage('Mask generated');
      onLabelAdded?.();
    } catch (err) {
      setStage('error');
      setStatusMessage(err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isLoading = stage === 'parsing' || stage === 'inferring';
  const previewSrc = overlayDataUrl || firstFrameBase64;

  // Cursor hint per mode
  const cursor = (() => {
    if (mode === 'polygon') return 'crosshair';
    if (mode === 'brush') return 'crosshair';
    if (isDragging) return 'crosshair';
    if (shape?.completed) return 'default';
    return 'crosshair';
  })();

  const modeBtn = (m: DrawMode, Icon: typeof IconSquare, label: string) => (
    <button
      type="button"
      onClick={() => handleModeChange(m)}
      title={label}
      aria-label={label}
      className={`p-1.5 rounded ${
        mode === m
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
      data-testid={`bbox-mode-${m}`}
    >
      <Icon size={14} />
    </button>
  );

  return (
    <div className="px-4 py-3 space-y-3">
      {/* Modality selector — must be chosen before Run AI is enabled */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium">What do you want to AI Label?</p>
        <div className="grid grid-cols-2 gap-1.5">
          {MODALITY_OPTIONS.map(opt => {
            const active = modality === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onModalityChange(opt.id)}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-foreground border-border hover:bg-muted'
                }`}
                data-testid={`modality-${opt.id}`}
                aria-pressed={active}
              >
                <span aria-hidden>{opt.emoji}</span>
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Frame preview with bbox drawing canvas (in-sidebar) */}
      {firstFrameBase64 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground leading-tight">
            Draw around the structure you want to segment, then type what it is and click Run.
            {mode === 'polygon' && ' Click to add points, double-click to close.'}
          </p>

          {/* Compact toolbar — icons only */}
          <div className="flex items-center gap-1">
            {modeBtn('rect', IconSquare, 'Rectangle')}
            {modeBtn('circle', IconCircle, 'Circle')}
            {modeBtn('polygon', IconHexagon, 'Polygon')}
            {modeBtn('brush', IconBrush, 'Brush')}
          </div>

          <div className="relative inline-block w-full rounded-md overflow-hidden border border-border bg-black">
            <img
              ref={imgRef}
              src={previewSrc || undefined}
              alt="Frame preview"
              className="block w-full h-auto select-none"
              draggable={false}
              onLoad={syncCanvasSize}
              data-testid="command-frame-preview"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full"
              style={{ cursor }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onClick={onClickCanvas}
              onDoubleClick={onDoubleClickCanvas}
              data-testid="command-bbox-canvas"
            />
            {shape && (
              <button
                type="button"
                onClick={clearShape}
                className="absolute top-1 right-1 flex items-center gap-1 rounded bg-background/90 text-foreground border border-border px-1.5 py-0.5 text-[10px] shadow-sm hover:bg-muted"
                data-testid="command-clear-box"
              >
                <X size={10} />
                Clear box
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={TASK_PLACEHOLDERS[selectedTask] || TASK_PLACEHOLDERS.segment}
          disabled={!jobId || isLoading}
          className="flex-1 text-sm"
        />
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!jobId || !command.trim() || !modality || isLoading}
          title={!modality ? 'Select a modality above first' : undefined}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-1" />
              Run AI
            </>
          )}
        </Button>
      </div>

      {/* Status area */}
      {stage !== 'idle' && (
        <div className="text-xs space-y-1">
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{statusMessage}</span>
            </div>
          )}

          {stage === 'clarify' && (
            <div className="flex items-start gap-2 text-amber-500">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {stage === 'error' && (
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {stage === 'done' && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-green-500">
                <CheckCircle2 className="h-3 w-3" />
                <span>{statusMessage}</span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                {confidence !== null && (
                  <span>Confidence: {Math.round(confidence * 100)}%</span>
                )}
                {modelUsed && (
                  <span>Model: {modelUsed}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
