import { and, eq } from "drizzle-orm";
import { projectJobs } from "../../../drizzle/schema";
import { AppError } from "../../appError";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import { extractAffectedRows } from "./projectQueryUtils";
import { buildProjectJobLease, PROJECT_JOB_HEARTBEAT_MS, type ProjectJobRow } from "./projectJobState";
import type { ProjectJobOwnership } from "./projectJobLease";

type HeartbeatOptions = {
  onOwnershipLost?: () => void;
  onHeartbeatFailed?: (error: unknown) => void;
};

async function requireHeartbeatDb() {
  const db = await getDb();
  if (!db) {
    throw new AppError("DATABASE_UNAVAILABLE", "Database connection is not configured.");
  }
  return db;
}

export async function heartbeatProjectJobLease(ownership: ProjectJobOwnership) {
  const db = await requireHeartbeatDb();
  const lease = buildProjectJobLease();
  const updateResult = await db
    .update(projectJobs)
    .set({
      heartbeatAt: lease.heartbeatAt,
      leaseUntil: lease.leaseUntil,
    })
    .where(
      and(
        eq(projectJobs.id, ownership.jobId),
        eq(projectJobs.status, "running"),
        eq(projectJobs.lockedBy, ownership.lockedBy),
        eq(projectJobs.attemptCount, ownership.attemptCount)
      )
    );

  const affectedRows = extractAffectedRows(updateResult);
  return typeof affectedRows === "number" ? affectedRows > 0 : true;
}

export function startProjectJobLeaseGuardian(
  job: Pick<ProjectJobRow, "id" | "projectId" | "type" | "status" | "progress">,
  ownership: ProjectJobOwnership,
  options: HeartbeatOptions = {}
) {
  let stopped = false;
  let renewalInFlight = false;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  const renew = () => {
    if (stopped || renewalInFlight) {
      return;
    }

    renewalInFlight = true;
    void heartbeatProjectJobLease(ownership)
      .then((stillOwned) => {
        if (stopped) {
          return;
        }

        logger.info("Project job heartbeat renewed", {
          action: "project.job.heartbeat",
          jobId: job.id,
          projectId: job.projectId,
          type: job.type,
          status: stillOwned ? "running" : "failed",
          progress: Number(job.progress ?? 0),
          lockedBy: ownership.lockedBy,
          attemptCount: ownership.attemptCount,
        });

        if (!stillOwned) {
          stop();
          options.onOwnershipLost?.();
        }
      })
      .catch((error) => {
        if (stopped) {
          return;
        }

        stop();
        options.onHeartbeatFailed?.(error);
      })
      .finally(() => {
        renewalInFlight = false;
      });
  };

  const timer = setInterval(renew, Math.max(1_000, PROJECT_JOB_HEARTBEAT_MS));
  timer.unref?.();

  return { stop };
}
