/**
 * Draw Mask Tool - Complete Overview and Implementation
 * 
 * This file provides a comprehensive overview of how the interactive drawing mask tool works
 * in the Ultrasound Shield application, including its underlying code structure and functionality.
 */

// ================================
// OVERVIEW OF THE DRAW MASK TOOL
// ================================

/**
 * WHAT IS THE DRAW MASK TOOL?
 * 
 * The draw mask tool is an interactive canvas-based interface that allows users to:
 * 1. Mark sensitive areas (PHI - Protected Health Information) on medical images
 * 2. Create reusable mask templates that can be applied to multiple frames
 * 3. Draw red-colored regions that will be blacked out during processing
 * 4. Use brush and eraser tools with adjustable sizes
 * 5. Undo/redo actions and clear the entire mask
 * 
 * HOW IT WORKS:
 * - Users load a representative frame from their DICOM or video file
 * - An HTML5 canvas is overlaid on top of the image
 * - Users draw with mouse/touch to mark areas for removal
 * - The drawn mask is saved as a base64-encoded PNG template
 * - This template is then applied pixel-by-pixel to all frames in the study
 */

// ================================
// CORE ARCHITECTURE
// ================================

interface Point {
  x: number;
  y: number;
}

interface MaskToolState {
  isDrawing: boolean;
  tool: 'draw' | 'erase';
  brushSize: number;
  imageLoaded: boolean;
}

interface MaskTemplate {
  maskData: string;    // Base64 encoded PNG data
  brushSize: number;   // Size of brush used
  frameNumber: number; // Representative frame number
  studyId: string;     // Associated study ID
}

// ================================
// 1. CANVAS DRAWING ENGINE
// ================================

/**
 * The CanvasDrawing class handles all low-level drawing operations
 * Located in: client/src/lib/canvas-utils.ts
 */
export class CanvasDrawing {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private isDrawing: boolean = false;
  private tool: 'draw' | 'erase' = 'draw';
  private brushSize: number = 36;
  private history: ImageData[] = [];  // For undo/redo functionality
  private historyStep: number = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D context from canvas');
    }
    this.ctx = ctx;
    this.setupCanvas();
  }

  /**
   * Initialize canvas with drawing settings
   */
  private setupCanvas(): void {
    this.ctx.lineCap = 'round';    // Smooth brush edges
    this.ctx.lineJoin = 'round';   // Smooth line connections
    this.saveState();              // Save initial empty state
  }

  /**
   * Save current canvas state for undo/redo
   */
  private saveState(): void {
    this.historyStep++;
    if (this.historyStep < this.history.length) {
      this.history.length = this.historyStep;  // Remove forward history
    }
    // Capture entire canvas as ImageData
    this.history.push(this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height));
  }

  /**
   * Switch between drawing and erasing modes
   */
  setTool(tool: 'draw' | 'erase'): void {
    this.tool = tool;
  }

  /**
   * Adjust brush size for drawing/erasing
   */
  setBrushSize(size: number): void {
    this.brushSize = size;
  }

  /**
   * Begin drawing at a specific point
   */
  startDrawing(point: Point): void {
    this.isDrawing = true;
    this.drawPoint(point);
  }

  /**
   * Continue drawing to a new point
   */
  draw(point: Point): void {
    if (!this.isDrawing) return;
    this.drawPoint(point);
  }

  /**
   * Stop drawing and save state
   */
  stopDrawing(): void {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.saveState();  // Save for undo functionality
  }

  /**
   * Draw a circular brush stroke at a point
   */
  private drawPoint(point: Point): void {
    // Set composite operation based on tool
    this.ctx.globalCompositeOperation = this.tool === 'draw' ? 'source-over' : 'destination-out';
    
    // Red semi-transparent color for mask visibility
    this.ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
    
    // Draw circular brush
    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, this.brushSize / 2, 0, 2 * Math.PI);
    this.ctx.fill();
  }

  /**
   * Clear entire canvas
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.saveState();
  }

  /**
   * Undo last drawing action
   */
  undo(): void {
    if (this.historyStep > 0) {
      this.historyStep--;
      this.ctx.putImageData(this.history[this.historyStep], 0, 0);
    }
  }

  /**
   * Redo previously undone action
   */
  redo(): void {
    if (this.historyStep < this.history.length - 1) {
      this.historyStep++;
      this.ctx.putImageData(this.history[this.historyStep], 0, 0);
    }
  }

  /**
   * Export canvas as base64 data URL
   */
  getDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Load mask from base64 data URL
   */
  loadFromDataURL(dataURL: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(img, 0, 0);
        this.saveState();
        resolve();
      };
      img.onerror = reject;
      img.src = dataURL;
    });
  }
}

