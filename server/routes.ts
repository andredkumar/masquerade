import type { Express } from "express";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import multer from "multer";
import { storage } from "./storage";
import { insertVideoJobSchema, type FileInfo } from "@shared/schema";
import { VideoProcessor } from "./services/videoProcessor";
import { FrameExtractor } from "./services/frameExtractor";
import { IntentParser } from "./services/intentParser";
import path from "path";
import fs from "fs";

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

  // Download processed video ZIP
  app.get("/api/videos/:jobId/download", async (req, res) => {
    try {
      const job = await storage.getVideoJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.status !== 'completed') {
        // For jobs in 'ready' state, check if ZIP file exists
        if (job.status === 'ready') {
          const zipPath = (job as any).outputZipPath || path.join('output', `processed_frames_${job.id}.zip`);
          if (!fs.existsSync(zipPath)) {
            return res.status(400).json({ 
              error: `Job is in ${job.status} state, download not available` 
            });
          }
          // Continue with download if ZIP exists
        } else {
          return res.status(400).json({ 
            error: `Job is in ${job.status} state, download not available` 
          });
        }
      }

      // Construct ZIP file path from job record or fallback
      const zipPath = (job as any).outputZipPath || path.join('output', `processed_frames_${job.id}.zip`);
      
      if (!fs.existsSync(zipPath)) {
        return res.status(404).json({ error: "Output file not found" });
      }

      const stat = fs.statSync(zipPath);
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="processed_${job.filename}.zip"`);
      
      const fileStream = fs.createReadStream(zipPath);
      fileStream.pipe(res);

    } catch (error) {
      console.error("Download error:", error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Download failed" 
      });
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
