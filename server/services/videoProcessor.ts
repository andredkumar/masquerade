import { storage } from '../storage';
import { FrameExtractor, type VideoMetadata } from './frameExtractor';
import type { Job, MaskData, OutputSettings, ProcessingProgress } from '@shared/schema';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs/promises';
import Sharp from 'sharp';
import { TempFolderManager } from './templateMaskFolderManager';
import { deleteUploadFile } from './cleanup';
import { rawFramesDir, applyStagingDir, cleanupApplyStaging, prepareCleanApplyStaging, assertNoSegmentDoubling } from './applyPaths';
import { listRawFrameFiles, isCompletePngBuffer } from './frameAccess';
import { rawFramesDir as rawFramesDirFor } from './applyPaths';
import {
  resolveApplyEngine, resolveQv, writeBboxMask, runFfmpegApply, type BboxMask,
} from './ffmpegApply';
import os from 'os';
import { perfMark, perfSpan } from './perf';

interface TransformationMatrix {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * The per-apply mask, built once (2B-3a).
 *
 * `maskedOffsets` holds the byte offset into a raw 3-channel frame of every
 * pixel the mask redacts, so the per-frame work scales with the *masked* pixel
 * count rather than the frame. On the prod clip that is 1,494 entries out of
 * 1,222,656 pixels — 0.12 %. `maskRgba` is retained because the per-stack
 * fallback path still expects the original RGBA raster.
 */
interface ApplyMask {
  width: number;
  height: number;
  maskRgba: Buffer;
  /** Byte offsets `(y*width + x) * 3` of every masked pixel, ascending. */
  maskedOffsets: Uint32Array;
  maskedPixels: number;
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

