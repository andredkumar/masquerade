import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ZoomIn, ZoomOut, Maximize, MousePointer, Hand, PaintbrushVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MaskData } from "@shared/schema";

interface MaskingCanvasProps {
  firstFrame: string | null;
  selectedTool: string;
  onMaskUpdate: (maskData: MaskData) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

declare global {
  interface Window {
    fabric: any;
  }
}

export default function MaskingCanvas({ 
  firstFrame, 
  selectedTool, 
  onMaskUpdate, 
  zoom, 
  onZoomChange 
}: MaskingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fabricCanvasRef = useRef<any>(null);
  const [canvasPosition, setCanvasPosition] = useState({ x: 0, y: 0 });
  const [currentMask, setCurrentMask] = useState<any>(null);
  const [undoStack, setUndoStack] = useState<any[]>([]);
  const undoStackRef = useRef<any[]>([]);
  const [polygonPoints, setPolygonPoints] = useState<any[]>([]);
  const [isDrawingPolygon, setIsDrawingPolygon] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [currentBrushSize, setCurrentBrushSize] = useState(36);

  // Initialize Fabric.js canvas
  useEffect(() => {
    if (!canvasRef.current || !window.fabric) return;

    // Start with small dimensions - will be resized to match first frame exactly
    const canvas = new window.fabric.Canvas(canvasRef.current, {
      width: 400,
      height: 300,
      backgroundColor: '#f8f9fa'
    });

    fabricCanvasRef.current = canvas;

    // Set up canvas event listeners
    canvas.on('mouse:move', (e: any) => {
      const pointer = canvas.getPointer(e.e);
      setCanvasPosition({ x: Math.round(pointer.x), y: Math.round(pointer.y) });
    });

    canvas.on('object:added', (e: any) => {
      // Make new objects red instantly for mask visibility
      const obj = e.target;
      if (obj && obj.type !== 'image') {
        obj.set({
          fill: 'red',
          stroke: 'red'
        });
        canvas.renderAll();
      }
      // Don't update mask on initial creation - wait for object:modified or mouse:up
    });

    canvas.on('object:modified', (e: any) => {
      // Update mask when object is moved, scaled, or rotated
      updateMaskFromCanvas(e.target);
    });

    // Listen for custom events from MaskingTools
    const handleClearMask = () => {
      if (canvas) {
        // Save current state for undo (excluding image objects to avoid layer issues)
        const canvasState = canvas.toJSON();
        canvasState.objects = canvasState.objects.filter((obj: any) => obj.type !== 'image');
        const currentState = JSON.stringify(canvasState);
        setUndoStack(prev => {
          const newStack = [...prev, currentState];
          undoStackRef.current = newStack;
          return newStack;
        });
        
        // Clear all objects except the background image
        const objects = canvas.getObjects();
        objects.forEach((obj: any) => {
          if (obj.type !== 'image') {
            canvas.remove(obj);
          }
        });
        canvas.renderAll();
        onMaskUpdate({ type: 'rectangle', coordinates: [], opacity: 75 });
      }
    };

    const handleUndo = () => {
      if (undoStackRef.current.length > 0 && canvas) {
        const lastState = undoStackRef.current[undoStackRef.current.length - 1];
        setUndoStack(prev => {
          const newStack = prev.slice(0, -1);
          undoStackRef.current = newStack;
          return newStack;
        });
        
        // Save background image properties before clearing
        const backgroundImage = canvas.getObjects().find((obj: any) => obj.type === 'image');
        const backgroundImageData = backgroundImage ? {
          src: backgroundImage.getSrc(),
          left: backgroundImage.left,
          top: backgroundImage.top,
          scaleX: backgroundImage.scaleX,
          scaleY: backgroundImage.scaleY,
          selectable: backgroundImage.selectable,
          evented: backgroundImage.evented
        } : null;
        
        // Disable pan control during undo operation
        setPanOffset({ x: 0, y: 0 });
        
        // Clear current canvas completely
        canvas.clear();
        
        // First, restore the background image at the back layer
        if (backgroundImageData) {
          window.fabric.Image.fromURL(backgroundImageData.src, (img: any) => {
            img.set({
              left: backgroundImageData.left,
              top: backgroundImageData.top,
              scaleX: backgroundImageData.scaleX,
              scaleY: backgroundImageData.scaleY,
              selectable: backgroundImageData.selectable,
              evented: backgroundImageData.evented
            });
            
            // Add background image first (it will be at the back)
            canvas.add(img);
            canvas.sendToBack(img);
            
            // Then restore mask objects from saved state
            const parsedState = JSON.parse(lastState);
            if (parsedState.objects && parsedState.objects.length > 0) {
              parsedState.objects.forEach((objData: any) => {
                // Skip any image objects in saved state (we already restored the background)
                if (objData.type === 'image') return;
                
                // Ensure mask objects are red and visible
                objData.fill = 'red';
                objData.stroke = 'red';
                
                // Create the object from saved data
                window.fabric.util.enlivenObjects([objData], (objects: any[]) => {
                  objects.forEach((obj: any) => {
                    obj.set({
                      fill: 'red',
                      stroke: 'red',
                      selectable: true,
                      evented: true
                    });
                    canvas.add(obj);
                  });
                  canvas.renderAll();
                  // Update mask after all objects are restored
                  setTimeout(() => updateMaskFromCanvas(), 100);
                });
              });
            } else {
              // No mask objects to restore, just render the background
              canvas.renderAll();
            }
          });
        } else {
          // No background image, just restore mask objects
          const parsedState = JSON.parse(lastState);
          if (parsedState.objects && parsedState.objects.length > 0) {
            parsedState.objects.forEach((objData: any) => {
              if (objData.type === 'image') return;
              
              objData.fill = 'red';
              objData.stroke = 'red';
              
              window.fabric.util.enlivenObjects([objData], (objects: any[]) => {
                objects.forEach((obj: any) => {
                  obj.set({
                    fill: 'red',
                    stroke: 'red',
                    selectable: true,
                    evented: true
                  });
                  canvas.add(obj);
                });
                canvas.renderAll();
                setTimeout(() => updateMaskFromCanvas(), 100);
              });
            });
          }
        }
      }
    };

    window.addEventListener('clearMask', handleClearMask);
    window.addEventListener('undoMask', handleUndo);

    return () => {
      canvas.dispose();
      window.removeEventListener('clearMask', handleClearMask);
      window.removeEventListener('undoMask', handleUndo);
    };
  }, []);

  // Load first frame image
  useEffect(() => {
    if (!firstFrame || !fabricCanvasRef.current) return;

    window.fabric.Image.fromURL(firstFrame, (img: any) => {
      const canvas = fabricCanvasRef.current;
      
      // DIRECT PIXEL MAPPING: Set canvas to exact first frame dimensions
      const imgWidth = img.width;
      const imgHeight = img.height;
      
      console.log(`🎯 DIRECT PIXEL MAPPING: Resizing canvas to match exact frame dimensions: ${imgWidth}x${imgHeight}`);
      
      // Resize canvas to match frame dimensions exactly - no scaling needed!
      canvas.setDimensions({
        width: imgWidth,
        height: imgHeight
      });
      
      // Set image at original size with no scaling - perfect 1:1 pixel mapping
      img.set({
        scaleX: 1,
        scaleY: 1,
        left: 0,
        top: 0,
        selectable: false,
        evented: false
      });
      
      console.log(`✅ Canvas now matches frame: ${imgWidth}x${imgHeight} - Direct pixel coordinates!`);
      
      canvas.clear();
      canvas.add(img);
      canvas.sendToBack(img);
      canvas.renderAll();
    });
  }, [firstFrame]);

  // Handle tool changes
  useEffect(() => {
    if (!fabricCanvasRef.current) return;

    const canvas = fabricCanvasRef.current;
    
    switch (selectedTool) {
      case 'rectangle':
        enableRectangleTool(canvas);
        break;
      case 'circle':
        enableCircleTool(canvas);
        break;
      case 'polygon':
        enablePolygonTool(canvas);
        break;
      case 'brush':
        enableBrushTool(canvas);
        break;
      case 'eraser':
        enableEraserTool(canvas);
        break;
      case 'pan':
        enablePanTool(canvas);
        break;
      default:
        enableSelectTool(canvas);
    }
  }, [selectedTool]);

  const enableRectangleTool = (canvas: any) => {
    canvas.isDrawingMode = false;
    canvas.selection = true; // Enable selection so objects can be moved
    
    // Clear existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    
    let isDrawing = false;
    let startPointer: any;
    let rect: any;

    const onMouseDown = (e: any) => {
      // If clicking on an existing object, don't start drawing
      if (e.target && e.target !== canvas) {
        return;
      }

      // Save state for undo before adding new rectangle (excluding image objects to avoid layer issues)
      const canvasState = canvas.toJSON();
      // Filter out image objects from the saved state to prevent undo layering issues
      canvasState.objects = canvasState.objects.filter((obj: any) => obj.type !== 'image');
      const currentState = JSON.stringify(canvasState);
      setUndoStack(prev => {
        const newStack = [...prev, currentState];
        undoStackRef.current = newStack;
        return newStack;
      });
      
      isDrawing = true;
      startPointer = canvas.getPointer(e.e);
      
      rect = new window.fabric.Rect({
        left: startPointer.x,
        top: startPointer.y,
        width: 0,
        height: 0,
        fill: 'rgba(34, 197, 94, 0.3)',
        stroke: '#22c55e',
        strokeWidth: 2,
        selectable: true,
        hasControls: true,
        hasBorders: true
      });
      
      canvas.add(rect);
    };

    const onMouseMove = (e: any) => {
      if (!isDrawing) return;
      
      const pointer = canvas.getPointer(e.e);
      const width = pointer.x - startPointer.x;
      const height = pointer.y - startPointer.y;
      
      rect.set({
        width: Math.abs(width),
        height: Math.abs(height),
        left: width < 0 ? pointer.x : startPointer.x,
        top: height < 0 ? pointer.y : startPointer.y
      });
      
      canvas.renderAll();
    };

    const onMouseUp = () => {
      isDrawing = false;
      // Update mask data only after rectangle drawing is complete
      if (rect && rect.width > 0 && rect.height > 0) {
        setTimeout(() => updateMaskFromCanvas(), 100); // Small delay to ensure dimensions are set
      }
      // Allow multiple rectangles by not removing event listeners
    };

    canvas.on('mouse:down', onMouseDown);
    canvas.on('mouse:move', onMouseMove);
    canvas.on('mouse:up', onMouseUp);
  };

  const enableCircleTool = (canvas: any) => {
    canvas.isDrawingMode = false;
    canvas.selection = true; // Enable selection so objects can be moved
    
    // Clear existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    
    let isDrawing = false;
    let startPointer: any;
    let circle: any;

    const onMouseDown = (e: any) => {
      // If clicking on an existing object, don't start drawing
      if (e.target && e.target !== canvas) {
        return;
      }

      // Save state for undo before adding new circle (excluding image objects to avoid layer issues)
      const canvasState = canvas.toJSON();
      // Filter out image objects from the saved state to prevent undo layering issues
      canvasState.objects = canvasState.objects.filter((obj: any) => obj.type !== 'image');
      const currentState = JSON.stringify(canvasState);
      setUndoStack(prev => {
        const newStack = [...prev, currentState];
        undoStackRef.current = newStack;
        return newStack;
      });
      
      isDrawing = true;
      startPointer = canvas.getPointer(e.e);
      
      circle = new window.fabric.Circle({
        left: startPointer.x,
        top: startPointer.y,
        radius: 0,
        fill: 'rgba(34, 197, 94, 0.3)',
        stroke: '#22c55e',
        strokeWidth: 2,
        selectable: true,
        hasControls: true,
        hasBorders: true,
        originX: 'center',
        originY: 'center'
      });
      
      canvas.add(circle);
    };

    const onMouseMove = (e: any) => {
      if (!isDrawing) return;
      
      const pointer = canvas.getPointer(e.e);
      const deltaX = pointer.x - startPointer.x;
      const deltaY = pointer.y - startPointer.y;
      const radius = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      
      circle.set({
        radius: radius,
        left: startPointer.x,
        top: startPointer.y
      });
      
      canvas.renderAll();
    };

    const onMouseUp = () => {
      isDrawing = false;
      // Update mask data after circle drawing is complete
      if (circle && circle.radius > 0) {
        setTimeout(() => updateMaskFromCanvas(), 100);
      }
      // Allow multiple circles by not removing event listeners
    };

    canvas.on('mouse:down', onMouseDown);
    canvas.on('mouse:move', onMouseMove);
    canvas.on('mouse:up', onMouseUp);
  };

  const enablePolygonTool = (canvas: any) => {
    canvas.isDrawingMode = false;
    canvas.selection = true; // Enable selection so objects can be moved
    
    // Clear existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    
    let points: any[] = [];
    let tempObjects: any[] = []; // Store temp circles and lines for proper cleanup
    let isDrawing = false;

    const onMouseDown = (e: any) => {
      // If clicking on an existing object, don't start drawing
      if (e.target && e.target !== canvas && e.target.type !== 'circle' && e.target.type !== 'line') {
        return;
      }

      if (e.e.detail === 2) { // Double click to finish polygon
        if (points.length >= 3) {
          finishPolygon();
        }
        return;
      }

      const pointer = canvas.getPointer(e.e);
      
      if (!isDrawing) {
        // Save state for undo before starting new polygon (excluding image objects to avoid layer issues)
        const canvasState = canvas.toJSON();
        // Filter out image objects from the saved state to prevent undo layering issues
        canvasState.objects = canvasState.objects.filter((obj: any) => obj.type !== 'image');
        const currentState = JSON.stringify(canvasState);
        setUndoStack(prev => {
          const newStack = [...prev, currentState];
          undoStackRef.current = newStack;
          return newStack;
        });
        
        // Start new polygon
        isDrawing = true;
        points = [pointer];
        tempObjects = [];
        
        // Add first point marker
        const circle = new window.fabric.Circle({
          left: pointer.x - 3,
          top: pointer.y - 3,
          radius: 3,
          fill: '#22c55e',
          selectable: false,
          evented: false,
          objectCaching: false
        });
        canvas.add(circle);
        tempObjects.push(circle);
        
      } else {
        // Add new point
        points.push(pointer);
        
        // Add point marker
        const circle = new window.fabric.Circle({
          left: pointer.x - 3,
          top: pointer.y - 3,
          radius: 3,
          fill: '#22c55e',
          selectable: false,
          evented: false,
          objectCaching: false
        });
        canvas.add(circle);
        tempObjects.push(circle);
        
        // Add line from previous point
        const prevPoint = points[points.length - 2];
        const line = new window.fabric.Line([prevPoint.x, prevPoint.y, pointer.x, pointer.y], {
          stroke: '#22c55e',
          strokeWidth: 2,
          selectable: false,
          evented: false,
          objectCaching: false
        });
        canvas.add(line);
        tempObjects.push(line);
      }
      
      canvas.renderAll();
    };

    const finishPolygon = () => {
      if (points.length >= 3) {
        // Remove all temporary objects using stored references
        tempObjects.forEach((obj: any) => {
          canvas.remove(obj);
        });
        tempObjects = [];
        
        // Create final polygon
        const polygon = new window.fabric.Polygon(points, {
          fill: 'rgba(34, 197, 94, 0.3)',
          stroke: '#22c55e',
          strokeWidth: 2,
          selectable: true,
          hasControls: true,
          hasBorders: true,
          objectCaching: false
        });
        canvas.add(polygon);
        canvas.renderAll();
        updateMaskFromCanvas();
      }
      
      // Reset state
      points = [];
      tempObjects = [];
      isDrawing = false;
    };

    canvas.on('mouse:down', onMouseDown);
  };

  const enableBrushTool = (canvas: any) => {
    // Save state for undo
    const currentState = JSON.stringify(canvas.toJSON());
    setUndoStack(prev => [...prev, currentState]);
    
    // Turn off Fabric.js drawing mode - we'll handle manually
    canvas.isDrawingMode = false;
    canvas.selection = false;
    
    // Clear all existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    canvas.off('path:created');
    
    let isDrawing = false;
    let lastPoint: {x: number, y: number} | null = null;
    let drawnPoints: {x: number, y: number}[] = [];
    
    // Get the overlay canvas for drawing
    const upperCanvasEl = canvas.upperCanvasEl;
    const ctx = upperCanvasEl.getContext('2d');
    
    // Set up canvas context with EXACT same red as rectangles
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'red'; // Exact same as rectangles
    ctx.fillStyle = 'red';   // Exact same as rectangles
    ctx.lineWidth = currentBrushSize;
    ctx.globalCompositeOperation = 'source-over';
    
    console.log(`🎨 Brush tool enabled with size: ${currentBrushSize}px`);
    
    // Mouse down - start drawing
    canvas.on('mouse:down', (e: any) => {
      // Save state for undo before starting brush stroke (excluding image objects to avoid layer issues)
      const canvasState = canvas.toJSON();
      canvasState.objects = canvasState.objects.filter((obj: any) => obj.type !== 'image');
      const currentState = JSON.stringify(canvasState);
      setUndoStack(prev => {
        const newStack = [...prev, currentState];
        undoStackRef.current = newStack;
        return newStack;
      });
      
      isDrawing = true;
      const pointer = canvas.getPointer(e.e);
      lastPoint = { x: pointer.x, y: pointer.y };
      drawnPoints = [{ x: pointer.x, y: pointer.y }];
      
      // Draw initial circle with current brush size
      const brushRadius = currentBrushSize / 2;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, brushRadius, 0, 2 * Math.PI);
      ctx.fill();
    });
    
    // Mouse move - continue drawing
    canvas.on('mouse:move', (e: any) => {
      if (!isDrawing || !lastPoint) return;
      const pointer = canvas.getPointer(e.e);
      
      drawnPoints.push({ x: pointer.x, y: pointer.y });
      
      // Update line width and draw line from last point to current
      ctx.lineWidth = currentBrushSize;
      ctx.beginPath();
      ctx.moveTo(lastPoint.x, lastPoint.y);
      ctx.lineTo(pointer.x, pointer.y);
      ctx.stroke();
      
      // Draw circle at current point with current brush size
      const brushRadius = currentBrushSize / 2;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, brushRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      lastPoint = { x: pointer.x, y: pointer.y };
    });
    
    // Mouse up - finish drawing and convert to Fabric object
    canvas.on('mouse:up', () => {
      if (isDrawing && drawnPoints.length > 0) {
        isDrawing = false;
        lastPoint = null;
        
        // Convert drawn path to Fabric.js object with current brush size
        convertDrawnPathToFabricObject(canvas, drawnPoints, currentBrushSize);
        
        // Clear the overlay canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawnPoints = [];
      }
    });
    
    // Set cursor with brush size indicator (circle cursor)
    updateBrushCursor(canvas, currentBrushSize);
  };
  
