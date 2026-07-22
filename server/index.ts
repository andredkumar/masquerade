import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { checkFFmpegInstallation, displaySystemStatus } from "./utils/systemCheck";
import { storage } from "./storage";

const app = express();

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

    // Report the ACTUAL target the app's own Pool (server/db.ts) resolved from
    // process.env.DATABASE_URL — host / db / user, password stripped. This is the
    // value BOTH this probe and PgStorage use (one shared `db` singleton). If it does
    // not match the host/db you see in your `.env` / `psql`, the running PM2 process
    // has a stale or overriding DATABASE_URL in its environment (a plain `pm2 restart`
    // reuses the daemon's cached env) — fix that, not the code.
    let target = '(unparseable DATABASE_URL)';
    try {
      const u = new URL(process.env.DATABASE_URL ?? '');
      target = `${u.hostname}:${u.port || '5432'}${u.pathname} user=${u.username}`;
    } catch { /* leave placeholder */ }
    log(`app DATABASE_URL target → ${target}`);

    try {
      // Beyond mere reachability, confirm the connected database actually carries the
      // A3 schema. `to_regclass('public.jobs')` is NULL when the table is absent, which
      // is exactly the "SELECT 1 OK but relation \"jobs\" does not exist" symptom of the
      // process pointing at a reachable-but-unmigrated DB (e.g. a leftover Neon URL in
      // PM2's env). Surface db/user/schema so it can be compared against psql.
      const res: { rows: Array<Record<string, unknown>> } = await db.execute(
        sql`SELECT current_database() AS db, current_user AS usr, current_schema() AS schema, to_regclass('public.jobs') IS NOT NULL AS has_jobs`,
      );
      const row = res.rows[0] ?? {};
      log(
        `database reachable (SELECT 1 OK) — running on Postgres · db=${row.db} ` +
        `user=${row.usr} schema=${row.schema} public.jobs=${row.has_jobs}`,
      );
      if (row.has_jobs !== true) {
        console.error(
          `FATAL: connected to database "${row.db}" (host per target above) but ` +
          'public.jobs is MISSING there. The app is pointed at a reachable but ' +
          'UNMIGRATED database — its DATABASE_URL differs from the one you migrated / ' +
          'see in psql. This is an ENVIRONMENT mismatch, not a code bug: the running ' +
          'PM2 process is using a stale/overriding DATABASE_URL. Fix it with ' +
          '`pm2 env <id>` to inspect, then restart with the correct env applied ' +
          '(`--update-env`, or a `pm2 delete` + fresh start). Refusing to serve writes ' +
          'against a schema-less DB.\n',
        );
        process.exit(1);
      }
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
