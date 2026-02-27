import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { checkFFmpegInstallation, displaySystemStatus } from "./utils/systemCheck";

const app = express();

// Debug middleware to log ALL requests (including PUT/PATCH)
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    console.log('\n🔍 EXPRESS ALL POST/PUT/PATCH REQUESTS:');
    console.log('=======================================');
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Content-Length:', req.headers['content-length']);
    console.log('=======================================\n');
  }
  next();
});

app.use(express.json({ limit: '50mb' })); // Increase limit to handle large canvas data
app.use(express.urlencoded({ extended: false }));

// Add our mask data endpoint with unique path to avoid Vite interference
app.patch("/internal/mask-processing/:jobId", async (req, res) => {
  try {
    console.log('\n🔧 WORKAROUND MASK ENDPOINT HIT!');
    console.log('=================================');
    console.log('JobID:', req.params.jobId);
    console.log('Body keys:', Object.keys(req.body || {}));
    
    const { maskData, outputSettings } = req.body || {};
    
    if (!maskData || !outputSettings) {
      console.log('❌ Missing required data');
      return res.status(400).json({ 
        success: false, 
        error: "maskData and outputSettings are required" 
      });
    }
    
    console.log('✅ Received mask data:', maskData.type);
    console.log('✅ Coordinates:', maskData.coordinates);
    console.log('✅ Canvas data length:', maskData.canvasDataUrl?.length || 0);
    
    // Import necessary modules for video processing
    const { VideoProcessor } = await import('./services/videoProcessor');
    const { storage } = await import('./storage');
    
    // Get existing job
    const job = await storage.getVideoJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ 
        success: false, 
        error: "Job not found" 
      });
    }

    // Allow processing regardless of job status to enable re-processing
    console.log('✅ Found job:', {
      id: job.id,
      status: job.status,
      filePath: job.filePath,
      hasFilePath: !!job.filePath
    });
    
    // Store mask data in the job
    await storage.updateVideoJob(req.params.jobId, {
      maskData,
      outputSettings
    });
    
    // Get the Socket.IO instance from global scope (set by registerRoutes)
    const io = (global as any).socketIo;
    if (!io) {
      return res.status(500).json({
        success: false,
        error: "Socket.IO not available"
      });
    }
    
    // Create video processor and trigger processing
    const videoProcessor = new VideoProcessor(io);
    console.log('🚀 Starting processing with mask data...');
    console.log('📋 Processing parameters:', {
      jobId: req.params.jobId,
      jobType: job.jobType,
      filePath: job.filePath,
      hasMaskData: !!maskData,
      hasOutputSettings: !!outputSettings,
      maskType: maskData?.type,
      maskCoordinates: maskData?.coordinates
    });
    
    // Check job type and process accordingly
    if (job.jobType === 'images') {
      // Process image batch
      const fileList = job.fileList as any[];
      if (!fileList || fileList.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: "No image files found in job" 
        });
      }
      
      // Construct file paths for images
      const imagePaths = fileList.map((file: any) => `uploads/${file.filename}`);
      
      // Start image processing asynchronously
      videoProcessor.processImages(
        req.params.jobId,
        imagePaths,
        maskData,
        outputSettings
      ).catch(error => {
        console.error("❌ Image processing error:", error);
      });
    } else {
      // Process video (default behavior)
      videoProcessor.processVideo(
        req.params.jobId, 
        job.filePath, 
        maskData, 
        outputSettings
      ).catch(error => {
        console.error("❌ Video processing error:", error);
      });
    }
    
    console.log('=================================\n');
    res.json({ 
      success: true, 
      message: 'Processing started',
      jobId: req.params.jobId 
    });
    
  } catch (error) {
    console.error("❌ Mask endpoint error:", error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to store mask data" 
    });
  }
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize temporary folder system
  const { TempFolderManager } = await import('./services/tempFolderManager');
  await TempFolderManager.initialize();
  
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, async () => {
    log(`serving on port ${port}`);
    
    // Check system dependencies on startup
    const systemCheck = await checkFFmpegInstallation();
    displaySystemStatus(systemCheck);
  });
})();
