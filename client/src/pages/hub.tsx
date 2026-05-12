import { useLocation } from "wouter";
import { useJob } from "@/contexts/JobContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  FileVideo,
  Layers,
  Brain,
  Tags,
  ArrowRight,
  Loader2,
  AlertCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function HubPage() {
  const { job, isLoading, error } = useJob();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" size={32} />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <AlertCircle className="mx-auto text-destructive" size={32} />
          <p className="text-sm text-muted-foreground">{error ?? "Job not found"}</p>
          <Button variant="outline" onClick={() => window.location.assign("/upload")}>
            Back to Upload
          </Button>
        </div>
      </div>
    );
  }

  const isReady = job.status === "ready";
  const isFailed = job.status === "failed";

  // Derive spoke tile statuses
  const templateMaskStatus = job.templateMask
    ? job.templateMask.status === "complete"
      ? "Applied"
      : job.templateMask.status
    : "Not started";

  const aiRunCount = job.ai?.runs?.length ?? 0;
  const aiStatus =
    aiRunCount > 0 ? `${aiRunCount} run${aiRunCount !== 1 ? "s" : ""}` : "Not started";

  // Sub-state label for initializing panel
  const subStateLabel = (status: string) => {
    switch (status) {
      case "uploading":
        return "Uploading…";
      case "probing":
        return "Analyzing media…";
      case "extracting":
        return "Extracting frames…";
      default:
        return "Extracting frames…";
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center px-6 py-4">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <FileVideo className="text-primary-foreground" size={16} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Masquerade</h1>
              <p className="text-xs text-muted-foreground">High-Performance Video Processing</p>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-5xl mx-auto w-full space-y-6">
        {/* ── Status strip ─────────────────────────────────────────────── */}
        <div className="border border-border rounded-xl p-5 bg-card space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold truncate">{job.filename}</h2>

            {/* PHI badge */}
            {job.phiStatus === "user_attested" && job.attestationRecord && (
              <Badge
                variant="outline"
                className={
                  job.attestationRecord.choice === "no_phi"
                    ? "border-green-500/50 text-green-600 dark:text-green-400 bg-green-500/10"
                    : "border-amber-500/50 text-amber-600 dark:text-amber-400 bg-amber-500/10"
                }
              >
                {job.attestationRecord.choice === "no_phi"
                  ? "No PHI"
                  : "Contains PHI"}
              </Badge>
            )}
          </div>

          {/* Metadata row */}
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>Uploaded {new Date(job.uploadedAt).toLocaleString()}</span>
            {job.source.width > 0 && (
              <span>
                {job.source.width}&times;{job.source.height}
              </span>
            )}
            {job.source.duration > 0 && (
              <span>{job.source.duration.toFixed(1)}s</span>
            )}
            {job.source.totalFrames > 0 && (
              <span>{job.source.totalFrames} frames</span>
            )}
          </div>
        </div>

        {/* ── Initializing panel ───────────────────────────────────────── */}
        {!isReady && !isFailed && (
          <div className="border border-border rounded-xl p-5 bg-card space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="animate-spin text-primary" size={20} />
              <span className="text-sm font-medium">
                {subStateLabel(job.status)}
              </span>
            </div>
            <Progress value={undefined} className="h-2" />
            <p className="text-xs text-muted-foreground">
              This may take a moment depending on the file size.
            </p>
          </div>
        )}

        {isFailed && (
          <div className="border border-destructive/30 rounded-xl p-5 bg-destructive/5 space-y-2">
            <div className="flex items-center gap-2">
              <AlertCircle className="text-destructive" size={18} />
              <span className="text-sm font-medium text-destructive">
                Processing failed
              </span>
            </div>
            {job.errorMessage && (
              <p className="text-xs text-muted-foreground">{job.errorMessage}</p>
            )}
          </div>
        )}

        {/* ── Spoke tiles ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Tile 1: Template Mask */}
          <SpokeTile
            title="Template Mask"
            icon={<Layers size={24} />}
            status={templateMaskStatus}
            disabled={!isReady}
            onClick={() => navigate("/template-mask")}
          />

          {/* Tile 2: Classify or Label — disabled */}
          <SpokeTile
            title="Classify or Label"
            icon={<Tags size={24} />}
            status="Coming soon"
            disabled
            comingSoon
          />

          {/* Tile 3: Run AI Models */}
          <SpokeTile
            title="Run AI Models"
            icon={<Brain size={24} />}
            status={aiStatus}
            disabled={!isReady}
            onClick={() => navigate("/ai")}
          />
        </div>
      </main>
    </div>
  );
}

// ── SpokeTile sub-component ───────────────────────────────────────────────

function SpokeTile({
  title,
  icon,
  status,
  disabled,
  comingSoon,
  onClick,
}: {
  title: string;
  icon: React.ReactNode;
  status: string;
  disabled: boolean;
  comingSoon?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`
        w-full border border-border rounded-xl p-6 text-left transition-all
        flex flex-col gap-4
        ${disabled
          ? "opacity-50 cursor-not-allowed bg-muted/30"
          : "bg-card hover:border-primary/50 hover:shadow-md cursor-pointer"
        }
      `}
    >
      <div className="flex items-center justify-between">
        <div className="text-muted-foreground">{icon}</div>
        {!disabled && <ArrowRight size={16} className="text-muted-foreground" />}
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className={`text-xs mt-1 ${comingSoon ? "text-muted-foreground italic" : "text-muted-foreground"}`}>
          {status}
        </p>
      </div>
    </button>
  );

  if (disabled && !comingSoon) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent>Waiting for frame extraction.</TooltipContent>
      </Tooltip>
    );
  }

  return inner;
}
