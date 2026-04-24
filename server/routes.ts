import type { Express } from "express";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import multer from "multer";
import { storage } from "./storage";
import { insertVideoJobSchema, type FileInfo, type AiLabel } from "@shared/schema";
import { VideoProcessor } from "./services/videoProcessor";
import { FrameExtractor } from "./services/frameExtractor";
import { IntentParser } from "./services/intentParser";
import { AIInferenceClient } from "./services/aiInferenceClient";
import { ModelRouter } from "./services/modelRouter";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import archiver from "archiver";

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
  app.post("/api/videos/upload", upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No video file uploaded" });
      }

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
        setImmediate(() => {
          videoProcessor.startBackgroundFrameExtraction(job.id, req.file!.path, quickMetadata.totalFrames)
            .catch(error => {
              console.error('❌ DICOM background extraction failed:', error);
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

      // Extract first frame for masking
      const firstFrameBuffer = await frameExtractor.extractFirstFrame(req.file.path);
      
      // 🚀 START BACKGROUND EXTRACTION OF ALL FRAMES IMMEDIATELY
      console.log('🚀 STARTING BACKGROUND FRAME EXTRACTION FOR ALL', metadata.totalFrames, 'FRAMES');
      setImmediate(() => {
        videoProcessor.startBackgroundFrameExtraction(job.id, req.file!.path, metadata.totalFrames)
          .catch(error => {
            console.error('❌ Background extraction failed:', error);
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
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Upload failed" 
      });
    }
  });

  // Upload multiple image files and create job
  app.post("/api/images/upload", imageUpload.array('images'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No image files uploaded" });
      }

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
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Image upload failed" 
      });
    }
  });

  // Get job status and progress
  app.get("/api/videos/:jobId", async (req, res) => {
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
  });

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

  // Download processed ZIP — built lazily from temp_processed/{jobId}/ on demand.
  // Optional query params: ?masks=true&overlays=true
  app.get("/api/videos/:jobId/download", async (req, res) => {
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

      // Source of truth for processed frames is the temp folder
      const tempDir = path.join(process.cwd(), 'temp_processed', job.id);
      if (!fs.existsSync(tempDir)) {
        return res.status(404).json({ error: "Processed frames not found on disk" });
      }

      const frameFiles = fs.readdirSync(tempDir)
        .filter(f => /\.(png|jpe?g)$/i.test(f))
        .sort();

      if (frameFiles.length === 0) {
        return res.status(404).json({ error: "No processed frames available to download" });
      }

      // Get approved AI labels from the job record
      const allLabels = ((job as any).aiLabels || []) as AiLabel[];
      const approvedLabels = allLabels.filter(l => l.approved);

      // Collect mask/overlay buffers from the first approved label that has them.
      // Silently skip add-ons if no approved label supplies the corresponding artifact.
      let maskBuffer: Buffer | null = null;
      let overlayBuffer: Buffer | null = null;
      if (includeMasks || includeOverlays) {
        for (const label of approvedLabels) {
          if (includeMasks && !maskBuffer && label.maskB64) {
            maskBuffer = Buffer.from(label.maskB64, 'base64');
          }
          if (includeOverlays && !overlayBuffer && label.overlayB64) {
            overlayBuffer = Buffer.from(label.overlayB64, 'base64');
          }
          if ((!includeMasks || maskBuffer) && (!includeOverlays || overlayBuffer)) break;
        }
      }

      // Build per-frame and top-level AI label arrays
      const labelsForManifest = approvedLabels.map(l => ({
        id: l.id,
        intent: l.intent,
        target: l.target,
        confidence: l.confidence,
        model: l.model,
        approved: l.approved,
        bbox: l.bbox || null,
      }));
      const labelsForFrame = approvedLabels.map(l => ({
        intent: l.intent,
        target: l.target,
        confidence: l.confidence,
        model: l.model,
        approved: l.approved,
        bbox: l.bbox || null,
      }));

      // Derive split assignment from frame index (80/10/10 train/val/test)
      const determineSplit = (n: number): 'train' | 'val' | 'test' => {
        const mod = n % 10;
        if (mod <= 7) return 'train';
        if (mod === 8) return 'val';
        return 'test';
      };

      // Extract frame index from filename (supports frame_000000.png and image_001_name.png)
      const extractFrameIndex = (filename: string, fallback: number): { index: number; paddedNum: string; ext: string } => {
        const m1 = filename.match(/^frame_(\d+)\.(\w+)$/);
        if (m1) return { index: parseInt(m1[1], 10), paddedNum: m1[1], ext: m1[2] };
        const m2 = filename.match(/^image_(\d+)_.*\.(\w+)$/);
        if (m2) {
          const idx = parseInt(m2[1], 10) - 1;
          return { index: idx, paddedNum: String(idx).padStart(6, '0'), ext: m2[2] };
        }
        return { index: fallback, paddedNum: String(fallback).padStart(6, '0'), ext: path.extname(filename).slice(1) || 'png' };
      };

      const outputFormat = (job as any).outputSettings?.format || 'png';
      const manifestFrames = frameFiles.map((filename, i) => {
        const { index } = extractFrameIndex(filename, i);
        return {
          frame_number: index,
          filename: `frame_${String(index).padStart(4, '0')}.${outputFormat}`,
          split: determineSplit(index),
          has_mask: true,
          ai_labels: labelsForFrame,
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
      if (includeMasks && maskBuffer) {
        readmeSections.push(
          `masks/`,
          `  Binary segmentation masks. White pixels = AI-detected target structure.`,
          `  Black pixels = background. Use these to train segmentation models.`,
          ``,
        );
      }
      if (includeOverlays && overlayBuffer) {
        readmeSections.push(
          `overlays/`,
          `  Visual overlays showing AI detections highlighted in green on the original`,
          `  frame. Use these to verify segmentation quality before training.`,
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

      // 4. Frames + optional mask/overlay companions
      for (let i = 0; i < frameFiles.length; i++) {
        const filename = frameFiles[i];
        const { index, paddedNum, ext } = extractFrameIndex(filename, i);
        const framePath = path.join(tempDir, filename);
        archive.file(framePath, { name: `images/frame_${paddedNum}.${ext}` });

        if (includeMasks && maskBuffer) {
          archive.append(maskBuffer, { name: `masks/frame_${paddedNum}_mask.png` });
        }
        if (includeOverlays && overlayBuffer) {
          archive.append(overlayBuffer, { name: `overlays/frame_${paddedNum}_overlay.png` });
        }
        void index; // suppress unused warning
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
  });

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
  app.post("/api/ai/infer", async (req, res) => {
    try {
      const { jobId, command, frameBase64 } = req.body;

      if (!jobId || !command) {
        return res.status(400).json({
          error: "jobId and command are required",
        });
      }

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

      // 3. Resolve the frame image: prefer temp folder, fall back to request body
      let resolvedFrameBase64 = frameBase64;
      const tempDir = path.join(process.cwd(), 'temp_processed', jobId);
      if (fs.existsSync(tempDir)) {
        const pngFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.png')).sort();
        if (pngFiles.length > 0) {
          const firstFramePath = path.join(tempDir, pngFiles[0]);
          resolvedFrameBase64 = fs.readFileSync(firstFramePath).toString('base64');
          console.log(`📂 Using first frame from temp folder: ${pngFiles[0]}`);
        }
      }

      if (!resolvedFrameBase64) {
        return res.status(400).json({
          error: "No frame available — upload and process a video first, or send frameBase64",
        });
      }

      // 4. Route to the best model
      const router = new ModelRouter();
      const modelConfig = router.route(parsedIntent);
      console.log(`🔀 Model router selected: ${modelConfig.id} (${modelConfig.name}) — type: ${modelConfig.type}, available: ${modelConfig.available}`);

      // 5. Call the AI inference service
      const aiClient = new AIInferenceClient();
      const result = await aiClient.infer({
        modelConfig,
        imageBase64: resolvedFrameBase64,
        intent: parsedIntent,
        jobId,
      });

      // 6. Store the AI label on the job record (with mask/overlay artifacts)
      const existingLabels = ((job as any).aiLabels || []) as AiLabel[];
      const newLabel: AiLabel = {
        id: randomUUID(),
        intent: parsedIntent.intent,
        target: parsedIntent.target || 'unknown',
        confidence: result.confidence ?? null,
        model: result.modelUsed || 'unknown',
        timestamp: new Date().toISOString(),
        approved: true,
        bbox: null,
        maskB64: result.maskBase64 || undefined,
        overlayB64: result.overlayBase64 || undefined,
      };
      await storage.updateVideoJob(jobId, {
        aiLabels: [...existingLabels, newLabel] as any,
      });

      // 7. Return the result
      res.json({
        parsedIntent,
        maskBase64: result.maskBase64,
        confidence: result.confidence,
        modelUsed: result.modelUsed,
        inferenceMs: result.inferenceMs,
        label: newLabel,
      });
    } catch (error) {
      console.error("AI inference error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "AI inference failed",
      });
    }
  });

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
  app.patch("/api/ai/labels/:jobId/:labelId", async (req, res) => {
    try {
      const { approved } = req.body;
      if (typeof approved !== 'boolean') {
        return res.status(400).json({ error: "approved (boolean) is required" });
      }

      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const labels = ((job as any).aiLabels || []) as AiLabel[];
      const idx = labels.findIndex(l => l.id === req.params.labelId);
      if (idx === -1) {
        return res.status(404).json({ error: "Label not found" });
      }

      labels[idx].approved = approved;
      await storage.updateVideoJob(req.params.jobId, { aiLabels: labels as any });
      res.json({ label: labels[idx] });
    } catch (error) {
      console.error("Patch label error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update label" });
    }
  });

  // DELETE a label
  app.delete("/api/ai/labels/:jobId/:labelId", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const labels = ((job as any).aiLabels || []) as AiLabel[];
      const filtered = labels.filter(l => l.id !== req.params.labelId);
      if (filtered.length === labels.length) {
        return res.status(404).json({ error: "Label not found" });
      }

      await storage.updateVideoJob(req.params.jobId, { aiLabels: filtered as any });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete label error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete label" });
    }
  });

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

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down video processor...');
    await videoProcessor.cleanup();
    httpServer.close();
  });

  return httpServer;
}
