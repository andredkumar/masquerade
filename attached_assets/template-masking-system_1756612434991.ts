/**
 * Complete Template Masking System
 * 
 * This file contains the complete implementation for template-based masking
 * of medical images (DICOM/video frames). It handles:
 * - Canvas-based mask creation
 * - Base64 template storage and retrieval
 * - Pixel-level mask application to frame sequences
 * - Batch processing with error recovery
 */

import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';

// ================================
// TYPE DEFINITIONS
// ================================

interface MaskTemplate {
  id: string;
  studyId: string;
  maskData: string;  // Base64 encoded PNG
  brushSize: number;
  frameNumber: number;
  createdAt: Date;
}

interface StudyFrame {
  frameNumber: number;
  originalPath: string;
  pngPath: string;
  width: number;
  height: number;
}

interface MaskApplicationResult {
  maskedFrames: string[];
  processedCount: number;
  failedCount: number;
  errors: string[];
}

interface PixelDetectionResult {
  isDrawn: boolean;
  isRed: boolean;
  maskR: number;
  maskG: number;
  maskB: number;
  maskA: number;
}

// ================================
// TEMPLATE MASKING ENGINE
// ================================

export class TemplateMaskingEngine {
  private outputDir: string;
  private maskThresholds: {
    alphaThreshold: number;
    redMinimum: number;
    redDominanceRatio: number;
  };

  constructor(outputDir: string = 'processed') {
    this.outputDir = path.resolve(outputDir);
    this.maskThresholds = {
      alphaThreshold: 128,      // Alpha transparency threshold
      redMinimum: 150,          // Minimum red value to consider
      redDominanceRatio: 1.5    // Red must be 1.5x greater than green/blue
    };
    this.ensureOutputDir();
  }

  private async ensureOutputDir(): Promise<void> {
    try {
      await fs.access(this.outputDir);
    } catch {
      await fs.mkdir(this.outputDir, { recursive: true });
    }
  }

  // ================================
  // MASK TEMPLATE PROCESSING
  // ================================

  /**
   * Extract base64 image data from canvas data URL
   */
  private extractBase64Data(dataUrl: string): string | null {
    if (!dataUrl || typeof dataUrl !== 'string') {
      return null;
    }

    // Expected format: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA..."
    const parts = dataUrl.split(',');
    if (parts.length !== 2 || !parts[0].includes('base64')) {
      return null;
    }

    return parts[1];
  }

  /**
   * Convert base64 template to Sharp image buffer
   */
  private async createMaskBuffer(base64Data: string): Promise<Buffer> {
    try {
      return Buffer.from(base64Data, 'base64');
    } catch (error) {
      throw new Error(`Failed to decode base64 mask data: ${error}`);
    }
  }

  /**
   * Scale mask template to match target frame dimensions
   */
  private async scaleMaskToFrame(
    maskBuffer: Buffer, 
    targetWidth: number, 
    targetHeight: number
  ): Promise<{ data: Buffer; channels: number }> {
    try {
      const maskInfo = await sharp(maskBuffer)
        .resize(targetWidth, targetHeight, {
          fit: 'fill',           // Stretch to exact dimensions
          kernel: 'lanczos3'     // High-quality interpolation
        })
        .raw()
        .toBuffer({ resolveWithObject: true });

      return {
        data: maskInfo.data,
        channels: maskInfo.info.channels
      };
    } catch (error) {
      throw new Error(`Failed to scale mask template: ${error}`);
    }
  }

  // ================================
  // PIXEL-LEVEL PROCESSING
  // ================================

  /**
   * Detect if a pixel represents a mask area (red drawing)
   */
  private detectMaskPixel(
    maskData: Buffer, 
    pixelIndex: number, 
    channels: number
  ): PixelDetectionResult {
    const baseIndex = pixelIndex * channels;
    
    const maskR = maskData[baseIndex] || 0;
    const maskG = maskData[baseIndex + 1] || 0;
    const maskB = maskData[baseIndex + 2] || 0;
    const maskA = channels > 3 ? (maskData[baseIndex + 3] || 0) : 255;

    // Check if pixel is visible (not transparent)
    const isDrawn = maskA > this.maskThresholds.alphaThreshold;

    // Check if pixel is predominantly red
    const isRed = maskR > this.maskThresholds.redMinimum &&
                  maskR > maskG * this.maskThresholds.redDominanceRatio &&
                  maskR > maskB * this.maskThresholds.redDominanceRatio;

    return { isDrawn, isRed, maskR, maskG, maskB, maskA };
  }

