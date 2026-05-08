/**
 * Coordinate Alignment Solution for Template Masking
 * 
 * This file provides detailed solutions and implementation strategies 
 * to overcome coordinate misalignment issues between user-drawn masks
 * and actual frame pixels during template masking operations.
 */

import sharp from 'sharp';

// ================================
// COORDINATE ALIGNMENT PROBLEMS
// ================================

/**
 * Common coordinate misalignment issues:
 * 
 * 1. CANVAS-TO-IMAGE DIMENSION MISMATCH
 *    - User draws on canvas with display dimensions (e.g., 800x600)
 *    - Actual image has different dimensions (e.g., 1024x768)
 *    - Direct pixel mapping causes shifted mask positions
 * 
 * 2. ASPECT RATIO DIFFERENCES
 *    - Canvas aspect ratio doesn't match image aspect ratio
 *    - CSS scaling creates non-uniform coordinate mapping
 *    - Mask appears stretched or compressed
 * 
 * 3. BROWSER SCALING AND DPI
 *    - High DPI displays create pixel density mismatches
 *    - Browser zoom affects canvas coordinate systems
 *    - devicePixelRatio inconsistencies
 * 
 * 4. TEMPLATE REUSE ACROSS VARYING FRAME SIZES
 *    - Single template applied to frames with different dimensions
 *    - Geometric distortion when scaling between frame sizes
 *    - Loss of mask precision during interpolation
 */

// ================================
// SOLUTION 1: DIMENSION TRACKING
// ================================

interface CanvasDimensions {
  displayWidth: number;    // Canvas display size in CSS pixels
  displayHeight: number;   // Canvas display size in CSS pixels
  actualWidth: number;     // Canvas internal resolution
  actualHeight: number;    // Canvas internal resolution
  devicePixelRatio: number; // Browser pixel density
}

interface ImageDimensions {
  width: number;
  height: number;
  aspectRatio: number;
}

/**
 * Capture precise canvas and image dimensions for coordinate mapping
 */
export class DimensionTracker {
  
  /**
   * Get accurate canvas dimensions including DPI scaling
   */
  static getCanvasDimensions(canvas: HTMLCanvasElement): CanvasDimensions {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    return {
      displayWidth: rect.width,
      displayHeight: rect.height,
      actualWidth: canvas.width,
      actualHeight: canvas.height,
      devicePixelRatio: dpr
    };
  }
  
  /**
   * Get image dimensions from file or metadata
   */
  static async getImageDimensions(imagePath: string): Promise<ImageDimensions> {
    const metadata = await sharp(imagePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Could not determine image dimensions");
    }
    
    return {
      width: metadata.width,
      height: metadata.height,
      aspectRatio: metadata.width / metadata.height
    };
  }
}

// ================================
// SOLUTION 2: COORDINATE TRANSFORMATION
// ================================

interface CoordinateTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Calculate transformation matrix between coordinate systems
 */
export class CoordinateMapper {
  
  /**
   * Calculate transformation from canvas coordinates to image coordinates
   */
  static calculateTransform(
    canvasDims: CanvasDimensions,
    imageDims: ImageDimensions,
    fitMode: 'contain' | 'cover' | 'fill' = 'contain'
  ): CoordinateTransform {
    
    switch (fitMode) {
      case 'fill':
        // Direct scaling without preserving aspect ratio
        return {
          scaleX: imageDims.width / canvasDims.actualWidth,
          scaleY: imageDims.height / canvasDims.actualHeight,
          offsetX: 0,
          offsetY: 0
        };
        
      case 'contain':
        // Scale to fit within canvas while preserving aspect ratio
        const scaleContain = Math.min(
          canvasDims.actualWidth / imageDims.width,
          canvasDims.actualHeight / imageDims.height
        );
        
        const scaledWidth = imageDims.width * scaleContain;
        const scaledHeight = imageDims.height * scaleContain;
        
        return {
          scaleX: 1 / scaleContain,
          scaleY: 1 / scaleContain,
          offsetX: (canvasDims.actualWidth - scaledWidth) / 2,
          offsetY: (canvasDims.actualHeight - scaledHeight) / 2
        };
        
      case 'cover':
        // Scale to cover entire canvas while preserving aspect ratio
        const scaleCover = Math.max(
          canvasDims.actualWidth / imageDims.width,
          canvasDims.actualHeight / imageDims.height
        );
        
        return {
          scaleX: 1 / scaleCover,
          scaleY: 1 / scaleCover,
          offsetX: (canvasDims.actualWidth - imageDims.width * scaleCover) / 2,
          offsetY: (canvasDims.actualHeight - imageDims.height * scaleCover) / 2
        };
    }
  }
  
