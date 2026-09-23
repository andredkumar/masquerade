import { useState, useEffect, useCallback, useRef, useReducer, useMemo } from "react";
import { useLocation } from "wouter";
import { useJob } from "@/contexts/JobContext";
import MaskingCanvas, { type ProposalEvent, type ProposalLayerProps, type MaskMode } from "@/components/MaskingCanvas";
import AutomaskProposalBar from "@/components/AutomaskProposalBar";
import MaskingTools from "@/components/MaskingTools";
import ProcessingControls from "@/components/ProcessingControls";
import ProcessingStatus from "@/components/ProcessingStatus";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileVideo, Loader2, AlertCircle } from "lucide-react";
import type { MaskData, OutputSettings } from "@shared/schema";
import { useAutomaskProposal, sessionReducer, buildOutcome, decideOutcome, postOutcome, type ProposalSession } from "@/hooks/useAutomaskProposal";
import type { ControlId, ShapeKind } from "@shared/automask/shape";

type FrameStatus = "loading" | "ready" | "extracting" | "not_found" | "gone" | "error";

/** `reason` from the frames endpoint's 410 body (routes.ts, item 28). */
type GoneReason = "uploads_swept" | "frames_swept" | null;

// Round 2A: how long the spoke waits for frame 1 to appear before giving up.
// Only reachable if the user opens the spoke faster than the first extraction
// batch lands, or if extraction died without updating status (see §4 of
// docs/refactor/ROUND2A_FRAME0_UNBLOCK.md).
const FRAME0_POLL_MS = 1000;
const FRAME0_POLL_TIMEOUT_MS = 120_000;

