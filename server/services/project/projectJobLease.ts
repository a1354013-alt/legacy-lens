import type { ProjectJobRow } from "./projectJobState";
import { getProjectJobAttemptCount, toDate } from "./projectJobState";

export type ProjectJobOwnership = {
  jobId: number;
  projectId: number;
  type: ProjectJobRow["type"];
  lockedBy: string;
  attemptCount: number;
};

export type ProjectJobExecutionState = {
  ownership: ProjectJobOwnership | null;
  abortedError: ProjectJobExecutionAbortedError | null;
};

export class ProjectJobExecutionAbortedError extends Error {
  constructor(
    message: string,
    readonly reason: "ownership_lost" | "heartbeat_failed",
    readonly ownership: ProjectJobOwnership,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ProjectJobExecutionAbortedError";
  }
}

export function buildProjectJobOwnership(
  job: Pick<ProjectJobRow, "id" | "projectId" | "type" | "lockedBy" | "attemptCount">
): ProjectJobOwnership | null {
  if (!job.lockedBy) {
    return null;
  }

  return {
    jobId: job.id,
    projectId: job.projectId,
    type: job.type,
    lockedBy: job.lockedBy,
    attemptCount: getProjectJobAttemptCount(job),
  };
}

export function createProjectJobExecutionState(ownership: ProjectJobOwnership | null): ProjectJobExecutionState {
  return {
    ownership,
    abortedError: null,
  };
}

export function isProjectJobOwnershipActive(
  job: Pick<ProjectJobRow, "id" | "status" | "lockedBy" | "attemptCount" | "leaseUntil"> | null,
  ownership: ProjectJobOwnership,
  now = new Date()
) {
  if (!job) {
    return false;
  }

  const leaseUntil = toDate(job.leaseUntil);
  return (
    job.id === ownership.jobId &&
    job.status === "running" &&
    job.lockedBy === ownership.lockedBy &&
    getProjectJobAttemptCount(job) === ownership.attemptCount &&
    Boolean(leaseUntil && leaseUntil.getTime() > now.getTime())
  );
}

export function createProjectJobExecutionAbortedError(
  reason: "ownership_lost" | "heartbeat_failed",
  ownership: ProjectJobOwnership,
  action: string,
  cause?: unknown
) {
  const message =
    reason === "ownership_lost"
      ? `Project job ${ownership.jobId} lost ownership before ${action}.`
      : `Project job ${ownership.jobId} heartbeat failed before ${action}.`;
  return new ProjectJobExecutionAbortedError(message, reason, ownership, cause);
}
