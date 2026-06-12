import type { Express } from "express";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import multer from "multer";
import { storage } from "./storage";
import { insertVideoJobSchema, type FileInfo, type AiLabel, type AIRun, type Job } from "@shared/schema";
import { VideoProcessor } from "./services/videoProcessor";
import { FrameExtractor } from "./services/frameExtractor";
import { IntentParser } from "./services/intentParser";
import { AIInferenceClient } from "./services/aiInferenceClient";
import { ModelRouter } from "./services/modelRouter";
import {
  deleteUploadFile,
  sweepDirectory,
  safeDelete,
  cleanupJobArtifacts,
  SWEEP_TARGETS,
  SPOKE_AI_DIR,
  SPOKE_TEMPLATE_MASK_DIR,
} from "./services/cleanup";
import {
  resolveFramePath,
  tempDirExists,
  countFrames,
  listFrameFiles,
  listRawFrameFiles,
  colorForLabelId,
} from "./services/frameAccess";
import Sharp from "sharp";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import archiver from "archiver";
import { applyTemplateMask } from "./handlers/templateMaskApply";

// ── Helpers for AI run → label lookup ────────────────────────────────────

/**
 * Walk `job.ai.runs[*].labels` to find which run contains a given labelId.
 * Returns the run or undefined if no match. O(runs × labels-per-run) —
 * fine at single-tenant scale.
 */
function findRunByLabelId(runs: AIRun[], labelId: string): AIRun | undefined {
  return runs.find(r => r.labels.some(l => l.id === labelId));
}


const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'video/mp4',
      'video/quicktime', // .mov
      'video/x-msvideo', // .avi
      'application/dicom' // .dcm
    ];
    
    if (allowedMimes.includes(file.mimetype) || 
        file.originalname.match(/\.(mp4|mov|avi|dcm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, AVI, and DICOM files are allowed.'));
    }
  }
});

