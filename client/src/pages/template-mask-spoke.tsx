import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useJob } from "@/contexts/JobContext";
import MaskingCanvas from "@/components/MaskingCanvas";
import MaskingTools from "@/components/MaskingTools";
import ProcessingControls from "@/components/ProcessingControls";
import ProcessingStatus from "@/components/ProcessingStatus";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileVideo } from "lucide-react";
import type { MaskData, OutputSettings } from "@shared/schema";
import { getCachedFirstFrame, getCachedMetadata } from "@/lib/frameCache";

export default function TemplateMaskSpokePage() {
  const { job } = useJob();
  const [, navigate] = useLocation();

  // Local state — mirrors what home.tsx manages for Steps 2-3
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [maskData, setMaskData] = useState<MaskData | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>("rectangle");
  const [canvasZoom, setCanvasZoom] = useState(75);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastProcessedSettings, setLastProcessedSettings] = useState<OutputSettings | null>(null);

  const jobId = job?.id ?? "";

  // Build videoMetadata from Job V2 source or cached upload response
  const videoMetadata = job
    ? {
        duration: job.source.duration,
        width: job.source.width,
        height: job.source.height,
        frameRate: job.source.frameRate,
        totalFrames: job.source.totalFrames,
        filename: job.filename,
      }
    : getCachedMetadata(jobId) ?? null;

  // Load first frame from sessionStorage cache
  useEffect(() => {
    if (!jobId) return;
    const cached = getCachedFirstFrame(jobId);
    if (cached) setFirstFrame(cached);
  }, [jobId]);

  // Monitor legacy job status for processing state transitions
  const { data: legacyJobData } = useQuery({
    queryKey: ["/api/videos", jobId],
    refetchInterval: 2000,
    enabled: !!jobId,
  });

  const legacyJob = (legacyJobData as any)?.job;

  useEffect(() => {
    if (legacyJob && isProcessing && (legacyJob.status === "completed" || legacyJob.status === "failed")) {
      setIsProcessing(false);
    }
  }, [legacyJob, isProcessing]);

  const handleMaskUpdate = (newMaskData: MaskData) => setMaskData(newMaskData);

  const handleStartProcessing = (outputSettings: OutputSettings) => {
    if (!jobId || !maskData) return;
    setIsProcessing(true);
    setLastProcessedSettings(outputSettings);
  };

  if (!job) return null;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <FileVideo className="text-primary-foreground" size={16} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Masquerade</h1>
              <p className="text-xs text-muted-foreground">Template Mask</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={() => navigate("/")}
          >
            <ArrowLeft size={16} />
            Back to job
          </Button>
        </div>
      </header>

      <div className="flex h-[calc(100vh-65px)]">
        {/* Sidebar — same layout as home.tsx Steps 2-3 */}
        <aside className="w-80 border-r border-border bg-card flex flex-col overflow-y-auto">
          {/* Masking tools */}
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-semibold">Draw Mask</h2>
          </div>
          <MaskingTools
            selectedTool={selectedTool}
            onToolChange={setSelectedTool}
            maskData={maskData}
            onMaskUpdate={handleMaskUpdate}
          />

          {/* Processing controls */}
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-semibold">Apply to All Frames</h2>
          </div>
          {maskData && jobId ? (
            <ProcessingControls
              jobId={jobId}
              maskData={maskData}
              videoMetadata={videoMetadata}
              samplingFps={null}
              onStartProcessing={handleStartProcessing}
              disabled={!jobId || !maskData}
              hasExistingMask={!!maskData}
              isProcessing={isProcessing}
              lastProcessedSettings={lastProcessedSettings}
            />
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Draw a mask on the first frame to enable processing.
            </div>
          )}
        </aside>

        {/* Main canvas area */}
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

            {isProcessing && (
              <div className="absolute top-8 right-8 bg-card border border-border rounded-lg shadow-lg p-4 z-10">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 bg-primary rounded-full animate-pulse" />
                  <div>
                    <p className="font-medium text-sm">Processing Started</p>
                    <p className="text-xs text-muted-foreground">Applying mask to all frames…</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {jobId && <ProcessingStatus jobId={jobId} />}
        </main>
      </div>
    </div>
  );
}
