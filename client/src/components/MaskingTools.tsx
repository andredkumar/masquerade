import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Circle, Square, Triangle, PaintbrushVertical, Eraser, Undo, Trash2, Info, MousePointer, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MaskData } from "@shared/schema";
import type { MaskMode } from "@/components/MaskingCanvas";

interface MaskingToolsProps {
  selectedTool: string;
  onToolChange: (tool: string) => void;
  maskData: MaskData | null;
  onMaskUpdate: (maskData: MaskData) => void;
  /** Output Round 1 (O2): Exclude = what you draw is blanked (default, today); Keep = what you draw is kept. */
  maskMode?: MaskMode;
  onMaskModeChange?: (mode: MaskMode) => void;
  /** Locked to Exclude while an auto-mask proposal or accepted cone is on the canvas (kickoff §2). */
  maskModeLocked?: boolean;
}

export default function MaskingTools({ 
  selectedTool, 
  onToolChange, 
  maskData, 
  onMaskUpdate,
  maskMode = 'exclude',
  onMaskModeChange,
  maskModeLocked = false
}: MaskingToolsProps) {

  const presetShapes = [
    { id: 'circle', icon: Circle, label: 'Circle' },
    { id: 'rectangle', icon: Square, label: 'Rectangle' },
    { id: 'polygon', icon: Triangle, label: 'Polygon' }
  ];

  const drawingTools = [
    { id: 'brush', icon: PaintbrushVertical, label: 'Brush Tool' },
    { id: 'eraser', icon: Eraser, label: 'Erase All' }
  ];


  const handleUndo = () => {
    // Implement undo functionality - emit event to canvas
    const event = new CustomEvent('undoMask');
    window.dispatchEvent(event);
  };

  const handleClearMask = () => {
    // Clear the current mask - emit event to canvas
    const event = new CustomEvent('clearMask');
    window.dispatchEvent(event);
  };

  return (
    <div className="p-6 border-b border-border">

      {/* Output Round 1 (O2): Keep / Exclude — one toggle per job, default Exclude (today's behaviour) */}
      <div className="mb-4">
        <Label className="text-sm font-medium text-muted-foreground mb-2 block">
          What you draw is
        </Label>
        <ToggleGroup
          type="single"
          variant="outline"
          className="justify-start"
          value={maskMode}
          disabled={maskModeLocked}
          onValueChange={(v) => { if (v === 'exclude' || v === 'keep') onMaskModeChange?.(v); }}
          aria-label="Mask mode"
          data-testid="mask-mode"
        >
          <ToggleGroupItem value="exclude" className="flex-1" data-testid="mask-mode-exclude">Remove</ToggleGroupItem>
          <ToggleGroupItem value="keep" className="flex-1" data-testid="mask-mode-keep">Keep</ToggleGroupItem>
        </ToggleGroup>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="mask-mode-hint">
          {maskModeLocked ? (
            <span className="inline-flex items-center gap-1"><Lock size={12} /> Auto-mask active — the drawn region is blanked.</span>
          ) : maskMode === 'keep' ? (
            'Drawn areas are kept; everything else is removed.'
          ) : (
            'Drawn areas are removed; everything else stays.'
          )}
        </p>
      </div>
      
      {/* Select Tool */}
      <div className="mb-4">
        <Label className="text-sm font-medium text-muted-foreground mb-2 block">
          Selection
        </Label>
        <Button
          variant={selectedTool === 'select' ? "default" : "outline"}
          className={cn(
            "w-full justify-start",
            selectedTool === 'select' && "bg-primary text-primary-foreground"
          )}
          onClick={() => onToolChange('select')}
          data-testid="tool-select"
        >
          <MousePointer size={16} className="mr-2" />
          Select & Move
        </Button>
      </div>

      {/* Preset Shapes */}
      <div className="mb-4">
        <Label className="text-sm font-medium text-muted-foreground mb-2 block">
          Preset Shapes
        </Label>
        <div className="grid grid-cols-3 gap-2">
          {presetShapes.map((shape) => (
            <Button
              key={shape.id}
              variant={selectedTool === shape.id ? "default" : "outline"}
              className={cn(
                "p-3 h-auto flex flex-col items-center gap-1",
                selectedTool === shape.id && "bg-primary text-primary-foreground"
              )}
              onClick={() => onToolChange(shape.id)}
              data-testid={`preset-${shape.id}`}
            >
              <shape.icon size={20} />
              <span className="text-xs">{shape.label}</span>
            </Button>
          ))}
        </div>
      </div>

      {/* Drawing Tools */}
      <div className="mb-4">
        <Label className="text-sm font-medium text-muted-foreground mb-2 block">
          Drawing Tools
        </Label>
        <div className="space-y-2">
          {drawingTools.map((tool) => (
            <div key={tool.id} className="flex items-center gap-1">
              <Button
                variant={selectedTool === tool.id ? "default" : "outline"}
                className={cn(
                  "flex-1 justify-start",
                  selectedTool === tool.id && "bg-primary text-primary-foreground"
                )}
                onClick={() => onToolChange(tool.id)}
                data-testid={`tool-${tool.id}`}
              >
                <tool.icon size={16} className="mr-2" />
                {tool.label}
              </Button>
              <div className="relative group">
                <Info size={14} className="text-muted-foreground cursor-help" />
                <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 bg-popover text-popover-foreground text-xs p-2 rounded border shadow-md opacity-0 group-hover:opacity-100 pointer-events-none z-10 w-48 transition-opacity">
                  {tool.id === 'brush' ? 
                    'Paint mask areas to define the region you want to extract from each frame.' :
                    'Remove mask areas to exclude regions from your selection.'
                  }
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <Button 
          variant="secondary" 
          className="w-full"
          onClick={handleUndo}
          data-testid="undo-button"
        >
          <Undo size={16} className="mr-2" />
          Undo
        </Button>
        
        <Button 
          variant="secondary" 
          className="w-full"
          onClick={handleClearMask}
          data-testid="clear-mask-button"
        >
          <Trash2 size={16} className="mr-2" />
          Clear Mask
        </Button>
      </div>
    </div>
  );
}
