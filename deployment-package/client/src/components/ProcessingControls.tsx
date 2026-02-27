import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Play, HelpCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { MaskData, OutputSettings } from "@shared/schema";
import { posthog } from "@/lib/posthog";

interface ProcessingControlsProps {
  jobId: string | null;
  maskData: MaskData | null;
  videoMetadata: any;
  onStartProcessing: (outputSettings: OutputSettings) => void;
  disabled: boolean;
  hasExistingMask?: boolean;
  isProcessing?: boolean;
  lastProcessedSettings?: OutputSettings | null;
}

export default function ProcessingControls({
  jobId,
  maskData,
  videoMetadata,
  onStartProcessing,
  disabled,
  hasExistingMask = false,
  isProcessing = false,
  lastProcessedSettings = null
}: ProcessingControlsProps) {
  const [outputSize, setOutputSize] = useState<'224x224' | '256x256' | '512x512' | '1024x1024' | '416x416' | 'original' | 'custom'>('original');
  const [customWidth, setCustomWidth] = useState(512);
  const [customHeight, setCustomHeight] = useState(512);
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpg'>('png');
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [aspectRatioMode, setAspectRatioMode] = useState<'stretch' | 'letterbox' | 'crop'>('letterbox');
  const { toast } = useToast();

  // Check if current settings differ from last processed settings
  const currentSettings: OutputSettings = {
    size: outputSize,
    customWidth: outputSize === 'custom' ? customWidth : undefined,
    customHeight: outputSize === 'custom' ? customHeight : undefined,
    format: outputFormat,
    includeMetadata,
    parallelThreads: 8,
    batchSize: 12,
    aspectRatioMode
  };

  const settingsHaveChanged = lastProcessedSettings && (
    lastProcessedSettings.size !== currentSettings.size ||
    lastProcessedSettings.customWidth !== currentSettings.customWidth ||
    lastProcessedSettings.customHeight !== currentSettings.customHeight ||
    lastProcessedSettings.format !== currentSettings.format ||
    lastProcessedSettings.includeMetadata !== currentSettings.includeMetadata ||
    lastProcessedSettings.aspectRatioMode !== currentSettings.aspectRatioMode
  );

  const processingMutation = useMutation({
    mutationFn: async (settings: OutputSettings) => {
      // Debug: Check what data we have
      console.log('\n🎯 FRONTEND PROCESSING MUTATION:');
      console.log('================================');
      console.log('JobID:', jobId);
      console.log('Has maskData:', !!maskData);
      console.log('MaskData type:', maskData?.type);
      console.log('MaskData coordinates:', maskData?.coordinates);
      console.log('MaskData has canvasDataUrl:', !!maskData?.canvasDataUrl);
      console.log('MaskData canvasDataUrl length:', maskData?.canvasDataUrl?.length || 0);
      console.log('================================\n');
      
      if (!jobId || !maskData) {
        console.error('❌ STOPPING: Missing data', { jobId: !!jobId, maskData: !!maskData });
        throw new Error('Missing job ID or mask data');
      }

      // WORKAROUND: Use non-API route to completely bypass Vite
      console.log('🔧 WORKAROUND: Using non-API route to completely bypass Vite...');
      const response = await apiRequest('PATCH', `/internal/mask-processing/${jobId}`, {
        maskData,
        outputSettings: settings
      });
      
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Processing Started",
        description: "Your video is being processed. You can monitor progress below.",
      });
    },
    onError: (error) => {
      console.error('Processing error:', error);
      toast({
        title: "Processing Failed",
        description: error instanceof Error ? error.message : "Failed to start processing",
        variant: "destructive",
      });
    },
  });

  const handleStartProcessing = () => {
    const outputSettings: OutputSettings = {
      size: outputSize,
      customWidth: outputSize === 'custom' ? customWidth : undefined,
      customHeight: outputSize === 'custom' ? customHeight : undefined,
      format: outputFormat,
      includeMetadata,
      parallelThreads: 8,
      batchSize: 12,
      aspectRatioMode
    };

    processingMutation.mutate(outputSettings);
    onStartProcessing(outputSettings);
    
    posthog.capture('mask_processing_started', {
      job_id: jobId,
      mask_type: maskData?.type,
      output_size: outputSize,
      output_format: outputFormat,
      aspect_ratio_mode: aspectRatioMode
    });
  };

  const estimateProcessingTime = () => {
    if (!videoMetadata) return "Unknown";
    
    const framesPerSecond = 4; // Processing speed target
    const totalFrames = videoMetadata.totalFrames || 0;
    const estimatedSeconds = Math.ceil(totalFrames / framesPerSecond);
    
    if (estimatedSeconds < 60) {
      return `${estimatedSeconds} seconds`;
    } else {
      const minutes = Math.floor(estimatedSeconds / 60);
      const seconds = estimatedSeconds % 60;
      return `${minutes}m ${seconds}s`;
    }
  };

  return (
    <div className="p-6 flex-1 flex flex-col">
      <h2 className="text-lg font-semibold mb-4">Processing</h2>
      
      {/* Output Settings */}
      <div className="mb-6 space-y-4">
        <div>
          <Label className="text-sm font-medium text-muted-foreground mb-2 block">
            Output Size
          </Label>
          <Select value={outputSize} onValueChange={(value: any) => setOutputSize(value)}>
            <SelectTrigger data-testid="output-size-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="original">Original Size</SelectItem>
              <SelectItem value="224x224">224x224</SelectItem>
              <SelectItem value="256x256">256x256</SelectItem>
              <SelectItem value="416x416">416x416</SelectItem>
              <SelectItem value="512x512">512x512 (Standard)</SelectItem>
              <SelectItem value="1024x1024">1024x1024 (High Quality)</SelectItem>
              <SelectItem value="custom">Custom Size</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Custom size inputs */}
        {outputSize === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Width</Label>
              <input
                type="number"
                value={customWidth}
                onChange={(e) => setCustomWidth(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
                min="64"
                max="2048"
                data-testid="custom-width-input"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Height</Label>
              <input
                type="number"
                value={customHeight}
                onChange={(e) => setCustomHeight(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
                min="64"
                max="2048"
                data-testid="custom-height-input"
              />
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Label className="text-sm font-medium text-muted-foreground">
              Aspect Ratio Mode
            </Label>
            <div className="group relative">
              <HelpCircle size={14} className="text-muted-foreground hover:text-foreground cursor-help" />
              <div className="invisible group-hover:visible absolute z-50 left-0 top-6 w-96 bg-popover border border-border rounded-md shadow-lg p-3 text-xs">
                <div className="space-y-3">
                  <div><strong>Stretch to Fit:</strong> Stretches image to exact output size (may distort proportions). Use when exact dimensions matter more than preserving natural proportions, like creating thumbnails for grid layouts.</div>
                  <div><strong>Letterbox with Padding:</strong> Preserves aspect ratio, adds black bars if needed. Use when you need the full image visible without cropping, like creating video previews or displaying artwork.</div>
                  <div><strong>Center Crop:</strong> Preserves aspect ratio, crops excess content. Use when you want the most important central content to fill the frame, like profile photos or product images.</div>
                </div>
              </div>
            </div>
          </div>
          <Select value={aspectRatioMode} onValueChange={(value: any) => setAspectRatioMode(value)}>
            <SelectTrigger data-testid="aspect-ratio-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stretch">Stretch to Fit</SelectItem>
              <SelectItem value="letterbox">Letterbox with Padding</SelectItem>
              <SelectItem value="crop">Center Crop</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {aspectRatioMode === 'stretch' && 'Stretches image to exact output size (may distort)'}
            {aspectRatioMode === 'letterbox' && 'Preserves aspect ratio, adds black bars if needed'}
            {aspectRatioMode === 'crop' && 'Preserves aspect ratio, crops excess content'}
          </p>
        </div>

        <div>
          <Label className="text-sm font-medium text-muted-foreground mb-2 block">
            Format
          </Label>
          <Select value={outputFormat} onValueChange={(value: any) => setOutputFormat(value)}>
            <SelectTrigger data-testid="output-format-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="png">PNG (Lossless)</SelectItem>
              <SelectItem value="jpg">JPG (Compressed)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="includeMetadata"
            checked={includeMetadata}
            onCheckedChange={(checked) => setIncludeMetadata(checked as boolean)}
            data-testid="metadata-checkbox"
          />
          <Label htmlFor="includeMetadata" className="text-sm">
            Include Metadata CSV
          </Label>
        </div>
      </div>

      {/* Process Button */}
      <div className="mt-auto space-y-2">
        <Button
          className={`w-full ${settingsHaveChanged ? 'bg-primary hover:bg-primary/90' : ''}`}
          size="lg"
          onClick={handleStartProcessing}
          disabled={disabled || processingMutation.isPending || (isProcessing && !settingsHaveChanged)}
          data-testid="start-processing-button"
        >
          <Play size={16} className="mr-2" />
          {processingMutation.isPending ? "Starting..." : 
           hasExistingMask ? (settingsHaveChanged ? "Re-process with New Settings" : "Apply Mask to All") : "Apply Mask to All Frames"}
        </Button>
        
        {hasExistingMask && !isProcessing && (
          <p className="text-xs text-muted-foreground text-center">
            {settingsHaveChanged ? 
              "Settings changed - click above to re-process with new output settings" :
              "Change output size, format, or aspect ratio above to re-process with the same mask"
            }
          </p>
        )}
        
        {videoMetadata && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Estimated time: <span data-testid="estimated-time">{estimateProcessingTime()}</span>
          </p>
        )}
      </div>
    </div>
  );
}
