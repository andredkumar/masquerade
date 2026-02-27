import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Download, Pause, Square, AlertTriangle, Upload } from "lucide-react";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { ProcessingProgress } from "@shared/schema";
import { posthog } from "@/lib/posthog";

interface ProcessingStatusProps {
  jobId: string;
}

export default function ProcessingStatus({ jobId }: ProcessingStatusProps) {
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);

  // WebSocket connection for real-time updates
  const { socket, isConnected } = useWebSocket();

  // Poll for job status
  const { data: jobData } = useQuery({
    queryKey: ['/api/videos', jobId],
    refetchInterval: 2000,
    enabled: !!jobId
  });

  // Set up WebSocket listeners
  useEffect(() => {
    if (!socket || !jobId) return;

    socket.emit('join', jobId);

    const handleProgress = (progressData: ProcessingProgress) => {
      if (progressData.jobId === jobId) {
        setProgress(progressData);
      }
    };

    socket.on('progress', handleProgress);

    return () => {
      socket.off('progress', handleProgress);
    };
  }, [socket, jobId]);

  const currentProgress = progress || (jobData as any)?.progress;
  const job = (jobData as any)?.job;

  if (!currentProgress && !job) {
    return (
      <div className="border-t border-border bg-card p-6">
        <div className="text-center text-muted-foreground">
          Loading processing status...
        </div>
      </div>
    );
  }

  const getStageLabel = (stage: string) => {
    switch (stage) {
      case 'uploading': return 'Uploading';
      case 'extracting': return 'Extracting Frames';
      case 'processing': return 'Processing Frames';
      case 'exporting': return 'Creating Output';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return 'Processing';
    }
  };

  const getStageColor = (stage: string) => {
    switch (stage) {
      case 'completed': return 'default';
      case 'failed': return 'destructive';
      default: return 'secondary';
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleDownload = () => {
    window.open(`/api/videos/${jobId}/download`, '_blank');
    
    posthog.capture('frames_downloaded', {
      job_id: jobId
    });
  };

  const handleUploadAnother = () => {
    // Refresh the page to restart the upload process
    window.location.reload();
  };

  const handlePause = () => {
    console.log('Pause processing');
  };

  const handleStop = () => {
    console.log('Stop processing');
  };

  return (
    <div className="border-t border-border bg-card p-6" data-testid="processing-status">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Progress Overview */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Processing Status</h3>
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <div className={`w-2 h-2 rounded-full ${currentProgress?.stage === 'completed' ? 'bg-green-500' : 'bg-accent animate-pulse'}`}></div>
                <Badge variant={getStageColor(currentProgress?.stage || 'processing')}>
                  {getStageLabel(currentProgress?.stage || 'processing')}
                </Badge>
              </div>
              {isConnected && (
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <div className="w-1 h-1 bg-green-500 rounded-full"></div>
                  Live
                </div>
              )}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-2">
              <span>Frame Processing</span>
              <span data-testid="frame-progress">
                {currentProgress?.currentFrame || 0} / {currentProgress?.totalFrames || 0} frames
              </span>
            </div>
            <Progress 
              value={currentProgress?.progress || 0} 
              className="h-3"
              data-testid="progress-bar"
            />
          </div>

        </div>

        {/* Current Task */}
        <div>
          <h4 className="font-semibold mb-4">Current Task</h4>
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              <div className="relative w-12 h-12">
                <svg className="w-12 h-12 transform -rotate-90">
                  <circle 
                    cx="24" cy="24" r="20" 
                    stroke="hsl(var(--muted))" 
                    strokeWidth="4" 
                    fill="none" 
                  />
                  <circle 
                    cx="24" cy="24" r="20" 
                    stroke="hsl(var(--accent))" 
                    strokeWidth="4" 
                    fill="none"
                    strokeDasharray="125.6"
                    strokeDashoffset={125.6 - (125.6 * (currentProgress?.progress || 0) / 100)}
                    className="transition-all duration-300"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xs font-bold" data-testid="progress-percentage">
                    {Math.round(currentProgress?.progress || 0)}%
                  </span>
                </div>
              </div>
              <div>
                <div className="font-medium text-sm" data-testid="current-task">
                  {getStageLabel(currentProgress?.stage || 'processing')}
                </div>
                <div className="text-xs text-muted-foreground">
                  Processing batch of frames
                </div>
              </div>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <div>Status: <span className="font-mono text-foreground">{job?.status || 'unknown'}</span></div>
              <div>Progress: <span className="font-mono text-foreground">{(currentProgress?.progress || 0).toFixed(1)}%</span></div>
              {job?.completedAt && (
                <div>Completed: <span className="font-mono text-foreground">
                  {new Date(job.completedAt).toLocaleTimeString()}
                </span></div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Error Messages */}
      {currentProgress?.errorMessage && (
        <Alert className="mt-6" variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {currentProgress.errorMessage}
          </AlertDescription>
        </Alert>
      )}

      {/* Controls */}
      <div className="mt-6 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {job?.status === 'completed' ? (
            <span>Processing completed successfully</span>
          ) : (
            <span>Processing in progress...</span>
          )}
        </div>
        <div className="flex space-x-3">
          {job?.status === 'completed' ? (
            <>
              <Button onClick={handleDownload} data-testid="download-button">
                <Download size={16} className="mr-2" />
                Download ZIP
              </Button>
              <Button variant="outline" onClick={handleUploadAnother} data-testid="upload-another-button">
                <Upload size={16} className="mr-2" />
                Upload Another Image
              </Button>
            </>
          ) : (
            <>
              <Button 
                variant="outline" 
                onClick={handlePause}
                data-testid="pause-button"
              >
                <Pause size={16} className="mr-2" />
                Pause
              </Button>
              <Button 
                variant="outline" 
                onClick={handleStop}
                data-testid="stop-button"
              >
                <Square size={16} className="mr-2" />
                Stop
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
