import { and, eq, inArray, isNull } from "drizzle-orm";
import { projectJobs, projects } from "../../../drizzle/schema";
import { AppError } from "../../appError";
import type { DatabaseClient } from "../../dbTypes";
import { logger } from "../../_core/logger";
import { extractAffectedRows } from "./projectQueryUtils";
import {
  STALE_PROJECT_JOB_MS,
  canRetryProjectJob,
  getProjectJobAttemptCount,
  getProjectJobMaxAttempts,
  hasProjectJobLease,
  isActiveProjectJobStatus,
  isProjectJobLeaseExpired,
  toDate,
  type ProjectJobRow,
} from "./projectJobState";
import type { ProjectStatus } from "../../../shared/contracts";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;

export type ProjectJobRecoveryDeps = {
  isProjectWorkerEnabled: () => boolean;
  requireDb: () => Promise<DbHandle>;
  getProjectJobLogContext: (
    job: Pick<
      ProjectJobRow,
      "id" | "projectId" | "type" | "status" | "progress"
    >,
    extra?: Record<string, unknown>
  ) => Record<string, unknown>;
  failAnalysisProjectIfStillAnalyzing: (
    job: ProjectJobRow,
    now: Date,
    error?: AppError
  ) => Promise<void>;
  failImportProjectIfStillImporting: (
    job: ProjectJobRow,
    now: Date,
    error?: AppError
  ) => Promise<void>;
  markProjectAsRecoveryFailed: (
    projectId: number,
    status: ProjectStatus,
    message: string,
    now: Date
  ) => Promise<void>;
  kickProjectJobWorker: () => void | Promise<void>;
};