// ================================
// 2. INTERACTIVE MASKING COMPONENT
// ================================

/**
 * The main React component that provides the UI for mask creation
 * Located in: client/src/components/interactive-masking.tsx
 */

interface InteractiveMaskingProps {
  study: Study;
  onMaskChange: (maskData: string, brushSize: number) => void;
}

/**
 * COMPONENT WORKFLOW:
 * 
 * 1. IMAGE DISPLAY SETUP
 *    - Loads the first frame of the study as a reference image
 *    - Overlays a transparent canvas on top of the image
 *    - Ensures canvas dimensions match image display size
 * 
 * 2. DRAWING INTERACTION HANDLING
 *    - Mouse events: onMouseDown, onMouseMove, onMouseUp
 *    - Touch events: onTouchStart, onTouchMove, onTouchEnd (mobile support)
 *    - Coordinate calculation: Converts screen coordinates to canvas coordinates
 * 
 * 3. TOOL CONTROLS
 *    - Tool selector: Toggle between "Draw" and "Erase" modes
 *    - Brush size slider: Adjustable from 10px to 100px
 *    - Action buttons: Clear, Undo, Save Template
 * 
 * 4. MASK TEMPLATE PERSISTENCE
 *    - Converts canvas to base64 PNG data
 *    - Saves to database with study association
 *    - Provides visual feedback on save success/failure
 */

// Key React component structure:
const InteractiveMaskingExample = () => {
  // State management
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<"draw" | "erase">("draw");
  const [brushSize, setBrushSize] = useState(36);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Canvas and image references
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Mouse coordinate calculation
  const getMousePos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,  // Relative to canvas
      y: e.clientY - rect.top,
    };
  };

  // Drawing event handlers
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    draw(e);  // Draw initial point
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    const pos = getMousePos(e);

    // Set drawing mode
    ctx.globalCompositeOperation = tool === "draw" ? "source-over" : "destination-out";
    ctx.fillStyle = "rgba(255, 0, 0, 0.8)"; // Red mask color

    // Draw brush circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, 2 * Math.PI);
    ctx.fill();
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    
    // Notify parent component of mask changes
    const canvas = canvasRef.current;
    if (canvas) {
      const maskData = canvas.toDataURL('image/png');
      onMaskChange(maskData, brushSize);
    }
  };

  // Return JSX with canvas overlay on image...
};

// ================================
// 3. MASK TEMPLATE PROCESSING
// ================================

/**
 * SERVER-SIDE MASK PROCESSING WORKFLOW:
 * 
 * 1. TEMPLATE STORAGE
 *    - Receives base64 PNG data from frontend
 *    - Validates data format and size
 *    - Stores in database with metadata (brush size, study ID, timestamp)
 * 
 * 2. COORDINATE ALIGNMENT
 *    - Canvas dimensions may differ from actual frame dimensions
 *    - Calculates transformation matrix for proper scaling
 *    - Preserves aspect ratio during template application
 * 
 * 3. PIXEL-LEVEL APPLICATION
 *    - Loads each frame and the scaled template
 *    - Performs pixel-by-pixel red color detection
 *    - Applies blackening to matching pixels
 *    - Saves masked frames with "_masked.png" suffix
 */

interface MaskApplicationProcess {
  steps: [
    "Extract base64 data from canvas data URL",
    "Scale template to match target frame dimensions",
    "Detect red mask pixels using RGB thresholds",
    "Apply blackening to matching pixels in frame",
    "Save processed frame with masked suffix"
  ];
  
  redColorDetection: {
    threshold: "RGB(150+, <75% of red, <75% of red)";
    alphaThreshold: 128;
    purpose: "Identify user-drawn red areas for masking";
  };
  
  coordinateAccuracy: {
    scalingMethod: "High-quality Lanczos3 interpolation";
    aspectRatioPreservation: true;
    pixelPerfectAlignment: true;
  };
}

// ================================
// 4. USER INTERFACE CONTROLS
// ================================

/**
 * DRAWING TOOL CONTROLS:
 */
