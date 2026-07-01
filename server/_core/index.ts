import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { JSON_UPLOAD_BODY_LIMIT_BYTES } from "@shared/const";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { validateDbConfig, closeDb } from "../db";
import { createContext } from "./context";
import { validateRuntimeConfig } from "./env";
import { registerDevAuthRoutes } from "./devAuth";
import { registerOAuthRoutes } from "./oauth";
import { serveStatic } from "./static";
import { logger } from "./logger";
import { registerHealthEndpoint } from "./health";
import { configureTrustProxy, registerRateLimiters } from "./rateLimiter";
import { registerSecurityHeaders } from "./securityHeaders";
import { registerReportDownloadRoute } from "./reportRoute";
import {
  recoverStaleProjectJobsOnStartup,
  startProjectJobWorkerPolling,
  stopProjectJobWorkerPolling,
} from "../services/projectWorkflow";
import { registerProjectUploadRoute } from "../services/projectUploadRoute";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available port found starting from ${startPort}`);
}

async function gracefulShutdown(signal: string) {
  logger.info("Server shutdown requested", { action: "server.shutdown.start", status: "ok", signal });

  stopProjectJobWorkerPolling();

  // Close database connections
  await closeDb();
  
  logger.info("Server shutdown completed", { action: "server.shutdown.complete", status: "ok", signal });
  process.exit(0);
}

async function startServer() {
  validateRuntimeConfig();
  await validateDbConfig();
  const recoveredJobCount = await recoverStaleProjectJobsOnStartup();
  const projectWorkerEnabled = process.env.PROJECT_WORKER_ENABLED !== "false";
  const projectWorkerPollIntervalMs = projectWorkerEnabled
    ? Number.parseInt(process.env.PROJECT_WORKER_POLL_INTERVAL_MS ?? "2000", 10) || 2000
    : null;

  const app = express();
  const server = createServer(app);
  configureTrustProxy(app);
  registerSecurityHeaders(app);

  // Middleware order matters!
  // Health endpoints first (no rate limiting)
  registerHealthEndpoint(app);
  
  // Rate limiting
  registerRateLimiters(app);
  
  // Body parsers with enough headroom for the shared raw ZIP upload limit after base64 encoding.
  app.use(express.json({ limit: JSON_UPLOAD_BODY_LIMIT_BYTES }));
  app.use(express.urlencoded({ limit: JSON_UPLOAD_BODY_LIMIT_BYTES, extended: true }));

  // Logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.debug("HTTP request completed", {
        action: "http.request",
        status: "ok",
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: duration,
      });
    });
    next();
  });

  registerDevAuthRoutes(app);
  registerOAuthRoutes(app);
  registerReportDownloadRoute(app);
  registerProjectUploadRoute(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  if (process.env.NODE_ENV === "development") {
    const viteDevModulePath = "./vite-dev";
    const { setupVite }: typeof import("./vite-dev") = await import(viteDevModulePath);
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = Number.parseInt(process.env.PORT || "3000", 10);
  let port = preferredPort;

  if (process.env.NODE_ENV === "development") {
    port = await findAvailablePort(preferredPort);
    if (port !== preferredPort) {
      logger.info(`Port ${preferredPort} is busy, using port ${port} instead`);
    }
  } else if (!(await isPortAvailable(preferredPort))) {
    throw new Error(`Port ${preferredPort} is already in use. Set PORT to a different value before starting the server.`);
  }

  server.listen(port, () => {
    logger.info("Server started", {
      action: "server.start",
      status: "ok",
      port,
      env: process.env.NODE_ENV || "development",
      recoveredJobCount,
      projectWorkerEnabled,
      projectWorkerPollIntervalMs,
    });
    
    // Log health endpoint availability
    logger.info("Health endpoints ready", { action: "server.health", status: "ok", port });
  });

  startProjectJobWorkerPolling();

  // Graceful shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.error("Failed to start server", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