const imageUpload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit per image
    files: 10000, // Support up to 10,000 files
    fields: 10000, // Support up to 10,000 fields
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/png',
      'image/jpeg',
      'image/jpg'
    ];
    
    if (allowedMimes.includes(file.mimetype) || 
        file.originalname.match(/\.(png|jpg|jpeg)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG and JPG files are allowed.'));
    }
  }
});

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  
  // Initialize Socket.IO for real-time progress updates
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Store Socket.IO globally for use in mask endpoint
  (global as any).socketIo = io;

  // Initialize video processor with Socket.IO
  const videoProcessor = new VideoProcessor(io);
  const frameExtractor = new FrameExtractor();

  // Test endpoint to verify POST requests reach backend
  app.post("/api/test-post", async (req, res) => {
    console.log('\n🧪 TEST POST ENDPOINT HIT!');
    console.log('==========================');
    console.log('Body:', req.body);
    console.log('==========================\n');
    res.json({ success: true, message: 'Test POST received' });
  });

  // Test non-API route to verify it bypasses Vite
  app.post("/test-non-api", async (req, res) => {
    console.log('\n🧪 TEST NON-API ENDPOINT HIT!');
    console.log('==============================');
    console.log('Body:', req.body);
    console.log('==============================\n');
    res.json({ success: true, message: 'Non-API route works!' });
  });

  // This endpoint has been moved to server/index.ts to avoid Vite interception

  // Upload video file and create job
  const videoUploadHandler: import('express').RequestHandler = async (req, res) => {
    // If the client disconnects after multer finished writing but before we
    // returned a response, the partial-but-valid file at uploads/<hash> would
    // otherwise leak. Delete it on abort. Idempotent — a successful response
    // path that already deleted the file (or moved on) is unaffected.
    const uploadedPath = req.file?.path;
    req.on('aborted', () => { void deleteUploadFile(uploadedPath); });

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No video file uploaded" });
      }

      // Phase 3d: read optional phiStatus / attestationRecord from body
      const phiStatus: 'raw' | 'user_attested' = req.body.phiStatus === 'user_attested' ? 'user_attested' : 'raw';
      const rawAttestation = phiStatus === 'user_attested' ? req.body.attestationRecord : undefined;
      const attestationRecord = typeof rawAttestation === 'string' ? JSON.parse(rawAttestation) : rawAttestation;

      // Check if this is a DICOM file for optimized workflow
      const isDicom = await frameExtractor.isDicomFile(req.file.path);

      if (isDicom) {
        console.log('🏥 DICOM DETECTED: Starting optimized DICOM workflow');

        // STEP 1: Extract first frame IMMEDIATELY (fast DICOM first frame)
        const firstFrameBuffer = await frameExtractor.extractFirstFrame(req.file.path);

        // STEP 2: Extract only basic metadata quickly (no full analysis yet)
        const quickMetadata = await frameExtractor.extractVideoMetadata(req.file.path);

        // Create video job with initial data
        const jobData = {
          filename: req.file.originalname,
          filePath: req.file.path,
          originalSize: req.file.size,
          duration: quickMetadata.duration,
          width: quickMetadata.width,
          height: quickMetadata.height,
          frameRate: quickMetadata.frameRate,
          totalFrames: quickMetadata.totalFrames,
          status: 'extracting' as const, // Set to extracting immediately
          progress: 0,
          maskData: null,
          outputSettings: null
        };

        const job = await storage.createVideoJob(jobData);

        // Phase 3d: create hub-and-spoke Job record eagerly
        const extractionRate = typeof req.body.samplingFps === 'number' && req.body.samplingFps > 0
          ? req.body.samplingFps : quickMetadata.frameRate;
        await storage.createJobV2({
          id: job.id,
          filename: req.file.originalname,
          uploadedAt: new Date().toISOString(),
          phiStatus,
          ...(attestationRecord ? { attestationRecord } : {}),
          source: {
            duration: quickMetadata.duration,
            width: quickMetadata.width,
            height: quickMetadata.height,
            frameRate: quickMetadata.frameRate,
            totalFrames: quickMetadata.totalFrames,
            type: 'video',
          },
          extractionRate,
          status: 'extracting',
          errorMessage: null,
        });

        // STEP 3: Return first frame immediately to user for fast display
        res.json({
          jobId: job.id,
          metadata: {
            duration: quickMetadata.duration,
            width: quickMetadata.width,
            height: quickMetadata.height,
            frameRate: quickMetadata.frameRate,
            totalFrames: quickMetadata.totalFrames,
            filename: req.file.originalname,
            fileSize: req.file.size,
            isDicom: true
          },
          firstFrame: `data:image/png;base64,${firstFrameBuffer.toString('base64')}`
        });

        // STEP 4: Continue background processing asynchronously (pause/resume concept)
        console.log('🚀 DICOM: First frame displayed, continuing background extraction');
        const dicomFilePath = req.file.path;
        setImmediate(() => {
          videoProcessor.startBackgroundFrameExtraction(job.id, dicomFilePath, quickMetadata.totalFrames)
            .catch(error => {
              console.error('❌ DICOM background extraction failed:', error);
              // Extraction failed → job never becomes applyable, so no redo loop
              // depends on this upload. Reclaim it now (processVideo's finally no
              // longer deletes the upload as of Phase 4b-0).
              void deleteUploadFile(dicomFilePath);
            });
        });

        return; // Early return for DICOM files
      }

      // Standard video file workflow (MP4, MOV, AVI)
      console.log('🎬 STANDARD VIDEO: Starting regular video workflow');

      // Extract basic metadata
      const metadata = await frameExtractor.extractVideoMetadata(req.file.path);

      // Create video job
      const jobData = {
        filename: req.file.originalname,
        filePath: req.file.path,
        originalSize: req.file.size,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        frameRate: metadata.frameRate,
        totalFrames: metadata.totalFrames,
        status: 'uploaded' as const,
        progress: 0,
        maskData: null,
        outputSettings: null
      };

      const job = await storage.createVideoJob(jobData);

      // Phase 3d: create hub-and-spoke Job record eagerly
      const extractionRate = typeof req.body.samplingFps === 'number' && req.body.samplingFps > 0
        ? req.body.samplingFps : metadata.frameRate;
      await storage.createJobV2({
        id: job.id,
        filename: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        phiStatus,
        ...(attestationRecord ? { attestationRecord } : {}),
        source: {
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          frameRate: metadata.frameRate,
          totalFrames: metadata.totalFrames,
          type: 'video',
        },
        extractionRate,
        status: 'extracting',
        errorMessage: null,
      });

      // Extract first frame for masking
      const firstFrameBuffer = await frameExtractor.extractFirstFrame(req.file.path);

      // 🚀 START BACKGROUND EXTRACTION OF ALL FRAMES IMMEDIATELY
      console.log('🚀 STARTING BACKGROUND FRAME EXTRACTION FOR ALL', metadata.totalFrames, 'FRAMES');
      const stdFilePath = req.file.path;
      setImmediate(() => {
        videoProcessor.startBackgroundFrameExtraction(job.id, stdFilePath, metadata.totalFrames)
          .catch(error => {
            console.error('❌ Background extraction failed:', error);
            // Extraction failed → job never becomes applyable, so no redo loop
            // depends on this upload. Reclaim it now (processVideo's finally no
            // longer deletes the upload as of Phase 4b-0).
            void deleteUploadFile(stdFilePath);
          });
      });

      res.json({
        jobId: job.id,
        metadata: {
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          frameRate: metadata.frameRate,
          totalFrames: metadata.totalFrames,
          filename: req.file.originalname,
          fileSize: req.file.size
        },
        firstFrame: `data:image/png;base64,${firstFrameBuffer.toString('base64')}`
      });

    } catch (error) {
      console.error("Upload error:", error);
      // Reclaim the partial upload before responding — error path was previously
      // leaking the multer-written file at uploads/<hash> indefinitely.
      await deleteUploadFile(uploadedPath);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Upload failed"
      });
    }
  };
  app.post("/api/videos/upload", upload.single('video'), videoUploadHandler);   // legacy
  app.post("/api/uploads/video", upload.single('video'), videoUploadHandler);   // canonical

  // Upload multiple image files and create job
  const imageUploadHandler: import('express').RequestHandler = async (req, res) => {
    // Snapshot the multer-written paths BEFORE any await so the abort listener
    // and the catch block both have access even if the body-handler short-circuits.
    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) || [];
    const uploadedPaths = uploadedFiles.map(f => f.path);
    req.on('aborted', () => {
      for (const p of uploadedPaths) void deleteUploadFile(p);
    });

    try {
      const files = uploadedFiles;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No image files uploaded" });
      }

      // Phase 3d: read optional phiStatus / attestationRecord from body
      const phiStatus: 'raw' | 'user_attested' = req.body.phiStatus === 'user_attested' ? 'user_attested' : 'raw';
      const rawAttestation = phiStatus === 'user_attested' ? req.body.attestationRecord : undefined;
      const attestationRecord = typeof rawAttestation === 'string' ? JSON.parse(rawAttestation) : rawAttestation;

      // Get dimensions of the first image to set as base dimensions
      const firstImageMetadata = await frameExtractor.getImageDimensions(files[0].path);

      // Create file info array
      const fileList: FileInfo[] = [];
      for (const file of files) {
        const imageMeta = await frameExtractor.getImageDimensions(file.path);
        fileList.push({
          filename: file.filename,
          originalName: file.originalname,
          size: file.size,
          type: file.mimetype,
          width: imageMeta.width,
          height: imageMeta.height
        });
      }

      // Create image batch job
      const jobData = {
        filename: `${files.length}_images_batch`,
        filePath: files[0].path, // Use first image as primary
        originalSize: files.reduce((total, file) => total + file.size, 0),
        duration: 0, // No duration for images
        width: firstImageMetadata.width,
        height: firstImageMetadata.height,
        frameRate: 1, // 1 "frame" per image
        totalFrames: files.length,
        status: 'ready' as const, // Images are immediately ready
        progress: 0,
        maskData: null,
        outputSettings: null,
        jobType: 'images' as const,
        fileCount: files.length,
        fileList: fileList
      };

      const job = await storage.createVideoJob(jobData);

      // Phase 3d: create hub-and-spoke Job record eagerly
      await storage.createJobV2({
        id: job.id,
        filename: `${files.length}_images_batch`,
        uploadedAt: new Date().toISOString(),
        phiStatus,
        ...(attestationRecord ? { attestationRecord } : {}),
        source: {
          duration: 0,
          width: firstImageMetadata.width,
          height: firstImageMetadata.height,
          frameRate: 1,
          totalFrames: files.length,
          type: 'image_batch',
        },
        extractionRate: 1, // 1 "frame" per image — no sampling for image batches
        status: 'ready',
        errorMessage: null,
      });

      // Convert first image to base64 for display
      const firstImageBuffer = await frameExtractor.getImageAsBuffer(files[0].path);

      res.json({
        jobId: job.id,
        metadata: {
          duration: 0,
          width: firstImageMetadata.width,
          height: firstImageMetadata.height,
          frameRate: 1,
          totalFrames: files.length,
          filename: `${files.length} images`,
          fileSize: files.reduce((total, file) => total + file.size, 0),
          jobType: 'images',
          fileCount: files.length
        },
        firstFrame: `data:image/png;base64,${firstImageBuffer.toString('base64')}`
      });

    } catch (error) {
      console.error("Image upload error:", error);
      // Reclaim every partial upload from this batch before responding.
      for (const p of uploadedPaths) await deleteUploadFile(p);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Image upload failed"
      });
    }
  };
  app.post("/api/images/upload", imageUpload.array('images'), imageUploadHandler);   // legacy
  app.post("/api/uploads/images", imageUpload.array('images'), imageUploadHandler);  // canonical

  // Get job status and progress
  // Legacy: returns VideoJob + progress (unchanged from Phase 1)
  const getLegacyJobHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const progress = await storage.getProcessingProgress(req.params.jobId);

      res.json({
        job,
        progress
      });

    } catch (error) {
      console.error("Get job error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to get job"
      });
    }
  };
  app.get("/api/videos/:jobId", getLegacyJobHandler);  // legacy alias

  // Canonical: returns Job V2 (hub-and-spoke shape) from jobsV2 MemStorage
  const getJobV2Handler: import('express').RequestHandler = async (req, res) => {
    try {
      const job = await storage.getJobV2(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      res.json(job);
    } catch (error) {
      console.error("Get job V2 error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to get job"
      });
    }
  };
  app.get("/api/jobs/:jobId", getJobV2Handler);  // canonical — returns Job V2

  // Start video processing with mask data
  app.post("/api/videos/:jobId/process", async (req, res) => {
    try {
      const { maskData, outputSettings } = req.body;
      
      // Debug: Check what we received
      console.log('\n🚀 API ENDPOINT RECEIVED DATA:');
      console.log('============================');
      console.log('Request body keys:', Object.keys(req.body));
      console.log('Has maskData:', !!maskData);
      console.log('Has outputSettings:', !!outputSettings);
      
      if (maskData) {
        console.log('Mask data type:', maskData.type);
        console.log('Mask coordinates:', maskData.coordinates);
        console.log('Has canvasDataUrl:', !!maskData.canvasDataUrl);
        console.log('Canvas data URL length:', maskData.canvasDataUrl?.length || 0);
        console.log('Has imageDisplayInfo:', !!maskData.imageDisplayInfo);
        console.log('Has imageDimensions:', !!maskData.imageDimensions);
        console.log('Has originalCanvasDimensions:', !!maskData.originalCanvasDimensions);
      }
      
      if (outputSettings) {
        console.log('Output settings:', outputSettings);
      }
      console.log('============================\n');
      
      if (!maskData || !outputSettings) {
        return res.status(400).json({ 
          error: "maskData and outputSettings are required" 
        });
      }

      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // ✅ Allow processing from uploaded OR ready state (ready = background extraction complete)
      if (job.status !== 'uploaded' && job.status !== 'ready') {
        return res.status(400).json({ 
          error: `Job is in ${job.status} state, cannot start processing` 
        });
      }

      // Check job type and process accordingly
      if (job.jobType === 'images') {
        // Process image batch
        const fileList = job.fileList as FileInfo[];
        if (!fileList || fileList.length === 0) {
          return res.status(400).json({ error: "No image files found in job" });
        }
        
        // Construct file paths for images (they should be in the uploads directory)
        const imagePaths = fileList.map(file => `uploads/${file.filename}`);
        
        // Start image processing asynchronously
        videoProcessor.processImages(
          req.params.jobId,
          imagePaths,
          maskData,
          outputSettings
        ).catch(error => {
          console.error("Image processing error:", error);
        });
      } else {
        // Process video (default behavior)
        const videoPath = job.filePath;
        
        // Start processing asynchronously
        videoProcessor.processVideo(
          req.params.jobId, 
          videoPath, 
          maskData, 
          outputSettings
        ).catch(error => {
          console.error("Video processing error:", error);
        });
      }

      res.json({ 
        message: "Processing started",
        jobId: req.params.jobId 
      });

    } catch (error) {
      console.error("Start processing error:", error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to start processing" 
      });
    }
  });

  // Download processed ZIP — built lazily from spokes/template_mask/{jobId}/ on demand.
  // Optional query params: ?masks=true&overlays=true
  const templateMaskDownloadHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.status !== 'completed') {
        return res.status(400).json({
          error: `Job is in ${job.status} state, download not available`,
        });
      }

      // Read optional add-on flags from query params
      const includeMasks = req.query.masks === 'true';
      const includeOverlays = req.query.overlays === 'true';

      console.log(`📦 Building ZIP for job ${job.id} (masks: ${includeMasks}, overlays: ${includeOverlays})`);

      // Source of truth for processed frames is the template-mask spoke directory.
      // listFrameFiles handles path-traversal validation, dedup, and sorting.
      const { dir: tempDir, files: frameFiles } = await listFrameFiles(job.id);
      if (frameFiles.length === 0) {
        return res.status(404).json({ error: "Processed frames not found on disk" });
      }

      // Get approved AI labels from the job record
      const allLabels = ((job as any).aiLabels || []) as AiLabel[];
      const approvedLabels = allLabels.filter(l => l.approved);

      // Slugify a target string so it's safe as a filename fragment
      //   "Pleural Line" → "pleural_line"
      const slugifyTarget = (s: string): string => {
        const slug = (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        return slug || 'unknown';
      };

      // Per-label, per-frame path resolvers — artifacts live on disk under
      // spokes/ai/<jobId>/<runId>/. Build a lookup of labelId → run.outputDir.
      const allRuns = await storage.listAiRuns(job.id);
      const labelRunDirMap = new Map<string, string>();
      for (const r of allRuns) {
        for (const l of r.labels) labelRunDirMap.set(l.id, r.outputDir);
      }

      const getLabelFrameMaskPath = (label: AiLabel, frameIdx: number): string | null => {
        const dir = labelRunDirMap.get(label.id);
        if (!dir) return null;
        const p = path.join(dir, `mask_${frameIdx}.png`);
        return fs.existsSync(p) ? p : null;
      };
      const getLabelFrameOverlayPath = (label: AiLabel, frameIdx: number): string | null => {
        const dir = labelRunDirMap.get(label.id);
        if (!dir) return null;
        const p = path.join(dir, `overlay_${frameIdx}.png`);
        return fs.existsSync(p) ? p : null;
      };
      const getLabelFrameConfidence = (label: AiLabel, frameIdx: number): number | null => {
        const r = label.frameResults?.[frameIdx];
        if (r && typeof r.confidence === 'number') return r.confidence;
        return label.confidence ?? null;
      };

      // True if at least one approved label has at least one mask/overlay on disk
      const hasAnyMasks = includeMasks && approvedLabels.some(l => {
        const dir = labelRunDirMap.get(l.id);
        return dir ? fs.existsSync(path.join(dir, 'mask_0.png')) : false;
      });
      const hasAnyOverlays = includeOverlays && approvedLabels.some(l => {
        const dir = labelRunDirMap.get(l.id);
        return dir ? fs.existsSync(path.join(dir, 'overlay_0.png')) : false;
      });

      // Top-level AI labels in the manifest (unchanged top-level confidence is the first-frame one)
      const labelsForManifest = approvedLabels.map(l => ({
        id: l.id,
        intent: l.intent,
        target: l.target,
        modality: l.modality || null,
        confidence: l.confidence,
        model: l.model,
        approved: l.approved,
        bbox: l.bbox || null,
      }));

      // Per-frame AI labels are built below with each frame's individual confidence score

      // Derive split assignment from frame index (80/10/10 train/val/test)
      const determineSplit = (n: number): 'train' | 'val' | 'test' => {
        const mod = n % 10;
        if (mod <= 7) return 'train';
        if (mod === 8) return 'val';
        return 'test';
      };

      // Extract just the file extension — frame numbering uses sorted-list POSITION (i),
      // so we never trust the integer embedded in the filename.
      const fileExt = (filename: string): string => {
        const m = filename.match(/\.(\w+)$/);
        return (m && m[1]) || 'png';
      };

      const outputFormat = (job as any).outputSettings?.format || 'png';
      const manifestFrames = frameFiles.map((filename, i) => {
        // Each approved label carries THIS frame's individual confidence (from that
        // label's own frameResults), so multi-label exports show distinct scores
        // per label per frame rather than a shared value. Lookup is keyed by sorted
        // position `i` — the same key the inference loop wrote with.
        const perFrameLabels = approvedLabels.map(l => ({
          intent: l.intent,
          target: l.target,
          modality: l.modality || null,
          confidence: getLabelFrameConfidence(l, i),
          model: l.model,
          approved: l.approved,
          bbox: l.bbox || null,
        }));
        return {
          frame_number: i,
          filename: `frame_${String(i).padStart(4, '0')}.${outputFormat}`,
          split: determineSplit(i),
          has_mask: true,
          ai_labels: perFrameLabels,
        };
      });

      const manifest: Record<string, any> = {
        masquerade_version: '1.0',
        export_timestamp: new Date().toISOString(),
        job_id: job.id,
        source_filename: job.filename,
        total_frames: frameFiles.length,
        output_format: outputFormat,
        splits: { train: 0.8, val: 0.1, test: 0.1 },
        ai_labels: labelsForManifest,
        frames: manifestFrames,
      };

      // Build README.txt
      const splitCounts = { train: 0, val: 0, test: 0 };
      for (const f of manifestFrames) {
        if (f.split in splitCounts) splitCounts[f.split as keyof typeof splitCounts]++;
      }

      const aiLines = approvedLabels.length === 0
        ? 'AI Labels: none (manual mask)'
        : `AI Labels (${approvedLabels.length} approved):\n` +
          approvedLabels.map(l =>
            `  - ${l.target} (${l.intent}, ${l.model}, confidence ${l.confidence !== null ? (l.confidence * 100).toFixed(0) + '%' : 'N/A'})`
          ).join('\n');

      const readmeSections: string[] = [
        `images/`,
        `  Template-masked ultrasound frames with PHI and irrelevant markings removed.`,
        `  These are your primary training images.`,
        ``,
      ];
      if (hasAnyMasks) {
        readmeSections.push(
          `masks/`,
          `  One subfolder per analysis run, named analysis_N_<target>.`,
          `  Each subfolder contains one binary mask PNG per frame.`,
          `  White pixels = AI-detected region. Black = background.`,
          ``,
        );
      }
      if (hasAnyOverlays) {
        readmeSections.push(
          `overlays/`,
          `  One subfolder per analysis run, named analysis_N_<target>.`,
          `  Each subfolder contains one overlay PNG per frame (green highlight on image).`,
          ``,
        );
      }
      readmeSections.push(
        `manifest.json`,
        `  Per-frame AI label data including target structure, confidence score,`,
        `  and approval status. This is the primary AI output for programmatic use.`,
        ``,
        `metadata.csv`,
        `  Tabular summary of all frames and labels. Import into Excel or pandas.`,
      );

      const readme = [
        `=== Masquerade Export ===`,
        ``,
        `Export date: ${manifest.export_timestamp}`,
        `Source file: ${manifest.source_filename}`,
        `Total frames: ${manifest.total_frames}`,
        aiLines,
        `Splits: train=${splitCounts.train}, val=${splitCounts.val}, test=${splitCounts.test}`,
        ``,
        ...readmeSections,
      ].join('\n');

      // Build metadata.csv
      const aiTarget = approvedLabels.map(l => l.target).join('; ');
      const aiConfidence = approvedLabels.map(l => l.confidence !== null ? l.confidence.toString() : '').join('; ');
      const csvHeaders = ['filename', 'frame_number', 'split', 'ai_target', 'ai_confidence'];
      const csvRows = manifestFrames.map(f =>
        [f.filename, f.frame_number, f.split, `"${aiTarget}"`, `"${aiConfidence}"`].join(',')
      );
      const csv = [csvHeaders.join(','), ...csvRows].join('\n');

      // Stream the ZIP to the client
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="processed_${job.filename}.zip"`);

      // Intentionally NOT deleting spokes/template_mask/<jobId>/ here.
      // The frame viewer may need to read it after download. Folder is
      // reclaimed by the hourly retention sweep (24h) instead.

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err: Error) => {
        console.error('Archive build error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to build ZIP' });
        }
      });
      archive.pipe(res);

      // 1. manifest.json
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      // 2. README.txt
      archive.append(readme, { name: 'README.txt' });
      // 3. metadata.csv
      archive.append(csv, { name: 'metadata.csv' });

      // 4. Frames + optional per-label, per-frame mask/overlay companions.
      //    Organized into one subfolder per approved label (aka "analysis run"):
      //      masks/analysis_1_pleural_line/frame_000000_mask.png
      //      masks/analysis_2_effusion/frame_000000_mask.png
      //      overlays/analysis_1_pleural_line/frame_000000_overlay.png
      //      overlays/analysis_2_effusion/frame_000000_overlay.png
      //    Subfolder naming is stable across single-label and multi-label jobs.
      //    archiver auto-creates the directory entries when files are appended.
      const analysisFolders = approvedLabels.map((label, i) =>
        `analysis_${i + 1}_${slugifyTarget(label.target)}`
      );
      for (let i = 0; i < frameFiles.length; i++) {
        const filename = frameFiles[i];
        const ext = fileExt(filename);
        // Sorted-list position is the canonical frame number across the whole ZIP.
        const paddedNum = String(i).padStart(6, '0');
        const framePath = path.join(tempDir, filename);
        archive.file(framePath, { name: `images/frame_${paddedNum}.${ext}` });

        if (includeMasks) {
          for (let li = 0; li < approvedLabels.length; li++) {
            const maskPath = getLabelFrameMaskPath(approvedLabels[li], i);
            if (!maskPath) continue;
            archive.file(maskPath, {
              name: `masks/${analysisFolders[li]}/frame_${paddedNum}_mask.png`,
            });
          }
        }
        if (includeOverlays) {
          for (let li = 0; li < approvedLabels.length; li++) {
            const overlayPath = getLabelFrameOverlayPath(approvedLabels[li], i);
            if (!overlayPath) continue;
            archive.file(overlayPath, {
              name: `overlays/${analysisFolders[li]}/frame_${paddedNum}_overlay.png`,
            });
          }
        }
      }

      await archive.finalize();
      console.log(`✅ ZIP streamed to client for job ${job.id}`);

    } catch (error) {
      console.error("Download error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Download failed",
        });
      }
    }
  };
  app.get("/api/videos/:jobId/download", templateMaskDownloadHandler);            // legacy alias
  app.get("/api/jobs/:jobId/template-mask/download", templateMaskDownloadHandler); // canonical

  // ── AI: Parse natural language command into structured intent ──
  app.post("/api/ai/parse-intent", async (req, res) => {
    try {
      const { command } = req.body;

      if (!command || typeof command !== 'string' || command.trim().length === 0) {
        return res.status(400).json({ error: "command is required and must be a non-empty string" });
      }

      const parser = new IntentParser();
      const result = await parser.parse(command.trim());

      res.json(result);
    } catch (error) {
      console.error("Intent parsing error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to parse intent",
      });
    }
  });

  // ── AI: Run inference on a single frame ──────────────────────
  const aiInferHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const jobId = req.params.jobId ?? req.body.jobId;
      const { command, frameBase64, bbox, useAutoPrompt, modality } = req.body;

      if (!jobId || !command) {
        return res.status(400).json({
          error: "jobId and command are required",
        });
      }

      // Normalize modality — only accept the four known values, else treat as null
      const validModalities = new Set(['cardiac', 'lung', 'abdominal', 'other']);
      const resolvedModality: 'cardiac' | 'lung' | 'abdominal' | 'other' | null =
        (typeof modality === 'string' && validModalities.has(modality))
          ? (modality as 'cardiac' | 'lung' | 'abdominal' | 'other')
          : null;

      // 1. Fetch the job
      const job = await storage.getVideoJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // 2. Parse the command
      const parser = new IntentParser();
      const parsedIntent = await parser.parse(command.trim());
      console.log(`🧠 Parsed intent: ${parsedIntent.intent} → ${parsedIntent.target} (confidence: ${parsedIntent.confidence})`);

      if (parsedIntent.intent === 'clarify') {
        return res.json({ parsedIntent, maskBase64: null, confidence: 0, modelUsed: null, inferenceMs: 0 });
      }

      // 3. Collect frames for inference. Try template-masked frames first
      //    (spokes/template_mask/<jobId>/), then fall back to raw frames on disk
      //    (temp_extracted/<jobId>/, Phase 4b-0 — replaces the in-memory
      //    global.extractedFrames fallback). Hotfix 4: spoke independence — AI
      //    can run without a template mask applied.
      const { dir: tempDir, files: frameFileNames } = await listFrameFiles(jobId);

      // Check if raw frames are available as a fallback (on disk).
      const { dir: rawFrameDir, files: rawFrameFileNames } = await listRawFrameFiles(jobId);
      const useRawFrames = !frameFileNames.length && rawFrameFileNames.length > 0;

      // Fall back to request-body frame if neither masked nor raw frames exist
      const singleFrameFallback = !frameFileNames.length && !useRawFrames && frameBase64;
      if (!frameFileNames.length && !useRawFrames && !singleFrameFallback) {
        return res.status(400).json({
          error: "No frames available — upload and process a video first, or send frameBase64",
        });
      }

      // 4. Route to the best model
      const router = new ModelRouter();
      const modelConfig = router.route(parsedIntent);
      console.log(`🔀 Model router selected: ${modelConfig.id} (${modelConfig.name}) — type: ${modelConfig.type}, available: ${modelConfig.available}`);

      // 5. Create an AIRun record and output directory.
      const runId = randomUUID();
      const runOutputDir = path.join(SPOKE_AI_DIR, jobId, runId);
      await fsPromises.mkdir(runOutputDir, { recursive: true });

      // Phase 3d: Job record must exist (created eagerly at upload time).
      const jobV2 = await storage.getJobV2(jobId);
      if (!jobV2) {
        return res.status(400).json({ error: 'Job record not found — upload may have failed or server restarted since upload' });
      }
      const existingRuns = await storage.listAiRuns(jobId);
      const newLabelId = randomUUID();

      const run: AIRun = {
        id: runId,
        name: `Run ${existingRuns.length + 1}`,
        inputSource: useRawFrames ? 'raw' : 'template_mask',
        modality: resolvedModality,
        bbox: bbox && typeof bbox.x1 === 'number' ? { x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2 } : null,
        target: parsedIntent.target || 'unknown',
        outputDir: runOutputDir,
        labels: [],
        approved: false,
        createdAt: new Date().toISOString(),
      };
      await storage.addAiRun(jobId, run);

      // 6. Run inference on every frame, writing mask/overlay PNGs to disk per-frame.
      //    Base64 strings are decoded and written immediately, then discarded to keep
      //    heap usage bounded.
      const aiClient = new AIInferenceClient();

      const metaFrameResults: Record<number, { confidence: number }> = {};
      let firstResult: { maskBase64: string; overlayBase64?: string; confidence: number; modelUsed: string; inferenceMs: number } | null = null;
      const totalFrames = frameFileNames.length || rawFrameFileNames.length || 1;

      if (singleFrameFallback) {
        // Single-frame path (no temp folder yet)
        io?.to(jobId).emit('inference-progress', { jobId, current: 1, total: 1 });
        const r = await aiClient.infer({
          modelConfig,
          imageBase64: frameBase64,
          intent: parsedIntent,
          jobId,
          bbox: bbox || null,
          useAutoPrompt: typeof useAutoPrompt === 'boolean' ? useAutoPrompt : (bbox == null),
          modality: resolvedModality,
        });
        // Write mask/overlay to disk, discard base64 immediately
        const writes: Promise<void>[] = [];
        writes.push(fsPromises.writeFile(path.join(runOutputDir, 'mask_0.png'), Buffer.from(r.maskBase64, 'base64')));
        if (r.overlayBase64) writes.push(fsPromises.writeFile(path.join(runOutputDir, 'overlay_0.png'), Buffer.from(r.overlayBase64, 'base64')));
        await Promise.all(writes);
        metaFrameResults[0] = { confidence: r.confidence };
        firstResult = r;
      } else if (useRawFrames) {
        // Raw frames path (on disk in temp_extracted/<jobId>/, no template mask
        // applied). Phase 4b-0 — reads from disk instead of the in-memory
        // global.extractedFrames store. Hotfix 4.
        for (let i = 0; i < rawFrameFileNames.length; i++) {
          io?.to(jobId).emit('inference-progress', { jobId, current: i + 1, total: totalFrames });

          const b64 = (await fsPromises.readFile(path.join(rawFrameDir, rawFrameFileNames[i]))).toString('base64');

          const r = await aiClient.infer({
            modelConfig,
            imageBase64: b64,
            intent: parsedIntent,
            jobId,
            bbox: bbox || null,
            useAutoPrompt: typeof useAutoPrompt === 'boolean' ? useAutoPrompt : (bbox == null),
            modality: resolvedModality,
          });

          // Write mask/overlay to disk per-frame, discard base64 immediately
          const writes: Promise<void>[] = [];
          writes.push(fsPromises.writeFile(path.join(runOutputDir, `mask_${i}.png`), Buffer.from(r.maskBase64, 'base64')));
          if (r.overlayBase64) writes.push(fsPromises.writeFile(path.join(runOutputDir, `overlay_${i}.png`), Buffer.from(r.overlayBase64, 'base64')));
          await Promise.all(writes);

          metaFrameResults[i] = { confidence: r.confidence };
          if (i === 0) firstResult = r;
        }
      } else {
        // Masked frames path (on disk in spokes/template_mask/)
        for (let i = 0; i < frameFileNames.length; i++) {
          const filename = frameFileNames[i];

          io?.to(jobId).emit('inference-progress', { jobId, current: i + 1, total: totalFrames });

          const framePath = path.join(tempDir, filename);
          const b64 = fs.readFileSync(framePath).toString('base64');

          const r = await aiClient.infer({
            modelConfig,
            imageBase64: b64,
            intent: parsedIntent,
            jobId,
            bbox: bbox || null,
            useAutoPrompt: typeof useAutoPrompt === 'boolean' ? useAutoPrompt : (bbox == null),
            modality: resolvedModality,
          });

          // Write mask/overlay to disk per-frame, discard base64 immediately
          const writes: Promise<void>[] = [];
          writes.push(fsPromises.writeFile(path.join(runOutputDir, `mask_${i}.png`), Buffer.from(r.maskBase64, 'base64')));
          if (r.overlayBase64) writes.push(fsPromises.writeFile(path.join(runOutputDir, `overlay_${i}.png`), Buffer.from(r.overlayBase64, 'base64')));
          await Promise.all(writes);

          metaFrameResults[i] = { confidence: r.confidence };
          if (i === 0) firstResult = r;
        }
      }

      io?.to(jobId).emit('inference-progress', { jobId, current: totalFrames, total: totalFrames, done: true });

      if (!firstResult) {
        return res.status(500).json({ error: "Inference produced no results" });
      }

      // 7a. Build the AiLabel (metadata only — no base64 fields).
      const newLabel: AiLabel = {
        id: newLabelId,
        intent: parsedIntent.intent,
        target: parsedIntent.target || 'unknown',
        modality: resolvedModality,
        confidence: firstResult.confidence ?? null,
        model: firstResult.modelUsed || 'unknown',
        timestamp: new Date().toISOString(),
        approved: true,
        bbox: bbox && typeof bbox.x1 === 'number' ? { x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2 } : null,
        frameResults: metaFrameResults,
      };

      // 7b. Dual-write: push to BOTH the new AIRun.labels[] AND legacy job.aiLabels[].
      //     Frontend reads aiLabels; Phase 4 migrates to ai.runs.
      await storage.updateAiRun(jobId, runId, { labels: [newLabel] });

      const latestJob = await storage.getVideoJob(jobId);
      const existingLabels = ((latestJob as any)?.aiLabels || []) as AiLabel[];
      await storage.updateVideoJob(jobId, {
        aiLabels: [...existingLabels, newLabel] as any,
      });
      console.log(`🏷️  AI run "${run.name}" — label "${newLabel.target}" — artifacts at ${runOutputDir}`);

      // 8. Return the first-frame result (the UI only displays one preview overlay)
      res.json({
        parsedIntent,
        maskBase64: firstResult.maskBase64,
        overlayBase64: firstResult.overlayBase64,
        confidence: firstResult.confidence,
        modelUsed: firstResult.modelUsed,
        inferenceMs: firstResult.inferenceMs,
        framesProcessed: totalFrames,
        label: newLabel,
      });
    } catch (error) {
      console.error("AI inference error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "AI inference failed",
      });
    }
  };
  app.post("/api/ai/infer", aiInferHandler);              // legacy alias
  app.post("/api/jobs/:jobId/ai/runs", aiInferHandler);    // canonical

  // ── AI: Health check for the Python AI service ───────────────
  app.get("/api/ai/status", async (_req, res) => {
    try {
      const aiClient = new AIInferenceClient();
      const available = await aiClient.isAvailable();
      res.json({
        aiServiceAvailable: available,
        aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
      });
    } catch (error) {
      res.json({
        aiServiceAvailable: false,
        aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
      });
    }
  });

  // ── AI: List available models ─────────────────────────────────
  app.get("/api/ai/models", (_req, res) => {
    try {
      const router = new ModelRouter();
      res.json({ models: router.listModels() });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to load model registry",
      });
    }
  });

  // ── AI Labels: CRUD for session-based labels ─────────────────

  // GET all labels for a job
  app.get("/api/ai/labels/:jobId", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      res.json({ labels: ((job as any).aiLabels || []) as AiLabel[] });
    } catch (error) {
      console.error("Get labels error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get labels" });
    }
  });

  // PATCH toggle approved on a label
  const patchLabelHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const { approved } = req.body;
      if (typeof approved !== 'boolean') {
        return res.status(400).json({ error: "approved (boolean) is required" });
      }

      const jobId = req.params.jobId;
      const job = await storage.getVideoJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const labels = ((job as any).aiLabels || []) as AiLabel[];
      const idx = labels.findIndex(l => l.id === req.params.labelId);
      if (idx === -1) {
        return res.status(404).json({ error: "Label not found" });
      }

      labels[idx].approved = approved;
      await storage.updateVideoJob(jobId, { aiLabels: labels as any });

      // Dual-write: also update in the AIRun's labels[]
      const runs = await storage.listAiRuns(jobId);
      const matchedRun = req.params.runId
        ? runs.find(r => r.id === req.params.runId)
        : findRunByLabelId(runs, req.params.labelId);
      if (matchedRun) {
        const updatedLabels = matchedRun.labels.map(l =>
          l.id === req.params.labelId ? { ...l, approved } : l
        );
        await storage.updateAiRun(jobId, matchedRun.id, { labels: updatedLabels });
      }

      res.json({ label: labels[idx] });
    } catch (error) {
      console.error("Patch label error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update label" });
    }
  };
  app.patch("/api/ai/labels/:jobId/:labelId", patchLabelHandler);                              // legacy alias
  app.patch("/api/jobs/:jobId/ai/runs/:runId/labels/:labelId", patchLabelHandler);              // canonical

  // DELETE a label
  const deleteLabelHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const job = await storage.getVideoJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const labels = ((job as any).aiLabels || []) as AiLabel[];
      const filtered = labels.filter(l => l.id !== req.params.labelId);
      if (filtered.length === labels.length) {
        return res.status(404).json({ error: "Label not found" });
      }

      await storage.updateVideoJob(jobId, { aiLabels: filtered as any });

      // Also remove from AIRun + delete the run's output directory.
      // In Phase 3b each run has exactly one label, so deleting the label
      // is equivalent to deleting the entire run.
      const runs = await storage.listAiRuns(jobId);
      const matchedRun = req.params.runId
        ? runs.find(r => r.id === req.params.runId)
        : findRunByLabelId(runs, req.params.labelId);
      if (matchedRun) {
        try {
          await safeDelete(matchedRun.outputDir, SPOKE_AI_DIR);
        } catch (err) {
          console.warn(`⚠️  Failed to delete run output dir: ${matchedRun.outputDir}`, err instanceof Error ? err.message : err);
        }
        await storage.deleteAiRun(jobId, matchedRun.id);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Delete label error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete label" });
    }
  };
  app.delete("/api/ai/labels/:jobId/:labelId", deleteLabelHandler);                              // legacy alias
  app.delete("/api/jobs/:jobId/ai/runs/:runId/labels/:labelId", deleteLabelHandler);              // canonical

  // WebSocket connection handling
  io.on('connection', (socket) => {
    console.log('Client connected for progress updates');
    
    socket.on('join', (jobId) => {
      socket.join(jobId);
      console.log(`Client joined room for job ${jobId}`);
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  // ── Frame viewer (read-only) ─────────────────────────────────────────
  // These four endpoints feed the in-app frame viewer (Phase 4 of the
  // 5-step workflow). They never write to disk, never mutate job state,
  // and every filesystem path is bounded by frameAccess helpers.

  /**
   * GET /api/jobs/:jobId/viewer-info
   *   200: { jobId, totalFrames, status, labels[], hasFrames, hasInference, hasArtifacts }
   *   404: job record doesn't exist (typo'd jobId)
   *   410: job exists in MemStorage but spokes/template_mask/<jobId>/ has been
   *        swept by retention. UI should show "session expired" + offer rerun.
   */
  app.get("/api/jobs/:jobId/viewer-info", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const framesPresent = await tempDirExists(req.params.jobId);
      if (!framesPresent) {
        // 410 specifically signals "this used to exist, retention swept it"
        return res.status(410).json({
          error: "This session's frames are no longer available",
          reason: "frames_swept_by_retention",
        });
      }

      const totalFrames = await countFrames(req.params.jobId);
      const allLabels = ((job as any).aiLabels || []) as AiLabel[];

      // hasArtifacts is true if any completed AI run has mask files on disk.
      // Post-3b artifacts survive restarts, so this is essentially always true
      // for jobs with completed runs.
      const viewerRuns = await storage.listAiRuns(req.params.jobId);
      let hasArtifacts = false;
      for (const r of viewerRuns) {
        if (fs.existsSync(path.join(r.outputDir, 'mask_0.png'))) {
          hasArtifacts = true;
          break;
        }
      }

      const labels = allLabels.map(l => {
        const fr = l.frameResults || {};
        const confValues = Object.values(fr).map((v: any) => v.confidence).filter((c: any) => typeof c === 'number');
        const avg = confValues.length > 0
          ? confValues.reduce((a, b) => a + b, 0) / confValues.length
          : (l.confidence ?? 0);
        return {
          labelId: l.id,
          name: l.target,
          modality: l.modality || null,
          color: colorForLabelId(l.id),
          approved: l.approved,
          avgConfidence: avg,
          frameCount: confValues.length,
        };
      });

      res.json({
        jobId: job.id,
        totalFrames,
        status: job.status,
        labels,
        hasFrames: totalFrames > 0,
        hasInference: allLabels.length > 0,
        hasArtifacts,
      });
    } catch (error) {
      console.error("viewer-info error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load viewer info" });
    }
  });

  /**
   * GET /api/jobs/:jobId/frames/:n.png
   *
   * Streams the n-th processed frame. `n` is the 0-indexed sorted-list
   * position used by the inference loop and the manifest builder, so it
   * always matches the keys in inference.json.
   *
   * Cache-Control: private, max-age=3600 — the browser keeps frames in
   * its cache while the user scrubs back and forth without revalidating.
   * Marked private so intermediate proxies don't share frames between users.
   */
  app.get("/api/jobs/:jobId/frames/:n.png", async (req, res) => {
    try {
      const n = parseInt(req.params.n, 10);
      if (!Number.isInteger(n) || n < 0 || String(n) !== req.params.n) {
        return res.status(400).json({ error: "frame index must be a non-negative integer" });
      }

      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      if (!(await tempDirExists(req.params.jobId))) {
        return res.status(410).json({
          error: "This session's frames are no longer available",
          reason: "frames_swept_by_retention",
        });
      }

      const absPath = await resolveFramePath(req.params.jobId, n);
      if (!absPath) return res.status(404).json({ error: `frame ${n} not found` });

      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Type', 'image/png');
      // sendFile validates the absolute path; we already validated against
      // SPOKE_TEMPLATE_MASK_DIR in resolveFramePath, so this is doubly safe.
      res.sendFile(absPath, (err) => {
        if (err && !res.headersSent) {
          console.error('frame sendFile error:', err);
          res.status(500).end();
        }
      });
    } catch (error) {
      console.error("GET frame error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load frame" });
      }
    }
  });

  /**
   * GET /api/jobs/:jobId/inference.json
   *
   * Pivots `job.aiLabels` into a frame-indexed view the viewer can render:
   *   {
   *     imageWidth, imageHeight,
   *     labels: [{ labelId, name, modality, color, approved, avgConfidence, frameCount }],
   *     frames: { "<n>": [{ labelId, name, modality, confidence, bbox, approved, hasMask }] }
   *   }
   *
   * Bbox is in IMAGE pixel coords (whatever was stored on the AiLabel —
   * same coordinate system the GPU received). The viewer rescales to its
   * displayed image size client-side using imageWidth / imageHeight.
   *
   * No base64 blobs. Mask URLs are constructed client-side from labelId.
   */
  app.get("/api/jobs/:jobId/inference.json", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      if (!(await tempDirExists(req.params.jobId))) {
        return res.status(410).json({
          error: "This session's frames are no longer available",
          reason: "frames_swept_by_retention",
        });
      }

      const allLabels = ((job as any).aiLabels || []) as AiLabel[];

      // imageWidth/imageHeight are the dimensions in which AI bbox coords are
      // stored — i.e. SOURCE-VIDEO pixel space. CommandInput.toImagePixelBox
      // scales drawn boxes by videoMetadata.width/height (= job.width/height)
      // before POSTing, so bbox.x1/x2 ∈ [0, job.width] regardless of any
      // outputSize re-scaling that was applied to the displayed frames.
      // Using these values in a canonical SVG viewBox makes overlays align
      // for outputSize='original' (and for letterbox-aspect resizes, where
      // the rendered frame's content area still has the source video's
      // aspect ratio inside any black bars).
      const imageWidth = job.width || 0;
      const imageHeight = job.height || 0;

      // Surface the output settings the bbox alignment depends on so the
      // viewer can decide whether to show the "alignment may be inaccurate"
      // banner. Crop/stretch transforms that warp the rendered frame's
      // geometry are the cases where the source-video bbox can drift from
      // the visual content.
      const outputSettings = (job as any).outputSettings || {};
      const exposedOutputSettings = {
        size: outputSettings.size ?? null,
        aspectRatioMode: outputSettings.aspectRatioMode ?? null,
      };

      // Label-level summary (same shape viewer-info returns, repeated here so
      // the viewer only has to fetch this one endpoint to render everything)
      const labelSummary = allLabels.map(l => {
        const fr = l.frameResults || {};
        const confValues = Object.values(fr).map((v: any) => v.confidence).filter((c: any) => typeof c === 'number');
        const avg = confValues.length > 0
          ? confValues.reduce((a, b) => a + b, 0) / confValues.length
          : (l.confidence ?? 0);
        return {
          labelId: l.id,
          name: l.target,
          modality: l.modality || null,
          color: colorForLabelId(l.id),
          approved: l.approved,
          avgConfidence: avg,
          frameCount: confValues.length,
        };
      });

      // Build label→run output dir map for disk-based hasMask checks
      const inferRuns = await storage.listAiRuns(req.params.jobId);
      const labelDirMap = new Map<string, string>();
      for (const r of inferRuns) {
        for (const rl of r.labels) labelDirMap.set(rl.id, r.outputDir);
      }

      // Frame-indexed pivot. Each frame lists the labels that have a
      // confidence entry for that frame number in their frameResults.
      const totalFrames = await countFrames(req.params.jobId);
      const frames: Record<string, Array<Record<string, any>>> = {};
      for (let i = 0; i < totalFrames; i++) {
        const perFrame: Array<Record<string, any>> = [];
        for (const l of allLabels) {
          const r = l.frameResults?.[i];
          if (!r) continue;
          // hasMask: check whether the mask PNG exists on disk for this
          // (label, frame) pair. Post-3b masks are disk-persisted so they
          // survive restarts (unlike the old in-memory artifact store).
          const runDir = labelDirMap.get(l.id);
          const hasMask = !!runDir && fs.existsSync(path.join(runDir, `mask_${i}.png`));
          perFrame.push({
            labelId: l.id,
            name: l.target,
            modality: l.modality || null,
            confidence: r.confidence,
            bbox: l.bbox || null,
            approved: l.approved,
            hasMask,
          });
        }
        if (perFrame.length > 0) frames[String(i)] = perFrame;
      }

      res.setHeader('Cache-Control', 'no-store'); // inference shape can change between runs
      res.json({
        jobId: job.id,
        imageWidth,
        imageHeight,
        outputSettings: exposedOutputSettings,
        labels: labelSummary,
        frames,
      });
    } catch (error) {
      console.error("inference.json error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load inference data" });
    }
  });

  /**
   * GET /api/jobs/:jobId/masks/:labelId/:n.png                        (legacy alias)
   * GET /api/jobs/:jobId/ai/runs/:runId/masks/:labelId/:n.png         (canonical)
   *
   *   200: streams the binary mask PNG for the (label, frame) pair
   *   404: labelId doesn't exist on this job, or mask file missing
   *   410: { reason: "artifacts_lost_on_restart" } — no AIRun owns the label
   */
  const getMaskHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const n = parseInt(req.params.n, 10);
      if (!Number.isInteger(n) || n < 0 || String(n) !== req.params.n) {
        return res.status(400).json({ error: "frame index must be a non-negative integer" });
      }

      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const allLabels = ((job as any).aiLabels || []) as AiLabel[];
      const label = allLabels.find(l => l.id === req.params.labelId);
      if (!label) return res.status(404).json({ error: "Label not found" });

      // Resolve the mask PNG on disk via the AIRun that owns this label
      const runs = await storage.listAiRuns(req.params.jobId);
      const run = req.params.runId
        ? runs.find(r => r.id === req.params.runId)
        : findRunByLabelId(runs, label.id);
      if (!run) {
        return res.status(410).json({
          error: "Mask artifacts unavailable",
          reason: "artifacts_lost_on_restart",
        });
      }
      const maskPath = path.join(run.outputDir, `mask_${n}.png`);
      if (!fs.existsSync(maskPath)) {
        return res.status(404).json({ error: `mask for frame ${n} not found` });
      }

      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(path.resolve(maskPath));
    } catch (error) {
      console.error("GET mask error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load mask" });
      }
    }
  };
  app.get("/api/jobs/:jobId/masks/:labelId/:n.png", getMaskHandler);                             // legacy alias
  app.get("/api/jobs/:jobId/ai/runs/:runId/masks/:labelId/:n.png", getMaskHandler);              // canonical

  /**
   * GET /api/jobs/:jobId/overlays/:labelId/:n.png                     (legacy alias)
   * GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png      (canonical)
   *
   * Same shape as the mask endpoint, but serves the GPU's pre-rendered
   * overlay PNG (original frame with green tint on the mask region).
   * Used by the viewer's "Overlay" mode.
   */
  const getOverlayHandler: import('express').RequestHandler = async (req, res) => {
    try {
      const n = parseInt(req.params.n, 10);
      if (!Number.isInteger(n) || n < 0 || String(n) !== req.params.n) {
        return res.status(400).json({ error: "frame index must be a non-negative integer" });
      }

      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const allLabels = ((job as any).aiLabels || []) as AiLabel[];
      const label = allLabels.find(l => l.id === req.params.labelId);
      if (!label) return res.status(404).json({ error: "Label not found" });

      // Resolve the overlay PNG on disk via the AIRun that owns this label
      const runs = await storage.listAiRuns(req.params.jobId);
      const run = req.params.runId
        ? runs.find(r => r.id === req.params.runId)
        : findRunByLabelId(runs, label.id);
      if (!run) {
        return res.status(410).json({
          error: "Overlay artifacts unavailable",
          reason: "artifacts_lost_on_restart",
        });
      }
      const overlayPath = path.join(run.outputDir, `overlay_${n}.png`);
      if (!fs.existsSync(overlayPath)) {
        return res.status(404).json({ error: `overlay for frame ${n} not found` });
      }

      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(path.resolve(overlayPath));
    } catch (error) {
      console.error("GET overlay error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load overlay" });
      }
    }
  };
  app.get("/api/jobs/:jobId/overlays/:labelId/:n.png", getOverlayHandler);                       // legacy alias
  app.get("/api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png", getOverlayHandler);        // canonical

  // ── Frames endpoint (Phase 4b) ──────────────────────────────────────────

  /**
   * GET /api/jobs/:jobId/frames/:n — serve a frame as PNG.
   *
   * By default reads raw frames from temp_extracted/<jobId>/ on disk
   * (Phase 4b-0 — replaces the volatile global.extractedFrames map).
   * With ?source=template_mask, reads from spokes/template_mask/<jobId>/
   * (masked frames on disk). Hotfix 4 added the source param so the AI
   * spoke canvas can show the masked frame when a template mask exists.
   */
  app.get("/api/jobs/:jobId/frames/:n", async (req, res) => {
    try {
      const { jobId, n } = req.params;
      const source = req.query.source as string | undefined;
      const frameNumber = parseInt(n, 10);
      if (isNaN(frameNumber) || frameNumber < 0) {
        return res.status(400).json({ error: "Invalid frame number" });
      }

      const jobV2 = await storage.getJobV2(jobId);
      if (!jobV2) {
        return res.status(404).json({ error: "Job not found" });
      }

      // ── Template-mask source (on-disk masked frames) ──────────────
      if (source === 'template_mask') {
        const { dir: tempDir, files: frameFiles } = await listFrameFiles(jobId, SPOKE_TEMPLATE_MASK_DIR);
        if (!frameFiles.length || frameNumber >= frameFiles.length) {
          return res.status(404).json({ error: "Masked frame not found" });
        }
        const framePath = path.join(tempDir, frameFiles[frameNumber]);
        const buffer = await fsPromises.readFile(framePath);
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "private, max-age=3600");
        return res.send(buffer);
      }

      // ── Raw source (on-disk extracted frames, Phase 4b-0) ─────────
      // Raw frames live at temp_extracted/<jobId>/frame_NNNNNN.png, written by
      // startBackgroundFrameExtraction. listRawFrameFiles handles
      // path-traversal validation, dedup, and sorting; frames are addressed by
      // sorted position (index 0 = first frame), matching the template_mask
      // branch above.
      if (jobV2.status === 'extracting') {
        return res.status(503).json({ error: "Extraction in progress" });
      }

      const { dir: rawDir, files: rawFiles } = await listRawFrameFiles(jobId);
      if (!rawFiles.length) {
        // Directory absent or empty: frames were swept (6h retention) or the
        // server restarted before extraction completed.
        return res.status(410).json({
          error: "Frames are no longer available. The server may have restarted.",
        });
      }
      if (frameNumber >= rawFiles.length) {
        return res.status(404).json({ error: "Frame not found" });
      }

      const buffer = await fsPromises.readFile(path.join(rawDir, rawFiles[frameNumber]));
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "private, max-age=3600");
      res.send(buffer);
    } catch (error) {
      console.error("frames/:n error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to serve frame" });
    }
  });

  // ── Net-new CRUD endpoints (Phase 3c) ──────────────────────────────────

  // POST /api/jobs/:jobId/template-mask/apply — canonical URL for template-mask
  // processing. Shares handler logic with PATCH /internal/mask-processing/:jobId
  // (registered early in index.ts to dodge Vite middleware) via the shared
  // applyTemplateMask function in server/handlers/templateMaskApply.ts.
  app.post("/api/jobs/:jobId/template-mask/apply", async (req, res) => {
    try {
      const { maskData, outputSettings, samplingFps } = req.body || {};
      const result = await applyTemplateMask(
        req.params.jobId, maskData, outputSettings, samplingFps, (global as any).socketIo,
      );
      if (!result.ok) {
        return res.status(result.status).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Processing started', jobId: result.jobId });
    } catch (error) {
      console.error("template-mask/apply error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to start processing"
      });
    }
  });

  /**
   * GET /api/jobs/:jobId/ai/runs — list all AI runs for a job.
   */
  app.get("/api/jobs/:jobId/ai/runs", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const runs = await storage.listAiRuns(req.params.jobId);
      res.json({ runs });
    } catch (error) {
      console.error("List runs error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list runs" });
    }
  });

  /**
   * PATCH /api/jobs/:jobId/ai/runs/:runId — update run metadata (name, approved).
   */
  app.patch("/api/jobs/:jobId/ai/runs/:runId", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const { name, approved } = req.body;
      const updates: Partial<AIRun> = {};
      if (typeof name === 'string') updates.name = name;
      if (typeof approved === 'boolean') updates.approved = approved;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "At least one of name, approved is required" });
      }

      const updated = await storage.updateAiRun(req.params.jobId, req.params.runId, updates);
      if (!updated) return res.status(404).json({ error: "Run not found" });

      res.json({ run: updated });
    } catch (error) {
      console.error("Patch run error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update run" });
    }
  });

  /**
   * DELETE /api/jobs/:jobId/ai/runs/:runId — delete a specific AI run.
   * Removes all labels belonging to this run from job.aiLabels[], deletes
   * the run's output directory, and removes the AIRun record.
   */
  app.delete("/api/jobs/:jobId/ai/runs/:runId", async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const job = await storage.getVideoJob(jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const run = await storage.getAiRun(jobId, req.params.runId);
      if (!run) return res.status(404).json({ error: "Run not found" });

      // Remove this run's labels from job.aiLabels[] (backward compat)
      const runLabelIds = new Set(run.labels.map(l => l.id));
      const labels = ((job as any).aiLabels || []) as AiLabel[];
      const filtered = labels.filter(l => !runLabelIds.has(l.id));
      if (filtered.length !== labels.length) {
        await storage.updateVideoJob(jobId, { aiLabels: filtered as any });
      }

      // Delete run output directory from disk
      try {
        await safeDelete(run.outputDir, SPOKE_AI_DIR);
      } catch (err) {
        console.warn(`⚠️  Failed to delete run output dir: ${run.outputDir}`, err instanceof Error ? err.message : err);
      }

      // Remove the AIRun record
      await storage.deleteAiRun(jobId, run.id);

      res.json({ success: true });
    } catch (error) {
      console.error("Delete run error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete run" });
    }
  });

  /**
   * GET /api/jobs/:jobId/ai/runs/:runId/download — download a single AI run
   * as a ZIP containing mask and overlay PNGs plus a manifest.
   */
  app.get("/api/jobs/:jobId/ai/runs/:runId/download", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const run = await storage.getAiRun(req.params.jobId, req.params.runId);
      if (!run) return res.status(404).json({ error: "Run not found" });

      // Check the output directory exists and has files
      if (!fs.existsSync(run.outputDir)) {
        return res.status(404).json({ error: "Run output directory not found on disk" });
      }

      const allFiles = fs.readdirSync(run.outputDir).filter(f => /\.(png|jpe?g)$/i.test(f)).sort();
      if (allFiles.length === 0) {
        return res.status(404).json({ error: "No artifacts found for this run" });
      }

      const maskFiles = allFiles.filter(f => f.startsWith('mask_'));
      const overlayFiles = allFiles.filter(f => f.startsWith('overlay_'));

      // Build manifest for this run
      const manifest = {
        jobId: req.params.jobId,
        runId: run.id,
        runName: run.name,
        target: run.target,
        modality: run.modality || null,
        inputSource: run.inputSource,
        createdAt: run.createdAt,
        labels: run.labels.map(l => ({
          id: l.id,
          target: l.target,
          approved: l.approved,
          confidence: l.confidence,
          model: l.model,
        })),
        maskCount: maskFiles.length,
        overlayCount: overlayFiles.length,
      };

      const zipFilename = `ai-run-${run.name.replace(/\s+/g, '-').toLowerCase()}-${job.filename || 'output'}.zip`;
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
      res.setHeader('Content-Type', 'application/zip');

      const archive = archiver('zip', { zlib: { level: 1 } });
      archive.on('error', (err) => {
        console.error('Archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Archive creation failed' });
        }
      });
      archive.pipe(res);

      // Add mask PNGs
      for (const f of maskFiles) {
        archive.file(path.join(run.outputDir, f), { name: `masks/${f}` });
      }

      // Add overlay PNGs
      for (const f of overlayFiles) {
        archive.file(path.join(run.outputDir, f), { name: `overlays/${f}` });
      }

      // Add manifest
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      await archive.finalize();
      console.log(`✅ AI run ZIP streamed for job ${req.params.jobId}, run ${run.id}`);
    } catch (error) {
      console.error("AI run download error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : "AI run download failed" });
      }
    }
  });

  /**
   * DELETE /api/jobs/:jobId — delete a job entirely. Removes all disk
   * artifacts via cleanupJobArtifacts, then removes in-memory records.
   */
  app.delete("/api/jobs/:jobId", async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const job = await storage.getVideoJob(jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      // Clean up all disk artifacts (temp_extracted, temp_processed,
      // spoke dirs). Each target is individually try/wrapped inside
      // cleanupJobArtifacts so one failure doesn't block the rest.
      await cleanupJobArtifacts(jobId);

      // Remove the upload file if it still exists
      if (job.filePath) {
        try { await deleteUploadFile(job.filePath); } catch { /* best-effort */ }
      }

      // Remove in-memory records
      await storage.deleteVideoJob(jobId);
      await storage.deleteJobV2(jobId);

      res.json({ success: true });
    } catch (error) {
      console.error("Delete job error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete job" });
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down video processor...');
    // Each step is individually try/wrapped so one failure (e.g. an EBUSY
    // on a still-open ffmpeg child) cannot block the rest of shutdown.
    try {
      await videoProcessor.cleanup();
    } catch (err) {
      console.warn('SIGTERM: videoProcessor.cleanup failed', err);
    }
    // maxAgeMs=0 means "delete every entry regardless of age" — the process
    // is going away, no future request can reference any of these files.
    for (const [dir] of SWEEP_TARGETS) {
      try { await sweepDirectory(dir, 0); } catch (err) { console.warn(`SIGTERM: ${path.basename(dir)} sweep failed`, err); }
    }
    try {
      httpServer.close();
    } catch (err) {
      console.warn('SIGTERM: httpServer.close failed', err);
    }
  });

  return httpServer;
}