  // Update brush cursor to show visual circle indicating brush size
  const updateBrushCursor = (canvas: any, brushSize: number) => {
    const cursorSize = Math.max(Math.min(brushSize, 100), 8); // Limit cursor size between 8-100px
    const cursorCanvas = document.createElement('canvas');
    cursorCanvas.width = cursorSize + 4;
    cursorCanvas.height = cursorSize + 4;
    const cursorCtx = cursorCanvas.getContext('2d');
    
    if (cursorCtx) {
      // Draw circle outline
      cursorCtx.strokeStyle = '#333';
      cursorCtx.lineWidth = 1;
      cursorCtx.beginPath();
      cursorCtx.arc(cursorSize / 2 + 2, cursorSize / 2 + 2, cursorSize / 2, 0, 2 * Math.PI);
      cursorCtx.stroke();
      
      // Add center dot
      cursorCtx.fillStyle = '#333';
      cursorCtx.beginPath();
      cursorCtx.arc(cursorSize / 2 + 2, cursorSize / 2 + 2, 1, 0, 2 * Math.PI);
      cursorCtx.fill();
    }
    
    const cursorUrl = cursorCanvas.toDataURL();
    const hotspotX = Math.floor(cursorSize / 2) + 2;
    const hotspotY = Math.floor(cursorSize / 2) + 2;
    
    canvas.hoverCursor = `url(${cursorUrl}) ${hotspotX} ${hotspotY}, crosshair`;
    canvas.moveCursor = `url(${cursorUrl}) ${hotspotX} ${hotspotY}, crosshair`;
    canvas.defaultCursor = `url(${cursorUrl}) ${hotspotX} ${hotspotY}, crosshair`;
  };

