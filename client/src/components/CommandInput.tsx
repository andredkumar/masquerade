import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Sparkles, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useWebSocket } from "@/hooks/useWebSocket";

interface VideoMetadata {
  width?: number;
  height?: number;
}

interface CommandInputProps {
  jobId: string | null;
  currentFrame: number;
  firstFrameBase64: string | null;
  videoMetadata?: VideoMetadata | null;
  onMaskGenerated: (maskBase64: string, aiLabel?: { intent: string; target: string; confidence: number | null; model: string }) => void;
  onLabelAdded?: () => void;
  selectedTask?: string;
}

const TASK_PLACEHOLDERS: Record<string, string> = {
  segment: 'e.g. segment the pleural effusion',
  classify: 'e.g. classify this view',
  detect: 'e.g. detect all b-lines',
  label: 'e.g. label the pleural line',
  export: 'e.g. export all labeled effusions',
};

type Stage = 'idle' | 'parsing' | 'inferring' | 'done' | 'error' | 'clarify';

interface DisplayBox {
  x1: number; // display-pixel coords
  y1: number;
  x2: number;
  y2: number;
}

export default function CommandInput({ jobId, currentFrame, firstFrameBase64, videoMetadata, onMaskGenerated, onLabelAdded, selectedTask = 'segment' }: CommandInputProps) {
  const [command, setCommand] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);

  // bbox drawing state (local to this sidebar panel)
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<DisplayBox | null>(null);
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
    return () => {
      socket.off('inference-progress', onInferProgress);
    };
  }, [socket, jobId]);

  // Resize canvas internal pixels to match the image's rendered size
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
    redraw(box, w, h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box]);

  useEffect(() => {
    syncCanvasSize();
    window.addEventListener('resize', syncCanvasSize);
    return () => window.removeEventListener('resize', syncCanvasSize);
  }, [syncCanvasSize]);

  // Reset overlay + box when job / frame changes
  useEffect(() => {
    setOverlayDataUrl(null);
    setBox(null);
  }, [jobId, firstFrameBase64]);

  const redraw = (b: DisplayBox | null, w: number, h: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!b) return;
    const rx = Math.min(b.x1, b.x2);
    const ry = Math.min(b.y1, b.y2);
    const rw = Math.abs(b.x2 - b.x1);
    const rh = Math.abs(b.y2 - b.y1);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.15)';   // cyan tint
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.95)'; // cyan border
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, Math.max(0, rw - 2), Math.max(0, rh - 2));
  };

  const pointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    };
  };

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e);
    if (!p) return;
    setIsDrawing(true);
    setDrawStart(p);
    setBox({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    redraw({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }, displaySize.w, displaySize.h);
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const next = { x1: drawStart.x, y1: drawStart.y, x2: p.x, y2: p.y };
    setBox(next);
    redraw(next, displaySize.w, displaySize.h);
  };

  const onCanvasMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    setDrawStart(null);
    // Reject tiny boxes (accidental clicks)
    if (box) {
      const w = Math.abs(box.x2 - box.x1);
      const h = Math.abs(box.y2 - box.y1);
      if (w < 4 || h < 4) {
        setBox(null);
        redraw(null, displaySize.w, displaySize.h);
      }
    }
  };

  const clearBox = () => {
    setBox(null);
    redraw(null, displaySize.w, displaySize.h);
  };

  // Convert display-pixel box to actual-image-pixel box
  const toImagePixelBox = (b: DisplayBox): { x1: number; y1: number; x2: number; y2: number } | null => {
    const imgW = videoMetadata?.width;
    const imgH = videoMetadata?.height;
    if (!imgW || !imgH || displaySize.w === 0 || displaySize.h === 0) return null;
    const sx = imgW / displaySize.w;
    const sy = imgH / displaySize.h;
    const x1 = Math.min(b.x1, b.x2) * sx;
    const y1 = Math.min(b.y1, b.y2) * sy;
    const x2 = Math.max(b.x1, b.x2) * sx;
    const y2 = Math.max(b.y1, b.y2) * sy;
    return {
      x1: Math.max(0, Math.min(imgW, Math.round(x1))),
      y1: Math.max(0, Math.min(imgH, Math.round(y1))),
      x2: Math.max(0, Math.min(imgW, Math.round(x2))),
      y2: Math.max(0, Math.min(imgH, Math.round(y2))),
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

      const pixelBox = box ? toImagePixelBox(box) : null;

      const inferRes = await fetch('/api/ai/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          command: command.trim(),
          frameBase64: firstFrameBase64?.replace('data:image/png;base64,', ''),
          bbox: pixelBox,
          useAutoPrompt: pixelBox == null,
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

      // Show the GPU's visual overlay on top of the preview (box stays visible)
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

  return (
    <div className="px-4 py-3 space-y-3">
      {/* Frame preview with bbox drawing canvas (in-sidebar) */}
      {firstFrameBase64 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground leading-tight">
            Draw a box around the structure you want to segment, then type what it is and click Run.
          </p>
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
              style={{ cursor: isDrawing ? 'crosshair' : (box ? 'default' : 'crosshair') }}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
              data-testid="command-bbox-canvas"
            />
            {box && (
              <button
                type="button"
                onClick={clearBox}
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
          disabled={!jobId || !command.trim() || isLoading}
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