  /**
   * Apply blackening to a specific pixel in the image buffer
   */
  private blackenPixel(imageBuffer: Buffer, pixelIndex: number, imageChannels: number): void {
    const baseIndex = pixelIndex * imageChannels;
    
    // Set RGB values to 0 (black)
    imageBuffer[baseIndex] = 0;         // Red
    imageBuffer[baseIndex + 1] = 0;     // Green
    imageBuffer[baseIndex + 2] = 0;     // Blue
    // Alpha channel preserved if present
  }

  /**
   * Process all pixels in an image with the mask template
   */
  private async processImagePixels(
    originalBuffer: Buffer,
    maskData: Buffer,
    width: number,
    height: number,
    imageChannels: number,
    maskChannels: number
  ): Promise<Buffer> {
    // Create modifiable copy of original image
    const maskedPixels = Buffer.from(originalBuffer);
    const totalPixels = width * height;
    
    let maskedPixelCount = 0;

    // Process each pixel individually
    for (let i = 0; i < totalPixels; i++) {
      const detection = this.detectMaskPixel(maskData, i, maskChannels);
      
      // Apply blackening if pixel matches mask criteria
      if (detection.isDrawn && detection.isRed) {
        this.blackenPixel(maskedPixels, i, imageChannels);
        maskedPixelCount++;
      }
    }

    console.log(`Processed ${totalPixels} pixels, masked ${maskedPixelCount} pixels`);
    return maskedPixels;
  }

  // ================================
  // FRAME PROCESSING
  // ================================

  /**
   * Apply mask template to a single frame
   */
  async applyMaskToSingleFrame(
    originalPath: string, 
    maskedPath: string, 
    maskTemplate: string
  ): Promise<void> {
    try {
      // Handle empty mask case
      if (!maskTemplate || maskTemplate.trim() === "") {
        await fs.copyFile(originalPath, maskedPath);
        return;
      }

      // Extract and validate base64 data
      const base64Data = this.extractBase64Data(maskTemplate);
      if (!base64Data) {
        await fs.copyFile(originalPath, maskedPath);
        return;
      }

      // Create mask buffer
      const maskBuffer = await this.createMaskBuffer(base64Data);

      // Load original image and get metadata
      const originalImage = sharp(originalPath);
      const { width, height } = await originalImage.metadata();
      
      if (!width || !height) {
        throw new Error("Could not determine image dimensions");
      }

      // Get raw pixel data from original image
      const originalRaw = await originalImage.raw().toBuffer();
      
      // Scale mask to match frame dimensions
      const { data: maskRaw, channels: maskChannels } = await this.scaleMaskToFrame(
        maskBuffer, 
        width, 
        height
      );

      // Process pixels with mask
      const imageChannels = 3; // RGB format
      const maskedPixels = await this.processImagePixels(
        originalRaw,
        maskRaw,
        width,
        height,
        imageChannels,
        maskChannels
      );

      // Create new image from processed pixels
      const maskedImage = await sharp(maskedPixels, {
        raw: {
          width,
          height,
          channels: imageChannels
        }
      })
      .png({ 
        compressionLevel: 6,  // Balanced compression
        palette: false        // Force RGB output
      })
      .toBuffer();

      // Save masked image
      await fs.writeFile(maskedPath, maskedImage);
      
    } catch (error) {
      console.error(`Failed to create masked frame ${maskedPath}:`, error);
      // Fallback: copy original if masking fails
      try {
        await fs.copyFile(originalPath, maskedPath);
      } catch (copyError) {
        throw new Error(`Failed to create masked frame and fallback copy failed: ${copyError}`);
      }
    }
  }