  // Convert drawn path to Fabric.js object for undo/clear integration
  const convertDrawnPathToFabricObject = (canvas: any, points: {x: number, y: number}[], brushSize: number) => {
    if (points.length === 0) return;
    
    // Create a path string from points
    let pathString = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      pathString += ` L ${points[i].x} ${points[i].y}`;
    }
    
    // Create Fabric.js path object with fill for proper mask rendering
    const path = new window.fabric.Path(pathString, {
      fill: 'red',
      stroke: 'red',
      strokeWidth: brushSize,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false
    });
    
    canvas.add(path);
    canvas.renderAll();
    updateMaskFromCanvas();
  };
  

  const enablePanTool = (canvas: any) => {
    // Clear existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    
    canvas.isDrawingMode = false;
    canvas.selection = false;
    
    let isDragging = false;
    let lastPointer = { x: 0, y: 0 };
    
    const onMouseDown = (e: any) => {
      isDragging = true;
      lastPointer = canvas.getPointer(e.e);
    };
    
    const onMouseMove = (e: any) => {
      if (!isDragging) return;
      
      const pointer = canvas.getPointer(e.e);
      const deltaX = pointer.x - lastPointer.x;
      const deltaY = pointer.y - lastPointer.y;
      
      setPanOffset(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }));
      
      lastPointer = pointer;
    };
    
    const onMouseUp = () => {
      isDragging = false;
    };
    
    canvas.on('mouse:down', onMouseDown);
    canvas.on('mouse:move', onMouseMove);
    canvas.on('mouse:up', onMouseUp);
  };

  const enableEraserTool = (canvas: any) => {
    // Save state for undo before clearing
    const currentState = JSON.stringify(canvas.toJSON());
    setUndoStack(prev => [...prev, currentState]);
    
    // Clear existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    canvas.off('path:created');
    
    // Turn off drawing mode
    canvas.isDrawingMode = false;
    
    // Clear all mask objects from canvas (including brush strokes)
    const objects = canvas.getObjects().filter((obj: any) => obj.type !== 'image');
    objects.forEach((obj: any) => {
      canvas.remove(obj);
    });
    canvas.renderAll();
    
    // Clear mask data
    onMaskUpdate({
      type: 'freeform',
      coordinates: { x: 0, y: 0, width: 0, height: 0 },
      opacity: 0,
      aspectRatioMode: 'stretch',
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      canvasDataUrl: ''
    });
    
    // Set to select mode after erasing
    enableSelectTool(canvas);
  };

  const enableSelectTool = (canvas: any) => {
    // Clear existing event listeners
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');
    
    canvas.isDrawingMode = false;
    canvas.selection = true;
  };

  const updateMaskFromCanvas = (modifiedObject?: any) => {
    if (!fabricCanvasRef.current) return;

    const canvas = fabricCanvasRef.current;
    const objects = canvas.getObjects().filter((obj: any) => obj.type !== 'image');
    
    if (objects.length === 0) return;

    // Use the modified object if provided, otherwise use the last added object
    const maskObject = modifiedObject || objects[objects.length - 1];
    let maskData: MaskData;
    
    // Get precise dimension tracking (following prototype approach)
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const canvasElement = canvasRef.current;
    
    // Capture exact dimensions including DPI scaling
    const devicePixelRatio = window.devicePixelRatio || 1;
    let displayDimensions = { width: canvasWidth, height: canvasHeight };
    
    if (canvasElement) {
      const rect = canvasElement.getBoundingClientRect();
      displayDimensions = {
        width: rect.width,
        height: rect.height
      };
    }
    
    // Get image dimensions and display information from the loaded image
    const imageObj = canvas.getObjects().find((obj: any) => obj.type === 'image') as any;
    let imageDimensions = { width: canvasWidth, height: canvasHeight };
    let imageDisplayInfo = { scale: 1, offsetX: 0, offsetY: 0 };
    
    if (imageObj && imageObj.getElement()) {
      const img = imageObj.getElement() as HTMLImageElement;
      imageDimensions = {
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height
      };
      
      // Capture the display scaling information for coordinate transformation
      imageDisplayInfo = {
        scale: imageObj.scaleX || 1,
        offsetX: imageObj.left || 0,
        offsetY: imageObj.top || 0
      };
      
      console.log('Image display info:', imageDisplayInfo);
      
      // Log coordinate tracking information
      console.log('\n🎯 FRONTEND COORDINATE TRACKING:');
      console.log('================================');
      console.log('Canvas Dimensions:', { width: canvasWidth, height: canvasHeight });
      console.log('Image Dimensions:', imageDimensions);
      console.log('Display Transform:', imageDisplayInfo);
      console.log('Device Pixel Ratio:', window.devicePixelRatio);
      console.log('================================\n');
    }
    
    // Create a temporary canvas with canvas dimensions for coordinate mapping
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasWidth;
    tempCanvas.height = canvasHeight;
    const tempCtx = tempCanvas.getContext('2d');
    
    if (tempCtx) {
      // Fill with black background (non-mask areas)
      tempCtx.fillStyle = 'black';
      tempCtx.fillRect(0, 0, canvasWidth, canvasHeight);
      
      // Create a temporary Fabric canvas for rendering
      const maskCanvas = new window.fabric.Canvas(tempCanvas, {
        width: canvasWidth,
        height: canvasHeight
      });
      
      // Add all mask objects with red color for detection
      objects.forEach((obj: any) => {
        const clonedObj = window.fabric.util.object.clone(obj);
        
        // Special handling for path objects (brush tool)
        if (obj.type === 'path') {
          console.log('🎨 RENDERING PATH OBJECT FOR MASK:', {
            type: obj.type,
            strokeWidth: obj.strokeWidth,
            originalFill: obj.fill,
            originalStroke: obj.stroke
          });
          clonedObj.set({
            fill: 'red',
            stroke: 'red',
            strokeWidth: obj.strokeWidth || 36
          });
        } else {
          clonedObj.set({
            fill: 'red',
            stroke: 'red',
            strokeWidth: obj.strokeWidth || 1
          });
        }
        maskCanvas.add(clonedObj);
      });
      
      maskCanvas.renderAll();
      
      // Get base64 data URL from the mask-only canvas
      const canvasDataUrl = tempCanvas.toDataURL('image/png');
      
      // Clean up temporary canvas
      maskCanvas.dispose();
      
      // Create mask data with absolute pixel coordinates (no scaling)
      console.log('🔧 MASK OBJECT DEBUG:', {
        type: maskObject.type,
        left: maskObject.left,
        top: maskObject.top,
        width: maskObject.width,
        height: maskObject.height,
        canvasWidth,
        canvasHeight
      });
      
      console.log('🎯 IMPLEMENTING DIRECT PIXEL MAPPING - No coordinate transformation needed!');
      
      switch (maskObject.type) {
        case 'rect':
          // Store absolute pixel coordinates - no normalization needed!
          const rectCoordinates = {
            x: Math.round(maskObject.left),
            y: Math.round(maskObject.top),
            width: Math.round(maskObject.width),
            height: Math.round(maskObject.height)
          };
          
          console.log('🎯 ABSOLUTE PIXEL COORDINATES:', rectCoordinates);
          
          maskData = {
            type: 'rectangle',
            coordinates: rectCoordinates,
            opacity: 75,

            aspectRatioMode: 'stretch',
            canvasWidth,
            canvasHeight,
            canvasDataUrl, // Add base64 canvas data
            // Store comprehensive dimension tracking (following prototype approach)
            originalCanvasDimensions: {
              width: canvasWidth,
              height: canvasHeight,
            },
            displayDimensions,
            devicePixelRatio,
            aspectRatio: canvasWidth / canvasHeight,
            imageAspectRatio: imageDimensions ? imageDimensions.width / imageDimensions.height : canvasWidth / canvasHeight,
            imageDimensions: imageDimensions!,
            // Include display transformation info for coordinate mapping
            imageDisplayInfo
          };
          break;
        case 'circle':
          // Store absolute pixel coordinates - no normalization needed!
          const circleCoordinates = {
            x: Math.round(maskObject.left),
            y: Math.round(maskObject.top),
            radius: Math.round(maskObject.radius)
          };
          
          console.log('🎯 ABSOLUTE CIRCLE COORDINATES:', circleCoordinates);
          
          maskData = {
            type: 'circle',
            coordinates: {
              x: circleCoordinates.x,
              y: circleCoordinates.y,
              width: circleCoordinates.radius * 2,
              height: circleCoordinates.radius * 2
            },
            opacity: 75,

            aspectRatioMode: 'stretch',
            canvasWidth,
            canvasHeight,
            canvasDataUrl,
            // Store comprehensive dimension tracking (following prototype approach)
            originalCanvasDimensions: {
              width: canvasWidth,
              height: canvasHeight,
            },
            displayDimensions,
            devicePixelRatio,
            aspectRatio: canvasWidth / canvasHeight,
            imageAspectRatio: imageDimensions ? imageDimensions.width / imageDimensions.height : canvasWidth / canvasHeight,
            imageDimensions: imageDimensions!,
            // Include display transformation info for coordinate mapping
            imageDisplayInfo
          };
          break;
        case 'polygon':
          const points = maskObject.points || [];
          const polygonCoordinates: number[] = [];
          points.forEach((point: any) => {
            polygonCoordinates.push(
              Math.round(point.x + maskObject.left),
              Math.round(point.y + maskObject.top)
            );
          });
          
          console.log('🎯 ABSOLUTE POLYGON COORDINATES:', polygonCoordinates);
          maskData = {
            type: 'polygon',
            coordinates: polygonCoordinates,
            opacity: 75,

            aspectRatioMode: 'stretch',
            canvasWidth,
            canvasHeight,
            canvasDataUrl,
            // Store comprehensive dimension tracking (following prototype approach)
            originalCanvasDimensions: {
              width: canvasWidth,
              height: canvasHeight,
            },
            displayDimensions,
            devicePixelRatio,
            aspectRatio: canvasWidth / canvasHeight,
            imageAspectRatio: imageDimensions ? imageDimensions.width / imageDimensions.height : canvasWidth / canvasHeight,
            imageDimensions: imageDimensions!,
            // Include display transformation info for coordinate mapping
            imageDisplayInfo
          };
          break;
        case 'path':
        case 'image':
          // Process as freeform mask - handles both path and brush-drawn images
          maskData = {
            type: 'freeform',
            coordinates: [
              Math.round(maskObject.left),
              Math.round(maskObject.top),
              Math.round(maskObject.width),
              Math.round(maskObject.height)
            ],
            opacity: 75,

            aspectRatioMode: 'stretch',
            canvasWidth,
            canvasHeight,
            canvasDataUrl,
            originalCanvasDimensions: {
              width: canvasWidth,
              height: canvasHeight,
            },
            displayDimensions,
            devicePixelRatio,
            aspectRatio: canvasWidth / canvasHeight,
            imageAspectRatio: imageDimensions ? imageDimensions.width / imageDimensions.height : canvasWidth / canvasHeight,
            imageDimensions: imageDimensions!,
            imageDisplayInfo
          };
          break;
        default:
          return;
      }
    } else {
      // Fallback to old coordinate-based system if canvas context fails
      switch (maskObject.type) {
        case 'rect':
          maskData = {
            type: 'rectangle',
            coordinates: [
              maskObject.left / canvasWidth,
              maskObject.top / canvasHeight,
              maskObject.width / canvasWidth,
              maskObject.height / canvasHeight
            ],
            opacity: 75,

            aspectRatioMode: 'stretch',
            canvasWidth,
            canvasHeight
          };
          break;
        default:
          return;
      }
    }

    setCurrentMask(maskObject);
    onMaskUpdate(maskData);
  };

  const handleZoomIn = () => {
    const newZoom = Math.min(zoom + 25, 300);
    onZoomChange(newZoom);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(zoom - 25, 25);
    onZoomChange(newZoom);
  };

  const handleFitToScreen = () => {
    onZoomChange(100);
  };

  const tools = [
    { id: 'select', icon: MousePointer, label: 'Select' },
    { id: 'pan', icon: Hand, label: 'Pan' },
    { id: 'brush', icon: PaintbrushVertical, label: 'Brush' }
  ];

  // Handle drag control functionality
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  // Use useEffect to handle global mouse events for smooth dragging
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;
      
      setPanOffset(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }));
      
      setDragStart({ x: e.clientX, y: e.clientY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStart]);

  // Handle reset pan position
  const handleResetPan = () => {
    setPanOffset({ x: 0, y: 0 });
  };

  return (
    <TooltipProvider>
      <div className="h-full relative bg-card border border-border rounded-lg overflow-hidden">
      {/* Pan Controls */}
      <div className="absolute top-4 left-4 z-10 bg-card border border-border rounded-lg shadow-sm">
        <div className="flex flex-col items-center p-2">
          <div className="text-xs text-muted-foreground mb-2">Pan Control</div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div 
                className={cn(
                  "w-12 h-12 bg-muted border-2 border-border rounded-lg cursor-move flex items-center justify-center",
                  "hover:bg-muted/80 transition-colors select-none",
                  isDragging && "bg-primary/20 border-primary"
                )}
                onMouseDown={handleDragStart}
                data-testid="pan-control"
              >
                <Hand size={16} className="text-muted-foreground" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Hold and move to pan</p>
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 px-2 py-1 text-xs"
            onClick={handleResetPan}
            data-testid="reset-pan"
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Zoom Controls */}
      <div className="absolute top-4 right-4 z-10 bg-card border border-border rounded-lg shadow-sm">
        <div className="flex flex-col">
          <Button
            variant="ghost"
            size="sm"
            className="p-2 border-b border-border rounded-none"
            onClick={handleZoomIn}
            data-testid="zoom-in"
          >
            <ZoomIn size={16} />
          </Button>
          <div className="px-3 py-2 text-sm font-mono border-b border-border" data-testid="zoom-level">
            {zoom}%
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="p-2 border-b border-border rounded-none"
            onClick={handleZoomOut}
            data-testid="zoom-out"
          >
            <ZoomOut size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="p-2 rounded-none"
            onClick={handleFitToScreen}
            data-testid="fit-to-screen"
          >
            <Maximize size={16} />
          </Button>
        </div>
      </div>


      {/* Main Canvas Area */}
      <div 
        ref={containerRef}
        className="w-full h-full flex items-start justify-center bg-muted/20"
        style={{ 
          transform: `scale(${zoom / 100}) translate(${panOffset.x}px, ${panOffset.y}px)`,
          transformOrigin: 'center top'
        }}
      >
        <canvas
          ref={canvasRef}
          className="border border-border rounded-lg shadow-lg"
          data-testid="masking-canvas"
        />
      </div>

      {/* Canvas Info Overlay */}
      </div>
    </TooltipProvider>
  );
}
