import type { Express } from "express";
import { getDb } from "../db";

export interface HealthStatus {
  status: "healthy" | "unhealthy" | "degraded";
  timestamp: string;
  version: string;
  checks: {
    database?: {
      status: "up" | "down";
      responseTimeMs?: number;
      error?: string;
    };
    disk?: {
      status: "up" | "down";
      freeSpaceGB?: number;
      error?: string;
    };
    memory?: {
      status: "up" | "down";
      usedMB?: number;
      totalMB?: number;
      usagePercent?: number;
    };
  };
}

const PACKAGE_VERSION = process.env.npm_package_version || "1.0.0";

async function checkDatabase(): Promise<HealthStatus["checks"]["database"]> {
  const startTime = Date.now();

  try {
    const db = await getDb();
    if (!db) {
      return { status: "down", error: "Database connection not initialized" };
    }

    await db.execute("SELECT 1");

    const responseTime = Date.now() - startTime;
    return {
      status: "up",
      responseTimeMs: responseTime,
    };
  } catch (error) {
    return {
      status: "down",
      error: error instanceof Error ? error.message : "Unknown database error",
    };
  }
}

async function checkDisk(): Promise<HealthStatus["checks"]["disk"]> {
  try {
    const { statfs } = await import("node:fs/promises");
    const stats = await statfs("/");

    const freeBytes = stats.bavail * stats.bsize;
    const freeGB = freeBytes / 1024 ** 3;

    if (freeGB < 1) {
      return {
        status: "down",
        freeSpaceGB: Number(freeGB.toFixed(2)),
        error: "Low disk space (< 1GB)",
      };
    }

    return {
      status: "up",
      freeSpaceGB: Number(freeGB.toFixed(2)),
    };
  } catch {
    return {
      status: "up",
      error: "Disk check unavailable",
    };
  }
}

function checkMemory(): HealthStatus["checks"]["memory"] {
  const memUsage = process.memoryUsage();
  const usedMB = memUsage.heapUsed / (1024 * 1024);
  const totalMB = memUsage.heapTotal / (1024 * 1024);
  const usagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  if (usagePercent > 90) {
    return {
      status: "down",
      usedMB: Number(usedMB.toFixed(2)),
      totalMB: Number(totalMB.toFixed(2)),
      usagePercent: Number(usagePercent.toFixed(2)),
    };
  }

  return {
    status: "up",
    usedMB: Number(usedMB.toFixed(2)),
    totalMB: Number(totalMB.toFixed(2)),
    usagePercent: Number(usagePercent.toFixed(2)),
  };
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const [database, disk, memory] = await Promise.all([
    checkDatabase(),
    checkDisk(),
    Promise.resolve(checkMemory()),
  ]);

  const checks: HealthStatus["checks"] = {
    database,
    disk,
    memory,
  };

  let status: HealthStatus["status"] = "healthy";

  if (database?.status === "down") {
    status = "unhealthy";
  } else if (memory?.status === "down" || disk?.status === "down") {
    status = "degraded";
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    version: PACKAGE_VERSION,
    checks,
  };
}

export function registerHealthEndpoint(app: Express) {
  app.get("/health", (_req, res) => {
    res.json({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/health", async (_req, res) => {
    try {
      const health = await getHealthStatus();

      if (health.status === "unhealthy") {
        return res.status(503).json(health);
      }

      return res.status(health.status === "degraded" ? 206 : 200).json(health);
    } catch (error) {
      return res.status(500).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        version: PACKAGE_VERSION,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}