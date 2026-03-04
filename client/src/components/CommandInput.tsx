import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Sparkles, AlertTriangle, CheckCircle2 } from "lucide-react";

interface CommandInputProps {
  jobId: string | null;
  currentFrame: number;
  firstFrameBase64: string | null;
  onMaskGenerated: (maskBase64: string) => void;
}

type Stage = 'idle' | 'parsing' | 'inferring' | 'done' | 'error' | 'clarify';

export default function CommandInput({ jobId, currentFrame, firstFrameBase64, onMaskGenerated }: CommandInputProps) {
  const [command, setCommand] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!command.trim() || !jobId) return;

    try {
      // Stage 1: Parse intent
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

      // If the parser needs clarification, show the prompt
      if (parsed.intent === 'clarify') {
        setStage('clarify');
        setStatusMessage(parsed.clarifyPrompt || 'Could you rephrase that?');
        return;
      }

      // Stage 2: Run inference
      setStage('inferring');
      setStatusMessage(`Running ${parsed.intent} on "${parsed.target}"...`);

      const inferRes = await fetch('/api/ai/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          command: command.trim(),
          frameBase64: firstFrameBase64?.replace('data:image/png;base64,', ''),
        }),
      });

      if (!inferRes.ok) {
        const err = await inferRes.json();
        throw new Error(err.error || 'Inference failed');
      }

      const result = await inferRes.json();

      if (result.maskBase64) {
        console.log('🎭 Mask received, calling onMaskGenerated:', { maskBase64Length: result.maskBase64?.length, confidence: result.confidence, modelUsed: result.modelUsed });
        onMaskGenerated(result.maskBase64);
      }

      setConfidence(result.confidence);
      setModelUsed(result.modelUsed);
      setStage('done');
      setStatusMessage('Mask generated');
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
          placeholder='e.g. segment the pleural effusion'
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
          {/* Progress steps */}
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Clarify prompt */}
          {stage === 'clarify' && (
            <div className="flex items-start gap-2 text-amber-500">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Error */}
          {stage === 'error' && (
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Done */}
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