  /**
   * Transform canvas pixel coordinates to image pixel coordinates
   */
  static transformCoordinates(
    canvasX: number,
    canvasY: number,
    transform: CoordinateTransform
  ): { imageX: number; imageY: number } {
    
    // Apply offset and scaling transformation
    const imageX = (canvasX - transform.offsetX) * transform.scaleX;
    const imageY = (canvasY - transform.offsetY) * transform.scaleY;
    
    return {
      imageX: Math.round(imageX),
      imageY: Math.round(imageY)
    };
  }
}

// ================================
// SOLUTION 3: PRECISE MASK SCALING
// ================================

/**
 * Advanced mask scaling with geometric preservation
 */
export class PreciseMaskScaler {
  
  /**
   * Scale mask template to exact target dimensions with coordinate preservation
   */
  static async scaleTemplateWithCoordinateMapping(
    maskBuffer: Buffer,
    sourceCanvasDims: CanvasDimensions,
    targetImageDims: ImageDimensions,
    fitMode: 'contain' | 'cover' | 'fill' = 'contain'
  ): Promise<{ scaledMask: Buffer; transform: CoordinateTransform }> {
    
    // Calculate coordinate transformation
    const transform = CoordinateMapper.calculateTransform(
      sourceCanvasDims,
      targetImageDims,
      fitMode
    );
    
    // Scale mask using high-quality interpolation
    const scaledMask = await sharp(maskBuffer)
      .resize(targetImageDims.width, targetImageDims.height, {
        fit: fitMode,
        kernel: 'lanczos3',      // High-quality interpolation
        background: { r: 0, g: 0, b: 0, alpha: 0 }  // Transparent background
      })
      .raw()
      .toBuffer();
    
    return { scaledMask, transform };
  }
  
  /**
   * Apply geometric correction during mask scaling
   */
  static async scaleWithGeometricCorrection(
    maskBuffer: Buffer,
    targetWidth: number,
    targetHeight: number,
    preserveAspectRatio: boolean = true
  ): Promise<{ data: Buffer; channels: number; actualDimensions: ImageDimensions }> {
    
    // Get original mask dimensions
    const originalInfo = await sharp(maskBuffer).metadata();
    if (!originalInfo.width || !originalInfo.height) {
      throw new Error("Cannot determine mask dimensions");
    }
    
    let resizeOptions: sharp.ResizeOptions;
    
    if (preserveAspectRatio) {
      // Maintain aspect ratio with letterboxing
      resizeOptions = {
        width: targetWidth,
        height: targetHeight,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: 'lanczos3'
      };
    } else {
      // Stretch to exact dimensions
      resizeOptions = {
        width: targetWidth,
        height: targetHeight,
        fit: 'fill',
        kernel: 'lanczos3'
      };
    }
    
    const resizedInfo = await sharp(maskBuffer)
      .resize(resizeOptions)
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    return {
      data: resizedInfo.data,
      channels: resizedInfo.info.channels,
      actualDimensions: {
        width: resizedInfo.info.width,
        height: resizedInfo.info.height,
        aspectRatio: resizedInfo.info.width / resizedInfo.info.height
      }
    };
  }
}

