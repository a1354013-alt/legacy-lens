import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { validateDbConfig, closeDb } from "../db";
import { createContext } from "./context";
import { validateRuntimeConfig } from "./env";
import { registerOAuthRoutes } from "./oauth";
import { serveStatic, setupVite } from "./vite";
import { logger } from "./logger";
import { registerHealthEndpoint } from "./health";
import { registerRateLimiters } from "./rateLimiter";
import { globalJobQueue } from "./jobQueue";

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
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  // Stop job queue
  globalJobQueue.stopWorker();
  
  // Close database connections
  await closeDb();
  
  logger.info("Graceful shutdown completed");
  process.exit(0);
}

async function startServer() {
  validateRuntimeConfig();
  await validateDbConfig();

  const app = express();
  const server = createServer(app);

  // Middleware order matters!
  // Health endpoints first (no rate limiting)
  registerHealthEndpoint(app);
  
  // Rate limiting
  registerRateLimiters(app);
  
  // Body parsers with increased limits for large uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.debug(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    });
    next();
  });

  registerOAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  if (process.env.NODE_ENV === "development") {
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
    logger.info(`Server running on http://localhost:${port}/`, {
      port,
      env: process.env.NODE_ENV || "development",
    });
    
    // Log health endpoint availability
    logger.info(`Health check available at http://localhost:${port}/health`);
    logger.info(`Full health status at http://localhost:${port}/api/health`);
  });

  // Graceful shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.error("Failed to start server", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
