import type { Express } from "express";
import { getDb } from "../db";
import { getProjectJobWorkerHealthState } from "../services/projectWorkflow";
import { logger } from "./logger";
import { getAppVersion, getCommitHash } from "./version";

type DependencyStatus = "up" | "down" | "unknown";
type ReadinessReasonCode =
  | "database_unavailable"
  | "disk_check_failed"
  | "worker_unavailable"
  | "unknown_dependency_failure";

type InternalDependencyCheck = {
  status: DependencyStatus;
  detail?: string;
};

type InternalReadiness = {
  status: "ready" | "not_ready";
  timestamp: string;
  checks: {
    database: DependencyStatus;
    disk: DependencyStatus;
    worker: DependencyStatus;
  };
  reasonCodes: ReadinessReasonCode[];
  internalFailures: Partial<Record<"database" | "disk" | "worker", string>>;
};

export interface HealthStatus {
  status: "healthy" | "unhealthy" | "degraded";
  timestamp: string;
  version: string;
  commitHash: string;
  checks: {
    database: { status: DependencyStatus; responseTimeMs?: number };
    disk: { status: DependencyStatus; freeSpaceGB?: number };
    worker: { status: DependencyStatus; enabled: boolean };
    memory: {
      status: "up" | "down";
      usedMB?: number;
      totalMB?: number;
      usagePercent?: number;
    };
  };
}

export interface ReadinessStatus {
  status: "ready" | "not_ready";
  timestamp: string;
  checks: {
    database: DependencyStatus;
    disk: DependencyStatus;
    worker: DependencyStatus;
  };
  reasonCodes: ReadinessReasonCode[];
}

async function checkDatabase(): Promise<
  InternalDependencyCheck & { responseTimeMs?: number }
> {
  const startTime = Date.now();

  try {
    const db = await getDb();
    if (!db) {
      return {
        status: "down",
        detail: "Database connection is not initialized.",
      };
    }

    await db.execute("SELECT 1");
    return {
      status: "up",
      responseTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      status: "down",
      detail: error instanceof Error ? error.message : "Unknown database error",
    };
  }
}

async function checkDisk(): Promise<
  InternalDependencyCheck & { freeSpaceGB?: number }
> {
  try {
    const { statfs } = await import("node:fs/promises");
    const stats = await statfs("/");

    const freeBytes = stats.bavail * stats.bsize;
    const freeGB = Number((freeBytes / 1024 ** 3).toFixed(2));

    if (freeGB < 1) {
      return {
        status: "down",
        freeSpaceGB: freeGB,
        detail: "Available disk space is below 1 GB.",
      };
    }

    return {
      status: "up",
      freeSpaceGB: freeGB,
    };
  } catch (error) {
    return {
      status: "unknown",
      detail:
        error instanceof Error ? error.message : "Unknown disk check error",
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

async function collectReadinessState(): Promise<InternalReadiness> {
  const [database, disk] = await Promise.all([checkDatabase(), checkDisk()]);
  const worker = getProjectJobWorkerHealthState();
  const checks = {
    database: database.status,
    disk: disk.status,
    worker: worker.status,
  } as const;
  const reasonCodes: ReadinessReasonCode[] = [];
  const internalFailures: InternalReadiness["internalFailures"] = {};

  if (database.status !== "up") {
    reasonCodes.push("database_unavailable");
    if (database.detail) internalFailures.database = database.detail;
  }
  if (disk.status !== "up") {
    reasonCodes.push("disk_check_failed");
    if (disk.detail) internalFailures.disk = disk.detail;
  }
  if (worker.enabled && worker.status !== "up") {
    reasonCodes.push("worker_unavailable");
    if (worker.reason) internalFailures.worker = worker.reason;
  }
  if (
    reasonCodes.length === 0 &&
    Object.values(checks).some(
      status => status !== "up" && status !== "unknown"
    )
  ) {
    reasonCodes.push("unknown_dependency_failure");
  }

  const ready =
    database.status === "up" &&
    disk.status === "up" &&
    (!worker.enabled || worker.status === "up");
  return {
    status: ready ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks,
    reasonCodes,
    internalFailures,
  };
}

function logReadinessFailure(readiness: InternalReadiness) {
  if (readiness.status === "ready") {
    return;
  }

  logger.warn("Readiness check failed", {
    action: "health.ready",
    status: "error",
    reasonCodes: readiness.reasonCodes,
    checks: readiness.checks,
    internalFailures: readiness.internalFailures,
  });
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const [database, disk] = await Promise.all([checkDatabase(), checkDisk()]);
  const worker = getProjectJobWorkerHealthState();
  const memory = checkMemory();

  let status: HealthStatus["status"] = "healthy";
  if (
    database.status === "down" ||
    disk.status === "down" ||
    (worker.enabled && worker.status === "down")
  ) {
    status = "unhealthy";
  } else if (
    disk.status === "unknown" ||
    memory.status === "down" ||
    worker.status === "unknown"
  ) {
    status = "degraded";
  }

  if (database.detail || disk.detail || worker.reason) {
    logger.warn("Health dependency issue detected", {
      action: "health.summary",
      status: status === "healthy" ? "ok" : "error",
      database: database.detail ?? null,
      disk: disk.detail ?? null,
      worker: worker.reason ?? null,
    });
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    version: getAppVersion(),
    commitHash: getCommitHash(),
    checks: {
      database: {
        status: database.status,
        responseTimeMs: database.responseTimeMs,
      },
      disk: {
        status: disk.status,
        freeSpaceGB: disk.freeSpaceGB,
      },
      worker: {
        status: worker.status,
        enabled: worker.enabled,
      },
      memory,
    },
  };
}

export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const readiness = await collectReadinessState();
  logReadinessFailure(readiness);

  return {
    status: readiness.status,
    timestamp: readiness.timestamp,
    checks: readiness.checks,
    reasonCodes: readiness.reasonCodes,
  };
}

export function registerHealthEndpoint(app: Express) {
  app.get("/health", (_req, res) => {
    res.json({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/ready", async (_req, res) => {
    try {
      const readiness = await getReadinessStatus();
      return res
        .status(readiness.status === "ready" ? 200 : 503)
        .json(readiness);
    } catch (error) {
      logger.error("Readiness endpoint failed unexpectedly", {
        action: "health.ready.endpoint",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        status: "not_ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: "unknown",
          disk: "unknown",
          worker: "unknown",
        },
        reasonCodes: ["unknown_dependency_failure"],
      } satisfies ReadinessStatus);
    }
  });

  app.get("/api/health", async (_req, res) => {
    try {
      const health = await getHealthStatus();

      if (health.status === "unhealthy") {
        return res.status(503).json(health);
      }

      return res.status(health.status === "degraded" ? 206 : 200).json(health);
    } catch (error) {
      logger.error("Health endpoint failed unexpectedly", {
        action: "health.api.endpoint",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        version: getAppVersion(),
        commitHash: getCommitHash(),
        checks: {
          database: { status: "unknown" },
          disk: { status: "unknown" },
          worker: {
            status: "unknown",
            enabled: process.env.PROJECT_WORKER_ENABLED !== "false",
          },
          memory: { status: "down" },
        },
      } satisfies HealthStatus);
    }
  });
}
