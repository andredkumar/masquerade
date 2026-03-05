import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import FileUpload from "@/components/FileUpload";
import MaskingCanvas from "@/components/MaskingCanvas";
import MaskingTools from "@/components/MaskingTools";
import ProcessingControls from "@/components/ProcessingControls";
import ProcessingStatus from "@/components/ProcessingStatus";
import CommandInput from "@/components/CommandInput";
import TaskSelector from "@/components/TaskSelector";
import { Button } from "@/components/ui/button";
import { Settings, Video, Download, Lock, Upload, Check, X } from "lucide-react";
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
    window.open(`/api/videos/${currentJob}/download`, '_blank');
    posthog.capture('frames_downloaded', { job_id: currentJob });
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
                onMaskGenerated={handleAiMaskGenerated}
                onLabelAdded={fetchLabels}
                selectedTask={selectedTask}
              />

              {/* AI Label list */}
              {aiLabels.length > 0 && (
                <div className="px-4 py-3 space-y-2 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Only approved labels will appear in your download.
                  </p>
                  {aiLabels.map(label => (
                    <div
                      key={label.id}
                      className={`flex items-center justify-between rounded-md px-3 py-2 text-xs ${
                        label.approved ? 'bg-muted/50' : 'bg-muted/20 opacity-60'
                      }`}
                    >
                      <div className="flex-1 min-w-0 mr-2">
                        <span className="font-medium">{label.target}</span>
                        <span className="text-muted-foreground ml-1">({label.intent})</span>
                        {label.confidence !== null && (
                          <span className="text-muted-foreground ml-1">
                            {Math.round(label.confidence * 100)}%
                          </span>
                        )}
                        <span className="text-muted-foreground ml-1 text-[10px]">{label.model}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleToggleLabel(label.id, !label.approved)}
                          className={`p-1 rounded hover:bg-muted ${label.approved ? 'text-green-500' : 'text-muted-foreground'}`}
                          title={label.approved ? 'Unapprove' : 'Approve'}
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
                  ))}
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
            <div className="px-4 py-3 space-y-2">
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