const DrawingControls = () => {
  return (
    <div className="space-y-4">
      {/* Tool Selection */}
      <div className="flex gap-2">
        <Button
          variant={tool === "draw" ? "default" : "outline"}
          onClick={() => setTool("draw")}
          className="flex items-center gap-2"
        >
          <Paintbrush className="w-4 h-4" />
          Draw
        </Button>
        <Button
          variant={tool === "erase" ? "default" : "outline"}
          onClick={() => setTool("erase")}
          className="flex items-center gap-2"
        >
          <Eraser className="w-4 h-4" />
          Erase
        </Button>
      </div>

      {/* Brush Size Control */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Brush Size: {brushSize}px
        </label>
        <Slider
          value={[brushSize]}
          onValueChange={(value) => setBrushSize(value[0])}
          min={10}
          max={100}
          step={2}
          className="w-full"
        />
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={clearCanvas}
          className="flex items-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Clear
        </Button>
        <Button
          variant="outline"
          onClick={undoAction}
          className="flex items-center gap-2"
        >
          <RotateCcw className="w-4 h-4" />
          Undo
        </Button>
      </div>

      {/* Save Template */}
      <Button
        onClick={saveMaskTemplate}
        className="w-full bg-blue-600 hover:bg-blue-700"
        disabled={!hasMaskData}
      >
        Save Mask Template
      </Button>
    </div>
  );
};

// ================================
// 5. TECHNICAL IMPLEMENTATION DETAILS
// ================================

/**
 * COORDINATE SYSTEM HANDLING:
 * 
 * 1. DISPLAY COORDINATES → CANVAS COORDINATES
 *    - Browser events provide screen coordinates
 *    - getBoundingClientRect() gets canvas position
 *    - Subtract canvas offset to get relative coordinates
 * 
 * 2. CANVAS COORDINATES → IMAGE COORDINATES
 *    - Canvas may be scaled for display
 *    - Calculate scaling factor between canvas and actual image
 *    - Apply transformation matrix for accurate mapping
 * 
 * 3. IMAGE COORDINATES → PIXEL COORDINATES
 *    - Direct 1:1 mapping for pixel manipulation
 *    - Account for image format differences (RGB vs RGBA)
 *    - Handle bit depth variations (8-bit, 16-bit)
 */

interface CoordinateTransformation {
  displayToCanvas: (screenX: number, screenY: number) => Point;
  canvasToImage: (canvasX: number, canvasY: number) => Point;
  imageToPixel: (imageX: number, imageY: number) => number; // Array index
}

/**
 * CANVAS RENDERING OPTIMIZATION:
 * 
 * - globalCompositeOperation: Controls how new shapes blend with existing content
 *   - 'source-over': Normal drawing (default)
 *   - 'destination-out': Eraser mode (removes existing pixels)
 * 
 * - lineCap and lineJoin: 'round' for smooth brush strokes
 * 
 * - fillStyle: 'rgba(255, 0, 0, 0.8)' - Semi-transparent red for visibility
 * 
 * - History Management: Stores ImageData snapshots for undo/redo
 */

/**
 * MOBILE TOUCH SUPPORT:
 * 
 * - onTouchStart, onTouchMove, onTouchEnd events
 * - preventDefault() to avoid scrolling during drawing
 * - Touch coordinate extraction from touches[0]
 * - Pressure sensitivity (if available) for brush size variation
 */

/**
 * PERFORMANCE CONSIDERATIONS:
 * 
 * - Throttling: Limit drawing frequency during mouse movement
 * - Canvas size: Match display resolution to avoid unnecessary scaling
 * - Memory management: Limit undo history to prevent memory leaks
 * - Async operations: Non-blocking save operations with loading states
 */

// ================================
// 6. DATA FLOW SUMMARY
// ================================

/**
 * COMPLETE DATA FLOW:
 * 
 * 1. USER INTERACTION
 *    Mouse/touch events → Coordinate calculation → Canvas drawing
 * 
 * 2. VISUAL FEEDBACK
 *    Red semi-transparent overlay → Real-time brush preview
 * 
 * 3. TEMPLATE CREATION
 *    Canvas.toDataURL() → Base64 PNG → Database storage
 * 
 * 4. TEMPLATE APPLICATION
 *    Database retrieval → Coordinate scaling → Pixel processing → Frame masking
 * 
 * 5. EXPORT GENERATION
 *    Masked frames → Format conversion → ZIP/MP4 creation → Download
 */

interface CompleteWorkflow {
  userInput: "Mouse/touch drawing on canvas overlay";
  visualFeedback: "Real-time red mask overlay with brush preview";
  templateStorage: "Base64 PNG saved to database with metadata";
  batchProcessing: "Template applied to all frames in study";
  exportOptions: "MP4 video, PNG ZIP, JPG ZIP with various resolutions";
}

export default CanvasDrawing;