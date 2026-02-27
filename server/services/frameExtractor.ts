import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import * as dcmjs from 'dcmjs';

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  totalFrames: number;
  isDicom?: boolean;
  dicomMetadata?: {
    patientID?: string;
    studyDate?: string;
    modality?: string;
    studyDescription?: string;
    seriesDescription?: string;
  };
}

export class FrameExtractor {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp');
    this.ensureTempDir();
  }

  private async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create temp directory:', error);
    }
  }

  async extractVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    // Check if file is DICOM and handle differently
    const isDicom = await this.isDicomFile(videoPath);

    if (isDicom) {
      // For DICOM files, extract metadata using dcmjs
      try {
        const dicomBuffer = await fs.readFile(videoPath);
        const dataSet = dcmjs.data.DicomMessage.readFile(dicomBuffer.buffer);
        const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dataSet.dict);
        
        // 🔍 DETECT MULTI-FRAME DICOM FILES
        const totalFrames = this.detectDicomFrameCount(dataset);
        console.log(`📊 DICOM Analysis: Detected ${totalFrames} frames in DICOM file`);
        
        return {
          duration: totalFrames, // Use actual frame count for multi-frame DICOM
          width: dataset.Columns || 512,
          height: dataset.Rows || 512,
          frameRate: 1,
          totalFrames,
          isDicom: true,
          dicomMetadata: {
            patientID: dataset.PatientID,
            studyDate: dataset.StudyDate,
            modality: dataset.Modality,
            studyDescription: dataset.StudyDescription,
            seriesDescription: dataset.SeriesDescription,
          }
        };
      } catch (error) {
        console.error('Error extracting DICOM metadata:', error);
        return {
          duration: 1,
          width: 512,
          height: 512,
          frameRate: 1,
          totalFrames: 1,
          isDicom: true,
        };
      }
    }

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to extract metadata: ${err.message}`));
          return;
        }

        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (!videoStream) {
          reject(new Error('No video stream found'));
          return;
        }

        const duration = metadata.format.duration || 0;
        const frameRate = this.parseFrameRate(videoStream.r_frame_rate || '30/1');
        const totalFrames = Math.floor(duration * frameRate);

        resolve({
          duration,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          frameRate,
          totalFrames,
        });
      });
    });
  }

  // 🔍 NEW: Detect actual frame count in multi-frame DICOM files
  private detectDicomFrameCount(dataset: any): number {
    try {
      // Check for NumberOfFrames tag (multi-frame indicator)
      if (dataset.NumberOfFrames && dataset.NumberOfFrames > 1) {
        console.log(`🎞️ Multi-frame DICOM detected: ${dataset.NumberOfFrames} frames`);
        return dataset.NumberOfFrames;
      }
      
      // Check pixel data size to estimate frames
      if (dataset.PixelData) {
        const rows = dataset.Rows || 512;
        const cols = dataset.Columns || 512;
        const bitsAllocated = dataset.BitsAllocated || 16;
        const expectedBytesPerFrame = rows * cols * (bitsAllocated / 8);
        
        let pixelDataSize = 0;
        if (dataset.PixelData instanceof ArrayBuffer) {
          pixelDataSize = dataset.PixelData.byteLength;
        } else if (dataset.PixelData.buffer) {
          pixelDataSize = dataset.PixelData.byteLength;
        }
        
        if (pixelDataSize > expectedBytesPerFrame) {
          const estimatedFrames = Math.floor(pixelDataSize / expectedBytesPerFrame);
          console.log(`🔍 Estimated ${estimatedFrames} frames from pixel data size`);
          return estimatedFrames;
        }
      }
      
      // Default to single frame
      return 1;
    } catch (error) {
      console.error('Error detecting DICOM frame count:', error);
      return 1;
    }
  }

  async isDicomFile(filePath: string): Promise<boolean> {
    try {
      // Detect DICOM files by header signature (not extension)
      const buffer = await fs.readFile(filePath);
      
      // Check DICOM magic bytes (DICM at offset 128)
      if (buffer.length > 132) {
        const magicBytes = buffer.subarray(128, 132).toString('ascii');
        if (magicBytes === 'DICM') {
          return true;
        }
      }

      // Also check file extension as fallback
      const ext = path.extname(filePath).toLowerCase();
      return ext === '.dcm' || ext === '.dicom';
    } catch (error) {
      return false;
    }
  }

  async extractFirstFrame(videoPath: string): Promise<Buffer> {
    // Check if file is DICOM
    const isDicom = await this.isDicomFile(videoPath);
    
    if (isDicom) {
      // For DICOM files, extract the actual image data
      return await this.extractDicomImage(videoPath);
    }

    return new Promise((resolve, reject) => {
      const outputPath = path.join(this.tempDir, `first_frame_${Date.now()}.png`);
      
      ffmpeg(videoPath)
        .seekInput(0.1) // Seek to 0.1 seconds to avoid potential black frames
        .frames(1)
        .output(outputPath)
        .outputOptions([
          '-f', 'image2',
          '-vcodec', 'png',
          '-pix_fmt', 'rgb24'
        ])
        .on('end', async () => {
          try {
            const buffer = await fs.readFile(outputPath);
            await fs.unlink(outputPath); // Clean up temp file
            resolve(buffer);
          } catch (error) {
            reject(new Error(`Failed to read first frame: ${error}`));
          }
        })
        .on('error', (err) => {
          reject(new Error(`Failed to extract first frame: ${err.message}`));
        })
        .run();
    });
  }

  // 🎞️ NEW: Extract specific frame from multi-frame DICOM
  private async extractDicomFrame(filePath: string, frameIndex: number): Promise<Buffer> {
    try {
      const dicomBuffer = await fs.readFile(filePath);
      const dataSet = dcmjs.data.DicomMessage.readFile(dicomBuffer.buffer);
      const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dataSet.dict);
      
      // Extract image dimensions and metadata
      const rows = dataset.Rows || 512;
      const cols = dataset.Columns || 512;
      const bitsAllocated = dataset.BitsAllocated || 16;
      const totalFrames = this.detectDicomFrameCount(dataset);
      
      if (frameIndex >= totalFrames) {
        console.log(`⚠️ Frame ${frameIndex} exceeds total frames ${totalFrames}, using frame 0`);
        frameIndex = 0;
      }
      
      // Get pixel data for specific frame
      let pixelData = dataset.PixelData;
      if (!pixelData) {
        throw new Error('No pixel data found in DICOM file');
      }
      
      // Calculate frame offset
      const bytesPerFrame = rows * cols * (bitsAllocated / 8);
      const frameOffset = frameIndex * bytesPerFrame;
      
      console.log(`🗢️ Extracting DICOM frame ${frameIndex}/${totalFrames - 1} (offset: ${frameOffset}, size: ${bytesPerFrame})`);
      
      // 🔧 DEBUG: Log pixel data format for debugging
      console.log(`🔍 DICOM Frame ${frameIndex} - Pixel data inspection:`);
      console.log('- Type:', typeof pixelData);
      console.log('- Is ArrayBuffer:', pixelData instanceof ArrayBuffer);
      console.log('- Has buffer property:', !!(pixelData && pixelData.buffer));
      console.log('- Has InlineBinary:', !!(pixelData && pixelData.InlineBinary));
      if (typeof pixelData === 'object' && pixelData) {
        console.log('- Object keys:', Object.keys(pixelData));
        if (Object.keys(pixelData).length > 0) {
          const firstKey = Object.keys(pixelData)[0];
          console.log('- First key:', firstKey);
          console.log('- First value type:', typeof pixelData[firstKey]);
        }
      }
      
      // 🔧 USE EXACT SAME PIXEL DATA HANDLING AS extractDicomImage
      let pixelBuffer: ArrayBuffer | undefined;
      
      // Handle different pixel data formats - EXACTLY like extractDicomImage
      if (pixelData instanceof ArrayBuffer) {
        pixelBuffer = pixelData;
        console.log(`✅ Using direct ArrayBuffer (${pixelBuffer.byteLength} bytes)`);
      } else if (pixelData && pixelData.buffer instanceof ArrayBuffer) {
        pixelBuffer = pixelData.buffer.slice(pixelData.byteOffset, pixelData.byteOffset + pixelData.byteLength);
        console.log(`✅ Using .buffer property (${pixelBuffer.byteLength} bytes)`);
      } else if (typeof pixelData === 'object' && pixelData.InlineBinary) {
        // Handle inline binary data
        const base64Data = pixelData.InlineBinary;
        const binaryString = atob(base64Data);
        pixelBuffer = new ArrayBuffer(binaryString.length);
        const uint8Array = new Uint8Array(pixelBuffer);
        for (let i = 0; i < binaryString.length; i++) {
          uint8Array[i] = binaryString.charCodeAt(i);
        }
      } else if (typeof pixelData === 'object' && Object.keys(pixelData).length > 0) {
        // Check for other possible pixel data formats
        const firstKey = Object.keys(pixelData)[0];
        const firstValue = pixelData[firstKey];
        
        // Try to access the actual data
        if (firstValue instanceof ArrayBuffer) {
          pixelBuffer = firstValue;
        } else if (firstValue && firstValue.buffer instanceof ArrayBuffer) {
          pixelBuffer = firstValue.buffer;
        } else if (firstValue instanceof Uint8Array || firstValue instanceof Uint16Array) {
          pixelBuffer = firstValue.buffer.slice(firstValue.byteOffset, firstValue.byteOffset + firstValue.byteLength);
        } else if (typeof firstValue === 'string') {
          // Might be base64 encoded
          try {
            const binaryString = atob(firstValue);
            pixelBuffer = new ArrayBuffer(binaryString.length);
            const uint8Array = new Uint8Array(pixelBuffer);
            for (let i = 0; i < binaryString.length; i++) {
              uint8Array[i] = binaryString.charCodeAt(i);
            }
          } catch (e) {
            throw new Error(`Failed to decode base64 pixel data: ${e.message}`);
          }
        } else if (typeof firstValue === 'object' && firstValue) {
          // Handle nested object structure (common in DICOM)
          console.log(`🔍 Nested object found, exploring deeper...`);
          if (firstValue.buffer instanceof ArrayBuffer) {
            pixelBuffer = firstValue.buffer.slice(firstValue.byteOffset, firstValue.byteOffset + firstValue.byteLength);
            console.log(`✅ Using nested object .buffer (${pixelBuffer.byteLength} bytes)`);
          } else if (firstValue instanceof Uint8Array || firstValue instanceof Uint16Array) {
            pixelBuffer = firstValue.buffer.slice(firstValue.byteOffset, firstValue.byteOffset + firstValue.byteLength);
            console.log(`✅ Using nested typed array (${pixelBuffer.byteLength} bytes)`);
          } else {
            // Try to find any buffer-like property in the nested object
            const nestedKeys = Object.keys(firstValue);
            console.log(`🔍 Nested object keys:`, nestedKeys);
            let found = false;
            for (const nestedKey of nestedKeys) {
              const nestedValue = firstValue[nestedKey];
              if (nestedValue && nestedValue.buffer instanceof ArrayBuffer) {
                pixelBuffer = nestedValue.buffer.slice(nestedValue.byteOffset, nestedValue.byteOffset + nestedValue.byteLength);
                console.log(`✅ Using nested property "${nestedKey}" buffer (${pixelBuffer.byteLength} bytes)`);
                found = true;
                break;
              } else if (nestedValue instanceof ArrayBuffer) {
                pixelBuffer = nestedValue;
                console.log(`✅ Using nested property "${nestedKey}" ArrayBuffer (${pixelBuffer.byteLength} bytes)`);
                found = true;
                break;
              }
            }
            if (!found) {
              throw new Error(`Cannot find buffer data in nested object. Keys: ${nestedKeys.join(', ')}`);
            }
          }
        } else {
          throw new Error(`Unsupported pixel data format: object property "${firstKey}" of type ${typeof firstValue}`);
        }
      } else {
        // Try accessing the raw DICOM data directly using the raw dictionary
        console.log(`🔍 Trying raw DICOM data access...`);
        const rawPixelData = dataSet.dict['7FE00010']; // Pixel Data tag
        if (rawPixelData && rawPixelData.Value) {
          if (rawPixelData.Value instanceof ArrayBuffer) {
            pixelBuffer = rawPixelData.Value;
            console.log(`✅ Using raw DICOM ArrayBuffer (${pixelBuffer.byteLength} bytes)`);
          } else if (rawPixelData.Value.buffer instanceof ArrayBuffer) {
            pixelBuffer = rawPixelData.Value.buffer.slice(
              rawPixelData.Value.byteOffset, 
              rawPixelData.Value.byteOffset + rawPixelData.Value.byteLength
            );
            console.log(`✅ Using raw DICOM .buffer (${pixelBuffer.byteLength} bytes)`);
          } else {
            throw new Error(`Cannot access raw DICOM pixel data: ${typeof rawPixelData.Value}`);
          }
        } else {
          throw new Error(`No pixel data found: naturalized=${!!pixelData}, raw=${!!rawPixelData}`);
        }
      }
      
      // Ensure we have a pixel buffer
      if (!pixelBuffer) {
        throw new Error('Failed to extract pixel buffer from any source');
      }
      
      // Validate we have enough data
      if (pixelBuffer.byteLength < frameOffset + bytesPerFrame) {
        console.log(`⚠️ Not enough pixel data for frame ${frameIndex}. Available: ${pixelBuffer.byteLength}, needed: ${frameOffset + bytesPerFrame}`);
        // Fallback to first frame
        return this.extractDicomImage(filePath);
      }
      
      // Extract the specific frame data
      const framePixelData = new Uint8Array(pixelBuffer, frameOffset, bytesPerFrame);
      console.log(`✅ Successfully extracted ${framePixelData.length} bytes for frame ${frameIndex}`);
      
      // Process the frame data using existing logic from extractDicomImage
      return this.processDicomPixelDataHelper(dataset, framePixelData, rows, cols, bitsAllocated);
      
    } catch (error) {
      console.error(`Error extracting DICOM frame ${frameIndex}:`, error);
      // Fallback to first frame
      return this.extractDicomImage(filePath);
    }
  }

  // 🔧 Helper to try raw DICOM pixel data extraction
  private async tryRawDicomPixelData(dataSet: any, frameIndex: number, rows: number, cols: number, bitsAllocated: number): Promise<Buffer> {
    try {
      const rawPixelData = dataSet.dict['7FE00010']; // Pixel Data tag
      if (rawPixelData && rawPixelData.Value) {
        let pixelBuffer: ArrayBuffer;
        
        if (rawPixelData.Value instanceof ArrayBuffer) {
          pixelBuffer = rawPixelData.Value;
        } else if (rawPixelData.Value.buffer) {
          pixelBuffer = rawPixelData.Value.buffer.slice(
            rawPixelData.Value.byteOffset, 
            rawPixelData.Value.byteOffset + rawPixelData.Value.byteLength
          );
        } else {
          throw new Error('Cannot access raw pixel data');
        }
        
        // Calculate frame offset and extract
        const bytesPerFrame = rows * cols * (bitsAllocated / 8);
        const frameOffset = frameIndex * bytesPerFrame;
        
        if (pixelBuffer.byteLength >= frameOffset + bytesPerFrame) {
          const framePixelData = new Uint8Array(pixelBuffer, frameOffset, bytesPerFrame);
          console.log(`✅ Raw DICOM extraction: Successfully extracted ${framePixelData.length} bytes for frame ${frameIndex}`);
          
          // Create a mock dataset for processing
          const mockDataset = {
            Rows: rows,
            Columns: cols,
            BitsAllocated: bitsAllocated,
            BitsStored: bitsAllocated,
            PixelRepresentation: 0,
            Modality: '',
            WindowCenter: null,
            WindowWidth: null
          };
          
          return this.processDicomPixelDataHelper(mockDataset, framePixelData, rows, cols, bitsAllocated);
        }
      }
      
      throw new Error('Raw DICOM pixel data extraction failed');
    } catch (error) {
      console.log(`⚠️ Raw DICOM extraction failed for frame ${frameIndex}, using first frame`);
      // Final fallback to first frame
      return this.extractDicomImage(this.getFilePathFromDataSet(dataSet));
    }
  }
  
  // Helper to get file path (this is a fallback, won't work in practice)
  private getFilePathFromDataSet(dataSet: any): string {
    // This is a placeholder - in practice, we should pass the filePath properly
    return '';
  }

  // 🔧 Helper method to process DICOM pixel data
  private async processDicomPixelDataHelper(dataset: any, pixelDataArray: Uint8Array, rows: number, cols: number, bitsAllocated: number): Promise<Buffer> {
    try {
      const bitsStored = dataset.BitsStored || bitsAllocated;
      const pixelRepresentation = dataset.PixelRepresentation || 0;
      const modality = dataset.Modality || '';
      
      // Get window/level settings
      let windowCenter = dataset.WindowCenter;
      let windowWidth = dataset.WindowWidth;
      
      // Handle array values
      if (Array.isArray(windowCenter)) windowCenter = windowCenter[0];
      if (Array.isArray(windowWidth)) windowWidth = windowWidth[0];
      
      // Convert pixel data based on bit depth
      let normalizedPixelData: Uint8Array;
      
      if (bitsAllocated === 16) {
        // 16-bit pixel data
        const uint16Data = new Uint16Array(pixelDataArray.buffer, pixelDataArray.byteOffset, pixelDataArray.length / 2);
        
        // Find min/max for normalization if no window settings
        let min = 0, max = 65535;
        if (!windowCenter || !windowWidth) {
          min = Math.min(...uint16Data);
          max = Math.max(...uint16Data);
          console.log(`Auto-calculated range: ${min}-${max}`);
        }
        
        // Apply windowing and convert to 8-bit
        normalizedPixelData = new Uint8Array(uint16Data.length);
        
        if (windowCenter && windowWidth) {
          // Use DICOM window/level
          const windowMin = windowCenter - windowWidth / 2;
          const windowMax = windowCenter + windowWidth / 2;
          
          for (let i = 0; i < uint16Data.length; i++) {
            let value = uint16Data[i];
            if (value <= windowMin) value = 0;
            else if (value >= windowMax) value = 255;
            else value = ((value - windowMin) / (windowMax - windowMin)) * 255;
            
            normalizedPixelData[i] = Math.round(value);
          }
        } else {
          // Auto-normalize based on data range
          const range = max - min;
          for (let i = 0; i < uint16Data.length; i++) {
            normalizedPixelData[i] = Math.round(((uint16Data[i] - min) / range) * 255);
          }
        }
      } else {
        // 8-bit pixel data
        normalizedPixelData = new Uint8Array(pixelDataArray);
      }
      
      // Ensure correct size
      const expectedSize = rows * cols;
      if (normalizedPixelData.length !== expectedSize) {
        if (normalizedPixelData.length > expectedSize) {
          normalizedPixelData = normalizedPixelData.slice(0, expectedSize);
        } else {
          const paddedData = new Uint8Array(expectedSize);
          paddedData.set(normalizedPixelData);
          normalizedPixelData = paddedData;
        }
      }
      
      // Convert to PNG using Sharp
      return sharp(normalizedPixelData, {
        raw: {
          width: cols,
          height: rows,
          channels: 1 // Grayscale
        }
      }).png().toBuffer();
      
    } catch (error) {
      console.error('Error processing DICOM pixel data:', error);
      throw error;
    }
  }

  private async extractDicomImage(filePath: string): Promise<Buffer> {
    try {
      // Read the DICOM file
      const dicomBuffer = await fs.readFile(filePath);
      
      // Parse the DICOM file using dcmjs
      const dataSet = dcmjs.data.DicomMessage.readFile(dicomBuffer.buffer);
      const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dataSet.dict);
      
      // Extract image dimensions and metadata
      const rows = dataset.Rows || 512;
      const cols = dataset.Columns || 512;
      const bitsAllocated = dataset.BitsAllocated || 16;
      const bitsStored = dataset.BitsStored || bitsAllocated;
      const pixelRepresentation = dataset.PixelRepresentation || 0;
      const modality = dataset.Modality || '';
      
      // Get window/level settings
      let windowCenter = dataset.WindowCenter;
      let windowWidth = dataset.WindowWidth;
      
      // Handle array values
      if (Array.isArray(windowCenter)) windowCenter = windowCenter[0];
      if (Array.isArray(windowWidth)) windowWidth = windowWidth[0];
      
      // Get pixel data - handle different formats
      let pixelData = dataset.PixelData;
      if (!pixelData) {
        throw new Error('No pixel data found in DICOM file');
      }
      
      // Check pixel data properties
      const expectedBytes = rows * cols * (bitsAllocated / 8);
      
      // Handle different pixel data formats
      let pixelBuffer: ArrayBuffer;
      
      if (pixelData instanceof ArrayBuffer) {
        pixelBuffer = pixelData;
      } else if (pixelData.buffer instanceof ArrayBuffer) {
        pixelBuffer = pixelData.buffer.slice(pixelData.byteOffset, pixelData.byteOffset + pixelData.byteLength);
      } else if (typeof pixelData === 'object' && pixelData.InlineBinary) {
        // Handle inline binary data
        const base64Data = pixelData.InlineBinary;
        const binaryString = atob(base64Data);
        pixelBuffer = new ArrayBuffer(binaryString.length);
        const uint8Array = new Uint8Array(pixelBuffer);
        for (let i = 0; i < binaryString.length; i++) {
          uint8Array[i] = binaryString.charCodeAt(i);
        }
      } else if (typeof pixelData === 'object' && Object.keys(pixelData).length > 0) {
        // Check for other possible pixel data formats
        const firstKey = Object.keys(pixelData)[0];
        const firstValue = pixelData[firstKey];
        
        // Try to access the actual data
        if (firstValue instanceof ArrayBuffer) {
          pixelBuffer = firstValue;
        } else if (firstValue && firstValue.buffer instanceof ArrayBuffer) {
          pixelBuffer = firstValue.buffer;
        } else if (firstValue instanceof Uint8Array || firstValue instanceof Uint16Array) {
          pixelBuffer = firstValue.buffer.slice(firstValue.byteOffset, firstValue.byteOffset + firstValue.byteLength);
        } else if (typeof firstValue === 'string') {
          // Might be base64 encoded
          try {
            const binaryString = atob(firstValue);
            pixelBuffer = new ArrayBuffer(binaryString.length);
            const uint8Array = new Uint8Array(pixelBuffer);
            for (let i = 0; i < binaryString.length; i++) {
              uint8Array[i] = binaryString.charCodeAt(i);
            }
          } catch (e) {
            throw new Error(`Unsupported pixel data format: ${typeof pixelData}, first value: ${typeof firstValue}`);
          }
        } else {
          throw new Error(`Unsupported pixel data format: ${typeof pixelData}, first value: ${typeof firstValue}`);
        }
      } else {
        // Try accessing the raw DICOM data directly
        const rawPixelData = dataSet.dict['7FE00010']; // Pixel Data tag
        if (rawPixelData && rawPixelData.Value) {
          if (rawPixelData.Value instanceof ArrayBuffer) {
            pixelBuffer = rawPixelData.Value;
          } else if (rawPixelData.Value.buffer) {
            pixelBuffer = rawPixelData.Value.buffer.slice(
              rawPixelData.Value.byteOffset, 
              rawPixelData.Value.byteOffset + rawPixelData.Value.byteLength
            );
          } else {
            throw new Error('Cannot access raw pixel data');
          }
        } else {
          throw new Error(`Unsupported pixel data format: ${typeof pixelData}`);
        }
      }
      
      // Convert ArrayBuffer to appropriate typed array
      let pixelArray: Uint8Array | Uint16Array;
      let normalizedPixelData: Uint8Array;
      
      if (bitsAllocated <= 8) {
        // 8-bit data
        pixelArray = new Uint8Array(pixelBuffer);
        normalizedPixelData = new Uint8Array(pixelArray);
      } else {
        // 16-bit data
        pixelArray = new Uint16Array(pixelBuffer);
        normalizedPixelData = new Uint8Array(pixelArray.length);
        
        // Determine windowing parameters based on modality
        let windowMin: number, windowMax: number;
        
        if (windowCenter !== null && windowCenter !== undefined && 
            windowWidth !== null && windowWidth !== undefined) {
          // Use existing DICOM window/level settings
          windowMin = windowCenter - windowWidth / 2;
          windowMax = windowCenter + windowWidth / 2;
        } else {
          // Apply automatic windowing based on modality
          if (modality === 'CT') {
            // CT: Window 400, Level 40 (soft tissue)
            windowCenter = 40;
            windowWidth = 400;
            windowMin = windowCenter - windowWidth / 2;
            windowMax = windowCenter + windowWidth / 2;
          } else if (modality === 'CR' || modality === 'DX') {
            // X-ray: Window 2000, Level 1000 (bone)
            windowCenter = 1000;
            windowWidth = 2000;
            windowMin = windowCenter - windowWidth / 2;
            windowMax = windowCenter + windowWidth / 2;
          } else {
            // MRI or other: Auto-calculate from min/max pixel values
            let min = pixelArray[0];
            let max = pixelArray[0];
            for (let i = 1; i < pixelArray.length; i++) {
              if (pixelArray[i] < min) min = pixelArray[i];
              if (pixelArray[i] > max) max = pixelArray[i];
            }
            windowMin = min;
            windowMax = max;
          }
        }
        
        // Apply windowing and normalize to 0-255 range
        const range = windowMax - windowMin;
        if (range > 0) {
          for (let i = 0; i < pixelArray.length; i++) {
            let value = pixelArray[i];
            if (pixelRepresentation === 1) {
              // Signed data - convert to unsigned
              if (value > 32767) value = value - 65536;
            }
            
            if (value <= windowMin) {
              normalizedPixelData[i] = 0;
            } else if (value >= windowMax) {
              normalizedPixelData[i] = 255;
            } else {
              normalizedPixelData[i] = Math.round(((value - windowMin) / range) * 255);
            }
          }
        } else {
          // Fallback: simple normalization
          normalizedPixelData.fill(128);
        }
      }
      
      // Validate buffer size and handle multi-frame or oversized data
      const expectedSize = rows * cols;
      if (normalizedPixelData.length !== expectedSize) {
        // Handle multi-frame DICOM or oversized data
        if (normalizedPixelData.length > expectedSize) {
          // Take only the first frame if it's multi-frame
          normalizedPixelData = normalizedPixelData.slice(0, expectedSize);
        } else {
          // Pad with zeros if undersized
          const paddedData = new Uint8Array(expectedSize);
          paddedData.set(normalizedPixelData);
          normalizedPixelData = paddedData;
        }
      }
      
      // Convert to PNG using Sharp
      const pngBuffer = await sharp(Buffer.from(normalizedPixelData), {
        raw: {
          width: cols,
          height: rows,
          channels: 1 // Grayscale
        }
      })
      .png()
      .toBuffer();
      
      return pngBuffer;
      
    } catch (error) {
      console.error('Error extracting DICOM image:', error);
      // Fallback to placeholder if DICOM parsing fails
      return await this.createPlaceholderImage();
    }
  }

  private async createPlaceholderImage(): Promise<Buffer> {
    // Create a 512x512 gray placeholder image using Sharp
    try {
      const placeholderBuffer = await sharp({
        create: {
          width: 512,
          height: 512,
          channels: 3,
          background: { r: 128, g: 128, b: 128 } // Gray background
        }
      })
      .png()
      .toBuffer();
      
      return placeholderBuffer;
    } catch (error) {
      // Fallback: create a simple grayscale pattern
      const width = 512;
      const height = 512;
      const channels = 3;
      const data = Buffer.alloc(width * height * channels);
      
      // Fill with a gradient pattern
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          const value = Math.floor((x + y) / 4) % 255;
          data[idx] = value;     // R
          data[idx + 1] = value; // G  
          data[idx + 2] = value; // B
        }
      }
      
      return await sharp(data, {
        raw: {
          width,
          height,
          channels
        }
      }).png().toBuffer();
    }
  }

  async extractFrameBatch(
    videoPath: string, 
    startFrame: number, 
    endFrame: number
  ): Promise<Buffer[]> {
    // Check if file is DICOM
    const isDicom = await this.isDicomFile(videoPath);
    
    if (isDicom) {
      // 🎞️ NEW: Extract specific frames from multi-frame DICOM
      console.log(`🗢️ Extracting DICOM frames ${startFrame}-${endFrame}`);
      const frames: Buffer[] = [];
      
      for (let frameIndex = startFrame; frameIndex <= endFrame; frameIndex++) {
        try {
          const frameBuffer = await this.extractDicomFrame(videoPath, frameIndex);
          frames.push(frameBuffer);
          console.log(`✅ DICOM frame ${frameIndex} extracted`);
        } catch (error) {
          console.error(`❌ Failed to extract DICOM frame ${frameIndex}:`, error.message);
          console.log(`⚠️ Unsupported pixel data format, using first frame extraction`);
          // Use first frame as fallback
          const fallbackFrame = await this.extractDicomImage(videoPath);
          frames.push(fallbackFrame);
        }
      }
      
      return frames;
    }

    // For regular video files, use FFmpeg
    return new Promise((resolve, reject) => {
      const frames: Buffer[] = [];
      const frameCount = endFrame - startFrame + 1;

      // Create output pattern for this batch
      const batchId = Date.now();
      const outputPattern = path.join(this.tempDir, `batch_${batchId}_frame_%04d.png`);
      
      ffmpeg(videoPath)
        .outputOptions([
          '-f', 'image2',
          '-vcodec', 'png',
          '-pix_fmt', 'rgb24',
          '-vf', `select='between(n\\,${startFrame}\\,${endFrame})'`,
          '-vsync', 'vfr'
        ])
        .output(outputPattern)
        .on('end', async () => {
          try {
            // Read all generated frame files
            for (let i = 1; i <= frameCount; i++) {
              const framePath = path.join(this.tempDir, `batch_${batchId}_frame_${String(i).padStart(4, '0')}.png`);
              try {
                const buffer = await fs.readFile(framePath);
                frames.push(buffer);
                await fs.unlink(framePath); // Clean up temp file
              } catch (fileError) {
                console.warn(`Failed to read frame ${i}:`, fileError);
              }
            }
            resolve(frames);
          } catch (error) {
            reject(new Error(`Failed to read extracted frames: ${error}`));
          }
        })
        .on('error', (err) => {
          reject(new Error(`Failed to extract frame batch: ${err.message}`));
        })
        .run();
    });
  }

  private parseFrameRate(rFrameRate: string): number {
    const parts = rFrameRate.split('/');
    if (parts.length === 2) {
      const numerator = parseInt(parts[0], 10);
      const denominator = parseInt(parts[1], 10);
      return denominator > 0 ? numerator / denominator : 30;
    }
    return parseFloat(rFrameRate) || 30;
  }

  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir);
      const deletePromises = files.map(file => 
        fs.unlink(path.join(this.tempDir, file)).catch(err => 
          console.warn(`Failed to delete temp file ${file}:`, err)
        )
      );
      await Promise.all(deletePromises);
    } catch (error) {
      console.error('Failed to cleanup temp directory:', error);
    }
  }

  // New method to get image dimensions
  async getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
    try {
      const metadata = await sharp(imagePath).metadata();
      return {
        width: metadata.width || 0,
        height: metadata.height || 0
      };
    } catch (error) {
      console.error('Error getting image dimensions:', error);
      return { width: 0, height: 0 };
    }
  }

  // New method to get image as buffer
  async getImageAsBuffer(imagePath: string): Promise<Buffer> {
    try {
      return await sharp(imagePath).png().toBuffer();
    } catch (error) {
      console.error('Error getting image as buffer:', error);
      throw new Error(`Failed to read image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