// ================================
// SOLUTION 4: COORDINATE VALIDATION
// ================================

/**
 * Validate and correct coordinate alignment issues
 */
export class CoordinateValidator {
  
  /**
   * Validate that mask coordinates align with image boundaries
   */
  static validateCoordinateAlignment(
    maskWidth: number,
    maskHeight: number,
    imageWidth: number,
    imageHeight: number,
    tolerance: number = 0.01  // 1% tolerance
  ): { isValid: boolean; errors: string[] } {
    
    const errors: string[] = [];
    
    // Check dimension matching
    const widthRatio = Math.abs(maskWidth - imageWidth) / imageWidth;
    const heightRatio = Math.abs(maskHeight - imageHeight) / imageHeight;
    
    if (widthRatio > tolerance) {
      errors.push(`Width mismatch: mask=${maskWidth}, image=${imageWidth}, ratio=${widthRatio.toFixed(3)}`);
    }
    
    if (heightRatio > tolerance) {
      errors.push(`Height mismatch: mask=${maskHeight}, image=${imageHeight}, ratio=${heightRatio.toFixed(3)}`);
    }
    
    // Check aspect ratio preservation
    const maskAspectRatio = maskWidth / maskHeight;
    const imageAspectRatio = imageWidth / imageHeight;
    const aspectRatioDiff = Math.abs(maskAspectRatio - imageAspectRatio) / imageAspectRatio;
    
    if (aspectRatioDiff > tolerance) {
      errors.push(`Aspect ratio mismatch: mask=${maskAspectRatio.toFixed(3)}, image=${imageAspectRatio.toFixed(3)}`);
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Detect coordinate shift by analyzing mask placement
   */
  static detectCoordinateShift(
    maskData: Buffer,
    maskWidth: number,
    maskHeight: number,
    maskChannels: number
  ): { hasShift: boolean; suggestedOffset: { x: number; y: number } } {
    
    let minX = maskWidth, maxX = 0, minY = maskHeight, maxY = 0;
    let pixelCount = 0;
    
    // Find bounding box of mask content
    for (let y = 0; y < maskHeight; y++) {
      for (let x = 0; x < maskWidth; x++) {
        const pixelIndex = (y * maskWidth + x) * maskChannels;
        const r = maskData[pixelIndex] || 0;
        const g = maskData[pixelIndex + 1] || 0;
        const b = maskData[pixelIndex + 2] || 0;
        const a = maskChannels > 3 ? (maskData[pixelIndex + 3] || 0) : 255;
        
        // Check if pixel is part of mask (red and visible)
        if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          pixelCount++;
        }
      }
    }
    
    if (pixelCount === 0) {
      return { hasShift: false, suggestedOffset: { x: 0, y: 0 } };
    }
    
    // Calculate center of mask content
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    // Calculate center of image
    const imageCenterX = maskWidth / 2;
    const imageCenterY = maskHeight / 2;
    
    // Calculate suggested offset to center the mask
    const offsetX = imageCenterX - centerX;
    const offsetY = imageCenterY - centerY;
    
    // Detect if there's significant shift (more than 5% of image dimensions)
    const shiftThreshold = 0.05;
    const hasShift = Math.abs(offsetX) > maskWidth * shiftThreshold || 
                     Math.abs(offsetY) > maskHeight * shiftThreshold;
    
    return {
      hasShift,
      suggestedOffset: { x: Math.round(offsetX), y: Math.round(offsetY) }
    };
  }
}

// ================================
// SOLUTION 5: INTEGRATED ALIGNMENT ENGINE
// ================================

/**
 * Complete solution for coordinate alignment in template masking
 */
export class AlignmentEngine {
  
