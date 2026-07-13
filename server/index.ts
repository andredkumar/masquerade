import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { checkFFmpegInstallation, displaySystemStatus } from "./utils/systemCheck";
import { storage } from "./storage";

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
  // Phase 5C-2 — eager DB reachability probe. On the Postgres path the `pg` Pool is
  // LAZY: an unreachable/misconfigured RDS (with DATABASE_URL set) would otherwise boot
  // fine and only fail on the first request. Force a `SELECT 1` here so an unreachable DB
  // is a LOUD boot failure (process exit → PM2 crash-loop), never a silent-until-first-use
  // surprise — you know immediately to fix connectivity or roll back.
  //
  // Gated on the live store being PgStorage via its constructor name — deliberately NOT a
  // static `import` of `./db`/`./pgStorage` here, because that would force a DATABASE_URL
  // dependency onto the MemStorage ROLLBACK path (index.ts would then throw with no DB even
  // after reverting storage.ts). With this gate, a storage.ts-only rollback to MemStorage
  // makes this block self-disable (name check is false) → still boots with no DATABASE_URL,
  // so rollback stays a one-edit change. Assumes the build does not minify class names
  // (it does not — no `--minify` in the esbuild step).
  if (storage.constructor.name === 'PgStorage') {
    const { db } = await import('./db');
    const { sql } = await import('drizzle-orm');
    try {
      await db.execute(sql`SELECT 1`);
      log('database reachable (SELECT 1 OK) — running on Postgres');
    } catch (err) {
      console.error(
        'FATAL: DATABASE_URL is set but the database is unreachable at boot ' +
        '(Phase 5C-2 eager probe). Refusing to start on an unreachable Postgres. ' +
        'Fix connectivity (security group / endpoint / credentials / SSL) or roll back ' +
        'to MemStorage.\n',
        err,
      );
      process.exit(1);
    }
  }

  // Initialize temporary folder system
  const { TempFolderManager } = await import('./services/templateMaskFolderManager');
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
