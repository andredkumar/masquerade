import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useJob } from "@/contexts/JobContext";
import MaskingCanvas from "@/components/MaskingCanvas";
import MaskingTools from "@/components/MaskingTools";
import ProcessingControls from "@/components/ProcessingControls";
import ProcessingStatus from "@/components/ProcessingStatus";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileVideo, Loader2, AlertCircle } from "lucide-react";
import type { MaskData, OutputSettings } from "@shared/schema";

type FrameStatus = "loading" | "ready" | "extracting" | "not_found" | "gone" | "error";

export default function TemplateMaskSpokePage() {
  const { job, refetch } = useJob();
  const [, navigate] = useLocation();

  // Local state
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<FrameStatus>("loading");
  const [maskData, setMaskData] = useState<MaskData | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>("rectangle");
  const [canvasZoom, setCanvasZoom] = useState(75);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastProcessedSettings, setLastProcessedSettings] = useState<OutputSettings | null>(null);

  const jobId = job?.id ?? "";

  // Build videoMetadata from Job V2 source
  const videoMetadata = job
    ? {
        duration: job.source.duration,
        width: job.source.width,
        height: job.source.height,
        frameRate: job.source.frameRate,
        totalFrames: job.source.totalFrames,
        filename: job.filename,
      }
    : null;

  // Fetch first frame from the frames endpoint (Phase 4b — replaces sessionStorage cache)
  const fetchFirstFrame = useCallback(async () => {
    if (!jobId) return;
    setFrameStatus("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/frames/0`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setFirstFrame(url);
        setFrameStatus("ready");
      } else if (res.status === 503) {
        setFrameStatus("extracting");
      } else if (res.status === 404) {
        setFrameStatus("not_found");
      } else if (res.status === 410) {
        setFrameStatus("gone");
      } else {
        setFrameStatus("error");
      }
    } catch {
      setFrameStatus("error");
    }
  }, [jobId]);

  useEffect(() => {
    fetchFirstFrame();
  }, [fetchFirstFrame]);

  // When job status transitions to 'ready' and we were waiting on extraction, retry the frame fetch
  useEffect(() => {
    if (frameStatus === "extracting" && job?.status === "ready") {
      fetchFirstFrame();
    }
  }, [job?.status, frameStatus, fetchFirstFrame]);

  // Auto-retry while extracting (poll every 3 seconds)
  useEffect(() => {
    if (frameStatus !== "extracting") return;
    const timer = setInterval(() => {
      refetch();
    }, 3000);
    return () => clearInterval(timer);
  }, [frameStatus, refetch]);

  // Phase 4d-1b: the separate 2s GET /api/videos/:jobId poll was redundant — JobContext already
  // refetches the V2 Job on the WebSocket 'progress' event that fires at apply completion/failure
  // (videoProcessor.ts:403-458,1081). Drive the banner off the canonical templateMask spoke status.
  useEffect(() => {
    const tmStatus = job?.templateMask?.status;
    if (isProcessing && (tmStatus === "complete" || tmStatus === "failed")) {
      setIsProcessing(false);
    }
  }, [job?.templateMask?.status, isProcessing]);

  const handleMaskUpdate = (newMaskData: MaskData) => setMaskData(newMaskData);

  const handleStartProcessing = (outputSettings: OutputSettings) => {
    if (!jobId || !maskData) return;
    setIsProcessing(true);
    setLastProcessedSettings(outputSettings);
    // Refetch Job V2 so the hub tile reflects "applying" status immediately
    refetch();
  };

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (firstFrame && firstFrame.startsWith("blob:")) {
        URL.revokeObjectURL(firstFrame);
      }
    };
  }, [firstFrame]);

  if (!job) return null;

  // Error state UIs per requirement #4
  if (frameStatus === "not_found") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <AlertCircle className="mx-auto text-destructive" size={32} />
          <p className="text-sm text-muted-foreground">Job not found</p>
          <Button variant="outline" onClick={() => window.location.assign("/upload")}>
            Back to Upload
          </Button>
        </div>
      </div>
    );
  }

  if (frameStatus === "gone") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm">
          <AlertCircle className="mx-auto text-destructive" size={32} />
          <p className="text-sm font-medium">Frames are no longer available</p>
          <p className="text-xs text-muted-foreground">
            The server may have restarted. Please re-upload your file.
          </p>
          <Button variant="outline" onClick={() => window.location.assign("/upload")}>
            Back to Upload
          </Button>
        </div>
      </div>
    );
  }

  if (frameStatus === "extracting") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="mx-auto animate-spin text-primary" size={32} />
          <p className="text-sm font-medium">Frame extraction still in progress</p>
          <p className="text-xs text-muted-foreground">
            This will refresh automatically when ready.
          </p>
        </div>
      </div>
    );
  }

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
            {frameStatus === "loading" ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="animate-spin text-muted-foreground" size={32} />
              </div>
            ) : (
              <MaskingCanvas
                firstFrame={firstFrame}
                selectedTool={selectedTool}
                onMaskUpdate={handleMaskUpdate}
                zoom={canvasZoom}
                onZoomChange={setCanvasZoom}
                maskData={maskData}
              />
            )}

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
