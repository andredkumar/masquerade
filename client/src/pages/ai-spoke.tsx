import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useJob } from "@/contexts/JobContext";
import CommandInput, { type Modality } from "@/components/CommandInput";
import TaskSelector from "@/components/TaskSelector";
import FrameViewer from "@/components/FrameViewer";
import MaskingCanvas from "@/components/MaskingCanvas";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileVideo, Check, X, Trash2 } from "lucide-react";
import type { MaskData, AiLabel } from "@shared/schema";
import { getCachedFirstFrame, getCachedMetadata } from "@/lib/frameCache";
import { colorForLabelId } from "@/lib/labelColor";

export default function AiSpokePage() {
  const { job } = useJob();
  const [, navigate] = useLocation();

  const jobId = job?.id ?? "";

  // Local state — mirrors home.tsx Step 4
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [maskData, setMaskData] = useState<MaskData | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [selectedTask, setSelectedTask] = useState("segment");
  const [modality, setModality] = useState<Modality | null>(null);
  const [viewerActive, setViewerActive] = useState(false);
  const [aiLabels, setAiLabels] = useState<AiLabel[]>([]);

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

  // Check legacy job status to determine if Step 4 is unlocked
  const { data: legacyJobData } = useQuery({
    queryKey: ["/api/videos", jobId],
    refetchInterval: 2000,
    enabled: !!jobId,
  });
  const legacyJob = (legacyJobData as any)?.job;
  const jobCompleted = legacyJob?.status === "completed";

  // Fetch AI labels
  const fetchLabels = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/ai/labels/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        setAiLabels(data.labels || []);
      }
    } catch (err) {
      console.error("Failed to fetch labels:", err);
    }
  }, [jobId]);

  useEffect(() => {
    if (jobCompleted) fetchLabels();
  }, [jobCompleted, fetchLabels]);

  const handleAiMaskGenerated = (
    maskBase64: string,
    aiLabel?: { intent: string; target: string; confidence: number | null; model: string },
  ) => {
    const aiMask: MaskData = {
      type: "freeform",
      coordinates: { x: 0, y: 0, width: 0, height: 0 },
      opacity: 75,
      canvasDataUrl: `data:image/png;base64,${maskBase64}`,
      aiLabel,
    };
    setMaskData(aiMask);
  };

  const handleToggleLabel = async (labelId: string, approved: boolean) => {
    if (!jobId) return;
    try {
      await fetch(`/api/ai/labels/${jobId}/${labelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      await fetchLabels();
    } catch (err) {
      console.error("Failed to toggle label:", err);
    }
  };

  const handleRemoveLabel = async (labelId: string) => {
    if (!jobId) return;
    try {
      await fetch(`/api/ai/labels/${jobId}/${labelId}`, { method: "DELETE" });
      await fetchLabels();
    } catch (err) {
      console.error("Failed to remove label:", err);
    }
  };

  const handleDeleteLabelWithConfirm = (label: AiLabel) => {
    const ok = window.confirm(
      `Permanently delete label '${label.target}'? This cannot be undone.`,
    );
    if (!ok) return;
    void handleRemoveLabel(label.id);
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
              <p className="text-xs text-muted-foreground">AI Analysis</p>
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
        {/* Sidebar — same layout as home.tsx Step 4 */}
        <aside className="w-80 border-r border-border bg-card flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-semibold">AI Analysis</h2>
          </div>

          {jobCompleted ? (
            <>
              <TaskSelector selectedTask={selectedTask} onTaskChange={setSelectedTask} />
              <CommandInput
                jobId={jobId}
                currentFrame={currentFrame}
                firstFrameBase64={firstFrame}
                videoMetadata={videoMetadata}
                modality={modality}
                onModalityChange={setModality}
                onMaskGenerated={handleAiMaskGenerated}
                onLabelAdded={fetchLabels}
                selectedTask={selectedTask}
              />

              {/* AI Label list */}
              {aiLabels.length > 0 && (
                <div className="px-4 py-3 space-y-2 border-t border-border">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">
                      Approved labels ({aiLabels.filter((l) => l.approved).length})
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Draw a new box above to add another
                    </p>
                  </div>
                  {aiLabels.map((label) => {
                    const frameResults = (label as any).frameResults as
                      | Record<number, { confidence: number }>
                      | undefined;
                    let avgConfidence: number | null = label.confidence;
                    let frameCount = 0;
                    if (frameResults && Object.keys(frameResults).length > 0) {
                      const values = Object.values(frameResults)
                        .map((r) => r.confidence)
                        .filter((c) => typeof c === "number");
                      if (values.length > 0) {
                        avgConfidence = values.reduce((a, b) => a + b, 0) / values.length;
                        frameCount = values.length;
                      }
                    }
                    const swatchColor = colorForLabelId(label.id);
                    return (
                      <div
                        key={label.id}
                        className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
                          label.approved ? "bg-muted/50" : "bg-muted/20 opacity-60"
                        }`}
                      >
                        <span
                          className="inline-block w-3 h-3 rounded-sm shrink-0"
                          style={{ backgroundColor: swatchColor }}
                          aria-hidden
                        />
                        <div className="flex-1 min-w-0">
                          <span className="font-medium truncate">{label.target}</span>
                          {avgConfidence !== null && (
                            <span className="text-muted-foreground ml-1">
                              ({Math.round(avgConfidence * 100)}%
                              {frameCount > 1 ? " avg" : ""})
                            </span>
                          )}
                          <div className="text-muted-foreground text-[10px] truncate">
                            {label.intent} &middot; {label.model}
                            {frameCount > 1 ? ` · ${frameCount} frames` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleLabel(label.id, !label.approved)}
                          title={
                            label.approved
                              ? "Approved (click to un-approve)"
                              : "Not approved (click to approve)"
                          }
                          className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border transition-colors ${
                            label.approved
                              ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/40 hover:bg-green-500/25"
                              : "bg-transparent text-muted-foreground border-border hover:bg-muted"
                          }`}
                        >
                          {label.approved ? (
                            <>
                              <Check size={12} /> Approved
                            </>
                          ) : (
                            <>
                              <X size={12} /> Not approved
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteLabelWithConfirm(label)}
                          title="Delete label permanently"
                          className="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Frame viewer toggle */}
              {jobCompleted && (
                <div className="px-4 py-3 border-t border-border">
                  <Button
                    size="sm"
                    variant={viewerActive ? "outline" : "default"}
                    className="w-full"
                    onClick={() => setViewerActive(!viewerActive)}
                  >
                    {viewerActive ? "Close viewer" : "Open frame viewer"}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Template mask processing must complete before AI analysis is available.
            </div>
          )}
        </aside>

        {/* Main canvas area */}
        <main className="flex-1 flex flex-col">
          {viewerActive && jobId && jobCompleted ? (
            <FrameViewer
              jobId={jobId}
              onContinueToDownload={() => setViewerActive(false)}
              onBackToInference={() => setViewerActive(false)}
            />
          ) : (
            <div className="flex-1 p-6 relative">
              <MaskingCanvas
                firstFrame={firstFrame}
                selectedTool="rectangle"
                onMaskUpdate={() => {}}
                zoom={75}
                onZoomChange={() => {}}
                maskData={maskData}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
