import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useJob } from "@/contexts/JobContext";
import CommandInput, { type Modality } from "@/components/CommandInput";
import TaskSelector from "@/components/TaskSelector";
import FrameViewer from "@/components/FrameViewer";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileVideo, Check, X, Trash2 } from "lucide-react";
import type { AiLabel, AIRun } from "@shared/schema";
import { getCachedMetadata } from "@/lib/frameCache";
import { colorForLabelId } from "@/lib/labelColor";

// Label augmented with its owning AI run id. The canonical mutation URLs
// (PATCH/DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId) require runId
// in the path, which the runs-based label source supplies per label.
type AiLabelWithRun = AiLabel & { runId: string };

export default function AiSpokePage() {
  const { job } = useJob();
  const [, navigate] = useLocation();

  const jobId = job?.id ?? "";

  // Local state — mirrors home.tsx Step 4
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [selectedTask, setSelectedTask] = useState("segment");
  const [modality, setModality] = useState<Modality | null>(null);
  const [viewerActive, setViewerActive] = useState(false);
  const [aiLabels, setAiLabels] = useState<AiLabelWithRun[]>([]);
  // 5A relocation: host element in the main canvas area that CommandInput
  // portals its bbox drawing surface into. Callback ref so a re-render is
  // triggered once the host mounts and the portal target becomes available.
  const [canvasHost, setCanvasHost] = useState<HTMLDivElement | null>(null);

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

  // Masked-frame staleness fix (Part B): the masked source is served with a
  // long-lived Cache-Control at a stable URL, so re-applying a new template
  // mask would otherwise render the OLD masked frame. Version the masked URL
  // with the mask's completedAt so a re-apply busts the browser cache. The
  // frames endpoint reads only ?source, so the extra &v param is ignored
  // server-side — no backend change. Raw fallback stays unversioned.
  const maskVersion = job?.templateMask?.completedAt ?? "";

  // Fetch first frame: try masked (template_mask) first, fall back to raw.
  // This ensures the canvas shows the same image that AI inference will process.
  useEffect(() => {
    if (!jobId) return;
    let revoked = false;
    let blobUrl: string | null = null;

    (async () => {
      try {
        // Try masked frame first (versioned by completedAt to bust stale cache)
        const v = maskVersion ? `&v=${encodeURIComponent(maskVersion)}` : "";
        let res = await fetch(`/api/jobs/${jobId}/frames/0?source=template_mask${v}`);
        // If masked frame not available (404), fall back to raw (unversioned)
        if (res.status === 404) {
          res = await fetch(`/api/jobs/${jobId}/frames/0`);
        }
        if (!res.ok || revoked) return;
        const blob = await res.blob();
        if (revoked) return;
        blobUrl = URL.createObjectURL(blob);
        setFirstFrame(blobUrl);
      } catch {
        // firstFrame stays null (blank canvas)
      }
    })();

    return () => {
      revoked = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [jobId, maskVersion]);

  // AI availability gate (Amendment Change 1): template masking is OPTIONAL
  // preprocessing, so AI must NOT require a completed mask. Gate on V2
  // extraction completion (job.status === "ready") instead. job.status is kept
  // live by JobContext (refetches on Socket.IO progress events), so no separate
  // poll is needed. If a mask was applied → masked frames; if not → raw fallback.
  const jobReady = job?.status === "ready";

  // Fetch AI labels from the canonical runs-based source. Each label is
  // augmented with its owning run id so the canonical mutation URLs
  // (PATCH/DELETE .../ai/runs/:runId/labels/:labelId) can be constructed.
  // Defensive flatten ((r.labels ?? [])) guards runs with zero/undefined labels
  // — the 1:1 run↔label relationship is a current-impl property, not an invariant.
  const fetchLabels = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}/ai/runs`);
      if (res.ok) {
        const data = await res.json();
        const runs: AIRun[] = data.runs || [];
        const flattened: AiLabelWithRun[] = runs.flatMap((r) =>
          (r.labels ?? []).map((l) => ({ ...l, runId: r.id })),
        );
        setAiLabels(flattened);
      }
    } catch (err) {
      console.error("Failed to fetch labels:", err);
    }
  }, [jobId]);

  useEffect(() => {
    if (jobReady) fetchLabels();
  }, [jobReady, fetchLabels]);

  const handleToggleLabel = async (label: AiLabelWithRun, approved: boolean) => {
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}/ai/runs/${label.runId}/labels/${label.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      await fetchLabels();
    } catch (err) {
      console.error("Failed to toggle label:", err);
    }
  };

  const handleRemoveLabel = async (label: AiLabelWithRun) => {
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}/ai/runs/${label.runId}/labels/${label.id}`, {
        method: "DELETE",
      });
      await fetchLabels();
    } catch (err) {
      console.error("Failed to remove label:", err);
    }
  };

  const handleDeleteLabelWithConfirm = (label: AiLabelWithRun) => {
    const ok = window.confirm(
      `Permanently delete label '${label.target}'? This cannot be undone.`,
    );
    if (!ok) return;
    void handleRemoveLabel(label);
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

          {jobReady ? (
            <>
              <TaskSelector selectedTask={selectedTask} onTaskChange={setSelectedTask} />
              <CommandInput
                jobId={jobId}
                currentFrame={currentFrame}
                firstFrameBase64={firstFrame}
                videoMetadata={videoMetadata}
                modality={modality}
                onModalityChange={setModality}
                onMaskGenerated={() => {}}
                onLabelAdded={fetchLabels}
                selectedTask={selectedTask}
                canvasContainer={canvasHost}
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
                          onClick={() => handleToggleLabel(label, !label.approved)}
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
              {jobReady && (
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
              Upload processing must finish before AI analysis is available.
            </div>
          )}
        </aside>

        {/* Main canvas area */}
        <main className="flex-1 flex flex-col">
          {viewerActive && jobId && jobReady ? (
            <FrameViewer
              jobId={jobId}
              onContinueToDownload={() => setViewerActive(false)}
              onBackToInference={() => setViewerActive(false)}
            />
          ) : (
            // 5A relocation (Bug 1): the dead, wrong-mode MaskingCanvas instance
            // (selectedTool="rectangle", onMaskUpdate no-op, hardcoded zoom) is
            // removed. This host is the portal target for CommandInput's real
            // bbox drawing surface, which overlays the masked frame as backdrop.
            <div
              ref={setCanvasHost}
              className="flex-1 min-h-0 overflow-auto p-6 flex items-start justify-center"
              data-testid="ai-canvas-host"
            />
          )}
        </main>
      </div>
    </div>
  );
}