  /**
   * Apply mask template to multiple frames (batch processing)
   */
  async applyMaskToFrames(
    frames: StudyFrame[], 
    maskTemplate: string
  ): Promise<MaskApplicationResult> {
    const result: MaskApplicationResult = {
      maskedFrames: [],
      processedCount: 0,
      failedCount: 0,
      errors: []
    };

    console.log(`Starting batch mask application for ${frames.length} frames`);

    for (const frame of frames) {
      try {
        // Generate masked file path
        const maskedPath = frame.pngPath.replace('.png', '_masked.png');
        
        // Verify original frame exists
        try {
          await fs.access(frame.pngPath);
        } catch (error) {
          const errorMsg = `Original frame not found: ${frame.pngPath}`;
          console.warn(errorMsg);
          result.errors.push(errorMsg);
          result.failedCount++;
          continue;
        }
        
        // Apply mask to frame
        await this.applyMaskToSingleFrame(frame.pngPath, maskedPath, maskTemplate);
        
        result.maskedFrames.push(maskedPath);
        result.processedCount++;
        
      } catch (error) {
        const errorMsg = `Failed to process frame ${frame.frameNumber}: ${error}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
        result.failedCount++;
      }
    }

    console.log(`Batch processing complete: ${result.processedCount} success, ${result.failedCount} failed`);
    return result;
  }

  // ================================
  // TEMPLATE MANAGEMENT
  // ================================

  /**
   * Validate mask template data
   */
  validateMaskTemplate(maskData: string): { valid: boolean; error?: string } {
    if (!maskData || typeof maskData !== 'string') {
      return { valid: false, error: 'Mask data is required' };
    }

    if (!maskData.startsWith('data:image/')) {
      return { valid: false, error: 'Invalid data URL format' };
    }

    const base64Data = this.extractBase64Data(maskData);
    if (!base64Data) {
      return { valid: false, error: 'Could not extract base64 data' };
    }

    try {
      Buffer.from(base64Data, 'base64');
      return { valid: true };
    } catch (error) {
      return { valid: false, error: 'Invalid base64 encoding' };
    }
  }

  /**
   * Create mask template from canvas data
   */
  createMaskTemplate(
    studyId: string,
    maskData: string,
    brushSize: number,
    frameNumber: number = 1
  ): MaskTemplate {
    const validation = this.validateMaskTemplate(maskData);
    if (!validation.valid) {
      throw new Error(`Invalid mask template: ${validation.error}`);
    }

    return {
      id: `mask_${studyId}_${Date.now()}`,
      studyId,
      maskData,
      brushSize,
      frameNumber,
      createdAt: new Date()
    };
  }

  // ================================
  // UTILITY METHODS
  // ================================

  /**
   * Get mask statistics from template
   */
  async getMaskStatistics(maskTemplate: string): Promise<{
    totalPixels: number;
    maskedPixels: number;
    maskPercentage: number;
    dimensions: { width: number; height: number };
  }> {
    const base64Data = this.extractBase64Data(maskTemplate);
    if (!base64Data) {
      throw new Error('Invalid mask template data');
    }

    const maskBuffer = await this.createMaskBuffer(base64Data);
    const maskInfo = await sharp(maskBuffer).raw().toBuffer({ resolveWithObject: true });
    
    const { width, height, channels } = maskInfo.info;
    const maskData = maskInfo.data;
    const totalPixels = width * height;
    
    let maskedPixels = 0;
    for (let i = 0; i < totalPixels; i++) {
      const detection = this.detectMaskPixel(maskData, i, channels);
      if (detection.isDrawn && detection.isRed) {
        maskedPixels++;
      }
    }

    return {
      totalPixels,
      maskedPixels,
      maskPercentage: (maskedPixels / totalPixels) * 100,
      dimensions: { width, height }
    };
  }

  /**
   * Preview mask overlay on a specific frame
   */
  async createMaskPreview(
    originalFramePath: string,
    maskTemplate: string,
    outputPath: string
  ): Promise<void> {
    const base64Data = this.extractBase64Data(maskTemplate);
    if (!base64Data) {
      throw new Error('Invalid mask template data');
    }

    const maskBuffer = await this.createMaskBuffer(base64Data);
    
    // Create overlay by blending original with semi-transparent mask
    const originalImage = sharp(originalFramePath);
    const { width, height } = await originalImage.metadata();
    
    if (!width || !height) {
      throw new Error("Could not determine image dimensions");
    }

    const scaledMask = await sharp(maskBuffer)
      .resize(width, height)
      .png()
      .toBuffer();

    // Composite original with mask overlay
    const preview = await originalImage
      .composite([{
        input: scaledMask,
        blend: 'multiply'
      }])
      .png()
      .toBuffer();

    await fs.writeFile(outputPath, preview);
  }
}

// ================================
// EXPORT DEFAULT INSTANCE
// ================================

export default TemplateMaskingEngine;

// ================================
// POST-PROCESSING AFTER MASKING
// ================================

interface ExportOptions {
  convert512?: boolean;    // Convert to 512x512 for ML datasets
  includeCsv?: boolean;    // Include CSV metadata
  quality?: number;        // JPG quality (1-100)
  framerate?: number;      // Video framerate for MP4
}

interface ExportResult {
  success: boolean;
  outputPath: string;
  fileSize: number;
  processedFrames: number;
  error?: string;
}

/**
 * Post-processing manager for masked frames
 * Handles video generation, ZIP creation, and format conversion
 */
export class PostProcessingManager {
  private outputDir: string;

  constructor(outputDir: string = 'exports') {
    this.outputDir = path.resolve(outputDir);
    this.ensureOutputDir();
  }

  private async ensureOutputDir(): Promise<void> {
    try {
      await fs.access(this.outputDir);
    } catch {
      await fs.mkdir(this.outputDir, { recursive: true });
    }
  }

  /**
   * Create MP4 video from masked frames
   */
  async createVideoExport(
    studyId: string,
    frames: StudyFrame[],
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    const { framerate = 10 } = options;
    const videoPath = path.join(this.outputDir, `${studyId}_masked_video.mp4`);
    
    try {
      // Check if masked frames exist
      const firstFrame = frames[0];
      const maskedPath = firstFrame.pngPath.replace('.png', '_masked.png');
      let useOriginalFrames = false;
      
      try {
        await fs.access(maskedPath);
      } catch {
        console.warn("Masked frames not found, using original frames for video");
        useOriginalFrames = true;
      }
      
      // Create ffmpeg input pattern
      const inputPattern = useOriginalFrames 
        ? path.join(path.dirname(firstFrame.pngPath), "frame_%03d.png")
        : path.join(path.dirname(maskedPath), "frame_%03d_masked.png");
      
      console.log(`Creating MP4 video: ${videoPath}`);
      
      // Execute ffmpeg with optimized settings
      const ffmpegCmd = [
        'ffmpeg', '-y',
        '-framerate', framerate.toString(),
        '-i', `"${inputPattern}"`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-crf', '23',  // High quality
        '-preset', 'medium',
        '-movflags', '+faststart',
        `"${videoPath}"`
      ].join(' ');
      
      const { execSync } = require('child_process');
      execSync(ffmpegCmd, { stdio: 'pipe' });
      
      const stats = await fs.stat(videoPath);
      
      return {
        success: true,
        outputPath: videoPath,
        fileSize: stats.size,
        processedFrames: frames.length
      };
      
    } catch (error) {
      return {
        success: false,
        outputPath: videoPath,
        fileSize: 0,
        processedFrames: 0,
        error: `Video creation failed: ${error}`
      };
    }
  }

  /**
   * Create ZIP archive of masked frames in PNG format
   */
  async createPngZipExport(
    studyId: string,
    frames: StudyFrame[],
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    return this.createImageZipExport(studyId, frames, 'png', options);
  }

  /**
   * Create ZIP archive of masked frames in JPG format
   */
  async createJpgZipExport(
    studyId: string,
    frames: StudyFrame[],
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    return this.createImageZipExport(studyId, frames, 'jpg', options);
  }

  /**
   * Create ZIP archive with image format conversion and processing
   */
  private async createImageZipExport(
    studyId: string,
    frames: StudyFrame[],
    format: 'png' | 'jpg',
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    const { convert512 = false, includeCsv = false, quality = 90 } = options;
    const zipPath = path.join(this.outputDir, `${studyId}_masked_${format}.zip`);
    
    try {
      const archiver = require('archiver');
      const { createWriteStream } = require('fs');
      
      // Setup ZIP archive with compression
      const archive = archiver('zip', { 
        zlib: { level: 6 },
        forceLocalTime: true
      });
      
      const writeStream = createWriteStream(zipPath);
      archive.pipe(writeStream);
      
      let processedFrames = 0;
      const studyFolder = `${studyId}/`;
      
      // Process each frame
      for (const frame of frames) {
        try {
          // Determine source path (masked or original)
          let sourcePath = frame.pngPath.replace('.png', '_masked.png');
          
          try {
            await fs.access(sourcePath);
          } catch {
            console.warn(`Masked frame not found: ${sourcePath}, using original`);
            sourcePath = frame.pngPath;
          }
          
          // Process image with Sharp
          let sharpInstance = sharp(sourcePath);
          
          // Apply 512x512 conversion if requested
          if (convert512) {
            sharpInstance = sharpInstance.resize(512, 512, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 1 }
            });
          }
          
          // Convert to target format
          let imageBuffer: Buffer;
          if (format === 'jpg') {
            imageBuffer = await sharpInstance
              .jpeg({ 
                quality, 
                progressive: true, 
                mozjpeg: true 
              })
              .toBuffer();
          } else {
            imageBuffer = await sharpInstance
              .png({ 
                compressionLevel: 6, 
                progressive: true 
              })
              .toBuffer();
          }
          
          // Add to archive
          const filename = `frame_${frame.frameNumber.toString().padStart(3, '0')}.${format}`;
          archive.append(imageBuffer, { name: studyFolder + filename });
          processedFrames++;
          
        } catch (error) {
          console.error(`Error processing frame ${frame.frameNumber}:`, error);
          continue;
        }
      }
      
      // Add CSV metadata if requested
      if (includeCsv) {
        const csvContent = this.generateFramesCsv(frames);
        archive.append(csvContent, { name: studyFolder + 'frames.csv' });
      }
      
      // Finalize archive
      await new Promise<void>((resolve, reject) => {
        archive.on('error', reject);
        archive.on('end', resolve);
        archive.finalize();
      });
      
      const stats = await fs.stat(zipPath);
      
      return {
        success: true,
        outputPath: zipPath,
        fileSize: stats.size,
        processedFrames
      };
      
    } catch (error) {
      return {
        success: false,
        outputPath: zipPath,
        fileSize: 0,
        processedFrames: 0,
        error: `ZIP creation failed: ${error}`
      };
    }
  }

  /**
   * Generate CSV metadata for frames
   */
  private generateFramesCsv(frames: StudyFrame[]): string {
    const header = "frame_number,filename,width,height,original_path\n";
    const rows = frames.map(frame => 
      `${frame.frameNumber},frame_${frame.frameNumber.toString().padStart(3, '0')}.png,${frame.width},${frame.height},${frame.originalPath}`
    ).join('\n');
    
    return header + rows;
  }

  /**
   * Convert individual frame to 512x512 for ML datasets
   */
  async convertFrameTo512x512(
    inputPath: string, 
    outputPath: string
  ): Promise<void> {
    try {
      await sharp(inputPath)
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        })
        .png({ compressionLevel: 6 })
        .toFile(outputPath);
        
    } catch (error) {
      // Fallback: copy original if conversion fails
      await fs.copyFile(inputPath, outputPath);
    }
  }

  /**
   * Batch convert all masked frames to specific format
   */
  async batchConvertFrames(
    frames: StudyFrame[],
    targetFormat: 'png' | 'jpg' | '512x512',
    outputDir: string
  ): Promise<{ converted: string[]; failed: string[] }> {
    const converted: string[] = [];
    const failed: string[] = [];
    
    await fs.mkdir(outputDir, { recursive: true });
    
    for (const frame of frames) {
      try {
        const maskedPath = frame.pngPath.replace('.png', '_masked.png');
        let sourcePath = maskedPath;
        
        // Check if masked version exists
        try {
          await fs.access(maskedPath);
        } catch {
          sourcePath = frame.pngPath;
        }
        
        const outputFile = path.join(
          outputDir, 
          `frame_${frame.frameNumber.toString().padStart(3, '0')}.${targetFormat === '512x512' ? 'png' : targetFormat}`
        );
        
        if (targetFormat === '512x512') {
          await this.convertFrameTo512x512(sourcePath, outputFile);
        } else if (targetFormat === 'jpg') {
          await sharp(sourcePath)
            .jpeg({ quality: 90, progressive: true })
            .toFile(outputFile);
        } else {
          await sharp(sourcePath)
            .png({ compressionLevel: 6 })
            .toFile(outputFile);
        }
        
        converted.push(outputFile);
        
      } catch (error) {
        console.error(`Failed to convert frame ${frame.frameNumber}:`, error);
        failed.push(frame.pngPath);
      }
    }
    
    return { converted, failed };
  }
}

// Example usage:
/*
const maskingEngine = new TemplateMaskingEngine();
const postProcessor = new PostProcessingManager();

// 1. Create and apply mask template
const template = maskingEngine.createMaskTemplate(
  "study_123",
  "data:image/png;base64,iVBORw0KGgo...",
  36,
  1
);

const frames = [
  { frameNumber: 1, originalPath: "/path/to/original", pngPath: "/path/to/frame1.png", width: 512, height: 512 },
  // ... more frames
];

// 2. Apply mask to all frames
const maskResult = await maskingEngine.applyMaskToFrames(frames, template.maskData);
console.log(`Masked ${maskResult.processedCount} frames`);

// 3. Post-process masked frames
// Create MP4 video
const videoResult = await postProcessor.createVideoExport("study_123", frames, {
  framerate: 15,
  convert512: false
});

// Create JPG ZIP for download
const jpgResult = await postProcessor.createJpgZipExport("study_123", frames, {
  convert512: true,  // ML dataset format
  includeCsv: true,
  quality: 90
});

// Create PNG ZIP
const pngResult = await postProcessor.createPngZipExport("study_123", frames, {
  includeCsv: true
});

console.log('Export Results:', { videoResult, jpgResult, pngResult });
*/