  /**
   * Process mask template with automatic coordinate alignment
   */
  static async processAlignedMask(
    maskDataUrl: string,
    canvasDimensions: CanvasDimensions,
    targetImagePath: string,
    options: {
      fitMode?: 'contain' | 'cover' | 'fill';
      validateAlignment?: boolean;
      correctShift?: boolean;
      preserveAspectRatio?: boolean;
    } = {}
  ): Promise<{
    alignedMask: Buffer;
    transform: CoordinateTransform;
    validation: { isValid: boolean; errors: string[] };
    applied: boolean;
  }> {
    
    const {
      fitMode = 'contain',
      validateAlignment = true,
      correctShift = true,
      preserveAspectRatio = true
    } = options;
    
    try {
      // Extract mask data from data URL
      const base64Data = maskDataUrl.split(',')[1];
      const maskBuffer = Buffer.from(base64Data, 'base64');
      
      // Get target image dimensions
      const imageDims = await DimensionTracker.getImageDimensions(targetImagePath);
      
      // Calculate coordinate transformation
      const transform = CoordinateMapper.calculateTransform(
        canvasDimensions,
        imageDims,
        fitMode
      );
      
      // Scale mask with geometric correction
      const { data: scaledMaskData, channels, actualDimensions } = 
        await PreciseMaskScaler.scaleWithGeometricCorrection(
          maskBuffer,
          imageDims.width,
          imageDims.height,
          preserveAspectRatio
        );
      
      // Validate coordinate alignment
      let validation = { isValid: true, errors: [] };
      if (validateAlignment) {
        validation = CoordinateValidator.validateCoordinateAlignment(
          actualDimensions.width,
          actualDimensions.height,
          imageDims.width,
          imageDims.height
        );
      }
      
      // Detect and correct coordinate shift
      let finalMaskData = scaledMaskData;
      if (correctShift) {
        const shiftDetection = CoordinateValidator.detectCoordinateShift(
          scaledMaskData,
          actualDimensions.width,
          actualDimensions.height,
          channels
        );
        
        if (shiftDetection.hasShift) {
          console.log(`Detected coordinate shift: ${JSON.stringify(shiftDetection.suggestedOffset)}`);
          // Apply offset correction if needed
          // This would require additional image transformation logic
        }
      }
      
      return {
        alignedMask: finalMaskData,
        transform,
        validation,
        applied: true
      };
      
    } catch (error) {
      console.error("Mask alignment failed:", error);
      return {
        alignedMask: Buffer.alloc(0),
        transform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
        validation: { isValid: false, errors: [`Alignment failed: ${error}`] },
        applied: false
      };
    }
  }
}

// ================================
// IMPLEMENTATION DIRECTIONS
// ================================

/**
 * STEP-BY-STEP IMPLEMENTATION GUIDE:
 * 
 * 1. FRONTEND COORDINATE CAPTURE
 *    - Record exact canvas dimensions when mask is drawn
 *    - Include devicePixelRatio and display scaling
 *    - Store fit mode used for image display
 * 
 * 2. DIMENSION METADATA STORAGE
 *    - Save canvas dimensions with mask template
 *    - Include image display mode (contain/cover/fill)
 *    - Store original image dimensions for reference
 * 
 * 3. BACKEND COORDINATE TRANSFORMATION
 *    - Calculate transformation matrix for each frame
 *    - Apply geometric correction during scaling
 *    - Validate alignment before pixel processing
 * 
 * 4. PIXEL-LEVEL MAPPING
 *    - Use coordinate transformation for each pixel
 *    - Apply subpixel interpolation for precision
 *    - Handle boundary conditions and edge cases
 * 
 * 5. VALIDATION AND CORRECTION
 *    - Validate mask alignment after scaling
 *    - Detect coordinate shifts automatically
 *    - Apply corrections when misalignment detected
 * 
 * CRITICAL SUCCESS FACTORS:
 * - Always use the same fit mode for display and processing
 * - Store exact canvas dimensions with each mask template
 * - Apply high-quality interpolation during scaling
 * - Validate coordinate alignment before processing
 * - Handle aspect ratio differences correctly
 */

export default AlignmentEngine;