import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import FileUpload from "@/components/FileUpload";
import MaskingCanvas from "@/components/MaskingCanvas";
import MaskingTools from "@/components/MaskingTools";
import ProcessingControls from "@/components/ProcessingControls";
import ProcessingStatus from "@/components/ProcessingStatus";
import { Settings, Video } from "lucide-react";
import type { MaskData, OutputSettings } from "@shared/schema";

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

  // Monitor job status to reset processing state when complete
  const { data: jobData } = useQuery({
    queryKey: ['/api/videos', currentJob],
    refetchInterval: 2000,
    enabled: !!currentJob
  });

  // Reset processing state when job completes
  useEffect(() => {
    if (jobData) {
      const job = (jobData as any)?.job;
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
        <aside className="w-80 border-r border-border bg-card flex flex-col">
          {/* Step 1: Upload Video */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                1
              </div>
              <h2 className="text-lg font-semibold">Upload Video</h2>
            </div>
          </div>
          <FileUpload onUploadComplete={handleUploadComplete} />
          
          {/* Step 2: Masking Tools */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium ${currentJob ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                2
              </div>
              <h2 className="text-lg font-semibold">Masking Tools</h2>
            </div>
          </div>
          <MaskingTools 
            selectedTool={selectedTool}
            onToolChange={setSelectedTool}
            maskData={maskData}
            onMaskUpdate={handleMaskUpdate}
          />
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
          
          {/* Step 3: Processing */}
          {currentJob && (
            <div className="border-t border-border bg-card">
              <div className="p-4 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium ${currentJob && maskData ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                    3
                  </div>
                  <h2 className="text-lg font-semibold">Processing</h2>
                </div>
              </div>
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
            </div>
          )}
          
          {currentJob && (
            <ProcessingStatus jobId={currentJob} />
          )}
        </main>
      </div>
    </div>
  );
}
