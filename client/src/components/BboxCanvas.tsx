import { useRef, useEffect, useCallback, useState } from "react";
import { X } from "lucide-react";

interface DisplayBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PixelBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface BboxCanvasProps {
  /** data URL (data:image/png;base64,...) for the raw frame preview */
  frameBase64: string | null;
  /** base64-only (no data: prefix) for the AI overlay, displayed after inference */
  overlayBase64: string | null;
  /** actual image pixel dimensions (used to scale drawn box → image coords) */
  imageDimensions: { width?: number; height?: number } | null;
  /** reports the drawn box in IMAGE PIXEL coordinates, or null when cleared */
  onBboxChange: (bbox: PixelBox | null) => void;
}

/**
 * Large frame preview with a transparent drawing canvas on top.
 * Rendered in the main content panel during Step 4 (AI Analysis) so the
 * clinician can draw an accurate bbox prompt on a full-size image.
 */
export default function BboxCanvas({ frameBase64, overlayBase64, imageDimensions, onBboxChange }: BboxCanvasProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<DisplayBox | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

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
    ctx.fillStyle = 'rgba(34, 211, 238, 0.15)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, Math.max(0, rw - 2), Math.max(0, rh - 2));
  };

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

  // Reset on frame change
  useEffect(() => {
    setBox(null);
    redraw(null, displaySize.w, displaySize.h);
    onBboxChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameBase64]);

  const toImagePixelBox = (b: DisplayBox): PixelBox | null => {
    const imgW = imageDimensions?.width;
    const imgH = imageDimensions?.height;
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

  const pointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e);
    if (!p) return;
    setIsDrawing(true);
    setDrawStart(p);
    const next = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    setBox(next);
    redraw(next, displaySize.w, displaySize.h);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const next = { x1: drawStart.x, y1: drawStart.y, x2: p.x, y2: p.y };
    setBox(next);
    redraw(next, displaySize.w, displaySize.h);
  };

  const onMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    setDrawStart(null);
    if (box) {
      const w = Math.abs(box.x2 - box.x1);
      const h = Math.abs(box.y2 - box.y1);
      if (w < 4 || h < 4) {
        setBox(null);
        redraw(null, displaySize.w, displaySize.h);
        onBboxChange(null);
        return;
      }
      onBboxChange(toImagePixelBox(box));
    }
  };

  const clearBox = () => {
    setBox(null);
    redraw(null, displaySize.w, displaySize.h);
    onBboxChange(null);
  };

  if (!frameBase64) return null;

  const previewSrc = overlayBase64
    ? `data:image/png;base64,${overlayBase64}`
    : frameBase64;

  return (
    <div className="flex flex-col h-full">
      <p className="text-sm text-muted-foreground mb-3">
        Draw a box around the structure you want to segment, then type what it is and click <span className="font-medium text-foreground">Run AI</span> in the sidebar.
      </p>
      <div className="flex-1 flex items-start justify-center overflow-auto">
        <div className="relative inline-block rounded-md overflow-hidden border border-border bg-black max-w-full max-h-full">
          <img
            ref={imgRef}
            src={previewSrc}
            alt="Frame preview"
            className="block max-w-full max-h-[75vh] h-auto w-auto select-none"
            draggable={false}
            onLoad={syncCanvasSize}
            data-testid="ai-frame-preview"
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ cursor: isDrawing ? 'crosshair' : (box ? 'default' : 'crosshair') }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            data-testid="ai-bbox-canvas"
          />
          {box && (
            <button
              type="button"
              onClick={clearBox}
              className="absolute top-2 right-2 flex items-center gap-1 rounded bg-background/90 text-foreground border border-border px-2 py-1 text-xs shadow-sm hover:bg-muted"
              data-testid="ai-clear-box"
            >
              <X size={12} />
              Clear box
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
