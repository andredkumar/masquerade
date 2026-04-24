import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Sparkles, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useWebSocket } from "@/hooks/useWebSocket";

interface CommandInputProps {
  jobId: string | null;
  currentFrame: number;
  firstFrameBase64: string | null;
  /** bbox drawn on the main-panel canvas, already in image-pixel coordinates */
  bbox?: { x1: number; y1: number; x2: number; y2: number } | null;
  onMaskGenerated: (maskBase64: string, aiLabel?: { intent: string; target: string; confidence: number | null; model: string }) => void;
  /** fired after a successful inference so the parent can swap the main-panel preview to the overlay */
  onOverlayReceived?: (overlayBase64: string | null) => void;
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

export default function CommandInput({ jobId, currentFrame, firstFrameBase64, bbox, onMaskGenerated, onOverlayReceived, onLabelAdded, selectedTask = 'segment' }: CommandInputProps) {
  const [command, setCommand] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);

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

      const inferRes = await fetch('/api/ai/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          command: command.trim(),
          frameBase64: firstFrameBase64?.replace('data:image/png;base64,', ''),
          bbox: bbox || null,
          useAutoPrompt: bbox == null,
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

      // Report the overlay up so the main-panel preview can swap to it
      onOverlayReceived?.(result.overlayBase64 || null);

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

  return (
    <div className="px-4 py-3 space-y-3">
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

      {/* Bbox hint */}
      {bbox && stage !== 'inferring' && stage !== 'parsing' && (
        <div className="text-[11px] text-muted-foreground">
          Box prompt set — Run AI will use your drawn region.
        </div>
      )}
      {!bbox && stage === 'idle' && (
        <div className="text-[11px] text-muted-foreground">
          Draw a box on the preview for best results, or skip to use auto-detection.
        </div>
      )}

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