  async processVideo(
    jobId: string,
    videoPath: string,
    maskData: MaskData,
    outputSettings: OutputSettings,
    samplingFps: number | null = null
  ) {
    // Apply-time staging dir, used by both the success branch and the finally
    // block. This is an ISOLATED subdir (`_apply`) of the job's temp_extracted
    // tree — deliberately NOT the persistent raw-frame dir (Phase 4b-0). The
    // background extractor writes the persistent raw frames to
    // temp_extracted/<jobId>/frame_NNNNNN.png; re-extracting at apply time into
    // the same dir would collide with those frames (extractAllFramesSequential
    // reads back every frame_*.png to size the frame set), so apply-time
    // extraction is sandboxed here and the persistent raw frames are left intact.
    const extractedFramesDir = applyStagingDir(jobId);
    // We delete the apply-time staging subdir in `finally` whenever the job
    // reached a terminal status — i.e. processing actually started (success
    // path) OR an exception was raised (failed path). The persistent raw frames
    // and the original upload are intentionally NOT deleted here so a full redo
    // loop (re-draw → re-apply → re-run AI) works within their retention windows;
    // the hourly sweep / SIGTERM / cleanupJobArtifacts reclaim them instead.
    let reachedTerminal = false;

    // [PERF] Round 1 §3.2. The apply total is spanned here rather than from the
    // HTTP handler because processVideo is fired detached (`.catch(...)`) and
    // cannot be handed a closure without changing its signature. The
    // handler→processVideo gap is derivable from the `t` fields on
    // `apply.request` and `apply.done`.
    const endApply = perfSpan(jobId, 'apply.done');

    try {
      // [PERF] §3.2 — concurrency facts, once per apply. Tells us whether H2
      // (mask loop not actually parallel / capped by the libuv threadpool) is
      // even possible before we look at a single timing.
      perfMark(jobId, 'apply.env', {
        cpus: os.cpus().length,
        uv_threadpool: process.env.UV_THREADPOOL_SIZE ?? 'default(4)',
        sharp_concurrency: Sharp.concurrency(),
        // Outer batch width (processFrameBuffersInParallel → Promise.all over batches)
        batch_size: outputSettings?.batchSize || 12,
        // Inner stack width (one processFrameBatch call = one `apply.stack`)
        volume_batch_size: 8,
        // Round 2C experiment: 'sharp' (default, deployed) | 'ffmpeg'
        apply_engine: resolveApplyEngine(),
        node: process.version,
      });

      console.log('🔍 ENTERED processVideo method successfully!');
      console.log('🔍 Parameters:', { jobId, videoPath, maskDataType: maskData?.type, hasOutputSettings: !!outputSettings, samplingFps });

      await this.updateProgress(jobId, { stage: 'extracting', progress: 5 });

      // ── FRAME SOURCE: REUSE temp_extracted/, ELSE RE-EXTRACT ───────
      // Round 2B-1. Round 1 measured apply-time re-extraction at 19.5 s of a
      // 33.3 s apply (58%) on a 348-frame clip whose frames were already sitting
      // in temp_extracted/<jobId>/ from the upload 28 s earlier. Round 2A made
      // reuse safe by construction: Apply is unreachable until status is
      // `ready`, and `ready` is written only after the last extraction batch.
      //
      // The reuse branch is guarded four ways; ANY doubt falls through to the
      // untouched re-extract path below, which is still the only path for
      // sampled applies, short/mismatched frame sets, and torn files.
      let extractedBuffers: Buffer[];
      let extractedCount: number;
      const reuse = await this.tryReuseRawFrames(jobId, samplingFps);

      // 2B-3b — source metadata without re-probing the upload.
      //
      // `extractVideoMetadata` used to run unconditionally, before we knew
      // whether we'd even need it. On the reuse path the only consumer is the
      // `updateVideoJob` write below (duration/dims/frameRate), and the Job V2
      // record already carries exactly those four values from upload time — so
      // the probe is pure waste there. For DICOM it was an entire file read plus
      // a dcmjs parse of a file we no longer open at all.
      //
      // The re-extract path still probes: it needs `duration`/`frameRate` to
      // drive extractAllFramesSequential and `isDicom` to label the probe. No
      // new columns — this reads what A3 already stores (ROUND2B3_PROPOSAL §2B-3b).
      const cached = reuse?.source;
      const cacheUsable = !!cached
        && cached.duration > 0 && cached.width > 0 && cached.height > 0 && cached.frameRate > 0;
      let metadata: VideoMetadata;
      if (reuse && cacheUsable && cached) {
        metadata = {
          duration: cached.duration,
          width: cached.width,
          height: cached.height,
          frameRate: cached.frameRate,
          totalFrames: cached.totalFrames,
        };
        perfMark(jobId, 'apply.metadata', { mode: 'cached' });
      } else {
        const endMeta = perfSpan(jobId, 'apply.metadata', { mode: 'probe' });
        metadata = await this.frameExtractor.extractVideoMetadata(videoPath);
        endMeta({ reason: reuse ? 'incomplete_cache' : 'reextract' });
      }

      if (reuse) {
        extractedBuffers = reuse.buffers;
        extractedCount = reuse.buffers.length;
      } else {
        // ── SINGLE-PASS SEQUENTIAL FRAME EXTRACTION ──────────────────
        // The previous batch-based approach (select=between(n,…) + -vsync vfr,
        // run in parallel per batch) extracted frames non-sequentially and
        // duplicated frames across overlapping batch ranges. We now extract
        // ALL frames in one ffmpeg pass at a duration-based fps, write them
        // to a staging directory, and feed the resulting buffers into the
        // existing parallel batch pipeline. ffmpeg is invoked exactly once.
        //
        // Re-entrancy: clear `_apply` to an EMPTY dir before re-extracting. A run
        // interrupted before its finally cleanup (SIGTERM/OOM) can leave stale
        // frames here; extractAllFramesSequential reads back every frame_*.png to
        // size the frame set, so any residue would inflate/corrupt the frame
        // count. prepareCleanApplyStaging makes the apply idempotent across
        // re-invocation and returns the same temp_extracted/<jobId>/_apply path.
        const endStaging = perfSpan(jobId, 'apply.staging_clean');
        await prepareCleanApplyStaging(jobId);
        endStaging();

        // `path` comes from metadata.isDicom (already resolved above) so the probe
        // costs no extra I/O and the DICOM branch itself stays untouched.
        const endExtractAll = perfSpan(jobId, 'apply.extract_all', {
          path: metadata.isDicom ? 'dicom' : 'ffmpeg',
        });
        const extractedPaths = await this.frameExtractor.extractAllFramesSequential(
          videoPath,
          extractedFramesDir,
          metadata.duration,
          path.basename(videoPath),
          samplingFps,
          metadata.frameRate,
          jobId, // [PERF] enables the DICOM-branch `apply.extract_frame` probe only
        );
        extractedCount = extractedPaths.length;
        endExtractAll({ frames: extractedCount });

        // [PERF] Addition to §3.2: frames are read off disk in one bulk
        // Promise.all here, NOT per-frame inside the mask loop, so the spec's
        // per-frame `read_ms` has no per-frame site. This span is the whole
        // read bucket.
        const endReadAll = perfSpan(jobId, 'apply.read_all');
        extractedBuffers = await Promise.all(
          extractedPaths.map(p => fs.readFile(p)),
        );
        endReadAll({ frames: extractedCount });
      }

      await storage.updateVideoJob(jobId, {
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        frameRate: metadata.frameRate,
        // totalFrames now reflects how many frames we actually extracted, not
        // the raw decoded frame count of the source video.
        totalFrames: extractedCount,
        status: 'processing',
        maskData,
        outputSettings
      });

      await this.updateProgress(jobId, {
        stage: 'processing',
        progress: 10,
        totalFrames: extractedCount
      });

      // ── 2B-3a: build the mask ONCE per apply ─────────────────────────
      // It used to be rebuilt inside every processFrameBatch call — 58 times
      // for this clip — and each build runs a synchronous ~1.2M-iteration JS
      // loop (createMaskFromBase64's red-dominance detection). That is what made
      // `mask_build_ms` climb linearly with stack index (734 ms → 5788 ms): 58
      // stacks queueing on the one thread that matters. The mask is a static
      // shape and every frame in an apply shares the source dimensions, so one
      // build serves the whole run.
      const prebuiltMask = await this.buildApplyMask(jobId, extractedBuffers[0], maskData);

      // ── Round 2C EXPERIMENT: ffmpeg apply engine ─────────────────────
      // Deliberately narrow (experiment doc §2): reuse path only (the frames
      // must already be the contiguous 1-indexed sequence in temp_extracted/),
      // JPEG output, original size, non-empty mask. Anything else — PNG output,
      // any resize/letterbox/crop, the re-extract fallback, image batches —
      // routes to the sharp engine exactly as today, so the experiment moves one
      // variable. A throw or an in≠out frame count also falls back to sharp.
      let ffmpegFrames: number | null = null;
      let bboxMask: BboxMask | null = null;
      const engine = resolveApplyEngine();
      const sizeIsOriginal = outputSettings.size === 'original'
        || (outputSettings.width === metadata.width && outputSettings.height === metadata.height);
      const ffmpegEligible = engine === 'ffmpeg'
        && !!reuse
        && !!prebuiltMask
        && prebuiltMask.maskedPixels > 0
        && outputSettings.format !== 'png'
        && sizeIsOriginal;

      if (engine === 'ffmpeg' && !ffmpegEligible) {
        perfMark(jobId, 'apply.engine', {
          engine: 'sharp',
          reason: !reuse ? 'not_reuse_path'
            : !prebuiltMask ? 'no_prebuilt_mask'
            : prebuiltMask.maskedPixels === 0 ? 'empty_mask'
            : outputSettings.format === 'png' ? 'png_output'
            : 'size_not_original',
        });
      }

      if (ffmpegEligible && prebuiltMask) {
        const endEngine = perfSpan(jobId, 'apply.engine', { engine: 'ffmpeg' });
        try {
          bboxMask = await writeBboxMask(jobId, prebuiltMask.width, prebuiltMask.maskedOffsets);
          if (!bboxMask) throw new Error('bbox mask is empty');

          // The output dir must exist and be empty before ffmpeg writes into it,
          // and the frame-count check below depends on it holding nothing else.
          await TempFolderManager.cleanupJobTempFolder(jobId);
          await TempFolderManager.createJobTempFolder(jobId);

          const t0 = Date.now();
          let lastEmit = 0;
          const written = await runFfmpegApply({
            rawDir: rawFramesDirFor(jobId),
            outDir: TempFolderManager.getJobTempFolder(jobId),
            mask: bboxMask,
            expectedFrames: extractedCount,
            onProgress: (framesDone) => {
              const now = Date.now();
              if (now - lastEmit < 500) return;
              lastEmit = now;
              const progress = 10 + Math.min(framesDone / Math.max(extractedCount, 1), 1) * 80;
              void this.updateProgress(jobId, {
                progress: Math.min(progress, 90),
                currentFrame: framesDone,
                fps: parseFloat((framesDone / Math.max((now - t0) / 1000, 0.001)).toFixed(1)),
                eta: 0,
              });
            },
          });

          if (written !== extractedCount) {
            throw new Error(`frame count mismatch: ${extractedCount} in, ${written} out`);
          }
          ffmpegFrames = written;
          endEngine({
            frames: written,
            qv: resolveQv(),
            bbox: `${bboxMask.width}x${bboxMask.height}+${bboxMask.x}+${bboxMask.y}`,
            masked_px: bboxMask.pixels,
            mask_path: bboxMask.filePath,
          });
        } catch (ffErr) {
          // Never fail an apply over the experiment. Fall through to sharp,
          // which re-cleans the output dir itself before its own save loop.
          const message = ffErr instanceof Error ? ffErr.message : String(ffErr);
          endEngine({ ok: false, error: message });
          console.error('⚠️  [2C] ffmpeg apply engine failed — falling back to sharp:', message);
          ffmpegFrames = null;
        }
      }

      // Round 2C: the ffmpeg engine has already written the masked frames
      // straight to the spoke dir, so the whole sharp mask loop and its save
      // loop are skipped. When it is not in play — the default, and every
      // fallback — the block below is exactly the deployed sharp path.
      let tempDir: string;
      let savedCount = 0;

      if (ffmpegFrames !== null) {
        tempDir = TempFolderManager.getJobTempFolder(jobId);
        savedCount = ffmpegFrames;
        await this.updateProgress(jobId, { stage: 'exporting', progress: 90 });
        console.log(`💾 [2C] ffmpeg engine wrote ${savedCount} frames to ${tempDir}`);
      } else {
        // Create frame batches OVER the already-extracted frame list
        const batchSize = outputSettings.batchSize || 12;
        const batches = this.createFrameBatches(extractedCount, batchSize);

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

        // Process batches in parallel — each batch gets a SLICE of the already
        // extracted frame buffers, so ffmpeg is never re-invoked here.
        const processedFrames = await this.processFrameBuffersInParallel(
          jobId,
          extractedBuffers,
          batches,
          maskData,
          outputSettings,
          prebuiltMask
        );

        await this.updateProgress(jobId, { stage: 'exporting', progress: 90 });

        // Persist processed frames to spokes/template_mask/{jobId}/ so the download route
        // can build the ZIP lazily when the user clicks download. Do NOT pre-build a ZIP.
        await TempFolderManager.cleanupJobTempFolder(jobId);
        await TempFolderManager.createJobTempFolder(jobId);
        tempDir = TempFolderManager.getJobTempFolder(jobId);
        // 2B addendum §A.2 — the extension follows the encoder. Default output is
        // JPEG, so the default extension is `.jpg`; `.png` only when the user
        // selected PNG. Before this, every masked frame was JPEG bytes in a
        // `.png` file. Consumers list masked frames by sorted `frame_*` prefix
        // (listFrameFiles accepts png/jpg/jpeg) and derive the extension from the
        // filename, so nothing downstream keys on a hardcoded `.png`.
        const ext = outputSettings.format === 'png' ? 'png' : 'jpg';
        savedCount = 0;
        // [PERF] Addition to §3.2: masked frames are written here, after the mask
        // loop, so the spec's per-frame `write_ms` has no per-frame site inside a
        // stack. This span is the whole write bucket.
        const endWriteAll = perfSpan(jobId, 'apply.write_all');
        for (const { frameNumber, buffer } of processedFrames) {
          if (!buffer || buffer.length === 0) continue;
          const filename = `frame_${String(frameNumber).padStart(6, '0')}.${ext}`;
          await fs.writeFile(path.join(tempDir, filename), buffer);
          savedCount++;
        }
        endWriteAll({ frames: savedCount, ext });
        console.log(`💾 Saved ${savedCount} processed frames to ${tempDir}`);
      }

      await storage.updateVideoJob(jobId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
      });

      // Write Job.templateMask completion state (Phase 4b).
      // Wrapped in try/catch — must not block the existing completion flow.
      try {
        const completedAt = new Date().toISOString();
        await storage.setTemplateMaskState(jobId, {
          status: 'complete',
          maskData,
          outputSettings,
          outputDir: TempFolderManager.getJobTempFolder(jobId),
          completedAt,
        });
      } catch (tmErr) {
        console.error('Failed to set templateMask state to complete:', tmErr);
      }

      await this.updateProgress(jobId, {
        stage: 'completed',
        progress: 100
      });

      reachedTerminal = true;
      endApply({ frames: savedCount, outcome: 'completed' });
      return tempDir;

    } catch (error) {
      console.error(`Error processing video ${jobId}:`, error);

      await storage.updateVideoJob(jobId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      // Write Job.templateMask failure state (Phase 4b).
      // Wrapped in try/catch — must not block the existing failure flow.
      try {
        await storage.setTemplateMaskState(jobId, {
          status: 'failed',
          maskData,
          outputSettings,
          outputDir: TempFolderManager.getJobTempFolder(jobId),
          completedAt: null,
        });
      } catch (tmErr) {
        console.error('Failed to set templateMask state to failed:', tmErr);
      }

      await this.updateProgress(jobId, {
        stage: 'failed',
        progress: 0,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      reachedTerminal = true;
      endApply({ frames: 0, outcome: 'failed' });
      throw error;
    } finally {
      // Reclaim ONLY the apply-time staging subdir (`_apply`). It holds the
      // transient re-extracted frames this run produced and must be cleared so
      // a subsequent apply at a different samplingFps can't read back stale
      // higher-numbered frames.
      //
      // Phase 4b-0: we intentionally do NOT delete the persistent raw-frame dir
      // (temp_extracted/<jobId>/frame_*.png) or the original upload here. Both
      // must survive so the user can re-draw and re-apply the mask (the upload
      // is what we re-extract from). They are reclaimed by the hourly sweep,
      // the SIGTERM purge, and cleanupJobArtifacts(jobId) within their existing
      // retention windows (uploads/ 2h, temp_extracted/ 6h).
      //
      // The delete goes through cleanupApplyStaging, which asserts the resolved
      // target ends with `${sep}_apply` and bounds it to the job's own
      // raw-frame dir, so it is provably unable to touch the persistent frames.
      // It swallows its own error so cleanup can never re-throw out of `finally`
      // and mask the original error or crash a background task.
      if (reachedTerminal) {
        try {
          await cleanupApplyStaging(jobId);
        } catch (cleanupErr) {
          console.warn(`⚠️  Failed to clean up apply staging dir ${extractedFramesDir}:`, cleanupErr);
        }
      }
    }
  }

  /**
   * 2B-3a — build the apply's mask raster once, from frame 0's dimensions.
   *
   * Returns null (rather than throwing) if anything goes wrong; the caller then
   * falls back to the pre-2B-3a per-stack build, so a mask-prebuild failure can
   * never fail an apply that would otherwise have worked.
   */
  private async buildApplyMask(
    jobId: string,
    firstFrame: Buffer,
    maskData: MaskData,
  ): Promise<ApplyMask | null> {
    const end = perfSpan(jobId, 'apply.mask_build');
    try {
      const meta = await Sharp(firstFrame).metadata();
      const width = meta.width || 0;
      const height = meta.height || 0;
      if (width <= 0 || height <= 0) {
        end({ ok: false, reason: 'no_dimensions' });
        return null;
      }

      const maskRgba = await this.createMaskRgbaBuffer(maskData, width, height);

      // 2B-3a hotfix: flatten the binary mask alpha into a list of byte offsets
      // into a raw 3-channel frame. The old loop's cost was dominated by the
      // SCAN (1.2 M alpha tests per frame), not the writes (1,494 on the prod
      // clip); the offset list removes the scan entirely. Worst case — the whole
      // frame drawn — the list is every pixel, which is exactly the old loop's
      // cost, so this is never slower.
      //
      // This runs once per apply, so the scan below is paid once, not 348 times.
      const pixels = width * height;
      const offsets = new Uint32Array(pixels);
      let maskedPixels = 0;
      for (let i = 0; i < pixels; i++) {
        // The old loop tested `alpha > 0` (binary), so this reproduces it exactly.
        if (maskRgba[i * 4 + 3] > 0) offsets[maskedPixels++] = i * 3;
      }
      const maskedOffsets = offsets.subarray(0, maskedPixels);

      end({
        ok: true, w: width, h: height,
        masked_px: maskedPixels, total_px: pixels, offsets: maskedOffsets.length,
      });
      console.log(`🎭 Mask built once for this apply: ${width}x${height}, ${maskedPixels}/${pixels} px masked (${((maskedPixels / pixels) * 100).toFixed(2)}%)`);
      return { width, height, maskRgba, maskedOffsets, maskedPixels };
    } catch (err) {
      end({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Round 2B-1 — decide whether the apply can mask the raw frames already on
   * disk instead of decoding the original upload a second time.
   *
   * Returns the frame buffers on success, or `null` to mean "fall through to
   * the existing re-extract path". Every rejection is logged as
   * `[PERF] apply.source {mode:'reextract', reason}` so a fallback in prod is
   * diagnosable from the log alone rather than looking like a silent no-op.
   *
   * The four guards, in the order they can fail:
   *
   * 1. `samplingFps == null`. Background extraction always runs at the native
   *    rate, so a sampled apply (`-vf fps=N`) must still re-extract — reusing
   *    native frames would silently produce a different frame set than the user
   *    asked for. NOT in the 2B proposal; added because it is a correctness
   *    hazard, not an optimization detail. Today the UI always sends null.
   * 2. `jobV2.status === 'ready'`. The V2 status (not the legacy VideoJob one)
   *    because `mapVideoJobStatusToJobStatus` folds ready/masking/processing/
   *    completed into `ready` — so a redo apply on a `completed` job still
   *    qualifies, which is exactly the case the 2B test matrix re-runs.
   * 3. Frame count equals the job's `totalFrames`, and is > 0. A short or
   *    swept directory must never be masked as if it were the whole clip.
   * 4. Every file carries a PNG IEND trailer (the Round 2A `isCompletePngBuffer`
   *    guard). Belt-and-braces: `ready` already means the writes finished.
   *
   * Co-indexing: the buffers come back in `listRawFrameFiles` order — the same
   * sorted, positional index the frames endpoint, the AI raw-frame fallback and
   * the run download already use. Masked frame i is therefore derived from the
   * exact frame the user drew on.
   */
  private async tryReuseRawFrames(
    jobId: string,
    samplingFps: number | null,
  ): Promise<{ buffers: Buffer[]; source: Job['source'] } | null> {
    const reject = (reason: string, extra: Record<string, unknown> = {}) => {
      perfMark(jobId, 'apply.source', { mode: 'reextract', reason, ...extra });
      return null;
    };

    try {
      if (samplingFps != null) return reject('sampling_fps', { samplingFps });

      const jobV2 = await storage.getJobV2(jobId);
      if (!jobV2) return reject('no_job_v2');
      if (jobV2.status !== 'ready') return reject('status_not_ready', { status: jobV2.status });

      const expected = jobV2.source?.totalFrames ?? 0;
      const { dir, files } = await listRawFrameFiles(jobId);
      if (!files.length) return reject('no_raw_frames', { expected });
      if (expected <= 0) return reject('unknown_expected', { have: files.length });
      if (files.length !== expected) {
        return reject('count_mismatch', { have: files.length, expected });
      }

      const endReadAll = perfSpan(jobId, 'apply.read_all', { source: 'reuse' });
      const buffers = await Promise.all(files.map(f => fs.readFile(path.join(dir, f))));
      endReadAll({ frames: buffers.length });

      // A torn file means some write never finished; masking half a frame is
      // worse than paying for the re-extract.
      const tornIdx = buffers.findIndex(b => !isCompletePngBuffer(b));
      if (tornIdx !== -1) return reject('torn_png', { i: tornIdx, file: files[tornIdx] });

      perfMark(jobId, 'apply.source', { mode: 'reuse', frames: buffers.length });
      return { buffers, source: jobV2.source };
    } catch (err) {
      // Reuse is an optimization; it must never be the reason an apply fails.
      return reject('error', { message: err instanceof Error ? err.message : String(err) });
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
    // Snapshot upload paths so finally can reclaim them regardless of which
    // image triggered the failure. We delete them only after a terminal state
    // is reached so retries that recover mid-flight don't lose source data.
    const uploadPathsToReclaim = [...imageFiles];
    let reachedTerminal = false;

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

      // Frames are already saved to spokes/template_mask/{jobId}/ by TempFolderManager.saveProcessedImage
      // above. Do NOT pre-build a ZIP here — the download route builds it lazily with the
      // correct subfolder structure and any optional add-ons requested via query params.
      const tempDir = TempFolderManager.getJobTempFolder(jobId);
      console.log(`💾 Image batch frames available at ${tempDir}`);

      await storage.updateVideoJob(jobId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
      });

      // Write Job.templateMask completion state (Phase 4b).
      try {
        const completedAt = new Date().toISOString();
        await storage.setTemplateMaskState(jobId, {
          status: 'complete',
          maskData,
          outputSettings,
          outputDir: TempFolderManager.getJobTempFolder(jobId),
          completedAt,
        });
      } catch (tmErr) {
        console.error('Failed to set templateMask state to complete (images):', tmErr);
      }

      await this.updateProgress(jobId, {
        stage: 'completed',
        progress: 100
      });

      reachedTerminal = true;
      return tempDir;

    } catch (error) {
      console.error(`Error processing images ${jobId}:`, error);

      await storage.updateVideoJob(jobId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      // Write Job.templateMask failure state (Phase 4b).
      try {
        await storage.setTemplateMaskState(jobId, {
          status: 'failed',
          maskData,
          outputSettings,
          outputDir: TempFolderManager.getJobTempFolder(jobId),
          completedAt: null,
        });
      } catch (tmErr) {
        console.error('Failed to set templateMask state to failed (images):', tmErr);
      }

      await this.updateProgress(jobId, {
        stage: 'failed',
        progress: 0,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      reachedTerminal = true;
      throw error;
    } finally {
      // Reclaim uploaded source images regardless of success/failure. Each
      // delete is bounded to UPLOADS_DIR by deleteUploadFile, and each
      // swallows its own errors so cleanup never re-throws out of `finally`.
      if (reachedTerminal) {
        for (const p of uploadPathsToReclaim) {
          await deleteUploadFile(p);
        }
      }
    }
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

  /**
   * Apply the template mask to an in-memory list of pre-extracted frame
   * buffers. Mirrors processBatchesInParallel but does NOT call ffmpeg per
   * batch — it slices `extractedBuffers` instead, so the parallel batches
   * can never race over the same physical frames or duplicate them.
   *
   * The list of `batches` defines the slice ranges over `extractedBuffers`.
   */
  private async processFrameBuffersInParallel(
    jobId: string,
    extractedBuffers: Buffer[],
    batches: Array<{ start: number; end: number }>,
    maskData: MaskData,
    outputSettings: OutputSettings,
    prebuiltMask: ApplyMask | null = null,
  ): Promise<Array<{ frameNumber: number; buffer: Buffer }>> {
    console.log(`=== PROCESSING ${extractedBuffers.length} PRE-EXTRACTED FRAMES IN ${batches.length} BATCH(ES) ===`);

    const processedFrames: Array<{ frameNumber: number; buffer: Buffer }> = [];
    const startTime = Date.now();
    let completedFrames = 0;

    // Resolve output size — same logic as processBatchesInParallel, condensed
    let outputSize: { width: number; height: number };
    if (outputSettings.width && outputSettings.height) {
      outputSize = { width: outputSettings.width, height: outputSettings.height };
    } else if (outputSettings.size === 'custom') {
      outputSize = { width: outputSettings.customWidth || 512, height: outputSettings.customHeight || 512 };
    } else if (outputSettings.size === 'original') {
      const job = await storage.getVideoJob(jobId);
      outputSize = { width: job?.width || 512, height: job?.height || 512 };
    } else if (outputSettings.size && typeof outputSettings.size === 'string' && outputSettings.size.includes('x')) {
      const [w, h] = outputSettings.size.split('x').map(Number);
      outputSize = { width: w, height: h };
    } else {
      outputSize = { width: 512, height: 512 };
    }

    const totalFrames = extractedBuffers.length;
    const VOLUME_BATCH_SIZE = 8;
    // [PERF] §3.2 `apply.stack` — monotonic across the whole apply, so stacks
    // stay distinguishable even though the outer batches run concurrently.
    let perfStackIdx = 0;

    const batchPromises = batches.map(async (batch, batchIndex) => {
      const frameBuffers = extractedBuffers.slice(batch.start, batch.end + 1);
      const batchResults: Array<{ success: boolean; processedBuffer: Buffer; error?: string; frameNumber: number }> = [];

      for (let volumeStart = 0; volumeStart < frameBuffers.length; volumeStart += VOLUME_BATCH_SIZE) {
        const volumeEnd = Math.min(volumeStart + VOLUME_BATCH_SIZE, frameBuffers.length);
        const volumeFrameBuffers = frameBuffers.slice(volumeStart, volumeEnd);

        const volumeTasks = volumeFrameBuffers.map((frameBuffer, index) => ({
          frameBuffer,
          maskData,
          outputSize,
          outputSettings,
          // Frame number is the absolute index in the extracted-frame list,
          // which is sequential and gap-free by construction.
          frameNumber: batch.start + volumeStart + index,
        }));

        const volumeResults = await this.processFrameBatch(volumeTasks, {
          jobId,
          stackIdx: perfStackIdx++,
          batchIdx: batchIndex,
        }, prebuiltMask);

        if (global.gc) global.gc();

        completedFrames += volumeResults.length;
        const progress = 10 + (completedFrames / totalFrames) * 80;
        const elapsed = (Date.now() - startTime) / 1000;
        const fps = completedFrames / elapsed;
        const eta = fps > 0 ? (totalFrames - completedFrames) / fps : 0;

        await this.updateProgress(jobId, {
          progress: Math.min(progress, 90),
          currentFrame: completedFrames,
          fps: parseFloat(fps.toFixed(1)),
          eta: Math.ceil(eta),
        });

        batchResults.push(...volumeResults);
      }

      console.log(`✅ Batch ${batchIndex} (frames ${batch.start}-${batch.end}) complete`);
      return batchResults;
    });

    const allBatchResults = await Promise.all(batchPromises);

    allBatchResults.forEach(batchResults => {
      batchResults.forEach(result => {
        if (result.success) {
          processedFrames.push({ frameNumber: result.frameNumber, buffer: result.processedBuffer });
        } else {
          console.log(`Frame ${result.frameNumber} failed: ${result.error}`);
          processedFrames.push({ frameNumber: result.frameNumber, buffer: Buffer.alloc(0) });
        }
      });
    });

    return processedFrames.sort((a, b) => a.frameNumber - b.frameNumber);
  }

  private async updateProgress(jobId: string, progress: Partial<ProcessingProgress>) {
    await storage.updateProcessingProgress(jobId, progress);
    
    // Emit progress update via WebSocket — scoped to the job's room so only
    // clients that joined this jobId receive its progress (clients join via
    // socket.on('join', jobId => socket.join(jobId)) in routes.ts). Mirrors the
    // AI path, which already uses io.to(jobId).emit(...).
    this.io.to(jobId).emit('progress', { jobId, ...progress });
    
    // Log progress for monitoring
    if (progress.stage === 'extracting') {
      console.log(`📊 EXTRACTION PROGRESS: ${progress.extractionProgress?.toFixed(1)}% - ${progress.status}`);
    }
  }

  async cleanup() {
    await this.frameExtractor.cleanup();
  }

  // 🚀 NEW: Background frame extraction immediately after upload
  async startBackgroundFrameExtraction(
    jobId: string,
    videoPath: string,
    totalFrames: number,
    // 2B-3b: the upload handler already branched on DICOM-ness, so it passes the
    // answer in rather than making us re-read the whole file to find it again
    // (isDicomFile reads the entire file to inspect 4 bytes). Omitted → detect.
    isDicomHint?: boolean,
  ): Promise<void> {
    // [PERF] Round 1 §3.2 (upload path). `bg_extract.done` is the span close.
    const bgT0 = Date.now();
    const endBgExtract = perfSpan(jobId, 'bg_extract.done');
    let firstFrameLogged = false;

    try {
      perfMark(jobId, 'bg_extract.start', { totalFrames });
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
      
      const isDicom = isDicomHint ?? await this.frameExtractor.isDicomFile(videoPath);

      // Raw frames are written to disk under temp_extracted/<jobId>/ (Phase 4b-0).
      // This replaces the volatile global.extractedFrames in-memory map: frames
      // now survive a PM2 restart and are read back by the frames endpoint and
      // the AI raw-frame fallback via listRawFrameFiles. Naming matches
      // extractAllFramesSequential's ffmpeg convention (1-indexed frame_%06d.png)
      // so the persistent store stays consistent with the apply pipeline.
      const rawDir = rawFramesDir(jobId);
      // Tripwire: crash loudly if a regression ever re-suffixes the jobId into a
      // nested temp_extracted/<jobId>/<jobId>/ path (the Phase 4b-0 symptom).
      assertNoSegmentDoubling(rawDir);
      // Tripwire (kickoff §149): log the literal resolved mkdir path.
      console.log(`🗂️  [raw-frames] mkdir ${path.resolve(rawDir)}`);
      await fs.mkdir(rawDir, { recursive: true });

      // The `bg_extract.first_frame_on_disk` probe is what Round 2A's
      // draw-while-extracting depends on, so it must measure the file actually
      // landing — not ffmpeg's internal frame counter. Poll for the file.
      const watchFirstFrame = (stop: { done: boolean }) => {
        const firstPath = path.join(rawDir, 'frame_000001.png');
        const tick = async () => {
          if (stop.done || firstFrameLogged) return;
          try {
            await fs.access(firstPath);
            firstFrameLogged = true;
            perfMark(jobId, 'bg_extract.first_frame_on_disk', {
              ms_since_start: Date.now() - bgT0,
            });
            return;
          } catch {
            setTimeout(tick, 100);
          }
        };
        void tick();
      };

      // Emit the SAME progress payload the batch loop emitted, so Round 2A's
      // Apply note and the hub panel keep working unchanged. Throttled: ffmpeg
      // reports more often than the old 23-batches-per-clip, and each emit is a
      // DB write plus a socket send.
      let extractedFrames = 0;
      let lastEmit = 0;
      let lastEmitted = -1;
      const emitProgress = async (framesDone: number, force = false) => {
        const now = Date.now();
        if (!force && (now - lastEmit < 500 || framesDone === lastEmitted)) return;
        lastEmit = now;
        lastEmitted = framesDone;
        const progress = totalFrames > 0 ? Math.min((framesDone / totalFrames) * 100, 100) : 0;
        await this.updateProgress(jobId, {
          stage: 'extracting',
          currentFrame: framesDone,
          totalFrames,
          extractionProgress: progress,
          status: `Extracted ${framesDone}/${totalFrames} frames (${progress.toFixed(1)}%)`,
        });
      };

      if (isDicom) {
        // ── DICOM: unchanged per-frame loop in 15-frame batches ────────
        // extractFrameBatch is the only path that can read a DICOM container;
        // ffmpeg cannot demux one. 2B-3b is explicitly MP4-only.
        const batchSize = 15;
        for (let start = 0; start < totalFrames; start += batchSize) {
          const end = Math.min(start + batchSize - 1, totalFrames - 1);
          try {
            console.log(`🗢️ Extracting batch: frames ${start}-${end}`);
            const batchFrames = await this.frameExtractor.extractFrameBatch(videoPath, start, end);

            // Persist each frame to disk. Frame numbering is 1-indexed to match
            // ffmpeg's %06d output, so background-extracted frame 0 → frame_000001.png.
            // jobId is a server-generated UUID (not user input); the read helpers
            // additionally bound every path against TEMP_EXTRACTED_DIR.
            await Promise.all(
              batchFrames.map((frameBuffer, index) => {
                const padded = String(start + index + 1).padStart(6, '0');
                return fs.writeFile(path.join(rawDir, `frame_${padded}.png`), frameBuffer);
              }),
            );

            if (!firstFrameLogged) {
              firstFrameLogged = true;
              perfMark(jobId, 'bg_extract.first_frame_on_disk', {
                ms_since_start: Date.now() - bgT0,
                batchFrames: batchFrames.length,
              });
            }

            extractedFrames += batchFrames.length;
            await emitProgress(extractedFrames, true);
            console.log(`✅ Batch complete: ${extractedFrames}/${totalFrames} frames`);
          } catch (batchError) {
            console.error(`❌ Batch extraction failed:`, batchError);
            // Continue with other batches rather than failing completely
          }
        }
      } else {
        // ── MP4: one ffmpeg pass (2B-3b) ───────────────────────────────
        // Round 1 measured the 15-frame batch extractor at 131 ms/frame against
        // 56 ms/frame for the apply-time single pass on the same file — the
        // batch loop pays a seek and a process spawn per batch. Same muxer,
        // same 1-indexed frame_%06d.png naming, same native rate, so what lands
        // on disk is indistinguishable from what the apply path would write.
        const stop = { done: false };
        watchFirstFrame(stop);
        try {
          extractedFrames = await this.frameExtractor.extractAllFramesSinglePass(
            videoPath,
            rawDir,
            (framesDone) => { void emitProgress(framesDone); },
          );
        } finally {
          stop.done = true;
        }
        await emitProgress(extractedFrames, true);
        console.log(`✅ Single-pass extraction complete: ${extractedFrames}/${totalFrames} frames`);
      }
      
      console.log(`🎉 BACKGROUND EXTRACTION COMPLETE: ${extractedFrames} frames written to ${rawDir}`);

      // 2B-3b parity tripwire. The Round 2B-1 reuse guard requires
      // `files.length === totalFrames`; if the single pass decodes a different
      // count than the upload-time estimate (floor(duration x frameRate) — wrong
      // for VFR and for any clip whose real frame count isn't that product),
      // every apply falls back to re-extraction and 2B-1's 19.5 s saving is lost
      // on every apply, forever, for that job.
      //
      // So: reconcile totalFrames to what is actually on disk, exactly as
      // processVideo already does after its own extraction (`totalFrames:
      // extractedCount`). `totalFrames` is ONE shared column in PgStorage, read
      // by both rowToVideoJob (:469) and rowToJob's `source.totalFrames` (:498),
      // so this single existing-write-path call updates both facets. No schema
      // change, no new column.
      //
      // The warning and `parity: false` stay regardless — reconciling the count
      // must not make the divergence invisible; it is still worth knowing that
      // the upload-time estimate was wrong for this clip.
      //
      // Ordering matters: this lands BEFORE status flips to `ready`, so an apply
      // fired the instant the tile unlocks already reads the corrected count.
      let parityCorrected = false;
      if (extractedFrames !== totalFrames) {
        console.warn(
          `⚠️  [parity] extracted ${extractedFrames} frames but job.totalFrames is ${totalFrames}`,
        );
        if (!isDicom) {
          await storage.updateVideoJob(jobId, { totalFrames: extractedFrames });
          parityCorrected = true;
          console.warn(`⚠️  [parity] totalFrames reconciled to ${extractedFrames} so apply-time reuse still applies`);
        } else {
          // DICOM is NOT reconciled. Its totalFrames comes from
          // detectDicomFrameCount, which is exact — so a mismatch here means the
          // per-batch catch above swallowed a real extraction failure and frames
          // are genuinely MISSING. Rewriting the count would make the reuse
          // guard accept a short frame set and silently mask/export fewer frames
          // than the source has. A short DICOM set must keep failing the guard.
          console.warn(`⚠️  [parity] DICOM count NOT reconciled — a short set means frames failed to extract`);
        }
      }
      endBgExtract({
        frames: extractedFrames,
        expected: totalFrames,
        parity: extractedFrames === totalFrames,
        corrected: parityCorrected,
        path: isDicom ? 'dicom-batch' : 'ffmpeg-single-pass',
        outcome: 'ok',
      });

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
      endBgExtract({ frames: 0, outcome: 'failed' });
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
  }>,
  // [PERF] Round 1 §3.2. Optional and additive: only the template-mask apply
  // path (processFrameBuffersInParallel) passes it, so the images/legacy call
  // sites are unchanged and emit nothing.
  perf?: { jobId: string; stackIdx: number; batchIdx: number },
  // 2B-3a: the mask built once per apply. Null (or a dimension mismatch) falls
  // back to the pre-2B-3a per-stack build below.
  prebuiltMask: ApplyMask | null = null,
  ): Promise<Array<{ success: boolean; processedBuffer: Buffer; error?: string; frameNumber: number }>> {
    const endStack = perf
      ? perfSpan(perf.jobId, 'apply.stack', {
          stackIdx: perf.stackIdx,
          batchIdx: perf.batchIdx,
          stackSize: tasks.length,
          firstFrame: tasks[0]?.frameNumber ?? -1,
        })
      : null;
    // Per-frame decode happens in Step 1 (sequential) and the mask/encode in
    // Step 3, so decode times are parked here and emitted with the rest of the
    // frame's `apply.frame` line.
    const decodeMs: number[] = [];

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
        const tDecode = process.hrtime.bigint();
        const image = Sharp(task.frameBuffer);
        const metadata = await image.metadata();
        const frameRgb = await image.raw().toBuffer({ resolveWithObject: true });
        decodeMs.push(Number(process.hrtime.bigint() - tDecode) / 1e6);

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
      
      // 2B-3a: normally the mask arrives prebuilt (one build per apply). The
      // per-stack build survives only as the fallback for a stack whose frames
      // don't match frame 0's dimensions, or if the prebuild failed.
      const maskFits = !!prebuiltMask
        && prebuiltMask.width === volumeWidth
        && prebuiltMask.height === volumeHeight;
      let maskRgba: Buffer;
      let maskedOffsets: Uint32Array | null = null;
      let maskedPixelsTotal: number;
      let maskBuildMs = 0;
      if (maskFits && prebuiltMask) {
        maskRgba = prebuiltMask.maskRgba;
        maskedOffsets = prebuiltMask.maskedOffsets;
        maskedPixelsTotal = prebuiltMask.maskedPixels;
      } else {
        console.log('🎭 Creating volumetric mask for entire batch (fallback — no usable prebuilt mask)...');
        const tMaskBuild = process.hrtime.bigint();
        maskRgba = await this.createMaskRgbaBuffer(firstTask.maskData, volumeWidth, volumeHeight);
        maskBuildMs = Number(process.hrtime.bigint() - tMaskBuild) / 1e6;
        maskedPixelsTotal = -1; // counted per frame by the JS loop below
      }
      console.log(`🎭 Mask ${maskFits ? 'reused (prebuilt once per apply)' : 'rebuilt for this stack'}: ${maskRgba.length} bytes, applied to ${volumeDepth} layers`);
      
      // Step 3: Apply mask transformation to entire 3D volume simultaneously  
      console.log('⚡ Applying volumetric mask transformation...');
      const processedFrames: Buffer[] = [];
      const imageChannels = frameMetadata[0].channels;
      const pixelsPerFrame = (volumeWidth * volumeHeight);
      
      // Process all frames in parallel using the same mask
      const volumeProcessingPromises = frameBuffers.map(async (framePixels, frameIndex) => {
        const frameNumber = tasks[frameIndex].frameNumber;
        // 2B-3a hotfix: mask by offset list. The original loop's cost was the
        // SCAN — 1.2 M alpha tests per frame — not the writes, of which the prod
        // clip has 1,494 (0.12 % of the frame). `maskedOffsets` is built once per
        // apply, so per frame we touch only the pixels that actually change.
        //
        // This replaces 2B-3a's libvips composite, which measured WORSE on the
        // deployed t3.large (apply.done 13.4 s → 19.3 s): composite + removeAlpha
        // premultiplies, blends and unpremultiplies the WHOLE frame, so it did
        // far more arithmetic than the loop it replaced, on one physical core.
        // Cost must scale with masked pixels, not with the frame.
        //
        // The full scan survives only for a frame WITH an alpha channel, where
        // the old loop zeroed RGB but left A untouched and 3-channel offsets
        // would not line up. Extracted frames are RGB (ffmpeg -pix_fmt rgb24;
        // the DICOM writer emits 3-channel), so that is a guard, not a live path.
        const useOffsets = maskedOffsets !== null && imageChannels === 3;
        let maskedPixels = maskedPixelsTotal;
        const tMask = process.hrtime.bigint();
        if (useOffsets && maskedOffsets) {
          // Exactly the old loop's write (`RGB = 0`), restricted to the pixels
          // where it did anything.
          for (let k = 0; k < maskedOffsets.length; k++) {
            const o = maskedOffsets[k];
            framePixels[o] = 0;     // Red = 0 (black)
            framePixels[o + 1] = 0; // Green = 0 (black)
            framePixels[o + 2] = 0; // Blue = 0 (black)
          }
        } else {
          maskedPixels = 0;
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
        }

        const maskMs = Number(process.hrtime.bigint() - tMask) / 1e6;

        console.log(`\u{1F3AF} Frame ${frameNumber}: ${maskedPixels}/${pixelsPerFrame} pixels masked (${((maskedPixels/pixelsPerFrame)*100).toFixed(2)}%) [${useOffsets ? 'offsets' : 'js'}]`);

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
        
        // Convert to final format (2B addendum §A.1). The encoder now follows
        // `outputSettings.format` instead of being unconditionally JPEG while the
        // filename claimed `.png`. Default stays JPEG q90 — byte-identical output
        // for the default path — and PNG is chosen explicitly by the user.
        // compressionLevel 3 is the measured sweet spot (ROUND2B_REPORT.md §3):
        // ~7 ms / ~332 KB, versus ~14 ms / ~311 KB at libvips' default level 6.
        const outFormat: 'png' | 'jpeg' = outputSettings.format === 'png' ? 'png' : 'jpeg';
        const tEncode = process.hrtime.bigint();
        const outputBuffer = outFormat === 'png'
          ? await processedImage.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer()
          : await processedImage.jpeg({ quality: 90 }).toBuffer();
        const encodeMs = Number(process.hrtime.bigint() - tEncode) / 1e6;

        // [PERF] §3.2 `apply.frame`. `read_ms`/`write_ms` are absent by
        // construction — the disk read is one bulk Promise.all before the loop
        // (`apply.read_all`) and the write is one loop after it
        // (`apply.write_all`). `decode_ms` is the Sharp decode to raw pixels
        // (Step 1), `mask_ms` the synchronous pixel loop, `encode_ms` the
        // resize + JPEG encode. H3 is decided by encode_ms vs mask_ms here.
        if (perf) {
          perfMark(perf.jobId, 'apply.frame', {
            i: frameNumber,
            stackIdx: perf.stackIdx,
            decode_ms: +(decodeMs[frameIndex] ?? 0).toFixed(1),
            mask_ms: +maskMs.toFixed(1),
            mask_mode: useOffsets ? 'offsets' : 'js',
            encode_ms: +encodeMs.toFixed(1),
            fmt: outFormat,
            w: volumeWidth,
            h: volumeHeight,
            out_bytes: outputBuffer.length,
          });
        }

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

      endStack?.({
        decode_ms: +decodeMs.reduce((a, b) => a + b, 0).toFixed(1),
        // §2B-3a.1: the mask is built once per apply now (`apply.mask_build`),
        // so this only appears when the per-stack fallback fired.
        mask_source: maskFits ? 'prebuilt' : 'per_stack',
        ...(maskFits ? {} : { mask_build_ms: +maskBuildMs.toFixed(1) }),
        outcome: 'ok',
      });
      return results;

    } catch (error) {
      console.error('❌ Batch volumetric processing failed:', error);
      endStack?.({ outcome: 'failed' });
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
