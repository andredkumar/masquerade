import { storage } from '../storage';
import { FrameExtractor } from './frameExtractor';
import type { VideoJob, MaskData, OutputSettings, ProcessingProgress } from '@shared/schema';
import { Server } from 'socket.io';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import fs from 'fs/promises';
import Sharp from 'sharp';
import { TempFolderManager } from './tempFolderManager';

interface TransformationMatrix {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

interface CoordinateTransformParams {
  maskData: MaskData;
  frameWidth: number;
  frameHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export class VideoProcessor {
  private frameExtractor: FrameExtractor;
  private io: Server;
  private outputDir: string;

  constructor(io: Server) {
    this.frameExtractor = new FrameExtractor();
    this.io = io;
    this.outputDir = path.join(process.cwd(), 'output');
    this.ensureOutputDir();
  }

  private async ensureOutputDir() {
    try {
      await fs.mkdir(this.outputDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create output directory:', error);
    }
  }

  /**
   * Calculate coordinate transformation matrix from display space to processing space
   * Following the prototype approach for accurate coordinate mapping
   */
  private calculateTransformationMatrix(params: CoordinateTransformParams): TransformationMatrix {
    const { maskData, frameWidth, frameHeight } = params;
    
    // Get dimensions from mask data
    const canvasWidth = maskData.originalCanvasDimensions?.width || maskData.canvasWidth || frameWidth;
    const canvasHeight = maskData.originalCanvasDimensions?.height || maskData.canvasHeight || frameHeight;
    const imageDisplayInfo = maskData.imageDisplayInfo;
    
    this.logCoordinateTransformation('🔄 COORDINATE TRANSFORMATION CALCULATION', {
      input: {
        canvasWidth,
        canvasHeight,
        frameWidth,
        frameHeight,
        imageDisplayInfo,
        imageDimensions: maskData.imageDimensions
      }
    });
    
    if (imageDisplayInfo) {
      // CRITICAL: Transform from display space (contain) to processing space (fill)
      // Step 1: Convert canvas coordinates to image display coordinates
      const displayScale = imageDisplayInfo.scale;
      const displayOffsetX = imageDisplayInfo.offsetX;
      const displayOffsetY = imageDisplayInfo.offsetY;
      
      // Step 2: Calculate the actual displayed image dimensions
      const imageDims = maskData.imageDimensions;
      if (imageDims) {
        const displayedImageWidth = imageDims.width * displayScale;
        const displayedImageHeight = imageDims.height * displayScale;
        
        // Step 3: Calculate transformation from display coordinates to frame coordinates
        const scaleX = frameWidth / displayedImageWidth;
        const scaleY = frameHeight / displayedImageHeight;
        
        // Step 4: Calculate offset adjustment for the letterboxing
        const offsetX = -displayOffsetX * scaleX;
        const offsetY = -displayOffsetY * scaleY;
        
        const result = { scaleX, scaleY, offsetX, offsetY };
        
        this.logCoordinateTransformation('✅ TRANSFORMATION MATRIX CALCULATED', {
          displayInfo: {
            displayScale,
            displayOffsetX,
            displayOffsetY,
            displayedImageWidth,
            displayedImageHeight
          },
          transformation: result,
          calculations: {
            scaleXCalc: `${frameWidth} / ${displayedImageWidth} = ${scaleX}`,
            scaleYCalc: `${frameHeight} / ${displayedImageHeight} = ${scaleY}`,
            offsetXCalc: `-${displayOffsetX} * ${scaleX} = ${offsetX}`,
            offsetYCalc: `-${displayOffsetY} * ${scaleY} = ${offsetY}`
          }
        });
        
        return result;
      }
    }
    
    // Fallback: direct scaling (old approach)
    const scaleX = frameWidth / canvasWidth;
    const scaleY = frameHeight / canvasHeight;
    const result = { scaleX, scaleY, offsetX: 0, offsetY: 0 };
    
    this.logCoordinateTransformation('⚠️ FALLBACK DIRECT SCALING', {
      reason: 'No imageDisplayInfo available',
      transformation: result,
      calculations: {
        scaleXCalc: `${frameWidth} / ${canvasWidth} = ${scaleX}`,
        scaleYCalc: `${frameHeight} / ${canvasHeight} = ${scaleY}`
      }
    });
    
    return result;
  }

  /**
   * Comprehensive coordinate transformation logging for troubleshooting
   */
  private logCoordinateTransformation(title: string, data: any) {
    console.log('\n' + '='.repeat(80));
    console.log(title);
    console.log('='.repeat(80));
    console.log(JSON.stringify(data, null, 2));
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Apply coordinate transformation to normalize coordinates
   */
  private transformCoordinates(
    canvasX: number, 
    canvasY: number, 
    matrix: TransformationMatrix
  ): { x: number; y: number } {
    return {
      x: (canvasX * matrix.scaleX) + matrix.offsetX,
      y: (canvasY * matrix.scaleY) + matrix.offsetY
    };
  }

  /**
   * Create mask with proper coordinate transformation from display to processing space
   */
  private async createTransformedMask(
    canvasDataUrl: string,
    maskData: MaskData,
    frameWidth: number,
    frameHeight: number
  ): Promise<Buffer> {
    // Extract base64 data
    const base64Data = canvasDataUrl.split(',')[1];
    const maskBuffer = Buffer.from(base64Data, 'base64');
    
    // Get canvas dimensions
    const canvasWidth = maskData.originalCanvasDimensions?.width || frameWidth;
    const canvasHeight = maskData.originalCanvasDimensions?.height || frameHeight;
    
    // Calculate transformation matrix
    const transform = this.calculateTransformationMatrix({
      maskData,
      frameWidth,
      frameHeight,
      outputWidth: frameWidth,
      outputHeight: frameHeight
    });
    
    console.log('Creating transformed mask with matrix:', transform);
    
    // Apply coordinate transformation during scaling
    // If we have display transformation info, we need to account for the coordinate space change
    if (maskData.imageDisplayInfo && maskData.imageDimensions) {
      // Create intermediate mask at the displayed image size first
      const displayScale = maskData.imageDisplayInfo.scale;
      const displayedWidth = maskData.imageDimensions.width * displayScale;
      const displayedHeight = maskData.imageDimensions.height * displayScale;
      
      // Step 1: Scale mask from canvas to displayed image size - VALIDATE DIMENSIONS
      const roundedWidth = Math.round(displayedWidth);
      const roundedHeight = Math.round(displayedHeight);
      
      if (roundedWidth <= 0 || roundedHeight <= 0) {
        console.error(`❌ Invalid displayed dimensions: ${roundedWidth}x${roundedHeight} (original: ${displayedWidth}x${displayedHeight})`);
        throw new Error(`Invalid displayed dimensions for mask scaling: ${roundedWidth}x${roundedHeight}`);
      }
      
      const intermediateInfo = await Sharp(maskBuffer)
        .resize(roundedWidth, roundedHeight, {
          fit: 'fill',
          kernel: 'lanczos3'
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      // Step 2: Scale to final frame size  
      const finalInfo = await Sharp(intermediateInfo.data, {
        raw: {
          width: intermediateInfo.info.width,
          height: intermediateInfo.info.height,
          channels: intermediateInfo.info.channels
        }
      })
        .resize(frameWidth, frameHeight, {
          fit: 'fill',
          kernel: 'lanczos3'
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      return this.convertToRgbaBuffer(finalInfo.data, frameWidth, frameHeight, finalInfo.info.channels);
    }
    
    // Fallback: direct scaling - VALIDATE DIMENSIONS
    if (frameWidth <= 0 || frameHeight <= 0) {
      console.error(`❌ Invalid frame dimensions for direct scaling: ${frameWidth}x${frameHeight}`);
      throw new Error(`Invalid frame dimensions for mask scaling: ${frameWidth}x${frameHeight}`);
    }
    
    const maskInfo = await Sharp(maskBuffer)
      .resize(frameWidth, frameHeight, {
        fit: 'fill',
        kernel: 'lanczos3'
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
      
    return this.convertToRgbaBuffer(maskInfo.data, frameWidth, frameHeight, maskInfo.info.channels);
  }

  /**
   * Convert mask data to RGBA buffer
   */
  private convertToRgbaBuffer(maskData: Buffer, width: number, height: number, channels: number): Buffer {
    const pixelCount = width * height;
    const rgbaBuffer = Buffer.alloc(pixelCount * 4);
    
    console.log(`Converting mask to RGBA: ${width}x${height}, channels: ${channels}`);
    
    for (let i = 0; i < pixelCount; i++) {
      const sourceIndex = i * channels;
      const targetIndex = i * 4;
      
      const r = maskData[sourceIndex] || 0;
      const g = maskData[sourceIndex + 1] || 0;
      const b = maskData[sourceIndex + 2] || 0;
      const a = channels > 3 ? (maskData[sourceIndex + 3] || 0) : 255;
      
      // Apply red color detection (following prototype)
      if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) {
        // Red pixel detected - this is a mask area (should be blackened)
        rgbaBuffer[targetIndex] = 255;     // R: 255 for mask areas
        rgbaBuffer[targetIndex + 1] = 0;   // G: 0  
        rgbaBuffer[targetIndex + 2] = 0;   // B: 0
        rgbaBuffer[targetIndex + 3] = 255; // A: 255 (opaque)
      } else {
        // Non-red pixel - this area should be preserved
        rgbaBuffer[targetIndex] = 0;       // R: 0 for non-mask areas
        rgbaBuffer[targetIndex + 1] = 0;   // G: 0
        rgbaBuffer[targetIndex + 2] = 0;   // B: 0  
        rgbaBuffer[targetIndex + 3] = 0;   // A: 0 (transparent)
      }
    }
    
    return rgbaBuffer;
  }

  async processVideo(jobId: string, videoPath: string, maskData: MaskData, outputSettings: OutputSettings) {
    try {
      console.log('🔍 ENTERED processVideo method successfully!');
      console.log('🔍 Parameters:', { jobId, videoPath, maskDataType: maskData?.type, hasOutputSettings: !!outputSettings });
      
      await this.updateProgress(jobId, { stage: 'extracting', progress: 5 });

      // Extract video metadata
      const metadata = await this.frameExtractor.extractVideoMetadata(videoPath);
      
      await storage.updateVideoJob(jobId, {
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        frameRate: metadata.frameRate,
        totalFrames: metadata.totalFrames,
        status: 'processing',
        maskData,
        outputSettings
      });

      await this.updateProgress(jobId, { 
        stage: 'processing', 
        progress: 10,
        totalFrames: metadata.totalFrames 
      });

      // Create frame batches
      const batchSize = outputSettings.batchSize || 12;
      const batches = this.createFrameBatches(metadata.totalFrames, batchSize);
      
      // Create batch records in storage
      for (let i = 0; i < batches.length; i++) {
        await storage.createFrameBatch({
          jobId,
          batchNumber: i + 1,
          startFrame: batches[i].start,
          endFrame: batches[i].end,
          status: 'pending'
        });
      }

      // Process batches in parallel
      const processedFrames = await this.processBatchesInParallel(
        jobId, 
        videoPath, 
        batches, 
        maskData, 
        outputSettings
      );

      await this.updateProgress(jobId, { stage: 'exporting', progress: 90 });

      // Create output ZIP
      const zipPath = await this.createOutputZip(jobId, processedFrames, metadata, outputSettings);

      await storage.updateVideoJob(jobId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
        outputZipPath: zipPath
      });

      await this.updateProgress(jobId, { 
        stage: 'completed', 
        progress: 100 
      });

      return zipPath;

    } catch (error) {
      console.error(`Error processing video ${jobId}:`, error);
      
      await storage.updateVideoJob(jobId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      await this.updateProgress(jobId, { 
        stage: 'failed', 
        progress: 0,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      throw error;
    }
  }

  /**
   * Process a batch of images with the same mask
   */
  async processImages(
    jobId: string,
    imageFiles: string[],
    maskData: MaskData,
    outputSettings: OutputSettings
  ): Promise<string> {
    try {
      console.log('🖼️ ENTERED processImages method successfully!');
      console.log('🖼️ Parameters:', { 
        jobId, 
        imageCount: imageFiles.length, 
        maskDataType: maskData?.type, 
        hasOutputSettings: !!outputSettings 
      });
      
      await this.updateProgress(jobId, { stage: 'processing', progress: 5 });

      // Get job info
      const job = await storage.getVideoJob(jobId);
      if (!job) {
        throw new Error('Job not found');
      }

      // Clean up any existing temp folder and create new one
      await TempFolderManager.cleanupJobTempFolder(jobId);
      await TempFolderManager.createJobTempFolder(jobId);

      // Update job with processing info
      await storage.updateVideoJob(jobId, {
        status: 'processing',
        maskData,
        outputSettings
      });

      await this.updateProgress(jobId, { 
        stage: 'processing', 
        progress: 10,
        totalFrames: imageFiles.length 
      });

      // Process images and save to temp folder
      let processedCount = 0;
      const processedImages: Array<{ imageNumber: number; buffer: Buffer; originalName: string }> = [];
      
      // Calculate output size based on settings
      const firstImageDimensions = await this.frameExtractor.getImageDimensions(imageFiles[0]);
      let outputSize;
      
      if (outputSettings.width && outputSettings.height) {
        outputSize = {
          width: outputSettings.width,
          height: outputSettings.height
        };
      } else if (outputSettings.size === 'custom') {
        outputSize = { 
          width: outputSettings.customWidth || 512, 
          height: outputSettings.customHeight || 512 
        };
      } else if (outputSettings.size === 'original') {
        outputSize = firstImageDimensions;
      } else if (outputSettings.size && typeof outputSettings.size === 'string' && outputSettings.size.includes('x')) {
        const [width, height] = outputSettings.size.split('x').map(Number);
        outputSize = { width, height };
      } else {
        outputSize = { width: 512, height: 512 };
      }
      
      // OPTIMIZED BATCH PROCESSING: Reduced batch size for better memory management
      const VOLUME_BATCH_SIZE = 8; // Reduced from 20 to 8 for better performance
      const startTime = Date.now();
      console.log(`🏗️ Processing ${imageFiles.length} images using volumetric batching (${VOLUME_BATCH_SIZE} image volumes)`);
      
      // Process images in volumetric batches
      for (let volumeStart = 0; volumeStart < imageFiles.length; volumeStart += VOLUME_BATCH_SIZE) {
        const volumeEnd = Math.min(volumeStart + VOLUME_BATCH_SIZE, imageFiles.length);
        const batchImageFiles = imageFiles.slice(volumeStart, volumeEnd);
        
        console.log(`📦 Processing image volume batch: ${volumeStart}-${volumeEnd-1} (${batchImageFiles.length} images)`);
        
        try {
          // Load image buffers for the batch
          const imageBuffers = await Promise.all(
            batchImageFiles.map(imagePath => this.frameExtractor.getImageAsBuffer(imagePath))
          );
          
          // Create volume processing tasks
          const volumeTasks = imageBuffers.map((frameBuffer, index) => ({
            frameBuffer,
            maskData,
            outputSize,
            outputSettings,
            frameNumber: volumeStart + index
          }));
          
          // Process entire volume simultaneously (3D mask application)
          const volumeResults = await this.processFrameBatch(volumeTasks);
          
          // Force garbage collection after processing each volume batch
          if (global.gc) {
            global.gc();
          }
          
          // Save processed images and collect data
          for (let i = 0; i < volumeResults.length; i++) {
            const result = volumeResults[i];
            const globalIndex = volumeStart + i;
            
            const fileList = job.fileList as any[];
            const originalName = fileList[globalIndex]?.originalName || `image_${globalIndex + 1}.png`;
            
            if (result.success && result.processedBuffer.length > 0) {
              // Save processed image to temp folder
              await TempFolderManager.saveProcessedImage(
                jobId,
                globalIndex,
                result.processedBuffer,
                originalName
              );
              
              // Collect processed image data for CSV generation
              processedImages.push({
                imageNumber: globalIndex,
                buffer: result.processedBuffer,
                originalName: originalName
              });
              
              processedCount++;
              console.log(`✅ Processed and saved image ${globalIndex + 1}: ${result.processedBuffer.length} bytes`);
            } else {
              console.error(`❌ Failed to process image ${globalIndex + 1}:`, result.error);
              // Add failed image to CSV with empty buffer for completeness
              processedImages.push({
                imageNumber: globalIndex,
                buffer: Buffer.alloc(0), // Empty buffer for failed frames
                originalName: originalName
              });
            }
          }
          
          // Update progress with volumetric processing stats
          const progress = 10 + ((volumeEnd) / imageFiles.length) * 80;
          const elapsed = (Date.now() - startTime) / 1000;
          const fps = processedCount / elapsed;
          
          console.log(`⚡ Image volume batch complete: ${volumeResults.length} images processed at ${fps.toFixed(1)} FPS`);
          
          await this.updateProgress(jobId, { 
            stage: 'processing', 
            progress,
            currentFrame: volumeEnd,
            fps: parseFloat(fps.toFixed(1))
          });
          
        } catch (error) {
          console.error(`❌ Error processing image volume batch ${volumeStart}-${volumeEnd-1}:`, error);
          
          // Process individually as fallback for this batch
          for (let i = volumeStart; i < volumeEnd; i++) {
            try {
              const imagePath = imageFiles[i];
              const imageBuffer = await this.frameExtractor.getImageAsBuffer(imagePath);
              
              const task = {
                frameBuffer: imageBuffer,
                maskData,
                outputSize,
                outputSettings,
                frameNumber: i
              };
              
              const result = await this.processFrame(task);
              
              if (result.success && result.processedBuffer.length > 0) {
                const fileList = job.fileList as any[];
                const originalName = fileList[i]?.originalName || `image_${i + 1}.png`;
                
                await TempFolderManager.saveProcessedImage(jobId, i, result.processedBuffer, originalName);
                processedImages.push({ imageNumber: i, buffer: result.processedBuffer, originalName });
                processedCount++;
                
                console.log(`✅ Fallback processed image ${i + 1}: ${result.processedBuffer.length} bytes`);
              }
              
              const progress = 10 + ((i + 1) / imageFiles.length) * 80;
              await this.updateProgress(jobId, { 
                stage: 'processing',
                progress,
                currentFrame: i + 1 
              });
              
            } catch (individualError) {
              console.error(`❌ Fallback failed for image ${i + 1}:`, individualError);
            }
          }
        }
      }

      await this.updateProgress(jobId, { stage: 'exporting', progress: 90 });

      // Create output ZIP from temp folder
      const zipPath = await this.createImageZipFromTempFolder(jobId, {
        duration: 0,
        width: firstImageDimensions.width,
        height: firstImageDimensions.height,
        frameRate: 1,
        totalFrames: imageFiles.length
      }, outputSettings, processedImages);

      await storage.updateVideoJob(jobId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
        outputZipPath: zipPath
      });

      await this.updateProgress(jobId, { 
        stage: 'completed', 
        progress: 100 
      });

      return zipPath;

    } catch (error) {
      console.error(`Error processing images ${jobId}:`, error);
      
      await storage.updateVideoJob(jobId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      await this.updateProgress(jobId, { 
        stage: 'failed', 
        progress: 0,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      throw error;
    }
  }

  /**
   * Create ZIP from processed images in temp folder (for multi-image upload workflow)
   */
  private async createImageZipFromTempFolder(
    jobId: string,
    metadata: any,
    outputSettings: OutputSettings,
    processedImages: Array<{ imageNumber: number; buffer: Buffer; originalName: string }>
  ): Promise<string> {
    const zipFilename = `processed_images_${jobId}.zip`;
    const zipPath = path.join(this.outputDir, zipFilename);

    console.log(`📦 Creating ZIP at: ${zipPath}`);
    console.log(`📦 Output directory: ${this.outputDir}`);

    return new Promise(async (resolve, reject) => {
      try {
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
          console.log(`✅ ZIP created successfully: ${zipPath} (${archive.pointer()} bytes)`);
          resolve(zipPath);
        });

        output.on('error', (err: Error) => {
          console.error(`❌ Output stream error:`, err);
          reject(err);
        });

        archive.on('error', (err: Error) => {
          console.error(`❌ Archive error:`, err);
          reject(err);
        });

        archive.on('warning', (err: Error) => {
          console.warn(`⚠️ Archive warning:`, err);
        });

        archive.pipe(output);

        // Get all processed images from temp folder
        const processedImagePaths = await TempFolderManager.getProcessedImages(jobId);
        
        console.log(`📦 Found ${processedImagePaths.length} processed images in temp folder`);
        
        if (processedImagePaths.length === 0) {
          console.warn(`⚠️ No processed images found in temp folder for job ${jobId}`);
        }
        
        // Add each processed image to the ZIP
        for (let i = 0; i < processedImagePaths.length; i++) {
          const imagePath = processedImagePaths[i];
          const filename = path.basename(imagePath);
          
          // Read the file and add to archive
          const imageBuffer = await fs.readFile(imagePath);
          archive.append(imageBuffer, { name: `images/${filename}` });
          console.log(`📦 Added image ${i + 1}: ${filename} (${imageBuffer.length} bytes)`);
        }

        // Add metadata CSV if requested
        if (outputSettings.includeMetadata) {
          const csvContent = this.generateImageMetadataCSV(processedImages, metadata, outputSettings);
          archive.append(csvContent, { name: 'metadata.csv' });
          console.log(`📦 Added metadata.csv`);
        }

        console.log(`📦 Finalizing archive...`);
        archive.finalize();
      } catch (error) {
        console.error(`❌ Error in createImageZipFromTempFolder:`, error);
        reject(error);
      }
    });
  }

  /**
   * Generate metadata CSV for processed images (matching video format exactly)
   */
  private generateImageMetadataCSV(
    processedImages: Array<{ imageNumber: number; buffer: Buffer; originalName: string }>,
    metadata: any,
    outputSettings: OutputSettings
  ): string {
    const headers = [
      'filename',
      'image_number', 
      'original_width',
      'original_height',
      'output_width',
      'output_height',
      'timestamp',
      'file_size',
      'status'
    ];

    // Handle different output settings formats (same as video)
    let outputWidth, outputHeight;
    if (outputSettings.width && outputSettings.height) {
      outputWidth = outputSettings.width;
      outputHeight = outputSettings.height;
    } else if (outputSettings.size && typeof outputSettings.size === 'string' && outputSettings.size.includes('x')) {
      const [width, height] = outputSettings.size.split('x').map(Number);
      outputWidth = width;
      outputHeight = height;
    } else if (outputSettings.size === 'original') {
      outputWidth = metadata.width;
      outputHeight = metadata.height;
    } else {
      outputWidth = 512;
      outputHeight = 512;
    }
    
    const rows = processedImages.map(({ imageNumber, buffer, originalName }) => {
      // Generate filename like temp folder naming: image_XXX_original_name.jpg
      const paddedNumber = String(imageNumber + 1).padStart(3, '0');
      const baseOriginalName = originalName.replace(/\.[^.]+$/, ''); // Remove extension
      const filename = `image_${paddedNumber}_${baseOriginalName}.${outputSettings.format}`;
      const timestamp = new Date().toISOString();
      const isSuccessful = buffer.length > 0;
      const status = isSuccessful ? 'success' : 'failed';
      
      return [
        filename,
        imageNumber,
        metadata.width,
        metadata.height,
        outputWidth,
        outputHeight,
        timestamp,
        buffer.length,
        status
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  private createFrameBatches(totalFrames: number, batchSize: number) {
    const batches = [];
    for (let start = 0; start < totalFrames; start += batchSize) {
      const end = Math.min(start + batchSize - 1, totalFrames - 1);
      batches.push({ start, end });
    }
    return batches;
  }

  private async processBatchesInParallel(
    jobId: string,
    videoPath: string,
    batches: Array<{ start: number; end: number }>,
    maskData: MaskData,
    outputSettings: OutputSettings
  ) {
    console.log(`=== PROCESSING BATCHES ===`);
    console.log(`JobID: ${jobId}`);
    
    // Debug: Detailed mask data analysis
    console.log('\n🔍 DETAILED MASK DATA ANALYSIS:');
    console.log('================================');
    console.log('Mask type:', maskData.type);
    console.log('Coordinates:', maskData.coordinates);
    console.log('Has canvasDataUrl:', !!maskData.canvasDataUrl);
    console.log('Canvas data URL length:', maskData.canvasDataUrl?.length || 0);
    console.log('Canvas data URL starts with:', maskData.canvasDataUrl?.substring(0, 50) || 'N/A');
    console.log('Has imageDisplayInfo:', !!maskData.imageDisplayInfo);
    console.log('Has imageDimensions:', !!maskData.imageDimensions);
    console.log('Has originalCanvasDimensions:', !!maskData.originalCanvasDimensions);
    if (maskData.imageDisplayInfo) {
      console.log('Image display info:', maskData.imageDisplayInfo);
    }
    if (maskData.imageDimensions) {
      console.log('Image dimensions:', maskData.imageDimensions);
    }
    if (maskData.originalCanvasDimensions) {
      console.log('Canvas dimensions:', maskData.originalCanvasDimensions);
    }
    console.log('================================\n');
    
    console.log(`🔍 CRITICAL DEBUG - OUTPUT SETTINGS:`, JSON.stringify(outputSettings, null, 2));
    console.log(`🔍 aspectRatioMode from OUTPUT SETTINGS: "${outputSettings.aspectRatioMode}"`);
    console.log(`🔍 aspectRatioMode from MASK DATA: "${maskData.aspectRatioMode}"`);
    
    const processedFrames: Array<{ frameNumber: number; buffer: Buffer }> = [];
    const startTime = Date.now();
    let completedFrames = 0;

    // Parse output size - handle both new format (width/height) and old format (size)
    let outputSize;
    console.log('🔧 DEBUG: outputSettings format:', outputSettings);
    
    if (outputSettings.width && outputSettings.height) {
      // New format: direct width/height properties
      outputSize = {
        width: outputSettings.width,
        height: outputSettings.height
      };
      console.log('✅ Using direct width/height:', outputSize);
    } else if (outputSettings.size === 'custom') {
      // Old format: custom size
      outputSize = { 
        width: outputSettings.customWidth || 512, 
        height: outputSettings.customHeight || 512 
      };
      console.log('✅ Using custom size:', outputSize);
    } else if (outputSettings.size === 'original') {
      // Use original video dimensions - get from existing job
      const job = await storage.getVideoJob(jobId);
      outputSize = { 
        width: job?.width || 632, 
        height: job?.height || 1080 
      };
      console.log('✅ Using original video dimensions:', outputSize);
    } else if (outputSettings.size && typeof outputSettings.size === 'string' && outputSettings.size.includes('x')) {
      // Old format: size string like "640x480"
      const [width, height] = outputSettings.size.split('x').map(Number);
      outputSize = { width, height };
      console.log('✅ Parsed size string:', outputSize);
    } else {
      // Fallback to default size
      outputSize = { width: 512, height: 512 };
      console.log('⚠️ Using fallback size:', outputSize);
    }

    const batchPromises = batches.map(async (batch, batchIndex) => {
      try {
        // Extract frames for this batch
        const frameBuffers = await this.frameExtractor.extractFrameBatch(
          videoPath, 
          batch.start, 
          batch.end
        );

        // OPTIMIZED BATCH PROCESSING: Reduced batch size for better memory management  
        const VOLUME_BATCH_SIZE = 8; // Reduced from 20 to 8 for better performance
        const batchResults = [];
        
        console.log(`🏗️ Processing ${frameBuffers.length} frames using volumetric batching (${VOLUME_BATCH_SIZE} frame volumes)`);
        
        // Split frames into volumetric batches of 20
        for (let volumeStart = 0; volumeStart < frameBuffers.length; volumeStart += VOLUME_BATCH_SIZE) {
          const volumeEnd = Math.min(volumeStart + VOLUME_BATCH_SIZE, frameBuffers.length);
          const volumeFrameBuffers = frameBuffers.slice(volumeStart, volumeEnd);
          
          console.log(`📦 Processing volume batch: frames ${volumeStart}-${volumeEnd-1} (${volumeFrameBuffers.length} frames)`);
          
          // Use the outputSize that was already correctly calculated above
          let actualOutputSize = outputSize;
          console.log(`📐 Using pre-calculated output dimensions: ${actualOutputSize.width}x${actualOutputSize.height}`);

          // CRITICAL DEBUG: Verify outputSize is valid before processing
          console.log(`🔍 DEBUG: Final outputSize before processing: ${actualOutputSize.width}x${actualOutputSize.height}`);
          if (actualOutputSize.width <= 0 || actualOutputSize.height <= 0) {
            console.error(`❌ CRITICAL ERROR: Invalid outputSize detected before processing!`);
            console.error(`   outputSettings.size: ${outputSettings.size}`);
            console.error(`   Original outputSize: ${outputSize.width}x${outputSize.height}`);
            console.error(`   Actual outputSize: ${actualOutputSize.width}x${actualOutputSize.height}`);
            throw new Error(`Invalid output dimensions: ${actualOutputSize.width}x${actualOutputSize.height}`);
          }

          // Create volume processing tasks
          const volumeTasks = volumeFrameBuffers.map((frameBuffer, index) => ({
            frameBuffer,
            maskData,
            outputSize: actualOutputSize,
            outputSettings,
            frameNumber: batch.start + volumeStart + index
          }));
          
          // Process entire volume simultaneously (3D mask application)
          const volumeResults = await this.processFrameBatch(volumeTasks);
          
          // Force garbage collection after each volume to prevent memory buildup
          if (global.gc) {
            global.gc();
          }
          
          // Update completion tracking
          completedFrames += volumeResults.length;
          
          // Calculate and update progress with volumetric processing stats
          const totalFrames = batches.reduce((sum, b) => sum + (b.end - b.start + 1), 0);
          const progress = 10 + (completedFrames / totalFrames) * 80; // 10-90% for processing
          const elapsed = (Date.now() - startTime) / 1000;
          const fps = completedFrames / elapsed;
          const eta = (totalFrames - completedFrames) / fps;

          console.log(`⚡ Volumetric batch complete: ${volumeResults.length} frames processed at ${fps.toFixed(1)} FPS`);

          await this.updateProgress(jobId, {
            progress: Math.min(progress, 90),
            currentFrame: completedFrames,
            fps: parseFloat(fps.toFixed(1)),
            eta: Math.ceil(eta)
          });

          batchResults.push(...volumeResults);
        }

        // Update batch status
        await storage.updateFrameBatch(
          batches.find(b => b.start === batch.start)?.toString() || '', 
          { 
            status: 'completed', 
            processedAt: new Date().toISOString() 
          }
        );

        return batchResults;

      } catch (error) {
        console.error(`Error processing batch ${batchIndex}:`, error);
        throw error;
      }
    });

    const allBatchResults = await Promise.all(batchPromises);
    
    // Flatten results and sort by frame number - INCLUDE ALL FRAMES FOR CSV
    allBatchResults.forEach((batchResults, batchIndex) => {
      console.log(`Batch ${batchIndex} returned ${batchResults.length} results`);
      batchResults.forEach(result => {
        if (result.success) {
          console.log(`Frame ${result.frameNumber} processed successfully (${result.processedBuffer.length} bytes)`);
          processedFrames.push({
            frameNumber: result.frameNumber,
            buffer: result.processedBuffer
          });
        } else {
          console.log(`Frame ${result.frameNumber} failed: ${result.error}`);
          // Create placeholder buffer for failed frames to maintain CSV completeness
          processedFrames.push({
            frameNumber: result.frameNumber,
            buffer: Buffer.alloc(0) // Empty buffer as placeholder
          });
        }
      });
    });
    
    console.log(`Total processed frames: ${processedFrames.length}`);

    return processedFrames.sort((a, b) => a.frameNumber - b.frameNumber);
  }

  private async createOutputZip(
    jobId: string,
    processedFrames: Array<{ frameNumber: number; buffer: Buffer }>,
    metadata: any,
    outputSettings: OutputSettings
  ): Promise<string> {
    const zipFilename = `processed_frames_${jobId}.zip`;
    const zipPath = path.join(this.outputDir, zipFilename);

    console.log(`📦 Creating ZIP at: ${zipPath}`);
    console.log(`📦 Output directory: ${this.outputDir}`);

    return new Promise((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        console.log(`✅ ZIP created successfully: ${zipPath} (${archive.pointer()} bytes)`);
        resolve(zipPath);
      });

      output.on('error', (err: Error) => {
        console.error(`❌ Output stream error:`, err);
        reject(err);
      });

      archive.on('error', (err: Error) => {
        console.error(`❌ Archive error:`, err);
        reject(err);
      });

      archive.on('warning', (err: Error) => {
        console.warn(`⚠️ Archive warning:`, err);
      });

      archive.pipe(output);

      // Add processed frames in a frames folder - only include successful frames in ZIP
      const successfulFrames = processedFrames.filter(frame => frame.buffer.length > 0);
      console.log(`📦 Found ${successfulFrames.length} successful frames (${processedFrames.length} total attempted)`);
      
      if (successfulFrames.length === 0) {
        console.warn(`⚠️ No successful frames to add to ZIP for job ${jobId}`);
      }
      
      successfulFrames.forEach(({ frameNumber, buffer }) => {
        const filename = `frames/frame_${String(frameNumber).padStart(6, '0')}.${outputSettings.format}`;
        console.log(`📦 Adding frame ${frameNumber} (${buffer.length} bytes) as ${filename}`);
        archive.append(buffer, { name: filename });
      });

      // Add metadata CSV if requested
      if (outputSettings.includeMetadata) {
        const csvContent = this.generateMetadataCSV(processedFrames, metadata, outputSettings);
        archive.append(csvContent, { name: 'metadata.csv' });
        console.log(`📦 Added metadata.csv`);
      }

      console.log(`📦 Finalizing archive...`);
      archive.finalize();
    });
  }

  private generateMetadataCSV(
    processedFrames: Array<{ frameNumber: number; buffer: Buffer }>,
    metadata: any,
    outputSettings: OutputSettings
  ): string {
    const headers = [
      'filename',
      'frame_number',
      'original_width',
      'original_height',
      'output_width',
      'output_height',
      'timestamp',
      'file_size',
      'status'
    ];

    // Handle different output settings formats
    let outputWidth, outputHeight;
    if (outputSettings.width && outputSettings.height) {
      outputWidth = outputSettings.width;
      outputHeight = outputSettings.height;
    } else if (outputSettings.size && typeof outputSettings.size === 'string' && outputSettings.size.includes('x')) {
      const [width, height] = outputSettings.size.split('x').map(Number);
      outputWidth = width;
      outputHeight = height;
    } else {
      outputWidth = 512;
      outputHeight = 512;
    }
    
    const rows = processedFrames.map(({ frameNumber, buffer }) => {
      const filename = `frame_${String(frameNumber).padStart(6, '0')}.${outputSettings.format}`;
      const timestamp = new Date().toISOString();
      const isSuccessful = buffer.length > 0;
      const status = isSuccessful ? 'success' : 'failed';
      
      return [
        filename,
        frameNumber,
        metadata.width,
        metadata.height,
        outputWidth,
        outputHeight,
        timestamp,
        buffer.length,
        status
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  private async updateProgress(jobId: string, progress: Partial<ProcessingProgress>) {
    await storage.updateProcessingProgress(jobId, progress);
    
    // Emit progress update via WebSocket
    this.io.emit('progress', { jobId, ...progress });
    
    // Log progress for monitoring
    if (progress.stage === 'extracting') {
      console.log(`📊 EXTRACTION PROGRESS: ${progress.extractionProgress?.toFixed(1)}% - ${progress.status}`);
    }
  }

  async cleanup() {
    await this.frameExtractor.cleanup();
  }

  // 🚀 NEW: Background frame extraction immediately after upload
  async startBackgroundFrameExtraction(jobId: string, videoPath: string, totalFrames: number): Promise<void> {
    try {
      console.log(`🚀 BACKGROUND EXTRACTION STARTED: JobID ${jobId}, ${totalFrames} frames`);
      
      // Update job status to indicate background extraction is starting
      await storage.updateVideoJob(jobId, { status: 'extracting' });
      await this.updateProgress(jobId, {
        stage: 'extracting',
        currentFrame: 0,
        totalFrames,
        extractionProgress: 0,
        status: 'Background frame extraction in progress'
      });
      
      // Create batches for parallel extraction (10-20 frames per batch as specified)
      const batchSize = 15; // Optimal batch size for memory management
      const batches = [];
      for (let i = 0; i < totalFrames; i += batchSize) {
        const end = Math.min(i + batchSize - 1, totalFrames - 1);
        batches.push({ start: i, end });
      }
      
      console.log(`📋 Created ${batches.length} batches of ~${batchSize} frames each`);
      
      // Extract all frames in parallel batches
      let extractedFrames = 0;
      const frameStore = new Map<number, Buffer>(); // Store extracted frames
      
      for (const batch of batches) {
        try {
          console.log(`🗢️ Extracting batch: frames ${batch.start}-${batch.end}`);
          const batchFrames = await this.frameExtractor.extractFrameBatch(
            videoPath, 
            batch.start, 
            batch.end
          );
          
          // Store frames with their frame numbers
          batchFrames.forEach((frameBuffer, index) => {
            const frameNumber = batch.start + index;
            frameStore.set(frameNumber, frameBuffer);
          });
          
          extractedFrames += batchFrames.length;
          const progress = (extractedFrames / totalFrames) * 100;
          
          // Update progress
          await this.updateProgress(jobId, {
            stage: 'extracting',
            currentFrame: extractedFrames,
            totalFrames,
            extractionProgress: progress,
            status: `Extracted ${extractedFrames}/${totalFrames} frames (${progress.toFixed(1)}%)`
          });
          
          console.log(`✅ Batch complete: ${extractedFrames}/${totalFrames} frames (${progress.toFixed(1)}%)`);
          
        } catch (batchError) {
          console.error(`❌ Batch extraction failed:`, batchError);
          // Continue with other batches rather than failing completely
        }
      }
      
      // Store extracted frames for later use (avoid re-extraction)
      (global as any).extractedFrames = (global as any).extractedFrames || new Map();
      (global as any).extractedFrames.set(jobId, frameStore);
      
      console.log(`🎉 BACKGROUND EXTRACTION COMPLETE: ${extractedFrames} frames extracted and stored`);
      
      // Update job status to ready for masking
      await storage.updateVideoJob(jobId, { status: 'ready' });
      await this.updateProgress(jobId, {
        stage: 'ready',
        currentFrame: extractedFrames,
        totalFrames,
        extractionProgress: 100,
        status: `Ready for masking - ${extractedFrames} frames extracted`
      });
      
    } catch (error) {
      console.error(`❌ Background extraction failed for job ${jobId}:`, error);
      await storage.updateVideoJob(jobId, { status: 'error' });
      await this.updateProgress(jobId, {
        stage: 'error',
        status: `Background extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  }

  /**
   * BATCH VOLUMETRIC PROCESSING: Process multiple frames simultaneously as 3D volume
   * Loads 20 frames into a 3D buffer, applies mask transformation to entire volume,
   * then outputs individual 2D frames. Target: 40-50 FPS instead of 4 FPS.
   */
  private async processFrameBatch(tasks: Array<{
    frameBuffer: Buffer;
    maskData: MaskData;
    outputSize: { width: number; height: number };
    outputSettings: OutputSettings;
    frameNumber: number;
  }>): Promise<Array<{ success: boolean; processedBuffer: Buffer; error?: string; frameNumber: number }>> {
    try {
      console.log(`🏗️ BATCH VOLUMETRIC PROCESSING: Processing ${tasks.length} frames as 3D volume`);
      
      // CRITICAL DEBUG: Check what outputSize each task received
      tasks.forEach((task, index) => {
        console.log(`🔍 Task ${index} dimensions: ${task.outputSize.width}x${task.outputSize.height} (frame ${task.frameNumber})`);
        if (task.outputSize.width <= 0 || task.outputSize.height <= 0) {
          console.error(`❌ INVALID TASK DIMENSIONS: Task ${index} has invalid outputSize: ${task.outputSize.width}x${task.outputSize.height}`);
        }
      });
      
      const batchStart = Date.now();
      
      // Step 1: Load all frames into 3D buffer (stack frames vertically)
      console.log('📚 Loading frames into 3D volume buffer...');
      const frameBuffers: Buffer[] = [];
      const frameMetadata: Array<{ width: number; height: number; channels: number }> = [];
      
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const image = Sharp(task.frameBuffer);
        const metadata = await image.metadata();
        const frameRgb = await image.raw().toBuffer({ resolveWithObject: true });
        
        frameBuffers.push(frameRgb.data);
        frameMetadata.push({
          width: metadata.width || 1920,
          height: metadata.height || 1080,
          channels: frameRgb.info.channels as 1 | 2 | 3 | 4
        });
        
        if (i === 0) {
          console.log(`📐 Volume dimensions: ${frameMetadata[0].width}x${frameMetadata[0].height}x${tasks.length} (WxHxD)`);
        }
      }
      
      // Step 2: Create single mask for the entire volume (reuse same coordinates)
      const firstTask = tasks[0];
      const volumeWidth = frameMetadata[0].width;
      const volumeHeight = frameMetadata[0].height;
      const volumeDepth = tasks.length;
      
      console.log('🎭 Creating volumetric mask for entire batch...');
      const maskRgba = await this.createMaskRgbaBuffer(firstTask.maskData, volumeWidth, volumeHeight);
      console.log(`🎭 Mask created: ${maskRgba.length} bytes, will be applied to ${volumeDepth} layers`);
      
      // Step 3: Apply mask transformation to entire 3D volume simultaneously  
      console.log('⚡ Applying volumetric mask transformation...');
      const processedFrames: Buffer[] = [];
      const imageChannels = frameMetadata[0].channels;
      const pixelsPerFrame = (volumeWidth * volumeHeight);
      
      // Process all frames in parallel using the same mask
      const volumeProcessingPromises = frameBuffers.map(async (framePixels, frameIndex) => {
        const frameNumber = tasks[frameIndex].frameNumber;
        let maskedPixels = 0;
        
        // Apply the same mask to this frame layer
        for (let i = 0; i < pixelsPerFrame; i++) {
          const maskAlpha = maskRgba[i * 4 + 3]; // Get mask alpha
          
          if (maskAlpha > 0) {
            const pixelIndex = i * imageChannels;
            framePixels[pixelIndex] = 0;     // Red = 0 (black)
            framePixels[pixelIndex + 1] = 0; // Green = 0 (black) 
            framePixels[pixelIndex + 2] = 0; // Blue = 0 (black)
            maskedPixels++;
          }
        }
        
        console.log(`🎯 Frame ${frameNumber}: ${maskedPixels}/${pixelsPerFrame} pixels masked (${((maskedPixels/pixelsPerFrame)*100).toFixed(2)}%)`);
        
        // Step 4: Use Sharp pipeline for optimized output generation
        const outputSettings = tasks[frameIndex].outputSettings;
        const outputSize = tasks[frameIndex].outputSize;
        
        let processedImage = Sharp(framePixels, {
          raw: {
            width: volumeWidth,
            height: volumeHeight,
            channels: imageChannels as 1 | 2 | 3 | 4
          }
        });
        
        // CORRECTED 3D PIPELINE: Apply aspect ratio first, then output size
        // OUTPUT SETTINGS TAKE ABSOLUTE PRIORITY over mask data
        const aspectMode = outputSettings.aspectRatioMode || 'letterbox';
        console.log(`📐 3D Pipeline: Applying aspect ratio mode: ${aspectMode} for frame ${frameNumber} (from output settings)`);
        
        // Configure resize options based on aspect ratio mode first
        let resizeOptions: any = { kernel: 'lanczos3' };
        switch (aspectMode) {
          case 'stretch':
            resizeOptions.fit = 'fill';
            break;
          case 'letterbox':
            resizeOptions.fit = 'contain';
            resizeOptions.background = { r: 0, g: 0, b: 0, alpha: 1 };
            break;
          case 'crop':
            resizeOptions.fit = 'cover';
            break;
          default:
            resizeOptions.fit = 'contain';
            resizeOptions.background = { r: 0, g: 0, b: 0, alpha: 1 };
        }
        
        // Apply resize with aspect ratio preservation if size is different
        if (outputSize.width > 0 && outputSize.height > 0 && 
            (outputSize.width !== volumeWidth || outputSize.height !== volumeHeight)) {
          processedImage = processedImage.resize(outputSize.width, outputSize.height, resizeOptions);
          console.log(`📐 3D Frame ${frameNumber}: ${volumeWidth}x${volumeHeight} → ${outputSize.width}x${outputSize.height} (${aspectMode} mode)`);
        } else {
          console.log(`📐 3D Frame ${frameNumber}: Keeping original dimensions ${volumeWidth}x${volumeHeight}`);
        }
        
        // Convert to final format
        const outputBuffer = await processedImage
          .jpeg({ quality: 90 })
          .toBuffer();
          
        return {
          success: true,
          processedBuffer: outputBuffer,
          frameNumber: frameNumber
        };
      });
      
      // Wait for all frames in the batch to complete
      const results = await Promise.all(volumeProcessingPromises);
      
      const batchTime = Date.now() - batchStart;
      const fps = (tasks.length / batchTime) * 1000;
      console.log(`🚀 BATCH COMPLETE: ${tasks.length} frames in ${batchTime}ms (${fps.toFixed(1)} FPS)`);
      
      return results;
      
    } catch (error) {
      console.error('❌ Batch volumetric processing failed:', error);
      // Return individual failures for each frame
      return tasks.map(task => ({
        success: false,
        processedBuffer: Buffer.alloc(0),
        error: error instanceof Error ? error.message : 'Unknown error',
        frameNumber: task.frameNumber
      }));
    }
  }

  private async processFrame(task: {
    frameBuffer: Buffer;
    maskData: MaskData;
    outputSize: { width: number; height: number };
    outputSettings: OutputSettings;
    frameNumber: number;
  }) {
    try {
      const { frameBuffer, maskData, outputSize, outputSettings, frameNumber } = task;

      // Load the frame image
      let image = Sharp(frameBuffer);
      
      // DEBUGGING: Export frame #1 without processing for comparison
      if (frameNumber === 0) {
        const unprocessedBuffer = await image.png().toBuffer();
        const fs = await import('fs');
        const path = await import('path');
        const debugPath = path.join('output', `debug_frame_${frameNumber}_original.png`);
        await fs.promises.writeFile(debugPath, unprocessedBuffer);
        console.log('🔍 SAVED UNPROCESSED FRAME:', debugPath);
      }
      
      // Get image metadata to calculate mask coordinates
      const metadata = await image.metadata();
      const originalWidth = metadata.width || 1920;
      const originalHeight = metadata.height || 1080;
      
      console.log(`🔍 Frame ${frameNumber}: ${originalWidth}x${originalHeight}`);
      
      // Move validation after coordinate calculation
      // (Will be added after pixelCoords is defined)
      
      console.log('🎯 MASK-THEN-RESIZE WORKFLOW: Apply mask at original dimensions, then resize to output');

      // Apply mask using corrected pixel manipulation
      console.log('🎭 APPLYING MASK TO FRAME:', frameNumber);
      console.log('🎭 Mask coordinates:', maskData.coordinates);
      console.log('🎭 Frame dimensions:', originalWidth, 'x', originalHeight);
      
      // NEW ARCHITECTURE: Direct pixel coordinates - no transformation needed!
      console.log('🎯 USING ABSOLUTE PIXEL COORDINATES - No transformation required!');
      
      let pixelCoords;
      if (!Array.isArray(maskData.coordinates) && typeof maskData.coordinates === 'object' && 'x' in maskData.coordinates) {
        // New format: absolute pixel coordinates {x, y, width, height}
        const coords = maskData.coordinates as { x: number; y: number; width: number; height: number };
        pixelCoords = {
          x: coords.x,
          y: coords.y,
          width: coords.width,
          height: coords.height
        };
        console.log('✅ Direct pixel coordinates:', pixelCoords);
      } else {
        // Legacy format fallback: normalized coordinates [x, y, w, h]
        const coords = Array.isArray(maskData.coordinates) ? maskData.coordinates : [0, 0, 0.1, 0.1];
        const defaultWidth = 100;
        const defaultHeight = 100;
        pixelCoords = {
          x: Math.floor(coords[0] * originalWidth),
          y: Math.floor(coords[1] * originalHeight),
          width: Math.floor(coords[2] * originalWidth) || defaultWidth,
          height: Math.floor(coords[3] * originalHeight) || defaultHeight
        };
        console.log('⚠️ Legacy coordinate transform:', coords, '->', pixelCoords);
      }
      
      // VALIDATION: Check that mask coordinates are within frame bounds
      if (pixelCoords.x < 0 || pixelCoords.y < 0 || 
          pixelCoords.x + pixelCoords.width > originalWidth ||
          pixelCoords.y + pixelCoords.height > originalHeight) {
        console.log('⚠️ WARNING: Mask coordinates exceed frame bounds!');
        console.log('Frame:', originalWidth, 'x', originalHeight);
        console.log('Mask:', pixelCoords);
        
        // Clamp coordinates to frame bounds
        pixelCoords.x = Math.max(0, Math.min(pixelCoords.x, originalWidth - 1));
        pixelCoords.y = Math.max(0, Math.min(pixelCoords.y, originalHeight - 1));
        pixelCoords.width = Math.max(1, Math.min(pixelCoords.width, originalWidth - pixelCoords.x));
        pixelCoords.height = Math.max(1, Math.min(pixelCoords.height, originalHeight - pixelCoords.y));
        console.log('🔧 Clamped coordinates:', pixelCoords);
      }
      
      // DIMENSION VALIDATION: Ensure all frames have identical dimensions
      if (frameNumber === 0) {
        console.log('🎯 REFERENCE FRAME DIMENSIONS SET:', originalWidth, 'x', originalHeight);
        // Store reference dimensions for validation
        (global as any).referenceDimensions = { width: originalWidth, height: originalHeight };
      } else {
        const ref = (global as any).referenceDimensions;
        if (ref && (ref.width !== originalWidth || ref.height !== originalHeight)) {
          throw new Error(`Frame dimension mismatch! Frame 0: ${ref.width}x${ref.height}, Frame ${frameNumber}: ${originalWidth}x${originalHeight}`);
        }
      }
      
      console.log(`Processing frame ${frameNumber} with mask:`, maskData.type, maskData.coordinates);
      
      // Convert image to RGB for processing (following working prototype approach)
      const frameRgb = await image.raw().toBuffer({ resolveWithObject: true });
      const { data: framePixels, info: frameInfo } = frameRgb;
      
      // Create mask overlay using correct dimensions
      console.log(`🔧 Creating mask buffer for frame ${frameNumber}: ${originalWidth}x${originalHeight}`);
      const maskRgba = await this.createMaskRgbaBuffer(maskData, originalWidth, originalHeight);
      console.log(`🔧 Mask buffer created: ${maskRgba.length} bytes (${maskRgba.length/4} pixels)`);
      
      // Apply mask by blackening detected areas (following working prototype approach)
      let maskedPixels = 0;
      const imageChannels = frameInfo.channels; // Should be 3 for RGB
      const totalPixels = framePixels.length / imageChannels;
      
      console.log(`Frame processing: ${totalPixels} pixels, ${imageChannels} channels`);
      
      let firstMaskedPixel = -1;
      let sampleMaskValues = [];
      
      for (let i = 0; i < totalPixels; i++) {
        const maskAlpha = maskRgba[i * 4 + 3]; // Get mask alpha from RGBA mask
        const maskRed = maskRgba[i * 4];       // Get mask red channel
        
        // Sample first 10 mask values for debugging
        if (sampleMaskValues.length < 10) {
          sampleMaskValues.push({ i, alpha: maskAlpha, red: maskRed });
        }
        
        // DEBUGGING: Check blending mode and verify mask application
        const maskGreen = maskRgba[i * 4 + 1]; // Green channel  
        const maskBlue = maskRgba[i * 4 + 2];  // Blue channel
        
        // Log first few mask applications for verification
        if (maskedPixels < 5 && maskAlpha > 0) {
          console.log(`🔍 MASK PIXEL ${maskedPixels}: Alpha=${maskAlpha}, RGB=(${maskRed},${maskGreen},${maskBlue})`);
        }
        
        // If mask is opaque (maskAlpha > 0), blacken the frame pixel (areas you drew)
        // If mask is transparent (maskAlpha = 0), keep frame pixel unchanged (preserve original)
        if (maskAlpha > 0) {
          if (firstMaskedPixel === -1) {
            firstMaskedPixel = i;
            console.log(`🎯 First masked pixel at index ${i} (alpha: ${maskAlpha}, red: ${maskRed})`);
          }
          
          const pixelIndex = i * imageChannels;
          // EXTREME BLACKENING: Ensure visibility
          framePixels[pixelIndex] = 0;     // Red = 0 (black)
          framePixels[pixelIndex + 1] = 0; // Green = 0 (black) 
          framePixels[pixelIndex + 2] = 0; // Blue = 0 (black)
          maskedPixels++;
          
          // DEBUGGING: Verify pixel was actually changed
          if (maskedPixels === 1) {
            console.log(`🎯 FIRST PIXEL MASKED: Index ${i}, RGB now (${framePixels[pixelIndex]},${framePixels[pixelIndex + 1]},${framePixels[pixelIndex + 2]})`);
          }
        }
      }
      
      console.log(`🔍 Sample mask values:`, sampleMaskValues);
      console.log(`🔍 First masked pixel index: ${firstMaskedPixel}`);
      
      console.log('🎭 MASK APPLIED - checking result...');
      console.log(`🎯 MASK APPLICATION RESULT:`);
      console.log(`   Total pixels: ${totalPixels}`);
      console.log(`   Masked pixels: ${maskedPixels}`);
      console.log(`   Mask coverage: ${((maskedPixels/totalPixels)*100).toFixed(2)}%`);
      console.log(`   Status: ${maskedPixels > 0 ? '✅ MASK APPLIED' : '❌ NO MASK APPLIED'}`);
      
      // OPTIMIZED SHARP PIPELINE: Create image from modified pixels
      console.log('⚡ Building optimized Sharp pipeline: mask → resize → save');
      let processedImage = Sharp(framePixels, {
        raw: {
          width: originalWidth,
          height: originalHeight,
          channels: imageChannels
        }
      });

      // CORRECTED PIPELINE: Apply aspect ratio FIRST, then handle output size
      // OUTPUT SETTINGS TAKE ABSOLUTE PRIORITY over mask data
      const aspectMode = outputSettings.aspectRatioMode || 'letterbox';
      console.log(`⚡ Pipeline: Applying aspect ratio mode: ${aspectMode} (from output settings, ignoring mask data)`);
      
      // Step 1: Apply aspect ratio handling first
      let resizeOptions: any = {};
      switch (aspectMode) {
        case 'stretch':
          resizeOptions = { fit: 'fill' };
          break;
        case 'letterbox':
          resizeOptions = { 
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 1 }
          };
          break;
        case 'crop':
          resizeOptions = { fit: 'cover' };
          break;
        default:
          resizeOptions = { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } };
      }

      // Step 2: Apply output size with aspect ratio preservation
      if (outputSettings.size !== 'original' && outputSize.width > 0 && outputSize.height > 0) {
        console.log(`⚡ Pipeline resize: ${originalWidth}x${originalHeight} → ${outputSize.width}x${outputSize.height} (${aspectMode} mode)`);
        processedImage = processedImage.resize(outputSize.width, outputSize.height, resizeOptions);
      } else {
        console.log('⚡ Pipeline: Original size - no resize needed');
      }

      // PIPELINE STEP 3: Convert to PNG and output
      console.log('⚡ Pipeline final step: Converting to PNG buffer');
      const processedBuffer = await processedImage.png().toBuffer();
      
      // DEBUGGING: Export processed frame #1 for comparison
      if (frameNumber === 0) {
        const fs = await import('fs');
        const path = await import('path');
        const debugPath = path.join('output', `debug_frame_${frameNumber}_processed.png`);
        await fs.promises.writeFile(debugPath, processedBuffer);
        console.log('🔍 SAVED PROCESSED FRAME:', debugPath);
        
        // Also save the mask buffer as an image for inspection
        const maskDebugBuffer = await Sharp(maskRgba, {
          raw: {
            width: originalWidth,
            height: originalHeight,
            channels: 4 // RGBA
          }
        }).png().toBuffer();
        const maskDebugPath = path.join('output', `debug_frame_${frameNumber}_mask.png`);
        await fs.promises.writeFile(maskDebugPath, maskDebugBuffer);
        console.log('🔍 SAVED MASK VISUALIZATION:', maskDebugPath);
      }

      return {
        frameNumber,
        processedBuffer,
        success: true
      };
    } catch (error) {
      return {
        frameNumber: task.frameNumber,
        processedBuffer: Buffer.alloc(0),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown processing error'
      };
    }
  }

  private async createMaskRgbaBuffer(maskData: MaskData, width: number, height: number): Promise<Buffer> {
    // Debug: Log what mask data we received
    console.log('\n🔍 MASK DATA ANALYSIS:');
    console.log('=======================');
    console.log('Has canvasDataUrl:', !!maskData.canvasDataUrl);
    console.log('Canvas data URL length:', maskData.canvasDataUrl?.length || 0);
    console.log('Canvas data URL starts with:', maskData.canvasDataUrl?.substring(0, 50) || 'N/A');
    console.log('Mask type:', maskData.type);
    console.log('Has imageDisplayInfo:', !!maskData.imageDisplayInfo);
    console.log('Has imageDimensions:', !!maskData.imageDimensions);
    console.log('Coordinates:', maskData.coordinates);
    console.log('=======================\n');
    
    // Check if we have base64 canvas data (preferred method from previous version)
    if (maskData.canvasDataUrl) {
      console.log('✓ Using base64 canvas mask (red color detection approach)');
      console.log('Canvas data URL length:', maskData.canvasDataUrl.length);
      // DIMENSION VALIDATION before mask creation
      if (width <= 0 || height <= 0) {
        console.error(`❌ Invalid dimensions for mask creation: ${width}x${height}`);
        throw new Error(`Invalid mask dimensions: ${width}x${height}`);
      }
      
      console.log('🔧 About to call createMaskFromBase64 with dimensions:', width, 'x', height);
      const maskBuffer = await this.createMaskFromBase64(maskData.canvasDataUrl, width, height, maskData);
      console.log('🔧 createMaskFromBase64 returned buffer of size:', maskBuffer.length);
      return maskBuffer;
    }
    
    // Fallback to percentage-based coordinates
    console.log('⚠️ Using percentage-based mask (fallback approach) - no canvas data');
    const pixelCount = width * height;
    const maskBuffer = Buffer.alloc(pixelCount * 4); // RGBA
    
    // Fill with transparent black (0,0,0,0) - areas outside mask
    maskBuffer.fill(0);
    
    // Calculate mask opacity
    const opacity = Math.floor((maskData.opacity / 100) * 255);
    const coordsDisplay = Array.isArray(maskData.coordinates) ? maskData.coordinates.join(', ') : 'object';
    console.log(`Creating mask: ${maskData.type}, opacity: ${maskData.opacity}% -> ${opacity}, coordinates: [${coordsDisplay}]`);
    
    // Apply mask based on type
    switch (maskData.type) {
      case 'rectangle':
        // Handle both array and object coordinate formats
        let xPct: number, yPct: number, wPct: number, hPct: number;
        if (Array.isArray(maskData.coordinates)) {
          [xPct, yPct, wPct, hPct] = maskData.coordinates;
        } else {
          const coords = maskData.coordinates as { x: number; y: number; width: number; height: number };
          xPct = coords.x;
          yPct = coords.y;
          wPct = coords.width;
          hPct = coords.height;
        }
        
        // Ensure coordinates are valid percentages
        if (xPct < 0 || xPct > 1 || yPct < 0 || yPct > 1 || wPct <= 0 || hPct <= 0) {
          console.log(`Invalid mask coordinates: ${xPct}, ${yPct}, ${wPct}, ${hPct}`);
          // Create a center rectangle for testing if coordinates are invalid
          const centerX = Math.floor(width * 0.25);
          const centerY = Math.floor(height * 0.25);
          const centerW = Math.floor(width * 0.5);
          const centerH = Math.floor(height * 0.5);
          
          for (let py = centerY; py < centerY + centerH && py < height; py++) {
            for (let px = centerX; px < centerX + centerW && px < width; px++) {
              const pixelIndex = (py * width + px) * 4;
              maskBuffer[pixelIndex] = 255;     // R
              maskBuffer[pixelIndex + 1] = 255; // G
              maskBuffer[pixelIndex + 2] = 255; // B
              maskBuffer[pixelIndex + 3] = opacity; // A
            }
          }
          console.log(`Created fallback center mask`);
          break;
        }
        
        const x = Math.floor(xPct * width);
        const y = Math.floor(yPct * height);
        const w = Math.floor(wPct * width);
        const h = Math.floor(hPct * height);
        
        console.log(`Rectangle mask: ${xPct}, ${yPct}, ${wPct}, ${hPct} -> ${x}, ${y}, ${w}, ${h} on ${width}x${height}`);
        
        let maskedPixels = 0;
        for (let py = y; py < y + h && py < height; py++) {
          for (let px = x; px < x + w && px < width; px++) {
            const pixelIndex = (py * width + px) * 4;
            maskBuffer[pixelIndex] = 255;     // R
            maskBuffer[pixelIndex + 1] = 255; // G
            maskBuffer[pixelIndex + 2] = 255; // B
            maskBuffer[pixelIndex + 3] = opacity; // A
            maskedPixels++;
          }
        }
        console.log(`Rectangle mask created with ${maskedPixels} opaque pixels`);
        break;
        
      case 'circle':
        // Handle both array and object coordinate formats for circle
        let cxPct: number, cyPct: number, radiusPct: number;
        if (Array.isArray(maskData.coordinates)) {
          [cxPct, cyPct, radiusPct] = maskData.coordinates;
        } else {
          // For circle, coordinates object should have x, y as center and width as diameter
          const coords = maskData.coordinates as { x: number; y: number; width: number; height: number };
          cxPct = coords.x + coords.width / 2; // Center x
          cyPct = coords.y + coords.height / 2; // Center y
          radiusPct = Math.min(coords.width, coords.height) / 2; // Radius
        }
        const cx = cxPct * width;
        const cy = cyPct * height;
        const radius = radiusPct * Math.min(width, height);
        
        for (let py = 0; py < height; py++) {
          for (let px = 0; px < width; px++) {
            const distance = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
            if (distance <= radius) {
              const pixelIndex = (py * width + px) * 4;
              maskBuffer[pixelIndex] = 255;     // R
              maskBuffer[pixelIndex + 1] = 255; // G
              maskBuffer[pixelIndex + 2] = 255; // B
              maskBuffer[pixelIndex + 3] = opacity; // A
            }
          }
        }
        break;
        
      default:
        // Default to full frame mask
        for (let i = 0; i < pixelCount; i++) {
          const pixelIndex = i * 4;
          maskBuffer[pixelIndex] = 255;     // R
          maskBuffer[pixelIndex + 1] = 255; // G
          maskBuffer[pixelIndex + 2] = 255; // B
          maskBuffer[pixelIndex + 3] = opacity; // A
        }
    }
    
    console.log(`Generated RGBA mask buffer: ${width}x${height}, opacity: ${opacity}`);
    return maskBuffer;
  }

  // Improved function implementing coordinate transformation and red color detection
  private async createMaskFromBase64(
    canvasDataUrl: string, 
    frameWidth: number, 
    frameHeight: number,
    maskData?: MaskData
  ): Promise<Buffer> {
    try {
      // Extract and validate base64 data (following working prototype)
      if (!canvasDataUrl || typeof canvasDataUrl !== 'string') {
        throw new Error('Invalid canvas data URL');
      }

      if (!canvasDataUrl.startsWith('data:image/')) {
        throw new Error('Invalid data URL format');
      }

      const parts = canvasDataUrl.split(',');
      if (parts.length !== 2 || !parts[0].includes('base64')) {
        throw new Error('Could not extract base64 data');
      }

      const base64Data = parts[1];
      const maskBuffer = Buffer.from(base64Data, 'base64');
      
      // Get canvas dimensions for transformation calculation
      let canvasWidth = frameWidth;
      let canvasHeight = frameHeight;
      
      if (maskData?.originalCanvasDimensions) {
        canvasWidth = maskData.originalCanvasDimensions.width;
        canvasHeight = maskData.originalCanvasDimensions.height;
      }
      
      // Calculate transformation matrix for coordinate alignment
      let transformationMatrix: TransformationMatrix | null = null;
      if (maskData) {
        transformationMatrix = this.calculateTransformationMatrix({
          maskData,
          frameWidth,
          frameHeight,
          outputWidth: frameWidth,
          outputHeight: frameHeight
        });
        console.log('Transformation matrix:', transformationMatrix);
      }
      
      // Apply coordinate transformation during scaling with detailed tracking
      let maskRaw: Buffer;
      let maskChannels: number;
      
      if (maskData?.imageDisplayInfo && maskData?.imageDimensions) {
        this.logCoordinateTransformation('🎯 MASK SCALING WITH COORDINATE TRANSFORMATION', {
          scalingApproach: 'Two-step transformation (display -> processing)',
          inputDimensions: {
            canvasWidth,
            canvasHeight,
            originalImageWidth: maskData.imageDimensions.width,
            originalImageHeight: maskData.imageDimensions.height
          },
          displayInfo: maskData.imageDisplayInfo,
          targetDimensions: {
            frameWidth,
            frameHeight
          }
        });
        
        // CRITICAL: Transform from display space (contain) to processing space (fill)
        const displayScale = maskData.imageDisplayInfo.scale;
        const displayedWidth = maskData.imageDimensions.width * displayScale;
        const displayedHeight = maskData.imageDimensions.height * displayScale;
        
        this.logCoordinateTransformation('📐 STEP 1: CANVAS TO DISPLAY SCALING', {
          calculation: {
            displayScale,
            originalImageDims: `${maskData.imageDimensions.width}x${maskData.imageDimensions.height}`,
            displayedDims: `${displayedWidth}x${displayedHeight}`,
            canvasDims: `${canvasWidth}x${canvasHeight}`
          },
          scalingRatio: {
            widthRatio: displayedWidth / canvasWidth,
            heightRatio: displayedHeight / canvasHeight
          }
        });
        
        // Step 1: Scale mask from canvas to displayed image size
        const intermediateInfo = await Sharp(maskBuffer)
          .resize(Math.round(displayedWidth), Math.round(displayedHeight), {
            fit: 'fill',
            kernel: 'lanczos3'
          })
          .raw()
          .toBuffer({ resolveWithObject: true });
        
        this.logCoordinateTransformation('📐 STEP 2: DISPLAY TO FRAME SCALING', {
          intermediateDims: `${intermediateInfo.info.width}x${intermediateInfo.info.height}`,
          targetFrameDims: `${frameWidth}x${frameHeight}`,
          finalScalingRatio: {
            widthRatio: frameWidth / intermediateInfo.info.width,
            heightRatio: frameHeight / intermediateInfo.info.height
          }
        });
        
        // Step 2: Scale to final frame size  
        const finalInfo = await Sharp(intermediateInfo.data, {
          raw: {
            width: intermediateInfo.info.width,
            height: intermediateInfo.info.height,
            channels: intermediateInfo.info.channels
          }
        })
          .resize(frameWidth, frameHeight, {
            fit: 'fill',
            kernel: 'lanczos3'
          })
          .raw()
          .toBuffer({ resolveWithObject: true });
        
        maskRaw = finalInfo.data;
        maskChannels = finalInfo.info.channels;
        
        this.logCoordinateTransformation('✅ MASK SCALING COMPLETE', {
          finalDimensions: `${finalInfo.info.width}x${finalInfo.info.height}`,
          channels: finalInfo.info.channels,
          bufferSize: finalInfo.data.length
        });
      } else {
        this.logCoordinateTransformation('⚠️ FALLBACK DIRECT SCALING', {
          reason: 'Missing imageDisplayInfo or imageDimensions',
          availableData: {
            hasImageDisplayInfo: !!maskData?.imageDisplayInfo,
            hasImageDimensions: !!maskData?.imageDimensions
          },
          directScaling: `${canvasWidth}x${canvasHeight} -> ${frameWidth}x${frameHeight}`
        });
        
        // Fallback: direct scaling
        const maskInfo = await Sharp(maskBuffer)
          .resize(frameWidth, frameHeight, {
            fit: 'fill',
            kernel: 'lanczos3'
          })
          .raw()
          .toBuffer({ resolveWithObject: true });
        
        maskRaw = maskInfo.data;
        maskChannels = maskInfo.info.channels;
      }
      
      console.log(`Processing base64 mask: ${frameWidth}x${frameHeight}, mask channels: ${maskChannels}`);
      
      // Create RGBA output buffer
      const pixelCount = frameWidth * frameHeight;
      const resultBuffer = Buffer.alloc(pixelCount * 4); // RGBA
      resultBuffer.fill(0); // Fill with transparent
      
      let detectedPixels = 0;
      
      // Mask detection thresholds (exact from working prototype)
      const alphaThreshold = 128;
      const redMinimum = 150;
      const redDominanceRatio = 1.5;
      
      // Per-pixel analysis loop with enhanced tracking
      let pixelAnalysisSample = [];
      const sampleInterval = Math.floor(pixelCount / 20); // Sample every 5% of pixels
      
      for (let i = 0; i < pixelCount; i++) {
        const maskPixelIndex = i * maskChannels;
        
        // Extract RGBA values from mask pixel
        const maskR = maskRaw[maskPixelIndex] || 0;
        const maskG = maskRaw[maskPixelIndex + 1] || 0;
        const maskB = maskRaw[maskPixelIndex + 2] || 0;
        const maskA = maskChannels > 3 ? (maskRaw[maskPixelIndex + 3] || 0) : 255;
        
        // Dual-condition mask detection (from working prototype):
        const isDrawn = maskA > alphaThreshold;  // Alpha threshold (visible pixel)
        const isRed = maskR > redMinimum &&      // Red dominance detection
                     maskR > maskG * redDominanceRatio &&  // Red > 1.5x Green
                     maskR > maskB * redDominanceRatio;    // Red > 1.5x Blue
        
        // Sample pixel data for analysis
        if (i % sampleInterval === 0 || (isDrawn && isRed)) {
          const x = i % frameWidth;
          const y = Math.floor(i / frameWidth);
          pixelAnalysisSample.push({
            index: i,
            coordinate: `(${x},${y})`,
            rgba: `(${maskR},${maskG},${maskB},${maskA})`,
            isDrawn,
            isRed,
            detected: isDrawn && isRed
          });
        }
        
        // Mark detected mask regions as opaque in the output buffer
        if (isDrawn && isRed) {
          const outputIndex = i * 4;
          resultBuffer[outputIndex] = 255;     // R
          resultBuffer[outputIndex + 1] = 255; // G
          resultBuffer[outputIndex + 2] = 255; // B
          resultBuffer[outputIndex + 3] = 255; // A (opaque)
          detectedPixels++;
          
          // Debug first few detections
          if (detectedPixels <= 5) {
            const x = i % frameWidth;
            const y = Math.floor(i / frameWidth);
            console.log(`Red pixel detected #${detectedPixels} at (${x},${y}): RGB(${maskR},${maskG},${maskB}) Alpha:${maskA}`);
          }
        }
      }
      
      this.logCoordinateTransformation('🔍 PIXEL ANALYSIS RESULTS', {
        summary: {
          totalPixels: pixelCount,
          detectedPixels,
          detectionRate: `${((detectedPixels / pixelCount) * 100).toFixed(2)}%`,
          sampleSize: pixelAnalysisSample.length
        },
        detectionCriteria: {
          alphaThreshold,
          redMinimum,
          redDominanceRatio
        },
        pixelSample: pixelAnalysisSample.slice(0, 10), // First 10 samples
        detectedSample: pixelAnalysisSample.filter(p => p.detected).slice(0, 5) // First 5 detected
      });
      
      console.log(`Base64 mask created with ${detectedPixels} detected pixels out of ${pixelCount}`);
      
      // Debug: Show sample of non-red pixels too
      if (detectedPixels === 0) {
        console.log('⚠️ NO RED PIXELS DETECTED! Checking first few pixels:');
        for (let i = 0; i < Math.min(10, pixelCount); i++) {
          const maskPixelIndex = i * maskChannels;
          const maskR = maskRaw[maskPixelIndex] || 0;
          const maskG = maskRaw[maskPixelIndex + 1] || 0;
          const maskB = maskRaw[maskPixelIndex + 2] || 0;
          const maskA = maskChannels > 3 ? (maskRaw[maskPixelIndex + 3] || 0) : 255;
          console.log(`Pixel ${i}: RGB(${maskR},${maskG},${maskB}) Alpha:${maskA}`);
        }
      }
      
      // Final mask buffer analysis
      const finalMaskPixels = resultBuffer.length / 4;
      let finalDetectedCount = 0;
      for (let i = 0; i < finalMaskPixels; i++) {
        if (resultBuffer[i * 4 + 3] > 0) finalDetectedCount++; // Count alpha > 0
      }
      
      console.log(`\n🎯 FINAL MASK BUFFER ANALYSIS:`);
      console.log(`   Buffer size: ${resultBuffer.length} bytes`);
      console.log(`   Total pixels: ${finalMaskPixels}`);
      console.log(`   Opaque pixels: ${finalDetectedCount}`);
      console.log(`   Final mask coverage: ${((finalDetectedCount/finalMaskPixels)*100).toFixed(2)}%`);
      console.log(`   Status: ${finalDetectedCount > 0 ? '✅ MASK READY' : '❌ EMPTY MASK'}\n`);
      
      return resultBuffer;
      
    } catch (error) {
      console.error('Error processing base64 mask, falling back to copy original:', error);
      // Return fully transparent mask on error (will preserve original frame)
      const pixelCount = frameWidth * frameHeight;
      const fallbackBuffer = Buffer.alloc(pixelCount * 4);
      fallbackBuffer.fill(0);
      return fallbackBuffer;
    }
  }
}
