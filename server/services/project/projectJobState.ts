import type { ProjectStatus } from "../../../shared/contracts";
import { projectStatusLabels } from "../../../shared/contracts";
import { projectJobs } from "../../../drizzle/schema";
import { AppError } from "../../appError";
import { parsePositiveIntEnv } from "../../_core/env";

export const ACTIVE_PROJECT_JOB_KEY = "active";
export const STALE_PROJECT_JOB_MS = parsePositiveIntEnv("PROJECT_JOB_STALE_MS", 900000);
export const PROJECT_JOB_LEASE_MS = parsePositiveIntEnv("PROJECT_JOB_LEASE_MS", 30000);
export const PROJECT_JOB_HEARTBEAT_MS = parsePositiveIntEnv("PROJECT_JOB_HEARTBEAT_MS", 10000);
export const DEFAULT_PROJECT_JOB_MAX_ATTEMPTS = parsePositiveIntEnv("PROJECT_JOB_MAX_ATTEMPTS", 3);
export const PROJECT_WORKER_POLL_INTERVAL_MS = parsePositiveIntEnv("PROJECT_WORKER_POLL_INTERVAL_MS", 2000);

export type ProjectJobRow = typeof projectJobs.$inferSelect;

const projectStatusTransitions: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ["importing", "failed"],
  importing: ["ready", "failed"],
  ready: ["importing", "analyzing", "failed"],
  analyzing: ["completed", "failed"],
  completed: ["importing", "analyzing", "failed"],
  failed: ["importing", "analyzing"],
};

export function assertProjectTransition(current: ProjectStatus, next: ProjectStatus) {
  if (current === next) {
    return;
  }

  if (!projectStatusTransitions[current].includes(next)) {
    throw new AppError("INVALID_PROJECT_STATE", `Invalid project transition: ${current} -> ${next}.`);
  }
}

export function isActiveProjectJobStatus(status: ProjectJobRow["status"]) {
  return status === "queued" || status === "running";
}

export function isBlockingActiveProjectJob(
  job: Pick<ProjectJobRow, "status" | "leaseUntil">,
  now = new Date()
) {
  if (job.status === "queued") {
    return true;
  }

  return job.status === "running" && !isProjectJobLeaseExpired(job, now);
}

export function toDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

export function isProjectJobLeaseExpired(job: Pick<ProjectJobRow, "status" | "leaseUntil">, now = new Date()) {
  if (job.status !== "running") {
    return false;
  }

  const leaseUntil = toDate(job.leaseUntil);
  return !leaseUntil || leaseUntil.getTime() <= now.getTime();
}

export function hasProjectJobLease(job: Pick<ProjectJobRow, "leaseUntil">) {
  return toDate(job.leaseUntil) !== null;
}

export function getProjectJobAttemptCount(job: Pick<ProjectJobRow, "attemptCount">) {
  return Number(job.attemptCount ?? 0);
}

export function getProjectJobMaxAttempts(job: Pick<ProjectJobRow, "maxAttempts">) {
  return Math.max(1, Number(job.maxAttempts ?? DEFAULT_PROJECT_JOB_MAX_ATTEMPTS));
}

export function canRetryProjectJob(job: Pick<ProjectJobRow, "attemptCount" | "maxAttempts">) {
  return getProjectJobAttemptCount(job) < getProjectJobMaxAttempts(job);
}

export function buildProjectJobLease(now = new Date()) {
  return {
    heartbeatAt: now,
    leaseUntil: new Date(now.getTime() + PROJECT_JOB_LEASE_MS),
  };
}

export function assertProjectStatusAllowsJob(status: ProjectStatus, allowedStatuses: Set<ProjectStatus>) {
  if (!allowedStatuses.has(status)) {
    throw new AppError("INVALID_PROJECT_STATE", `Project is currently "${projectStatusLabels[status]}".`);
  }
}