export default function TemplateMaskSpokePage() {
  const { job, refetch, progress } = useJob();
  const [, navigate] = useLocation();

  // Local state
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<FrameStatus>("loading");
  // Item 28: the 410 body now carries a `reason` so the panel can say which
  // retention window elapsed. Absent (older server, or an unexpected 410) →
  // null → the generic copy.
  const [goneReason, setGoneReason] = useState<GoneReason>(null);
  const [maskData, setMaskData] = useState<MaskData | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>("rectangle");
  // Output Round 1 (O2): one Keep / Exclude toggle per job, default Exclude (today's behaviour). Locked to Exclude while
  // an auto-mask proposal or accepted cone is on the canvas — the evenodd path already encodes keep-semantics and would
  // invert under the swap (kickoff §2).
  const [maskMode, setMaskMode] = useState<MaskMode>("exclude");
  const [canvasZoom, setCanvasZoom] = useState(75);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastProcessedSettings, setLastProcessedSettings] = useState<OutputSettings | null>(null);
  // Frame count reported by the most recent 503 body (Round 2A). Used only as a
  // fallback for the extraction notice when no socket `progress` event has
  // landed yet.
  const [framesReady, setFramesReady] = useState<number | null>(null);

  const jobId = job?.id ?? "";

  // ---- Auto-mask Round 2B-2: the proposal session (docs/refactor/AUTOMASK_ROUND2B2_PLAN.md §1) ---------------------
  // Fetched once frame 1 is on screen; null = today's spoke exactly (flag off / withheld / error / timeout). The spoke
  // owns every parameter; MaskingCanvas draws `canvasProposal` and reports handle drags, removals and the accept hand-off.
  const proposalBody = useAutomaskProposal(jobId, frameStatus === "ready");
  const [session, dispatch] = useReducer(sessionReducer, null);
  const expectAcceptUpdate = useRef(false);
  useEffect(() => {
    if (proposalBody && !session) {
      dispatch({ type: "init", body: proposalBody });
      // Kickoff §3.3: no drawing tool while the proposal shows, so a stray click-drag cannot draw a rectangle and cost
      // the user the proposal. Draw from scratch restores "rectangle".
      setSelectedTool("select");
    }
  }, [proposalBody, session]);
  const maskModeLocked = !!(session && !session.dismissed);
  const effectiveMaskMode: MaskMode = maskModeLocked ? "exclude" : maskMode;
  const canvasProposal = useMemo<ProposalLayerProps | null>(
    () => (session && !session.dismissed ? { shape: session.current, bound: session.body.bound, margin: session.body.margin_px, mode: session.mode } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.current, session?.body, session?.mode, session?.dismissed],
  );
  const frame = useMemo(() => ({ w: session?.body.width ?? 0, h: session?.body.height ?? 0 }), [session?.body]);
  const postOnce = useCallback((s: ProposalSession, outcome: "accept" | "edit" | "draw_from_scratch") => {
    if (s.posted || !jobId) return;                 // one line per job per spoke session (kickoff §3.8)
    postOutcome(jobId, buildOutcome(s, outcome, performance.now()));
    dispatch({ type: "posted" });
  }, [jobId]);
  const handleProposalEvent = (e: ProposalEvent) => {
    switch (e.kind) {
      case "rendered": dispatch({ type: "rendered", t: performance.now() }); break;
      case "drag": dispatch({ type: "nudge", dx: e.dx, dy: e.dy }); break;
      case "accepted": expectAcceptUpdate.current = true; break;
      case "removed":
        // A stroke (proposal mode) or Clear / Erase All (either mode) took the layer away: the user draws by hand.
        if (session && !session.dismissed) { postOnce(session, "draw_from_scratch"); dispatch({ type: "dismiss" }); }
        break;
    }
  };
  const handleAccept = () => dispatch({ type: "accept" });
  const handleAdjust = () => { dispatch({ type: "adjust" }); setMaskData(null); };
  const handleDrawFromScratch = () => {
    if (session && !session.dismissed) { postOnce(session, "draw_from_scratch"); dispatch({ type: "dismiss" }); }
    setMaskData(null);
    setSelectedTool("rectangle");
  };

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
  // `silent` is used by the Round 2A poll: flipping to "loading" on every tick
  // would bounce the view between the waiting screen and the canvas spinner
  // once a second. A silent attempt leaves the current state alone until it has
  // something better to say.
  const fetchFirstFrame = useCallback(async (silent = false) => {
    if (!jobId) return;
    if (!silent) setFrameStatus("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/frames/0`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setFirstFrame(url);
        setFrameStatus("ready");
      } else if (res.status === 503) {
        // Round 2A: the endpoint now answers 503 only when frame `n` is not yet
        // on disk (or is mid-write), not merely because the job is extracting.
        // The body carries how many frames have landed so far.
        try {
          const body = await res.json();
          if (typeof body?.framesReady === "number") setFramesReady(body.framesReady);
        } catch {
          /* body is advisory only — a parse failure must not change the state machine */
        }
        setFrameStatus("extracting");
      } else if (res.status === 404) {
        setFrameStatus("not_found");
      } else if (res.status === 410) {
        // Item 28: read the cause rather than asserting a restart. The old
        // hardcoded "the server may have restarted" was shown for every 410,
        // including image batches where nothing had restarted and nothing had
        // been swept — it cost an hour of live misdiagnosis on 2026-09-04.
        let reason: GoneReason = null;
        try {
          const body = await res.json();
          if (body?.reason === "uploads_swept" || body?.reason === "frames_swept") {
            reason = body.reason;
          }
        } catch {
          /* body is advisory only — a parse failure falls back to generic copy */
        }
        setGoneReason(reason);
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

  // Round 2A: poll frame 0 itself while it is not yet available, so the canvas
  // appears the moment the first extraction batch lands rather than waiting for
  // the whole run to finish. Bounded — after FRAME0_POLL_TIMEOUT_MS we fall to
  // the existing error state rather than spinning forever (the server-restart
  // case in §4). Cleared on unmount and as soon as the fetch succeeds, since
  // fetchFirstFrame flips frameStatus off "extracting".
  //
  // Replaces the previous 3 s `refetch()` interval, which polled the *job*
  // record — JobContext already does that every 2 s while the job is
  // non-terminal, so it was redundant even before this change.
  // The deadline is cleared only once a frame actually arrives — NOT whenever
  // frameStatus leaves "extracting". A retry passes through other states, and
  // resetting on those would restart the 120 s budget on every tick, so the cap
  // would never fire.
  const pollStartedAt = useRef<number | null>(null);
  useEffect(() => {
    if (frameStatus === "ready") {
      pollStartedAt.current = null;
      return;
    }
    if (frameStatus !== "extracting") return;
    if (pollStartedAt.current === null) pollStartedAt.current = Date.now();

    const timer = setInterval(() => {
      if (Date.now() - (pollStartedAt.current ?? Date.now()) > FRAME0_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        pollStartedAt.current = null;
        setFrameStatus("error");
        return;
      }
      void fetchFirstFrame(true);
    }, FRAME0_POLL_MS);

    return () => clearInterval(timer);
  }, [frameStatus, fetchFirstFrame]);

  // Phase 4d-1b: the separate 2s GET /api/videos/:jobId poll was redundant — JobContext already
  // refetches the V2 Job on the WebSocket 'progress' event that fires at apply completion/failure
  // (videoProcessor.ts:403-458,1081). Drive the banner off the canonical templateMask spoke status.
  useEffect(() => {
    const tmStatus = job?.templateMask?.status;
    if (isProcessing && (tmStatus === "complete" || tmStatus === "failed")) {
      setIsProcessing(false);
    }
  }, [job?.templateMask?.status, isProcessing]);

  // Round 2A: drawing is unblocked mid-extraction, but Apply is not — the apply
  // pipeline re-extracts from the original upload and the download expects the
  // full frame set, so it waits for `ready` exactly as before.
  const isExtracting = job?.status === "extracting";
  const canApply = job?.status === "ready";
  // Prefer the granular socket payload (JobContext already receives it); fall
  // back to the frame count the last 503 reported. No new backend source.
  const extractedSoFar =
    progress?.stage === "extracting" && typeof progress.currentFrame === "number"
      ? progress.currentFrame
      : framesReady;
  const totalFrames = progress?.totalFrames || job?.source.totalFrames || 0;
  const extractionNote = !isExtracting
    ? null
    : extractedSoFar != null && totalFrames > 0
      ? `Extracting frames… ${extractedSoFar} / ${totalFrames}`
      : "Extracting frames…";

  const handleMaskUpdate = (newMaskData: MaskData) => {
    // Output Round 1 (O6, sign-off §2): Clear Mask and Erase All report a maskData with no PNG. Before this round that
    // left Apply enabled on a mask the server's coordinate fallback rendered as nothing — a download of unmasked
    // frames labelled as masked. No PNG = no mask: Apply stays hidden until something is drawn, in both toggle modes.
    if (!newMaskData.canvasDataUrl) {
      setMaskData(null);
      return;
    }
    setMaskData(newMaskData);
    // 2B-2: in accepted mode the canvas reports one update for the accept hand-off (flagged by the 'accepted' event just
    // before it); any other update is a hand stroke unioned with the cone (sign-off §10-E) → the outcome becomes `edit`.
    if (session && !session.dismissed && session.mode === "accepted") {
      if (expectAcceptUpdate.current) expectAcceptUpdate.current = false;
      else dispatch({ type: "freehand" });
    }
  };

  const handleStartProcessing = (outputSettings: OutputSettings) => {
    if (!jobId || !maskData) return;
    setIsProcessing(true);
    setLastProcessedSettings(outputSettings);
    // 2B-2: the one outcome line per job fires on Apply — the committed moment — fire-and-forget, never gating Apply.
    if (session && !session.dismissed && session.mode === "accepted") postOnce(session, decideOutcome(session));
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
          <p className="text-sm font-medium">
            {goneReason === "uploads_swept"
              ? "Your uploaded images are no longer on the server"
              : "Frames are no longer available"}
          </p>
          <p className="text-xs text-muted-foreground">
            {goneReason === "uploads_swept"
              ? "Uploads are kept for 2 hours. Please re-upload your images."
              : goneReason === "frames_swept"
                ? "Extracted frames are kept for 6 hours, and are lost if the server restarts mid-extraction. Please re-upload your file."
                : "The server may have restarted. Please re-upload your file."}
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
          <p className="text-sm font-medium">Waiting for the first frame…</p>
          <p className="text-xs text-muted-foreground">
            {framesReady != null && totalFrames > 0
              ? `Extracted ${framesReady} / ${totalFrames}. The canvas opens as soon as frame 1 lands.`
              : "The canvas opens as soon as frame 1 lands."}
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
        <aside className="w-80 shrink-0 border-r border-border bg-card flex flex-col overflow-y-auto">
          {/* Masking tools */}
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-semibold">Draw Mask</h2>
          </div>
          <MaskingTools
            selectedTool={selectedTool}
            onToolChange={setSelectedTool}
            maskData={maskData}
            onMaskUpdate={handleMaskUpdate}
            maskMode={effectiveMaskMode}
            onMaskModeChange={setMaskMode}
            maskModeLocked={maskModeLocked}
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
              disabled={!jobId || !maskData || !canApply}
              extractionNote={extractionNote}
              hasExistingMask={!!maskData}
              isProcessing={isProcessing}
              lastProcessedSettings={lastProcessedSettings}
            />
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground space-y-1">
              <p>Draw a mask on the first frame to enable processing.</p>
              {extractionNote && <p className="text-primary">{extractionNote}</p>}
            </div>
          )}
        </aside>

        {/* Main canvas area */}
        <main className="flex-1 min-w-0 flex flex-col">
          {session && !session.dismissed && (
            <div className="px-6 pt-4">
              <AutomaskProposalBar
                fitted={session.fitted}
                current={session.current}
                mode={session.mode}
                grade={session.body.grade}
                frame={frame}
                onControl={(id: ControlId, value: number) => dispatch({ type: "control", id, value })}
                onNudge={(dx, dy) => dispatch({ type: "nudge", dx, dy })}
                onSwitch={(kind: ShapeKind) => dispatch({ type: "switch", kind })}
                onAccept={handleAccept}
                onAdjust={handleAdjust}
                onDrawFromScratch={handleDrawFromScratch}
              />
            </div>
          )}
          <div className="flex-1 min-h-0 p-6 relative overflow-auto">
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
                proposal={canvasProposal}
                onProposalEvent={handleProposalEvent}
                maskMode={effectiveMaskMode}
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
