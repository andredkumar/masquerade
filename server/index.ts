import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { checkFFmpegInstallation, displaySystemStatus } from "./utils/systemCheck";
import { applyTemplateMask } from "./handlers/templateMaskApply";

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

// Legacy mask-processing endpoint — registered before Vite middleware to avoid
// interception (Phase 1 finding). Delegates to the shared applyTemplateMask
// function so behaviour is identical to POST /api/jobs/:jobId/template-mask/apply.
app.patch("/internal/mask-processing/:jobId", async (req, res) => {
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
    console.error("Mask endpoint error:", error);
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

  // Disk cleanup: purge orphaned data from any previous process, ensure
  // spoke directories exist, then arm the hourly retention sweep BEFORE
  // the HTTP server starts listening.
  const {
    purgeUploadsOnStartup,
    purgeTempProcessedOnStartup,
    ensureSpokeDirectories,
    startCleanupScheduler,
  } = await import('./services/cleanup');
  await purgeUploadsOnStartup();
  await purgeTempProcessedOnStartup();
  await ensureSpokeDirectories();
  startCleanupScheduler();

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