export async function recoverStaleProjectJobsOnStartupImpl(
  deps: ProjectJobRecoveryDeps,
  now = new Date(),
  staleAfterMs = STALE_PROJECT_JOB_MS
) {
  if (!deps.isProjectWorkerEnabled()) {
    logger.info("Project worker disabled; skipping startup recovery.", {
      action: "project.job.recovery.skipped",

      status: "ok",
    });

    return 0;
  }

  const db = await deps.requireDb();

  const staleBefore = new Date(now.getTime() - staleAfterMs);

  const allJobs = await db
    .select()
    .from(projectJobs)
    .where(inArray(projectJobs.status, ["queued", "running"]));

  let recoveredJobCount = 0;

  for (const job of allJobs) {
    if (job.status === "queued") {
      recoveredJobCount += 1;

      continue;
    }

    if (job.status !== "running") {
      continue;
    }

    const heartbeatAt = toDate(job.heartbeatAt);

    const leaseUntil = toDate(job.leaseUntil);

    const startedAt = toDate(job.startedAt);

    const isLeaseExpired =
      hasProjectJobLease(job) && isProjectJobLeaseExpired(job, now);

    const isStaleByLegacyWindow =
      !heartbeatAt &&
      !leaseUntil &&
      (!startedAt || startedAt.getTime() <= staleBefore.getTime());

    if (!isLeaseExpired && !isStaleByLegacyWindow) {
      continue;
    }

    if (canRetryProjectJob(job)) {
      const updateResult = await db

        .update(projectJobs)

        .set({
          status: "queued",

          progress: 0,

          errorCode: null,

          errorMessage: null,

          lockedBy: null,

          leaseUntil: null,

          heartbeatAt: null,

          startedAt: null,

          finishedAt: null,
        })

        .where(
          and(
            eq(projectJobs.id, job.id),

            eq(projectJobs.status, "running"),

            job.lockedBy
              ? eq(projectJobs.lockedBy, job.lockedBy)
              : isNull(projectJobs.lockedBy),

            eq(projectJobs.attemptCount, getProjectJobAttemptCount(job))
          )
        );

      const affectedRows = extractAffectedRows(updateResult);

      if (typeof affectedRows === "number" && affectedRows === 0) {
        logger.warn(
          "Startup recovery skipped requeue because ownership changed",
          {
            action: "project.job.recovery.skipped",

            status: "error",

            jobId: job.id,

            projectId: job.projectId,

            lockedBy: job.lockedBy,

            attemptCount: getProjectJobAttemptCount(job),
          }
        );

        continue;
      }

      logger.warn("Recovered stale project job back to queue", {
        action: "project.job.stale.recovered",

        ...deps.getProjectJobLogContext(job, {
          status: "queued",

          leaseUntil,

          heartbeatAt,

          attemptCount: getProjectJobAttemptCount(job),

          maxAttempts: getProjectJobMaxAttempts(job),
        }),
      });

      recoveredJobCount += 1;

      continue;
    }

    const retryMessage = `Project job exceeded its retry budget (${getProjectJobAttemptCount(job)}/${getProjectJobMaxAttempts(job)}) after lease recovery.`;

    const updateResult = await db

      .update(projectJobs)

      .set({
        status: "failed",

        activeKey: null,

        payloadJson: null,

        lockedBy: null,

        leaseUntil: null,

        heartbeatAt: null,

        errorCode: "JOB_STALE_MAX_ATTEMPTS",

        errorMessage: retryMessage,

        finishedAt: now,
      })

      .where(
        and(
          eq(projectJobs.id, job.id),

          eq(projectJobs.status, "running"),

          job.lockedBy
            ? eq(projectJobs.lockedBy, job.lockedBy)
            : isNull(projectJobs.lockedBy),

          eq(projectJobs.attemptCount, getProjectJobAttemptCount(job))
        )
      );

    const affectedRows = extractAffectedRows(updateResult);

    if (typeof affectedRows === "number" && affectedRows === 0) {
      logger.warn(
        "Startup recovery skipped a project job because ownership changed",
        {
          action: "project.job.recovery.skipped",

          status: "error",

          jobId: job.id,

          projectId: job.projectId,

          lockedBy: job.lockedBy,

          attemptCount: getProjectJobAttemptCount(job),
        }
      );

      continue;
    }

    if (job.type === "analyze") {
      await deps.failAnalysisProjectIfStillAnalyzing(
        job,
        now,
        new AppError("JOB_STALE_MAX_ATTEMPTS", retryMessage)
      );
    } else {
      await deps.failImportProjectIfStillImporting(
        job,
        now,
        new AppError("JOB_STALE_MAX_ATTEMPTS", retryMessage)
      );
    }

    logger.error("Project job exhausted stale recovery retries", {
      action: "project.job.stale.failed",

      ...deps.getProjectJobLogContext(job, {
        status: "failed",

        errorCode: "JOB_STALE_MAX_ATTEMPTS",

        errorMessage: retryMessage,

        leaseUntil,

        heartbeatAt,

        attemptCount: getProjectJobAttemptCount(job),

        maxAttempts: getProjectJobMaxAttempts(job),
      }),
    });
  }

  const activeJobsAfterRecovery = await db
    .select()
    .from(projectJobs)
    .where(inArray(projectJobs.status, ["queued", "running"]));

  const projectRows = await db
    .select()
    .from(projects)
    .where(inArray(projects.status, ["importing", "analyzing"]));

  for (const project of projectRows) {
    if (project.status !== "importing" && project.status !== "analyzing") {
      continue;
    }

    const hasActiveJob = activeJobsAfterRecovery.some(
      job =>
        job.projectId === project.id && isActiveProjectJobStatus(job.status)
    );

    if (hasActiveJob) {
      continue;
    }

    const recoveryMessage =
      project.status === "importing"
        ? "Project import was left in an active state without a recoverable job after server startup."
        : "Project analysis was left in an active state without a recoverable job after server startup.";

    await deps.markProjectAsRecoveryFailed(
      project.id,
      project.status,
      recoveryMessage,
      now
    );
  }

  if (recoveredJobCount > 0) {
    void deps.kickProjectJobWorker();
  }

  return recoveredJobCount;
}
