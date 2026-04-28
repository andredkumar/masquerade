import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import FileUpload from "@/components/FileUpload";
import MaskingCanvas from "@/components/MaskingCanvas";
import MaskingTools from "@/components/MaskingTools";
import ProcessingControls from "@/components/ProcessingControls";
import ProcessingStatus from "@/components/ProcessingStatus";
import CommandInput, { type Modality } from "@/components/CommandInput";
import TaskSelector from "@/components/TaskSelector";
import { Button } from "@/components/ui/button";
import { Settings, Video, Download, Lock, Upload, Check, X, Info } from "lucide-react";
import type { MaskData, OutputSettings, AiLabel } from "@shared/schema";
import { posthog } from "@/lib/posthog";

export default function Home() {
  const [currentJob, setCurrentJob] = useState<string | null>(null);
  const [videoMetadata, setVideoMetadata] = useState<any>(null);
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [maskData, setMaskData] = useState<MaskData | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>('rectangle');
  const [canvasZoom, setCanvasZoom] = useState(75);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastProcessedSettings, setLastProcessedSettings] = useState<OutputSettings | null>(null);
  const [showCompletedStatus, setShowCompletedStatus] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [selectedTask, setSelectedTask] = useState('segment');
  const [includeMasks, setIncludeMasks] = useState(false);
  const [includeOverlays, setIncludeOverlays] = useState(false);

  // Step 4: modality selection — persists across AI runs on the same job,
  // but resets on every new upload.
  const [modality, setModality] = useState<Modality | null>(null);

  // Step 1: frame extraction rate.
  // null = native (every frame). Number = -vf fps=N on the backend.
  // 'custom' is held in samplingMode; samplingFps holds the resolved numeric value.
  const [samplingMode, setSamplingMode] = useState<'native' | '1' | '0.5' | 'custom'>('native');
  const [customFps, setCustomFps] = useState<string>('');
  const samplingFps: number | null = (() => {
    if (samplingMode === 'native') return null;
    if (samplingMode === '1') return 1;
    if (samplingMode === '0.5') return 0.5;
    const parsed = parseFloat(customFps);
    return isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  // Monitor job status to reset processing state when complete
  const { data: jobData } = useQuery({
    queryKey: ['/api/videos', currentJob],
    refetchInterval: 2000,
    enabled: !!currentJob
  });

  const job = (jobData as any)?.job;
  const jobCompleted = job?.status === 'completed';

  // Reset processing state when job completes
  useEffect(() => {
    if (jobData) {
      if (job && isProcessing && (job.status === 'completed' || job.status === 'failed')) {
        setIsProcessing(false);
        setShowCompletedStatus(true);
      }
    }
  }, [jobData, isProcessing]);

  const handleUploadComplete = (jobId: string, metadata: any, frameData: string) => {
    setCurrentJob(jobId);
    setVideoMetadata(metadata);
    setFirstFrame(frameData);
    setShowCompletedStatus(false);
    setMaskData(null);
    setIsProcessing(false);
    setLastProcessedSettings(null);
    setAiLabels([]);
    setModality(null); // new job — user must pick a modality again
    setSamplingMode('native');
    setCustomFps('');
  };

  const handleMaskUpdate = (newMaskData: MaskData) => {
    setMaskData(newMaskData);
  };

  const handleStartProcessing = (outputSettings: OutputSettings) => {
    if (!currentJob || !maskData) return;
    setIsProcessing(true);
    setLastProcessedSettings(outputSettings);
    setShowCompletedStatus(false);
  };

  const handleAiMaskGenerated = (maskBase64: string, aiLabel?: { intent: string; target: string; confidence: number | null; model: string }) => {
    const aiMask: MaskData = {
      type: 'freeform',
      coordinates: { x: 0, y: 0, width: 0, height: 0 },
      opacity: 75,
      canvasDataUrl: `data:image/png;base64,${maskBase64}`,
      aiLabel,
    };
    handleMaskUpdate(aiMask);
  };

  // AI Labels state and management
  const [aiLabels, setAiLabels] = useState<AiLabel[]>([]);

  const fetchLabels = useCallback(async () => {
    if (!currentJob) return;
    try {
      const res = await fetch(`/api/ai/labels/${currentJob}`);
      if (res.ok) {
        const data = await res.json();
        setAiLabels(data.labels || []);
      }
    } catch (err) {
      console.error('Failed to fetch labels:', err);
    }
  }, [currentJob]);

  // Fetch labels when job completes (Step 4 unlocks)
  useEffect(() => {
    if (jobCompleted) fetchLabels();
  }, [jobCompleted, fetchLabels]);

  const handleToggleLabel = async (labelId: string, approved: boolean) => {
    if (!currentJob) return;
    try {
      await fetch(`/api/ai/labels/${currentJob}/${labelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      });
      await fetchLabels();
    } catch (err) {
      console.error('Failed to toggle label:', err);
    }
  };

  const handleRemoveLabel = async (labelId: string) => {
    if (!currentJob) return;
    try {
      await fetch(`/api/ai/labels/${currentJob}/${labelId}`, { method: 'DELETE' });
      await fetchLabels();
    } catch (err) {
      console.error('Failed to remove label:', err);
    }
  };

  const handleDownload = () => {
    const params = new URLSearchParams();
    if (includeMasks) params.set('masks', 'true');
    if (includeOverlays) params.set('overlays', 'true');
    const qs = params.toString();
    window.open(`/api/videos/${currentJob}/download${qs ? '?' + qs : ''}`, '_blank');
    posthog.capture('frames_downloaded', { job_id: currentJob, includeMasks, includeOverlays });
  };

  const handleUploadAnother = () => {
    window.location.reload();
  };

  // Step unlock conditions
  const step2Enabled = !!currentJob;
  const step3Enabled = !!maskData;
  const step4Enabled = jobCompleted;
  const step5Enabled = jobCompleted;

  const stepCircle = (num: string, enabled: boolean) => (
    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium ${enabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
      {num}
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <Video className="text-primary-foreground" size={16} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Masquerade</h1>
              <p className="text-xs text-muted-foreground">High-Performance Video Processing</p>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="text-sm text-muted-foreground">
              CPU Cores: <span className="font-mono text-foreground">8</span>
            </div>
            <div className="text-sm text-muted-foreground">
              Memory: <span className="font-mono text-foreground">4.2GB / 8GB</span>
            </div>
            <button className="p-2 hover:bg-muted rounded-md" data-testid="settings-button">
              <Settings className="text-muted-foreground" size={16} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex h-[calc(100vh-80px)]">
        {/* Sidebar */}
        <aside className="w-80 border-r border-border bg-card flex flex-col overflow-y-auto">
          {/* Step 1: Upload Video */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2">
              {stepCircle('1', true)}
              <h2 className="text-lg font-semibold">Upload Video</h2>
            </div>
          </div>
          <FileUpload onUploadComplete={handleUploadComplete} />

          {/* Frame extraction rate — appears in Step 1 once a video is uploaded.
              Image batches use one frame per file, so we hide this for non-video jobs. */}
          {videoMetadata && videoMetadata.duration > 0 && videoMetadata.totalFrames > 1 && (
            <div className="px-6 pb-4 space-y-2 border-b border-border">
              <p className="text-sm font-medium">Frame extraction rate:</p>
              <div className="space-y-1 text-xs">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sampling-mode"
                    value="native"
                    checked={samplingMode === 'native'}
                    onChange={() => setSamplingMode('native')}
                    className="mt-0.5"
                    data-testid="sampling-native"
                  />
                  <span>
                    <span className="font-medium">Every frame</span>
                    <span className="text-muted-foreground"> — full dataset (recommended for labeling)</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sampling-mode"
                    value="1"
                    checked={samplingMode === '1'}
                    onChange={() => setSamplingMode('1')}
                    className="mt-0.5"
                    data-testid="sampling-1fps"
                  />
                  <span>
                    <span className="font-medium">1 per second</span>
                    <span className="text-muted-foreground"> — quick overview</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sampling-mode"
                    value="0.5"
                    checked={samplingMode === '0.5'}
                    onChange={() => setSamplingMode('0.5')}
                    className="mt-0.5"
                    data-testid="sampling-half-fps"
                  />
                  <span>
                    <span className="font-medium">1 per 2 seconds</span>
                    <span className="text-muted-foreground"> — fast preview</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sampling-mode"
                    value="custom"
                    checked={samplingMode === 'custom'}
                    onChange={() => setSamplingMode('custom')}
                    className="mt-0.5"
                    data-testid="sampling-custom"
                  />
                  <span className="font-medium">Custom:</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="fps"
                    value={customFps}
                    onChange={(e) => { setCustomFps(e.target.value); setSamplingMode('custom'); }}
                    className="w-16 px-1.5 py-0.5 text-xs border border-border rounded bg-background"
                    data-testid="sampling-custom-input"
                  />
                  <span className="text-muted-foreground">fps</span>
                </label>
              </div>
              {/* Estimate: native shows source totalFrames; sampled shows duration * fps */}
              <p className="text-[11px] text-muted-foreground" data-testid="frame-estimate">
                {samplingFps == null
                  ? `~${videoMetadata.totalFrames ?? Math.round(videoMetadata.duration * (videoMetadata.frameRate || 30))} frames at native rate`
                  : `~${Math.max(1, Math.round(videoMetadata.duration * samplingFps))} frames at ${samplingFps}fps`
                }
              </p>
            </div>
          )}

          {/* Step 2: Template Mask */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2">
              {stepCircle('2', step2Enabled)}
              <h2 className="text-lg font-semibold">Template Mask</h2>
              {!step2Enabled && <Lock size={14} className="text-muted-foreground ml-auto" />}
            </div>
          </div>
          {step2Enabled ? (
            <MaskingTools
              selectedTool={selectedTool}
              onToolChange={setSelectedTool}
              maskData={maskData}
              onMaskUpdate={handleMaskUpdate}
            />
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Upload a video to enable masking tools.
            </div>
          )}

          {/* Step 3: Apply to All Frames */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2">
              {stepCircle('3', step3Enabled)}
              <h2 className="text-lg font-semibold">Apply to All Frames</h2>
              {!step3Enabled && <Lock size={14} className="text-muted-foreground ml-auto" />}
            </div>
          </div>
          {step3Enabled && currentJob ? (
            <ProcessingControls
              jobId={currentJob}
              maskData={maskData}
              videoMetadata={videoMetadata}
              samplingFps={samplingFps}
              onStartProcessing={handleStartProcessing}
              disabled={!currentJob || !maskData}
              hasExistingMask={!!maskData}
              isProcessing={isProcessing}
              lastProcessedSettings={lastProcessedSettings}
            />
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Draw a mask on the first frame to enable processing.
            </div>
          )}

          {/* Step 4: AI Analysis */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2">
              {stepCircle('4', step4Enabled)}
              <h2 className="text-lg font-semibold">AI Analysis</h2>
              {!step4Enabled && <Lock size={14} className="text-muted-foreground ml-auto" />}
            </div>
          </div>
          {step4Enabled ? (
            <>
              <TaskSelector
                selectedTask={selectedTask}
                onTaskChange={setSelectedTask}
              />
              <CommandInput
                jobId={currentJob}
                currentFrame={currentFrame}
                firstFrameBase64={firstFrame}
                videoMetadata={videoMetadata}
                modality={modality}
                onModalityChange={setModality}
                onMaskGenerated={handleAiMaskGenerated}
                onLabelAdded={fetchLabels}
                selectedTask={selectedTask}
              />

              {/* AI Label list — all approved labels persist, each Run adds a new one */}
              {aiLabels.length > 0 && (
                <div className="px-4 py-3 space-y-2 border-t border-border">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">Approved labels ({aiLabels.filter(l => l.approved).length})</p>
                    <p className="text-[10px] text-muted-foreground">Draw a new box above to add another</p>
                  </div>
                  {aiLabels.map(label => {
                    // Compute average confidence across all frames (falls back to single value)
                    const frameResults = (label as any).frameResults as
                      | Record<number, { confidence: number }>
                      | undefined;
                    let avgConfidence: number | null = label.confidence;
                    let frameCount = 0;
                    if (frameResults && Object.keys(frameResults).length > 0) {
                      const values = Object.values(frameResults).map(r => r.confidence).filter(c => typeof c === 'number');
                      if (values.length > 0) {
                        avgConfidence = values.reduce((a, b) => a + b, 0) / values.length;
                        frameCount = values.length;
                      }
                    }
                    return (
                    <div
                      key={label.id}
                      className={`flex items-center justify-between rounded-md px-3 py-2 text-xs ${
                        label.approved ? 'bg-muted/50' : 'bg-muted/20 opacity-60'
                      }`}
                      data-testid={`ai-label-${label.id}`}
                    >
                      <div className="flex-1 min-w-0 mr-2">
                        {label.approved && <span className="text-green-500 mr-1">✓</span>}
                        <span className="font-medium">{label.target}</span>
                        {avgConfidence !== null && (
                          <span className="text-muted-foreground ml-1">
                            ({Math.round(avgConfidence * 100)}%{frameCount > 1 ? ' avg confidence' : ''})
                          </span>
                        )}
                        <span className="text-muted-foreground ml-1 text-[10px]">
                          {label.intent} · {label.model}
                          {frameCount > 1 ? ` · ${frameCount} frames` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleToggleLabel(label.id, true)}
                          className={`p-1 rounded hover:bg-muted ${label.approved ? 'text-green-500' : 'text-muted-foreground'}`}
                          title="Approve"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => handleRemoveLabel(label.id)}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-muted"
                          title="Remove"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Complete Step 3 first to enable AI analysis.
            </div>
          )}

          {/* Step 5: Download ZIP */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2">
              {stepCircle('5', step5Enabled)}
              <h2 className="text-lg font-semibold">Download ZIP</h2>
              {!step5Enabled && <Lock size={14} className="text-muted-foreground ml-auto" />}
            </div>
          </div>
          {step5Enabled ? (
            <div className="px-4 py-3 space-y-3">
              <div className="mb-3">
                <p className="text-sm font-medium text-foreground">Customize your download</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Your download always includes your images and a data file with AI label locations. The options below add extra files for technical use.
                </p>
              </div>

              {/* Binary masks checkbox */}
              <div className="flex items-start gap-2">
                <label className="flex items-start gap-2 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={includeMasks}
                    onChange={e => setIncludeMasks(e.target.checked)}
                    className="mt-0.5 rounded border-border"
                  />
                  <span className="text-xs leading-tight">Include binary masks</span>
                </label>
                <span
                  className="relative inline-flex items-center mt-0.5 group cursor-help"
                  tabIndex={0}
                  aria-label="About binary masks"
                >
                  <Info size={12} className="text-muted-foreground" />
                  <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block group-focus:block w-[280px] max-w-[calc(100vw-2rem)] p-2 text-[11px] leading-snug bg-popover text-popover-foreground border border-border rounded-md shadow-md z-50 pointer-events-none">
                    A black-and-white image where white pixels show exactly where the AI detected your target structure. Used by machine learning engineers to train models. You don't need this unless you're building or fine-tuning an AI model yourself.
                  </span>
                </span>
              </div>

              {/* Visual overlays checkbox */}
              <div className="flex items-start gap-2">
                <label className="flex items-start gap-2 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={includeOverlays}
                    onChange={e => setIncludeOverlays(e.target.checked)}
                    className="mt-0.5 rounded border-border"
                  />
                  <span className="text-xs leading-tight">Include visual overlays</span>
                </label>
                <span
                  className="relative inline-flex items-center mt-0.5 group cursor-help"
                  tabIndex={0}
                  aria-label="About visual overlays"
                >
                  <Info size={12} className="text-muted-foreground" />
                  <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block group-focus:block w-[280px] max-w-[calc(100vw-2rem)] p-2 text-[11px] leading-snug bg-popover text-popover-foreground border border-border rounded-md shadow-md z-50 pointer-events-none">
                    Your ultrasound image with the AI's detection highlighted in green. Useful for visually verifying segmentation quality or presenting results. Larger file size — skip this if you just need the data.
                  </span>
                </span>
              </div>

              <Button className="w-full" onClick={handleDownload} data-testid="sidebar-download-button">
                <Download size={16} className="mr-2" />
                Download ZIP
              </Button>
              <Button variant="outline" className="w-full" onClick={handleUploadAnother} data-testid="sidebar-upload-another-button">
                <Upload size={16} className="mr-2" />
                Upload Another
              </Button>
            </div>
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Complete Step 3 first to enable download.
            </div>
          )}
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col">
          <div className="flex-1 p-6 relative">
            <MaskingCanvas
              firstFrame={firstFrame}
              selectedTool={selectedTool}
              onMaskUpdate={handleMaskUpdate}
              zoom={canvasZoom}
              onZoomChange={setCanvasZoom}
              maskData={maskData}
            />

            {/* Processing Started Indicator - Top Right of Canvas */}
            {isProcessing && (
              <div className="absolute top-8 right-8 bg-card border border-border rounded-lg shadow-lg p-4 z-10" data-testid="processing-indicator">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 bg-primary rounded-full animate-pulse"></div>
                  <div>
                    <p className="font-medium text-sm">Processing Started</p>
                    <p className="text-xs text-muted-foreground">Applying mask to all frames...</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Processing Status - stays in main content area */}
          {currentJob && (
            <ProcessingStatus jobId={currentJob} />
          )}
        </main>
      </div>
    </div>
  );
}
