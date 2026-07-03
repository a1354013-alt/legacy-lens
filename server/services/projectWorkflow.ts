import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  AnalysisWarning,
  AnalysisSnapshot,
  DependenciesPageInput,
  FieldDependenciesPageInput,
  FieldDependencyListItem,
  FieldListItem,
  FieldsPageInput,
  PagedResult,
  ProjectJobCreateResult,
  ProjectJobRecord,
  ImportWarning,
  ReportArchivePayload,
  RisksPageInput,
  RulesPageInput,
  SymbolListItem,
  SymbolsPageInput,
} from "../../shared/contracts";
import type { ImpactTargetType, ProjectStatus } from "../../shared/contracts";
import { calculateAnalysisConfidence, type AnalysisConfidence } from "../../shared/analysisConfidence";
import { projectStatusLabels } from "../../shared/contracts";
import {
  analysisResults,
  dependencies,
  fieldDependencies,
  fields,
  files,
  projectJobs,
  projects,
  risks,
  rules,
  symbols,
} from "../../drizzle/schema";
import { AppError, toAppError } from "../appError";
import { ImpactAnalyzer } from "../analyzer/impactAnalyzer";
import { resolveMostSpecificSymbol } from "../analyzer/symbolOwner";
import type { AnalyzedSymbol, ProjectAnalysisResult } from "../analyzer/types";
import { getDb } from "../db";
import type { DatabaseClient, InsertProjectRecord } from "../dbTypes";
import { getProjectFiles } from "../utils/fileExtractor";
import { validateSafeGitUrl } from "../utils/gitHandler";
import { extractInsertId } from "../utils/insertResult";
import { logger } from "../_core/logger";
import { getAppVersion } from "../_core/version";
import { runProjectJob } from "./jobWorker";
import {
  renderProjectImpactSummaryMarkdown,
  severityRank,
  sortFieldDependencies,
  sortProjectDependencies,
  sortProjectFields,
  sortProjectFiles,
  sortProjectRisks,
  sortProjectRules,
  sortProjectSymbols,
} from "./projectWorkflow.helpers";
import { clearPreviousAnalysisData } from "./project/projectAnalysisPersistence";
import { buildProjectReportArchiveBuffer } from "./project/projectReportArchive";
import { recoverStaleProjectJobsOnStartupImpl } from "./project/projectJobRecovery";
import {
  getDependenciesPageImpl,
  getFieldDependenciesPageImpl,
  getFieldsPageImpl,
  getRisksPageImpl,
  getRulesPageImpl,
  getSymbolsPageImpl,
} from "./project/projectPagedQueries";
import { getAnalysisSnapshotImpl } from "./project/projectSnapshotQueries";
import { extractAffectedRows, isInMemoryDb } from "./project/projectQueryUtils";
import { analyzeProjectImpl, type ProjectAnalysisRunnerDeps } from "./project/projectAnalysisRunner";
import { importProjectGitImpl } from "./project/projectImportGit";
import {
  importProjectZipFromTempFileImpl,
  importProjectZipImpl,
  type ProjectImportDeps,
} from "./project/projectImportZip";
import {
  ACTIVE_PROJECT_JOB_KEY,
  DEFAULT_PROJECT_JOB_MAX_ATTEMPTS,
  PROJECT_JOB_HEARTBEAT_MS,
  PROJECT_WORKER_POLL_INTERVAL_MS,
  STALE_PROJECT_JOB_MS,
  assertProjectTransition,
  buildProjectJobLease,
  canRetryProjectJob,
  getProjectJobAttemptCount,
  getProjectJobMaxAttempts,
  hasProjectJobLease,
  isActiveProjectJobStatus,
  isProjectJobLeaseExpired,
  toDate,
  type ProjectJobRow,
} from "./project/projectJobState";
import {
  ProjectJobExecutionAbortedError,
  buildProjectJobOwnership,
  createProjectJobExecutionAbortedError,
  createProjectJobExecutionState,
  isProjectJobOwnershipActive,
  type ProjectJobExecutionState,
  type ProjectJobOwnership,
} from "./project/projectJobLease";
import {
  getImportZipPayloadTempPath,
  projectJobPayloadSchema,
  serializeProjectJobPayload,
  type ProjectJobPayload,
} from "./project/projectJobPayload";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;

const queuedJobPromises = new Map<number, Promise<void>>();
const PROJECT_JOB_LOCK_OWNER = process.env.PROJECT_WORKER_ID?.trim() || `worker-${process.pid}-${randomUUID()}`;
const ANALYSIS_INSERT_CHUNK_SIZE = 250;
const MYSQL_MEDIUMTEXT_MAX_BYTES = 16_777_215;
let projectJobWorkerLoop: Promise<void> | null = null;
let projectJobWorkerPollTimer: NodeJS.Timeout | null = null;
let projectJobWorkerKickCount = 0;
let projectJobWorkerLoopStartCount = 0;

type AnalysisFailureCode =
  | "ANALYSIS_PARSE_FAILED"
  | "ANALYSIS_PERSIST_FAILED"
  | "ANALYSIS_SUMMARY_FAILED"
  | "ANALYSIS_UNKNOWN_FAILED";

type AnalysisFailureContext = {
  stage: AnalysisFailureCode;
  projectId: number;
  jobId: number | null;
  focusLanguage?: string | null;
  fileCount?: number;
  filePath?: string;
  operation?: string;
  table?: string;
  rawMessage: string;
  stackPreview?: string[];
};

class AnalysisStageError extends AppError {
  constructor(
    code: AnalysisFailureCode,
    message: string,
    readonly context: AnalysisFailureContext,
    details?: string
  ) {
    super(code, message, details);
    this.name = "AnalysisStageError";
  }
}

function isProjectWorkerEnabled() {
  return process.env.PROJECT_WORKER_ENABLED !== "false";
}

function buildSymbolInsertKey(symbol: AnalyzedSymbol) {
  return symbol.stableKey;
}

function andAll(conditions: SQL[]): SQL {
  const [first, ...rest] = conditions;
  if (!first) {
    throw new Error("andAll requires at least one SQL condition.");
  }
  return rest.length === 0 ? first : (and(first, ...rest) as SQL);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function insertInChunks<T extends Record<string, unknown>>(db: DbHandle, table: object, rows: T[]) {
  for (const chunk of chunkArray(rows, ANALYSIS_INSERT_CHUNK_SIZE)) {
    await db.insert(table as typeof dependencies).values(chunk as never);
  }
}

function getProjectJobLogContext(
  job: Pick<ProjectJobRow, "id" | "projectId" | "type" | "status" | "progress">,
  extra: Record<string, unknown> = {}
) {
  return {
    jobId: job.id,
    projectId: job.projectId,
    type: job.type,
    status: job.status,
    progress: Number(job.progress ?? 0),
    ...extra,
  };
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error || "Unknown error");
}

function getStackPreview(error: unknown, maxLines = 4) {
  if (!(error instanceof Error) || !error.stack) {
    return undefined;
  }

  return error.stack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

function buildAnalysisErrorMessage(context: Pick<AnalysisFailureContext, "stage" | "rawMessage" | "filePath" | "operation" | "table">) {
  const parts = [context.stage, context.rawMessage];

  if (context.filePath) {
    parts.push(`filePath=${context.filePath}`);
  }

  if (context.table || context.operation) {
    const operationSummary = [context.operation, context.table].filter(Boolean).join(" @ ");
    parts.push(`db=${operationSummary}`);
  }

  return parts.join(" | ");
}

function toAnalysisStageError(
  error: unknown,
  context: Omit<AnalysisFailureContext, "rawMessage" | "stackPreview">
): AnalysisStageError {
  if (error instanceof AnalysisStageError) {
    return error;
  }

  const rawMessage = getErrorMessage(error);
  const stackPreview = getStackPreview(error);
  const details = error instanceof AppError ? error.details : rawMessage;

  return new AnalysisStageError(
    context.stage,
    buildAnalysisErrorMessage({
      stage: context.stage,
      rawMessage,
      filePath: context.filePath,
      operation: context.operation,
      table: context.table,
    }),
    {
      ...context,
      rawMessage,
      stackPreview,
    },
    details
  );
}

function buildAnalysisFailureWarning(error: AppError): AnalysisWarning {
  const context = error instanceof AnalysisStageError ? error.context : null;

  return {
    code: error.code,
    message: error.message,
    level: "error",
    filePath: context?.filePath,
    heuristic: true,
  };
}

function toPublicProjectJobRecord(job: ProjectJobRow): ProjectJobRecord {
  return {
    id: job.id,
    projectId: job.projectId,
    userId: job.userId,
    type: job.type,
    status: job.status,
    progress: job.progress,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: toDate(job.createdAt) ?? new Date(0),
    startedAt: toDate(job.startedAt),
    finishedAt: toDate(job.finishedAt),
    attemptCount: getProjectJobAttemptCount(job),
    maxAttempts: getProjectJobMaxAttempts(job),
  };
}

function parseProjectJobPayload(job: Pick<ProjectJobRow, "id" | "type" | "payloadJson">): ProjectJobPayload {
  if (!job.payloadJson) {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is missing.`);
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(job.payloadJson);
  } catch {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is invalid.`);
  }

  const parsedPayload = projectJobPayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is invalid.`);
  }

  const parsed = parsedPayload.data;
  if (!parsed || parsed.type !== job.type) {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is invalid.`);
  }

  return parsed;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /duplicate entry|unique/i.test(error.message);
}

export async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AppError("DATABASE_UNAVAILABLE", "Database connection is not configured.");
  }
  return db;
}

async function getOwnedProjectWithHandle(db: DbHandle, projectId: number, userId: number) {
  const project = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project[0]) {
    throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
  }

  return project[0];
}

export async function getOwnedProject(projectId: number, userId: number) {
  const db = await requireDb();
  return getOwnedProjectWithHandle(db, projectId, userId);
}

async function replaceAnalysisResult(db: DbHandle, projectId: number, values: Omit<typeof analysisResults.$inferInsert, "projectId">) {
  await db.delete(analysisResults).where(eq(analysisResults.projectId, projectId));
  await db.insert(analysisResults).values({
    projectId,
    ...values,
  });
}

async function getExistingUsableAnalysisResult(db: DbHandle, projectId: number) {
  const [report] = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.projectId, projectId), inArray(analysisResults.status, ["completed", "completed_with_warnings", "partial"])))
    .limit(1);

  return report ?? null;
}

async function writeProcessingAnalysisResultIfNoUsableSnapshot(db: DbHandle, projectId: number) {
  const existingReport = await getExistingUsableAnalysisResult(db, projectId);
  if (existingReport) {
    return;
  }

  await replaceAnalysisResult(db, projectId, {
    status: "processing",
    flowMarkdown: null,
    dataDependencyMarkdown: null,
    risksMarkdown: null,
    rulesYaml: null,
    summaryJson: null,
    warningsJson: [],
    errorMessage: null,
  });
}

async function transitionProjectState(
  db: DbHandle,
  projectId: number,
  updates: Partial<InsertProjectRecord> & { status: ProjectStatus },
  userId?: number
) {
  const current = userId
    ? await getOwnedProjectWithHandle(db, projectId, userId)
    : (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];

  if (!current) {
    throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
  }

  assertProjectTransition(current.status, updates.status);

  const condition = userId ? and(eq(projects.id, projectId), eq(projects.userId, userId)) : eq(projects.id, projectId);
  await db.update(projects).set({ ...updates, updatedAt: new Date() }).where(condition);
}

async function hasProjectJobOwnership(ownership: ProjectJobOwnership, now = new Date()) {
  const job = await getProjectJobById(ownership.jobId);
  return isProjectJobOwnershipActive(job, ownership, now);
}

function markProjectJobExecutionAborted(
  state: ProjectJobExecutionState,
  error: ProjectJobExecutionAbortedError,
  action: string,
  extra: Record<string, unknown> = {}
) {
  if (!state.abortedError) {
    state.abortedError = error;
    logger.warn("Project job execution aborted", {
      action,
      status: "error",
      jobId: error.ownership.jobId,
      projectId: error.ownership.projectId,
      type: error.ownership.type,
      lockedBy: error.ownership.lockedBy,
      attemptCount: error.ownership.attemptCount,
      reason: error.reason,
      message: error.message,
      ...extra,
    });
  }

  return state.abortedError;
}

async function assertProjectJobExecutionActive(
  state: ProjectJobExecutionState | undefined,
  action: string,
  options?: { refreshLease?: boolean }
) {
  if (!state?.ownership) {
    return;
  }

  if (state.abortedError) {
    throw state.abortedError;
  }

  try {
    const stillOwned = options?.refreshLease
      ? await heartbeatProjectJobLease(state.ownership)
      : await hasProjectJobOwnership(state.ownership);
    if (!stillOwned) {
      throw markProjectJobExecutionAborted(
        state,
        createProjectJobExecutionAbortedError("ownership_lost", state.ownership, action),
        "project.job.execution.aborted",
        { checkpoint: action }
      );
    }
  } catch (error) {
    if (error instanceof ProjectJobExecutionAbortedError) {
      throw error;
    }

    throw markProjectJobExecutionAborted(
      state,
      createProjectJobExecutionAbortedError("heartbeat_failed", state.ownership, action, error),
      "project.job.execution.aborted",
      {
        checkpoint: action,
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

async function getProjectJobById(jobId: number) {
  const db = await requireDb();
  const [job] = await db.select().from(projectJobs).where(eq(projectJobs.id, jobId)).limit(1);
  return job ?? null;
}

async function getProjectById(projectId: number) {
  const db = await requireDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return project ?? null;
}

async function createQueuedProjectJob(projectId: number, userId: number, payload: ProjectJobPayload): Promise<number> {
  const db = await requireDb();
  const nextStatus = payload.type === "analyze" ? "analyzing" : "importing";
  const allowedStatuses =
    payload.type === "analyze"
      ? new Set<ProjectStatus>(["ready", "completed", "failed"])
      : new Set<ProjectStatus>(["draft", "ready", "completed", "failed"]);

  try {
    return await db.transaction(async (tx) => {
      const project = await getOwnedProjectWithHandle(tx, projectId, userId);
      const existingJobs = await tx.select().from(projectJobs).where(and(eq(projectJobs.projectId, projectId), eq(projectJobs.userId, userId)));
      if (existingJobs.some((job) => isActiveProjectJobStatus(job.status))) {
        throw new AppError("PROJECT_JOB_ACTIVE", "Project already has an active job.");
      }

      if (!allowedStatuses.has(project.status)) {
        throw new AppError("INVALID_PROJECT_STATE", `Project is currently "${projectStatusLabels[project.status]}".`);
      }

      const insertResult = await tx.insert(projectJobs).values({
        projectId,
        userId,
        type: payload.type,
        status: "queued",
        progress: 0,
        errorCode: null,
        errorMessage: null,
        payloadJson: serializeProjectJobPayload(payload),
        activeKey: ACTIVE_PROJECT_JOB_KEY,
        lockedBy: null,
        leaseUntil: null,
        heartbeatAt: null,
        attemptCount: 0,
        maxAttempts: DEFAULT_PROJECT_JOB_MAX_ATTEMPTS,
        startedAt: null,
        finishedAt: null,
      });

      const jobId = extractInsertId(insertResult);
      if (jobId <= 0) {
        throw new AppError("DATABASE_UNAVAILABLE", "Job was created but its identifier could not be resolved.");
      }

      await transitionProjectState(
        tx,
        projectId,
        {
          status: nextStatus,
          importProgress: payload.type === "analyze" ? project.importProgress : 0,
          analysisProgress: payload.type === "analyze" ? 0 : project.analysisProgress,
          sourceUrl: payload.type === "import_git" ? payload.gitUrl : project.sourceUrl,
          errorMessage: null,
          lastErrorCode: null,
        },
        userId
      );

      if (payload.type === "analyze") {
        await writeProcessingAnalysisResultIfNoUsableSnapshot(tx, projectId);
      }

      return jobId;
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (isUniqueConstraintError(error)) {
      throw new AppError("PROJECT_JOB_ACTIVE", "Project already has an active job.");
    }
    throw error;
  }
}

function kickProjectJobWorker() {
  projectJobWorkerKickCount += 1;

  if (!isProjectWorkerEnabled()) {
    return null;
  }

  if (projectJobWorkerLoop) {
    return projectJobWorkerLoop;
  }

  projectJobWorkerLoopStartCount += 1;
  projectJobWorkerLoop = (async () => {
    try {
      while (await processNextQueuedProjectJob()) {
        // Keep draining queued jobs until none remain for this worker cycle.
      }
    } finally {
      projectJobWorkerLoop = null;
    }
  })();

  return projectJobWorkerLoop;
}

export function startProjectJobWorkerPolling(intervalMs = PROJECT_WORKER_POLL_INTERVAL_MS) {
  if (!isProjectWorkerEnabled()) {
    return null;
  }

  if (projectJobWorkerPollTimer) {
    return projectJobWorkerPollTimer;
  }

  projectJobWorkerPollTimer = setInterval(() => {
    void kickProjectJobWorker();
  }, intervalMs);
  projectJobWorkerPollTimer.unref?.();

  return projectJobWorkerPollTimer;
}

export function stopProjectJobWorkerPolling() {
  if (!projectJobWorkerPollTimer) {
    return;
  }

  clearInterval(projectJobWorkerPollTimer);
  projectJobWorkerPollTimer = null;
}

function compareProjectJobClaimOrder(left: Pick<ProjectJobRow, "createdAt" | "id">, right: Pick<ProjectJobRow, "createdAt" | "id">) {
  const leftCreatedAt = toDate(left.createdAt)?.getTime() ?? 0;
  const rightCreatedAt = toDate(right.createdAt)?.getTime() ?? 0;
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  return Number(left.id) - Number(right.id);
}

function buildClaimableProjectJobWhere(now: Date, legacyStaleBefore: Date) {
  return and(
    sql`${projectJobs.attemptCount} < ${projectJobs.maxAttempts}`,
    or(
      eq(projectJobs.status, "queued"),
      and(
        eq(projectJobs.status, "running"),
        or(
          and(sql`${projectJobs.leaseUntil} is not null`, sql`${projectJobs.leaseUntil} <= ${now}`),
          and(isNull(projectJobs.leaseUntil), or(isNull(projectJobs.startedAt), sql`${projectJobs.startedAt} <= ${legacyStaleBefore}`))
        )
      )
    )
  );
}

async function selectClaimableProjectJobCandidate(
  db: DbHandle,
  now: Date,
  legacyStaleBefore: Date
): Promise<ProjectJobRow | null> {
  if (isInMemoryDb(db)) {
    const jobs = await db.select().from(projectJobs);
    const candidate = jobs
      .filter((job) => {
        if (!canRetryProjectJob(job)) {
          return false;
        }

        if (job.status === "queued") {
          return true;
        }

        if (job.status !== "running") {
          return false;
        }

        if (hasProjectJobLease(job)) {
          return isProjectJobLeaseExpired(job, now);
        }

        const startedAt = toDate(job.startedAt);
        return !startedAt || startedAt.getTime() <= legacyStaleBefore.getTime();
      })
      .sort(compareProjectJobClaimOrder)[0];

    return candidate ?? null;
  }

  const [candidate] = await db
    .select()
    .from(projectJobs)
    .where(buildClaimableProjectJobWhere(now, legacyStaleBefore))
    .orderBy(asc(projectJobs.createdAt), asc(projectJobs.id))
    .limit(1);

  return candidate ?? null;
}

async function claimNextQueuedProjectJob(): Promise<ProjectJobRow | null> {
  const db = await requireDb();
  const now = new Date();
  const legacyStaleBefore = new Date(now.getTime() - STALE_PROJECT_JOB_MS);
  while (true) {
    const nextJob = await selectClaimableProjectJobCandidate(db, now, legacyStaleBefore);
    if (!nextJob) {
      return null;
    }

    const startedAt = nextJob.startedAt ? toDate(nextJob.startedAt) ?? now : now;
    const lease = buildProjectJobLease(now);
    const expectedAttemptCount = getProjectJobAttemptCount(nextJob) + 1;
    const updateConditions = [eq(projectJobs.id, nextJob.id)];

    if (nextJob.status === "queued") {
      updateConditions.push(eq(projectJobs.status, "queued"));
    } else {
      updateConditions.push(eq(projectJobs.status, "running"));
      updateConditions.push(nextJob.lockedBy ? eq(projectJobs.lockedBy, nextJob.lockedBy) : isNull(projectJobs.lockedBy));
      updateConditions.push(nextJob.leaseUntil ? eq(projectJobs.leaseUntil, nextJob.leaseUntil) : isNull(projectJobs.leaseUntil));
    }

    const updateResult = await db
      .update(projectJobs)
      .set({
        status: "running",
        progress: nextJob.status === "queued" ? 10 : Math.max(10, Number(nextJob.progress ?? 0)),
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        lockedBy: PROJECT_JOB_LOCK_OWNER,
        heartbeatAt: lease.heartbeatAt,
        leaseUntil: lease.leaseUntil,
        attemptCount: expectedAttemptCount,
      })
      .where(andAll(updateConditions));

    const affectedRows = extractAffectedRows(updateResult);
    if (typeof affectedRows === "number" && affectedRows === 0) {
      continue;
    }

    const [claimedJob] = await db.select().from(projectJobs).where(eq(projectJobs.id, nextJob.id)).limit(1);
    if (
      !claimedJob ||
      claimedJob.status !== "running" ||
      claimedJob.lockedBy !== PROJECT_JOB_LOCK_OWNER ||
      getProjectJobAttemptCount(claimedJob) !== expectedAttemptCount ||
      !toDate(claimedJob.heartbeatAt) ||
      !isProjectJobOwnershipActive(claimedJob, {
        jobId: claimedJob.id,
        projectId: claimedJob.projectId,
        type: claimedJob.type,
        lockedBy: PROJECT_JOB_LOCK_OWNER,
        attemptCount: expectedAttemptCount,
      }, now)
    ) {
      continue;
    }

    const queuedAt = toDate(claimedJob.createdAt);
    logger.info("Project job claimed", {
      action: "project.job.claimed",
      ...getProjectJobLogContext(claimedJob, {
        status: "running",
        progress: Number(claimedJob.progress ?? 0),
      queueWaitMs: queuedAt ? Math.max(0, now.getTime() - queuedAt.getTime()) : null,
      attemptCount: claimedJob.attemptCount,
      maxAttempts: claimedJob.maxAttempts,
      leaseUntil: claimedJob.leaseUntil,
      lockedBy: claimedJob.lockedBy,
      }),
    });

    return claimedJob;
  }
}

async function createProjectAndQueuedImportJob(
  userId: number,
  input: {
    name: string;
    focusLanguage: typeof projects.$inferInsert.language;
    sourceType: typeof projects.$inferInsert.sourceType;
    description?: string;
  },
  payload: Extract<ProjectJobPayload, { type: "import_zip" | "import_git" }>
): Promise<ProjectJobCreateResult> {
  const db = await requireDb();

  const result = await db.transaction(async (tx) => {
    const projectInsert = await tx.insert(projects).values({
      userId,
      name: input.name,
      description: input.description,
      language: input.focusLanguage,
      sourceType: input.sourceType,
      sourceUrl: payload.type === "import_git" ? payload.gitUrl : null,
      status: "importing",
      importProgress: 0,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: [],
    });

    const projectId = extractInsertId(projectInsert);
    if (projectId <= 0) {
      throw new AppError("DATABASE_UNAVAILABLE", "Project was created but its identifier could not be resolved from the insert result.");
    }

    const jobInsert = await tx.insert(projectJobs).values({
      projectId,
      userId,
      type: payload.type,
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: serializeProjectJobPayload(payload),
      activeKey: ACTIVE_PROJECT_JOB_KEY,
      lockedBy: null,
      leaseUntil: null,
      heartbeatAt: null,
      attemptCount: 0,
      maxAttempts: DEFAULT_PROJECT_JOB_MAX_ATTEMPTS,
      startedAt: null,
      finishedAt: null,
    });

    const jobId = extractInsertId(jobInsert);
    if (jobId <= 0) {
      throw new AppError("DATABASE_UNAVAILABLE", "Job was created but its identifier could not be resolved.");
    }

    return { projectId, jobId };
  });

  void kickProjectJobWorker();

  return {
    jobId: result.jobId,
    projectId: result.projectId,
    status: "queued",
  };
}

export async function claimNextQueuedProjectJobForTests() {
  return claimNextQueuedProjectJob();
}

export function getProjectJobWorkerSchedulerStateForTests() {
  return {
    kickCount: projectJobWorkerKickCount,
    loopStartCount: projectJobWorkerLoopStartCount,
    pollingActive: projectJobWorkerPollTimer !== null,
  };
}

export function resetProjectJobWorkerSchedulerStateForTests() {
  stopProjectJobWorkerPolling();
  projectJobWorkerKickCount = 0;
  projectJobWorkerLoopStartCount = 0;
}

async function failImportProjectIfStillImporting(job: ProjectJobRow, now: Date, error?: AppError) {
  const db = await requireDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId)).limit(1);
  if (project?.status !== "importing") {
    return;
  }
  await db
    .update(projects)
    .set({
      status: "failed",
      importProgress: Math.max(Number(project.importProgress ?? 0), Number(job.progress ?? 0)),
      errorMessage: error?.message ?? "Import failed.",
      lastErrorCode: error?.code ?? null,
      updatedAt: now,
    })
    .where(eq(projects.id, job.projectId));
}

async function failAnalysisProjectIfStillAnalyzing(job: ProjectJobRow, now: Date, error?: AppError) {
  const db = await requireDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId)).limit(1);
  if (project?.status !== "analyzing") {
    return;
  }

  const fallbackMessage = buildAnalysisErrorMessage({
    stage: "ANALYSIS_UNKNOWN_FAILED",
    rawMessage: "Analysis job ended without a captured error.",
  });
  const failureWarning = error ? [buildAnalysisFailureWarning(error)] : [];

  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        status: "failed",
        analysisProgress: 0,
        errorMessage: error?.message ?? fallbackMessage,
        lastErrorCode: error?.code ?? null,
        updatedAt: now,
      })
      .where(eq(projects.id, job.projectId));

    const existingResult = await tx.select().from(analysisResults).where(eq(analysisResults.projectId, job.projectId)).limit(1);
    const existingUsableResult =
      existingResult[0]?.status === "completed" ||
      existingResult[0]?.status === "completed_with_warnings" ||
      existingResult[0]?.status === "partial";
    if (existingUsableResult) {
      return;
    }

    await replaceAnalysisResult(tx, job.projectId, {
      status: "failed",
      flowMarkdown: null,
      dataDependencyMarkdown: null,
      risksMarkdown: null,
      rulesYaml: null,
      summaryJson: null,
      warningsJson: failureWarning,
      errorMessage: error?.message ?? fallbackMessage,
    });
  });
}

async function updateImportExecutionProgress(projectId: number, progress: number, executionState?: ProjectJobExecutionState) {
  const safeProgress = Math.min(100, Math.max(0, Math.floor(progress)));
  const db = await requireDb();
  await db.update(projects).set({ importProgress: safeProgress, updatedAt: new Date() }).where(eq(projects.id, projectId));

  const ownership = executionState?.ownership;
  if (!ownership) {
    return;
  }

  await db
    .update(projectJobs)
    .set({ progress: safeProgress })
    .where(
      and(
        eq(projectJobs.id, ownership.jobId),
        eq(projectJobs.status, "running"),
        eq(projectJobs.lockedBy, ownership.lockedBy),
        eq(projectJobs.attemptCount, ownership.attemptCount)
      )
    );
}

async function executeProjectJob(job: ProjectJobRow, executionState: ProjectJobExecutionState) {
  const payload = parseProjectJobPayload(job);

  if (payload.type === "import_zip") {
    if ("tempFilePath" in payload) {
      await importProjectZipFromTempFile(job.projectId, job.userId, payload.tempFilePath, executionState);
      return;
    }

    await importProjectZip(job.projectId, job.userId, payload.zipContent, executionState);
    return;
  }

  if (payload.type === "import_git") {
    await importProjectGit(job.projectId, job.userId, payload.gitUrl, executionState);
    return;
  }

  await analyzeProject(job.projectId, job.userId, executionState);
}

function buildProjectJobFailureFallback(job: Pick<ProjectJobRow, "type">) {
  if (job.type === "analyze") {
    return new AppError(
      "ANALYSIS_UNKNOWN_FAILED",
      buildAnalysisErrorMessage({
        stage: "ANALYSIS_UNKNOWN_FAILED",
        rawMessage: "Project job failed without a captured analysis error.",
      })
    );
  }

  return new AppError("IMPORT_FAILED", "Project job failed.");
}

async function heartbeatProjectJobLease(ownership: ProjectJobOwnership) {
  const db = await requireDb();
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

async function assertProjectJobProjectExists(projectId: number) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new AppError("PROJECT_NOT_FOUND", "Project no longer exists.");
  }
}

async function finalizeProjectJob(
  job: ProjectJobRow,
  executionState: ProjectJobExecutionState,
  status: "completed" | "failed",
  error?: AppError
) {
  const now = new Date();
  const queuedAt = toDate(job.createdAt);
  const startedAt = toDate(job.startedAt);
  const queueDurationMs = queuedAt && startedAt ? Math.max(0, startedAt.getTime() - queuedAt.getTime()) : null;
  const runDurationMs = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  const ownership = executionState.ownership;

  if (!ownership) {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be finalized because its ownership metadata is missing.`);
  }

  await assertProjectJobExecutionActive(executionState, `job.finalize.${status}`, { refreshLease: true });
  const db = await requireDb();
  const updateResult = await db
    .update(projectJobs)
    .set({
      status,
      ...(status === "completed" ? { progress: 100 } : {}),
      activeKey: null,
      payloadJson: null,
      lockedBy: null,
      leaseUntil: null,
      heartbeatAt: null,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      finishedAt: now,
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
  if (typeof affectedRows === "number" && affectedRows === 0) {
    throw markProjectJobExecutionAborted(
      executionState,
      createProjectJobExecutionAbortedError("ownership_lost", ownership, `job.finalize.${status}`),
      "project.job.execution.aborted",
      { checkpoint: `job.finalize.${status}` }
    );
  }

  if (status === "failed") {
    if (job.type === "import_zip" || job.type === "import_git") {
      await failImportProjectIfStillImporting(job, now, error);
    }

    if (job.type === "analyze") {
      await failAnalysisProjectIfStillAnalyzing(job, now, error);
    }
  }

  logger.info(`Project job ${status}`, {
    action: `project.job.${status}`,
    ...getProjectJobLogContext(job, {
      status,
      progress: status === "completed" ? 100 : Number(job.progress ?? 0),
      queueDurationMs,
      runDurationMs,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
    }),
  });
}

function buildImportWarningSummaryWarnings(
  projectFiles: Awaited<ReturnType<typeof getProjectFiles>>,
  importWarnings: ImportWarning[]
): AnalysisWarning[] {
  if (importWarnings.length === 0) {
    return [];
  }

  const pasFileCount = projectFiles.filter((file) => (file.fileType ?? "").toLowerCase() === ".pas").length;
  const limitedAnalysisWarnings = importWarnings.filter((warning) => warning.code === "IMPORT_LIMITED_ANALYSIS");
  const dfmLimitedAnalysisCount = limitedAnalysisWarnings.filter((warning) => (warning.filePath ?? "").toLowerCase().endsWith(".dfm")).length;
  const encodingWarningCount = importWarnings.filter((warning) => warning.code === "IMPORT_ENCODING_DETECTED").length;

  return [
    {
      code: "ANALYSIS_INPUT_SUMMARY",
      message: `Imported ${projectFiles.length} files; found ${pasFileCount} .pas files, ${dfmLimitedAnalysisCount} .dfm limited-analysis warnings, and ${encodingWarningCount} legacy-encoding warnings.`,
      level: "note",
      heuristic: true,
    },
    ...importWarnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      level: "warning" as const,
      filePath: warning.filePath,
      heuristic: true,
    })),
  ];
}

function mergeAnalysisWarnings(base: AnalysisWarning[], additions: AnalysisWarning[]) {
  const merged: AnalysisWarning[] = [];
  const seen = new Set<string>();

  for (const warning of [...base, ...additions]) {
    const key = `${warning.code}:${warning.filePath ?? ""}:${warning.message}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(warning);
  }

  return merged;
}

function isAnalysisConfidence(value: unknown): value is AnalysisConfidence {
  if (!value || typeof value !== "object") {
    return false;
  }

  const confidence = value as Partial<AnalysisConfidence>;
  return (
    typeof confidence.score === "number" &&
    ["high", "medium", "low"].includes(String(confidence.level)) &&
    Array.isArray(confidence.breakdown)
  );
}

function inferAnalysisResultFileTypes(result: ProjectAnalysisResult) {
  const paths = [
    ...result.symbols.map((symbol) => symbol.file),
    ...result.fieldReferences.map((reference) => reference.file),
    ...result.risks.map((risk) => risk.sourceFile),
    ...result.rules.map((rule) => rule.sourceFile),
    ...result.warnings.map((warning) => warning.filePath),
  ];

  return paths
    .filter((path): path is string => Boolean(path))
    .map((path) => path.match(/\.[^.\\/]+$/)?.[0] ?? path);
}

function recalculateAnalysisResultConfidence(
  result: ProjectAnalysisResult,
  context: { importWarnings?: ImportWarning[]; fileTypes?: string[] } = {}
): ProjectAnalysisResult {
  const metrics = {
    ...result.metrics,
    warningCount: result.warnings.length,
  };

  return {
    ...result,
    metrics: {
      ...metrics,
      confidence: calculateAnalysisConfidence({
        metrics,
        importWarnings: context.importWarnings ?? [],
        analyzerWarnings: result.warnings,
        fileTypes: context.fileTypes ?? inferAnalysisResultFileTypes(result),
        risks: result.risks,
      }),
    },
  };
}

function applyAdditionalAnalysisWarnings(
  result: ProjectAnalysisResult,
  additionalWarnings: AnalysisWarning[],
  context: { importWarnings?: ImportWarning[]; fileTypes?: string[] } = {}
): ProjectAnalysisResult {
  if (additionalWarnings.length === 0) {
    return result;
  }

  const warnings = mergeAnalysisWarnings(result.warnings, additionalWarnings);
  const warningCount = warnings.length;
  const nextStatus =
    result.status === "failed"
      ? "failed"
      : result.status === "completed"
        ? "completed_with_warnings"
        : result.status;

  return recalculateAnalysisResultConfidence({
    ...result,
    status: nextStatus,
    warnings,
    metrics: {
      ...result.metrics,
      warningCount,
    },
  }, context);
}

function getAnalysisResultErrorMessage(result: Pick<ProjectAnalysisResult, "status">) {
  return result.status === "partial" || result.status === "completed_with_warnings"
    ? "Analysis completed with warnings."
    : null;
}

function truncateUtf8(text: string, maxBytes: number, footer: string) {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }

  const footerBytes = Buffer.byteLength(footer, "utf8");
  let low = 0;
  let high = text.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    const candidateBytes = Buffer.byteLength(candidate, "utf8") + footerBytes;
    if (candidateBytes <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const safeText = best.replace(/\s+$/u, "");
  return {
    text: `${safeText}${footer}`,
    truncated: true,
    originalBytes,
  };
}

function buildDocumentTruncationFooter(kind: "markdown" | "yaml") {
  return kind === "yaml"
    ? "\n# Truncated to fit Legacy Lens database storage limits.\n"
    : "\n\n> Truncated to fit Legacy Lens database storage limits.\n";
}

function makeAnalysisPartialResultPersistable(
  result: ProjectAnalysisResult,
  context: { importWarnings?: ImportWarning[]; fileTypes?: string[] } = {}
): ProjectAnalysisResult {
  const truncationWarnings: AnalysisWarning[] = [];
  const truncateDocument = (value: string, documentName: string, kind: "markdown" | "yaml") => {
    const truncated = truncateUtf8(value, MYSQL_MEDIUMTEXT_MAX_BYTES, buildDocumentTruncationFooter(kind));
    if (truncated.truncated) {
      truncationWarnings.push({
        code: "ANALYSIS_DOCUMENT_TRUNCATED",
        message: `${documentName} exceeded MySQL MEDIUMTEXT storage and was truncated from ${truncated.originalBytes} bytes.`,
        level: "warning",
        heuristic: true,
      });
    }

    return truncated.text;
  };

  const flowDocument = truncateDocument(result.flowDocument, "flowMarkdown", "markdown");
  const dataDependencyDocument = truncateDocument(result.dataDependencyDocument, "dataDependencyMarkdown", "markdown");
  const risksDocument = truncateDocument(result.risksDocument, "risksMarkdown", "markdown");
  const rulesYaml = truncateDocument(result.rulesYaml, "rulesYaml", "yaml");

  if (truncationWarnings.length === 0) {
    return result;
  }

  const warnings = mergeAnalysisWarnings(result.warnings, truncationWarnings);
  return recalculateAnalysisResultConfidence({
    ...result,
    status: result.status === "failed" ? "failed" : result.status === "partial" ? "partial" : "completed_with_warnings",
    warnings,
    flowDocument,
    dataDependencyDocument,
    risksDocument,
    rulesYaml,
    metrics: {
      ...result.metrics,
      warningCount: warnings.length,
    },
  }, context);
}

function throwAnalysisPersistError(
  error: unknown,
  context: {
    projectId: number;
    executionState?: ProjectJobExecutionState;
    operation: string;
    table: string;
    filePath?: string;
  }
): never {
  throw toAnalysisStageError(error, {
    stage: "ANALYSIS_PERSIST_FAILED",
    projectId: context.projectId,
    jobId: context.executionState?.ownership?.jobId ?? null,
    fileCount: undefined,
    operation: context.operation,
    table: context.table,
    filePath: context.filePath,
  });
}

export async function failClaimedProjectJobBestEffort(ownership: ProjectJobOwnership, error: AppError) {
  const job = await getProjectJobById(ownership.jobId);
  if (!job || job.status !== "running") {
    return false;
  }

  const now = new Date();
  const payload = (() => {
    try {
      return parseProjectJobPayload(job);
    } catch {
      return null;
    }
  })();
  const tempFilePath = payload ? getImportZipPayloadTempPath(payload) : null;
  const db = await requireDb();
  const updateResult = await db
    .update(projectJobs)
    .set({
      status: "failed",
      activeKey: null,
      payloadJson: null,
      lockedBy: null,
      leaseUntil: null,
      heartbeatAt: null,
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: now,
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
  if (typeof affectedRows === "number" && affectedRows === 0) {
    logger.warn("Project job failure skipped because ownership changed", {
      action: "project.job.failure_skipped",
      ...getProjectJobLogContext(job, {
        status: job.status,
        lockedBy: ownership.lockedBy,
        attemptCount: ownership.attemptCount,
        errorCode: error.code,
        errorMessage: error.message,
      }),
    });
    return false;
  }

  if (job.type === "analyze") {
    await failAnalysisProjectIfStillAnalyzing(job, now, error);
  } else {
    await failImportProjectIfStillImporting(job, now, error);
  }

  if (tempFilePath) {
    await rm(tempFilePath, { force: true }).catch((cleanupError) => {
      logger.warn("Project job temp file cleanup failed", {
        action: "project.job.cleanup_failed",
        ...getProjectJobLogContext(job, {
          status: "failed",
          tempFilePath,
          errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }),
      });
    });
  }

  logger.error("Project job failed with fenced ownership", {
    action: "project.job.failed",
    ...getProjectJobLogContext(job, {
      status: "failed",
      lockedBy: ownership.lockedBy,
      attemptCount: ownership.attemptCount,
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: now,
    }),
  });

  return true;
}

export async function runClaimedProjectJob(jobId: number) {
  const claimedJob = await getProjectJobById(jobId);
  if (!claimedJob) {
    throw new AppError("PROJECT_JOB_NOT_FOUND", `Project job ${jobId} was not found.`);
  }
  const executionState = createProjectJobExecutionState(buildProjectJobOwnership(claimedJob));
  let tempFilePath: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  try {
    const payload = parseProjectJobPayload(claimedJob);
    tempFilePath = getImportZipPayloadTempPath(payload);
    await assertProjectJobProjectExists(claimedJob.projectId);
    await assertProjectJobExecutionActive(executionState, "job.start", { refreshLease: true });
    logger.info("Project job started", {
      action: "project.job.started",
      ...getProjectJobLogContext(claimedJob, {
        status: "running",
        lockedBy: executionState.ownership?.lockedBy ?? null,
        attemptCount: executionState.ownership?.attemptCount ?? null,
        tempFilePath,
      }),
    });
    const heartbeatOwnership = executionState.ownership;
    if (heartbeatOwnership) {
      heartbeatTimer = setInterval(() => {
        void heartbeatProjectJobLease(heartbeatOwnership)
          .then((stillOwned) => {
            logger.info("Project job heartbeat renewed", {
              action: "project.job.heartbeat",
              ...getProjectJobLogContext(claimedJob, {
                status: stillOwned ? "running" : "failed",
                lockedBy: heartbeatOwnership.lockedBy,
                attemptCount: heartbeatOwnership.attemptCount,
              }),
            });
            if (!stillOwned) {
              markProjectJobExecutionAborted(
                executionState,
                createProjectJobExecutionAbortedError("ownership_lost", heartbeatOwnership, "job.heartbeat"),
                "project.job.execution.aborted",
                { checkpoint: "job.heartbeat" }
              );
            }
          })
          .catch((error) => {
            markProjectJobExecutionAborted(
              executionState,
              createProjectJobExecutionAbortedError("heartbeat_failed", heartbeatOwnership, "job.heartbeat", error),
              "project.job.execution.aborted",
              {
                checkpoint: "job.heartbeat",
                cause: error instanceof Error ? error.message : String(error),
              }
            );
          });
      }, Math.max(1_000, PROJECT_JOB_HEARTBEAT_MS));
    }
    await executeProjectJob(claimedJob, executionState);
    await assertProjectJobExecutionActive(executionState, "job.pre_finalize");
    await assertProjectJobProjectExists(claimedJob.projectId);
    await finalizeProjectJob(claimedJob, executionState, "completed");
  } catch (error) {
    if (error instanceof ProjectJobExecutionAbortedError) {
      return;
    }

    const appError = toAppError(error, buildProjectJobFailureFallback(claimedJob));
    try {
      await finalizeProjectJob(claimedJob, executionState, "failed", appError);
    } catch (finalizeError) {
      if (finalizeError instanceof ProjectJobExecutionAbortedError) {
        return;
      }
      throw finalizeError;
    }
    throw appError;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (tempFilePath) {
      await rm(tempFilePath, { force: true }).catch(() => undefined);
    }
  }
}

async function processNextQueuedProjectJob() {
  const claimedJob = await claimNextQueuedProjectJob();
  if (!claimedJob) {
    return false;
  }

  const ownership = buildProjectJobOwnership(claimedJob);
  if (!ownership) {
    logger.error("Project job dispatch failed", {
      action: "project.job.worker.error",
      ...getProjectJobLogContext(claimedJob, {
        status: "failed",
        errorCode: "PROJECT_JOB_STALE",
        errorMessage: "Project job ownership metadata was missing after claim.",
      }),
    });
    return false;
  }

  const promise = runProjectJob(claimedJob.id, ownership)
    .catch((error) => {
      const appError = toAppError(error, buildProjectJobFailureFallback(claimedJob));
      logger.error("Project job dispatch failed", {
        action: "project.job.worker.error",
        ...getProjectJobLogContext(claimedJob, {
          status: "failed",
          errorCode: appError.code,
          errorMessage: appError.message,
        }),
      });
    })
    .finally(() => {
      queuedJobPromises.delete(claimedJob.id);
    });

  queuedJobPromises.set(claimedJob.id, promise);
  await promise;
  return true;
}

async function enqueueProjectJob(projectId: number, userId: number, payload: ProjectJobPayload): Promise<ProjectJobCreateResult> {
  const jobId = await createQueuedProjectJob(projectId, userId, payload);
  void kickProjectJobWorker();

  return {
    jobId,
    projectId,
    status: "queued",
  };
}

export async function waitForProjectJobForTests(jobId: number) {
  while (true) {
    const job = await getProjectJobById(jobId);
    if (!job || !isActiveProjectJobStatus(job.status)) {
      return;
    }

    if (queuedJobPromises.has(jobId)) {
      await queuedJobPromises.get(jobId);
      continue;
    }

    if (projectJobWorkerLoop) {
      await projectJobWorkerLoop;
      continue;
    }

    await kickProjectJobWorker();
  }
}

export async function waitForAllProjectJobsForTests() {
  while (true) {
    const db = await requireDb();
    const rows = await db.select().from(projectJobs);
    if (!rows.some((row) => isActiveProjectJobStatus(row.status))) {
      return;
    }

    if (projectJobWorkerLoop) {
      await projectJobWorkerLoop;
      continue;
    }

    await kickProjectJobWorker();
  }
}

async function markProjectAsRecoveryFailed(projectId: number, status: ProjectStatus, message: string, now: Date) {
  const db = await requireDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const updates: Partial<InsertProjectRecord> & { status: ProjectStatus } = {
    status: "failed",
    errorMessage: message,
    lastErrorCode: "PROJECT_JOB_STALE",
    updatedAt: now,
  };
  if (status === "importing") {
    updates.importProgress = Number(project?.importProgress ?? 0);
  }
  if (status === "analyzing") {
    updates.analysisProgress = 0;
  }

  await db.update(projects).set(updates).where(eq(projects.id, projectId));

  if (status === "analyzing") {
    const existingReport = await getExistingUsableAnalysisResult(db, projectId);
    if (existingReport) {
      return;
    }

    await replaceAnalysisResult(db, projectId, {
      status: "failed",
      flowMarkdown: null,
      dataDependencyMarkdown: null,
      risksMarkdown: null,
      rulesYaml: null,
      summaryJson: null,
      warningsJson: [],
      errorMessage: message,
    });
  }
}

export async function recoverStaleProjectJobsOnStartup(now = new Date(), staleAfterMs = STALE_PROJECT_JOB_MS) {
  return recoverStaleProjectJobsOnStartupImpl(
    {
      isProjectWorkerEnabled,
      requireDb,
      getProjectJobLogContext,
      failAnalysisProjectIfStillAnalyzing,
      failImportProjectIfStillImporting,
      markProjectAsRecoveryFailed,
      kickProjectJobWorker: () => {
        void kickProjectJobWorker();
      },
    },
    now,
    staleAfterMs
  );
}

export async function createProjectForUser(
  userId: number,
  input: {
    name: string;
    focusLanguage: typeof projects.$inferInsert.language;
    sourceType: typeof projects.$inferInsert.sourceType;
    description?: string;
  }
) {
  const db = await requireDb();
  const insertResult = await db.insert(projects).values({
    userId,
    name: input.name,
    description: input.description,
    language: input.focusLanguage,
    sourceType: input.sourceType,
    status: "draft",
    importProgress: 0,
    analysisProgress: 0,
    errorMessage: null,
    lastErrorCode: null,
    importWarningsJson: [],
  });

  const insertId = extractInsertId(insertResult);
  if (insertId <= 0) {
    throw new AppError("DATABASE_UNAVAILABLE", "Project was created but its identifier could not be resolved from the insert result.");
  }

  return insertId;
}

function getProjectImportDeps(): ProjectImportDeps {
  return {
    requireDb,
    getOwnedProject,
    assertProjectJobExecutionActive,
    updateImportExecutionProgress,
    transitionProjectState,
    clearPreviousAnalysisData,
  };
}

export async function importProjectZip(projectId: number, userId: number, zipContent: string, executionState?: ProjectJobExecutionState) {
  return importProjectZipImpl(getProjectImportDeps(), projectId, userId, zipContent, executionState);
}

export async function importProjectZipFromTempFile(
  projectId: number,
  userId: number,
  tempFilePath: string,
  executionState?: ProjectJobExecutionState
) {
  return importProjectZipFromTempFileImpl(getProjectImportDeps(), projectId, userId, tempFilePath, executionState);
}

export async function queueImportProjectZip(projectId: number, userId: number, zipContent: string) {
  return enqueueProjectJob(projectId, userId, {
    type: "import_zip",
    zipContent,
  });
}

export async function queueImportProjectZipFromTempFile(
  projectId: number,
  userId: number,
  tempFilePath: string,
  originalFileName?: string | null
) {
  return enqueueProjectJob(projectId, userId, {
    type: "import_zip",
    tempFilePath,
    originalFileName,
  });
}

export async function createProjectWithQueuedZipImport(
  userId: number,
  input: {
    name: string;
    focusLanguage: typeof projects.$inferInsert.language;
    sourceType: "upload";
    description?: string;
  },
  tempFilePath: string,
  originalFileName?: string | null
) {
  return createProjectAndQueuedImportJob(userId, input, {
    type: "import_zip",
    tempFilePath,
    originalFileName,
  });
}

export async function importProjectGit(projectId: number, userId: number, gitUrl: string, executionState?: ProjectJobExecutionState) {
  return importProjectGitImpl(getProjectImportDeps(), projectId, userId, gitUrl, executionState);
}

export async function queueImportProjectGit(projectId: number, userId: number, gitUrl: string) {
  return enqueueProjectJob(projectId, userId, {
    type: "import_git",
    gitUrl,
  });
}

export async function createProjectWithQueuedGitImport(
  userId: number,
  input: {
    name: string;
    focusLanguage: typeof projects.$inferInsert.language;
    sourceType: "git";
    description?: string;
  },
  gitUrl: string
) {
  const validatedGitUrl = await validateSafeGitUrl(gitUrl);
  return createProjectAndQueuedImportJob(userId, input, {
    type: "import_git",
    gitUrl: validatedGitUrl.gitUrl,
  });
}

function resolveOwningSymbol(symbolsForProject: AnalyzedSymbol[], file: string, line: number) {
  return resolveMostSpecificSymbol(symbolsForProject, line, file);
}

function resolveInsertedTargetSymbolId(
  dependency: ProjectAnalysisResult["dependencies"][number],
  symbolsForProject: AnalyzedSymbol[],
  insertedSymbolIds: Map<string, number>
) {
  if (dependency.to) {
    const targetByStableKey = insertedSymbolIds.get(dependency.to);
    if (targetByStableKey) {
      return targetByStableKey;
    }
  }

  const sourceSymbol = symbolsForProject.find((symbol) => symbol.stableKey === dependency.from);
  const sourceFile = sourceSymbol?.file.replace(/\\/g, "/");
  const candidates = symbolsForProject.filter((symbol) => {
    const symbolFile = symbol.file.replace(/\\/g, "/");
    return (
      symbol.qualifiedName === dependency.toName ||
      `${symbolFile}::${symbol.qualifiedName ?? symbol.name}` === dependency.toName ||
      (sourceFile === symbolFile && (symbol.name === dependency.toName || (symbol.qualifiedName?.split(".").at(-1) ?? symbol.name) === dependency.toName))
    );
  });
  const uniqueCandidate = candidates.length === 1 ? candidates[0] : null;

  return uniqueCandidate ? insertedSymbolIds.get(buildSymbolInsertKey(uniqueCandidate)) : undefined;
}

function getProjectAnalysisRunnerDeps(): ProjectAnalysisRunnerDeps {
  return {
    requireDb,
    getOwnedProject,
    assertProjectJobExecutionActive,
    transitionProjectState,
    writeProcessingAnalysisResultIfNoUsableSnapshot,
    toAnalysisStageError,
    createAnalysisStageError: (code, message, context) => new AnalysisStageError(code, message, context),
    getAnalysisFailureContext: (error) => (error instanceof AnalysisStageError ? error.context : null),
    buildAnalysisErrorMessage,
    applyAdditionalAnalysisWarnings,
    buildImportWarningSummaryWarnings,
    makeAnalysisPartialResultPersistable,
    recalculateAnalysisResultConfidence,
    replaceAnalysisResult,
    getAnalysisResultErrorMessage,
    throwAnalysisPersistError,
    insertInChunks,
    resolveOwningSymbol,
    resolveInsertedTargetSymbolId,
    getExistingUsableAnalysisResult,
    mergeAnalysisWarnings,
  };
}

export async function analyzeProject(projectId: number, userId: number, executionState?: ProjectJobExecutionState) {
  return analyzeProjectImpl(getProjectAnalysisRunnerDeps(), projectId, userId, executionState);
}

export async function queueAnalyzeProject(projectId: number, userId: number) {
  return enqueueProjectJob(projectId, userId, {
    type: "analyze",
  });
}

async function getProjectAnalysisRecord(db: DbHandle, projectId: number) {
  const [report] = await db.select().from(analysisResults).where(eq(analysisResults.projectId, projectId)).limit(1);
  return report ?? null;
}

function isReportReadyForExport(
  report: Awaited<ReturnType<typeof getProjectAnalysisRecord>>
): report is NonNullable<Awaited<ReturnType<typeof getProjectAnalysisRecord>>> & {
  flowMarkdown: string;
  dataDependencyMarkdown: string;
  risksMarkdown: string;
  rulesYaml: string;
} {
  return Boolean(
    report &&
      (report.status === "completed" || report.status === "completed_with_warnings" || report.status === "partial") &&
      report.flowMarkdown &&
      report.dataDependencyMarkdown &&
      report.risksMarkdown &&
      report.rulesYaml
  );
}

const DELPHI_LIKE_EXTENSIONS = new Set([".pas", ".dpr", ".dfm", ".inc", ".dpk", ".fmx"]);

function normalizeReportFileType(fileType: string | null | undefined) {
  return (fileType ?? "unknown").trim().toLowerCase() || "unknown";
}

function classifyReportLanguage(fileType: string | null | undefined) {
  const normalized = normalizeReportFileType(fileType).replace(/^\./, "");
  if (normalized === "go") return "go";
  if (normalized === "sql") return "sql";
  if (["pas", "dpr", "dfm", "inc", "dpk", "fmx", "delphi"].includes(normalized)) return "delphi-like";
  return "unknown";
}

function escapeMarkdownTableCell(value: unknown) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function renderMarkdownTable(headers: string[], rows: unknown[][]) {
  return [
    `| ${headers.map(escapeMarkdownTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`),
  ].join("\n");
}

function getReportDelphiEventMap(report: NonNullable<Awaited<ReturnType<typeof getProjectAnalysisRecord>>>) {
  const summary = report.summaryJson as (typeof report.summaryJson & { delphiEventMap?: Array<Record<string, unknown>> }) | null;
  return Array.isArray(summary?.delphiEventMap) ? summary.delphiEventMap : [];
}

function getReportDelphiDataBindings(report: NonNullable<Awaited<ReturnType<typeof getProjectAnalysisRecord>>>) {
  const summary = report.summaryJson as (typeof report.summaryJson & { delphiDataBindings?: Array<Record<string, unknown>> }) | null;
  return Array.isArray(summary?.delphiDataBindings) ? summary.delphiDataBindings : [];
}

function renderDelphiEventMapMarkdown(eventMap: Array<Record<string, unknown>>) {
  return [
    "# DELPHI_EVENT_MAP",
    "",
    "This document maps DFM/FMX component events to Pascal procedure/function/method declarations.",
    "Heuristic note: runtime event assignment, inherited forms, and cross-unit handlers may require human verification.",
    "",
    eventMap.length === 0
      ? "No DFM/FMX event bindings were detected."
      : renderMarkdownTable(
          ["Form", "Component", "Class", "Event", "Handler", "Resolved method", "Resolved file", "Status", "Warnings"],
          eventMap.map((entry) => [
            entry.formName,
            entry.componentName,
            entry.componentClass,
            entry.eventName,
            entry.handlerName,
            entry.resolvedMethod,
            entry.resolvedFile,
            entry.status,
            Array.isArray(entry.warnings) ? entry.warnings.join(" ") : "",
          ])
        ),
    "",
  ].join("\n");
}

function renderDelphiDataBindingsMarkdown(bindings: Array<Record<string, unknown>>) {
  return [
    "# DELPHI_DATA_BINDINGS",
    "",
    "This document maps Delphi DB-aware UI components to DataSource, DataSet, and field metadata parsed from DFM/FMX files.",
    "Heuristic note: runtime assignment of DataSource, DataSet, DataField, and grid columns is reported as unresolved or lower confidence.",
    "",
    bindings.length === 0
      ? "No Delphi DB-aware component bindings were detected."
      : renderMarkdownTable(
          ["Form", "Component", "Class", "DataSource", "DataSet", "DataField", "ReadOnly", "Enabled", "Confidence", "Warning"],
          bindings.map((binding) => [
            binding.formName,
            binding.componentName,
            binding.componentClass,
            binding.dataSource,
            binding.dataSet,
            binding.dataField,
            binding.readOnly,
            binding.enabled,
            binding.confidence,
            Array.isArray(binding.warnings) ? binding.warnings.join(" ") : "",
          ])
        ),
    "",
  ].join("\n");
}

function reportLimitationLines() {
  return [
    "- Legacy Lens currently uses heuristic static analysis. Treat the report as review support, not compiler-grade proof.",
    "- Delphi `with` blocks may hide dataset ownership and can leave field or parameter owners as `unknown`.",
    "- Runtime event binding, inherited forms, dynamic DataSource/DataSet/DataField assignment, dynamic grid columns, dynamic SQL, legacy encoding, and cross-file dataset ownership may be incomplete.",
    "- Results need human review before production changes, migration planning, or audit sign-off.",
  ];
}

function countBy<T>(items: T[], predicate: (item: T) => boolean) {
  return items.filter(predicate).length;
}

function countRiskMatches(items: Array<typeof risks.$inferSelect>, pattern: RegExp) {
  return countBy(items, (risk) => pattern.test(`${risk.riskType ?? ""} ${risk.title ?? ""} ${risk.description ?? ""}`));
}

function countWarningMatches(items: Array<AnalysisWarning | ImportWarning>, pattern: RegExp) {
  return countBy(items, (warning) => pattern.test(`${warning.code ?? ""} ${warning.message ?? ""}`));
}

function renderExecutiveSummaryMarkdown(input: {
  metadata: {
    projectName: string;
    createdAt: string;
    focusLanguage: string | null;
  };
  project: typeof projects.$inferSelect | null;
  metrics: NonNullable<Awaited<ReturnType<typeof getProjectAnalysisRecord>>>["summaryJson"];
  confidence?: AnalysisConfidence | null;
  languageCounts: { delphiLike: number; go: number; sql: number; unknown: number };
  limitedFileCount: number;
  fileInventoryItems: Array<{ analysisSucceeded: boolean }>;
  risks: Array<typeof risks.$inferSelect>;
  warnings: AnalysisWarning[];
  importWarnings: ImportWarning[];
  delphiEventMap: Array<Record<string, unknown>>;
  delphiDataBindings: Array<Record<string, unknown>>;
  fieldAccessItems: Array<{ accessKind: string; operation: string }>;
}) {
  const confidenceLines = input.confidence
    ? [
        `- Score: ${input.confidence.score}/100`,
        `- Level: ${input.confidence.level}`,
        "",
        "Top confidence drivers:",
        ...input.confidence.breakdown
          .filter((item) => item.impact < 0)
          .slice(0, 5)
          .map((item) => `- ${item.label}: ${item.impact} (${item.reason})`),
      ]
    : ["- Score: unavailable", "- Level: unavailable", "", "Top confidence drivers:", "- Confidence breakdown unavailable."];
  if (input.confidence && confidenceLines[4] === undefined) {
    confidenceLines.push("- No major confidence penalties were detected.");
  }

  const allWarnings = [...input.importWarnings, ...input.warnings];
  const unresolvedEventCount = countBy(input.delphiEventMap, (entry) => entry.status === "unresolved");
  const resolvedEventCount = countBy(input.delphiEventMap, (entry) => entry.status === "resolved");
  const unresolvedBindingCount = countBy(
    input.delphiDataBindings,
    (binding) => binding.confidence !== "high" || binding.accessHint === "unresolved"
  );
  const resolvedBindingCount = Math.max(0, input.delphiDataBindings.length - unresolvedBindingCount);
  const writeAccessCount = countBy(input.fieldAccessItems, (item) => item.operation === "write" || item.operation === "read-write");
  const readAccessCount = Math.max(0, input.fieldAccessItems.length - writeAccessCount);
  const dynamicSqlCount = countWarningMatches(allWarnings, /SQL_DYNAMIC_STRING|dynamic sql/i) + countRiskMatches(input.risks, /dynamic sql|sql\.text|sql\.add/i);
  const hardcodedConfigCount = countRiskMatches(input.risks, /hardcoded|connection string|filesystem path/i);
  const emptyExceptionCount = countRiskMatches(input.risks, /empty exception|empty except|swallowed exception/i);
  const unknownFileCount = input.languageCounts.unknown;
  const skippedOrDegradedCount = (input.metrics?.skippedFileCount ?? 0) + (input.metrics?.degradedFileCount ?? 0);

  const keyFindingCandidates = [
    dynamicSqlCount > 0 ? `Dynamic SQL requires review in ${dynamicSqlCount} detected signal(s).` : null,
    hardcodedConfigCount > 0 ? `Hardcoded path or connection string findings appear in ${hardcodedConfigCount} risk item(s).` : null,
    emptyExceptionCount > 0 ? `Empty or swallowed exception handler findings appear in ${emptyExceptionCount} risk item(s).` : null,
    unresolvedEventCount > 0 ? `${unresolvedEventCount} DFM/FMX event handler binding(s) are unresolved.` : null,
    unresolvedBindingCount > 0 ? `${unresolvedBindingCount} Delphi DataSource/DataSet binding(s) are unresolved or lower confidence.` : null,
    writeAccessCount > 0 ? `${writeAccessCount} FieldByName/ParamByName write access signal(s) were detected.` : null,
    input.limitedFileCount > 0 ? `${input.limitedFileCount} file(s) have limited or heuristic analysis signals.` : null,
    unknownFileCount > 0 ? `${unknownFileCount} scanned file(s) have unknown language or extension.` : null,
    input.risks.length > 0 ? `${input.risks.length} persisted risk finding(s) are available for engineering review.` : null,
  ].filter((item): item is string => Boolean(item));
  const keyFindings = keyFindingCandidates.slice(0, 5);

  const p0 = [
    unresolvedEventCount > 0 ? "Manually confirm unresolved event handlers before changing related forms or workflows." : null,
    dynamicSqlCount > 0 || writeAccessCount > 0 ? "Manually review dynamic SQL and high-risk write access paths." : null,
    hardcodedConfigCount > 0 ? "Confirm whether hardcoded connection strings or paths should move to configuration." : null,
  ].filter((item): item is string => Boolean(item));
  const p1 = [
    input.risks.length > 0 || input.fieldAccessItems.length > 0 ? "Fill in data-flow documentation for the highest-risk flows." : null,
    input.risks.length > 0 || writeAccessCount > 0 ? "Add or refresh tests around high-risk flows before refactoring." : null,
    unresolvedBindingCount > 0 || input.delphiDataBindings.length > 0 ? "Clarify DataSource/DataSet ownership for DB-aware Delphi components." : null,
  ].filter((item): item is string => Boolean(item));
  const p2 = [
    input.risks.length > 0 ? "Refactor low-risk duplicate or hard-to-follow logic after P0/P1 review is complete." : null,
    input.languageCounts.delphiLike > 0 || input.languageCounts.unknown > 0 ? "Improve naming and local documentation around legacy modules." : null,
    "Add examples and onboarding notes for future maintainers.",
  ].filter((item): item is string => Boolean(item));

  const renderActions = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`) : ["- No urgent action was inferred from the persisted findings."]);
  const hasDelphiFindings = input.languageCounts.delphiLike > 0 || input.delphiEventMap.length > 0 || input.delphiDataBindings.length > 0 || input.fieldAccessItems.length > 0;

  return [
    "# EXECUTIVE_SUMMARY",
    "",
    "This summary is intended for non-engineering stakeholders and engineering leads who need a quick, conservative view of the analysis results.",
    "",
    "## Project Summary",
    `- Project name: ${input.metadata.projectName}`,
    `- Import source type: ${input.project?.sourceType ?? "unknown"}`,
    `- Focus language: ${input.metadata.focusLanguage ?? "unknown"}`,
    `- Analyzed at: ${input.metadata.createdAt}`,
    `- Scanned files: ${input.metrics?.fileCount ?? input.fileInventoryItems.length}`,
    `- Successfully analyzed files: ${input.metrics?.analyzedFileCount ?? countBy(input.fileInventoryItems, (item) => item.analysisSucceeded)}`,
    `- Skipped / degraded files: ${skippedOrDegradedCount}`,
    `- Language distribution: Delphi-like ${input.languageCounts.delphiLike}, Go ${input.languageCounts.go}, SQL ${input.languageCounts.sql}, Unknown ${input.languageCounts.unknown}`,
    `- Delphi-like files: ${input.languageCounts.delphiLike}`,
    "",
    "## Analysis Confidence",
    ...confidenceLines,
    "",
    "## Key Findings Top 5",
    ...(keyFindings.length > 0 ? keyFindings.map((item, index) => `${index + 1}. ${item}`) : ["1. No high-priority finding signals were detected in the persisted report."]),
    "",
    "## Delphi Audit Summary",
    ...(hasDelphiFindings
      ? [
          `- DFM/FMX event bindings: ${input.delphiEventMap.length}`,
          `- Resolved / unresolved event handlers: ${resolvedEventCount} / ${unresolvedEventCount}`,
          `- DB-aware data bindings: ${input.delphiDataBindings.length}`,
          `- Resolved / unresolved data bindings: ${resolvedBindingCount} / ${unresolvedBindingCount}`,
          `- FieldByName / ParamByName accesses: ${input.fieldAccessItems.length}`,
          `- Read / write access summary: ${readAccessCount} / ${writeAccessCount}`,
        ]
      : ["- No Delphi-specific findings were detected."]),
    "",
    "## Recommended Next Actions",
    "P0:",
    ...renderActions(p0),
    "",
    "P1:",
    ...renderActions(p1),
    "",
    "P2:",
    ...renderActions(p2),
    "",
    "## Manual Review Notice",
    "Legacy Lens uses heuristic static analysis. It is not a Delphi compiler and it is not a complete IDE parser.",
    "Use this report to guide review, prioritization, and follow-up investigation rather than as a guarantee of complete program behavior.",
    "",
    "The following cases may require manual review:",
    "- `with` blocks",
    "- Runtime event binding",
    "- Inherited forms",
    "- Dynamic SQL",
    "- Encoding issues",
    "- Dataset ownership",
    "- Runtime-created components",
    "",
  ].join("\n");
}

function resolveReportConfidence(input: {
  report: NonNullable<Awaited<ReturnType<typeof getProjectAnalysisRecord>>>;
  importWarnings: ImportWarning[];
  analyzerWarnings: AnalysisWarning[];
  fileTypes: string[];
  risks: Array<typeof risks.$inferSelect>;
}) {
  const persistedConfidence = input.report.summaryJson?.confidence;
  if (isAnalysisConfidence(persistedConfidence)) {
    return persistedConfidence;
  }

  return calculateAnalysisConfidence({
    metrics: input.report.summaryJson,
    importWarnings: input.importWarnings,
    analyzerWarnings: input.analyzerWarnings,
    fileTypes: input.fileTypes,
    risks: input.risks,
  });
}

async function buildReportCompletenessArtifacts(
  db: Awaited<ReturnType<typeof requireDb>>,
  input: {
    project: typeof projects.$inferSelect | null;
    report: NonNullable<Awaited<ReturnType<typeof getProjectAnalysisRecord>>>;
    metadata: {
      projectName: string;
      analysisVersion: string;
      createdAt: string;
      focusLanguage: string | null;
      fileCount: number;
      symbolCount: number;
      dependencyCount: number;
      warningCount: number;
      importWarningCount: number;
    };
    projectId: number;
  }
) {
  const [fileRows, symbolRows, dependencyRows, fieldRows, fieldDependencyRows, riskRows, ruleRows] = await Promise.all([
    db.select().from(files).where(eq(files.projectId, input.projectId)),
    db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),
    db.select().from(dependencies).where(eq(dependencies.projectId, input.projectId)),
    db.select().from(fields).where(eq(fields.projectId, input.projectId)),
    db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, input.projectId)),
    db.select().from(risks).where(eq(risks.projectId, input.projectId)),
    db.select().from(rules).where(eq(rules.projectId, input.projectId)),
  ]);

  const sortedFiles = sortProjectFiles(fileRows);
  const sortedSymbols = sortProjectSymbols(symbolRows);
  const sortedDependencies = sortProjectDependencies(dependencyRows);
  const sortedFields = sortProjectFields(fieldRows);
  const sortedFieldDependencies = sortFieldDependencies(fieldDependencyRows);
  const sortedRisks = sortProjectRisks(riskRows);
  const sortedRules = sortProjectRules(ruleRows);

  const importWarnings = input.project?.importWarningsJson ?? [];
  const analyzerWarnings = input.report.warningsJson ?? [];
  const allWarnings = [...importWarnings, ...analyzerWarnings];
  const delphiEventMap = getReportDelphiEventMap(input.report);
  const delphiDataBindings = getReportDelphiDataBindings(input.report);
  const fileById = new Map(sortedFiles.map((file) => [file.id, file]));
  const fieldById = new Map(sortedFields.map((field) => [field.id, field]));
  const symbolById = new Map(sortedSymbols.map((symbol) => [symbol.id, symbol]));
  const symbolsByFileId = new Map<number, number>();
  const dependenciesByFileId = new Map<number, number>();
  const risksByFilePath = new Map<string, number>();
  const warningsByFilePath = new Map<string, number>();
  const limitedFilePaths = new Set<string>();

  for (const symbol of sortedSymbols) {
    symbolsByFileId.set(symbol.fileId, (symbolsByFileId.get(symbol.fileId) ?? 0) + 1);
  }

  for (const dependency of sortedDependencies) {
    const sourceFileId = symbolById.get(dependency.sourceSymbolId)?.fileId;
    if (sourceFileId) {
      dependenciesByFileId.set(sourceFileId, (dependenciesByFileId.get(sourceFileId) ?? 0) + 1);
    }
  }

  for (const risk of sortedRisks) {
    if (risk.sourceFile) {
      risksByFilePath.set(risk.sourceFile, (risksByFilePath.get(risk.sourceFile) ?? 0) + 1);
    }
  }

  for (const warning of allWarnings) {
    if (warning.filePath) {
      warningsByFilePath.set(warning.filePath, (warningsByFilePath.get(warning.filePath) ?? 0) + 1);
      if (warning.code === "IMPORT_LIMITED_ANALYSIS" || ("heuristic" in warning && warning.heuristic)) {
        limitedFilePaths.add(warning.filePath);
      }
    }
  }

  for (const file of sortedFiles) {
    if (DELPHI_LIKE_EXTENSIONS.has(normalizeReportFileType(file.fileType)) && file.fileType !== ".pas" && file.fileType !== ".dpr") {
      limitedFilePaths.add(file.filePath);
    }
  }

  const languageCounts = sortedFiles.reduce(
    (counts, file) => {
      const language = classifyReportLanguage(file.fileType);
      if (language === "delphi-like") counts.delphiLike += 1;
      if (language === "go") counts.go += 1;
      if (language === "sql") counts.sql += 1;
      if (language === "unknown") counts.unknown += 1;
      return counts;
    },
    { delphiLike: 0, go: 0, sql: 0, unknown: 0 }
  );

  const fileInventoryItems = sortedFiles.map((file) => {
    const symbolCount = symbolsByFileId.get(file.id) ?? 0;
    const dependencyCount = dependenciesByFileId.get(file.id) ?? 0;
    const riskCount = risksByFilePath.get(file.filePath) ?? 0;
    const warningCount = warningsByFilePath.get(file.filePath) ?? 0;
    const importWarningCodes = importWarnings.filter((warning) => warning.filePath === file.filePath).map((warning) => warning.code);
    const analysisSucceeded = file.status === "stored" && !importWarningCodes.includes("IMPORT_SKIPPED_UNSUPPORTED");

    return {
      filePath: file.filePath,
      fileType: normalizeReportFileType(file.fileType),
      language: classifyReportLanguage(file.fileType),
      analysisSucceeded,
      symbolCount,
      dependencyCount,
      riskCount,
      warningCount,
    };
  });

  const fieldAccessItems = sortedFieldDependencies
    .map((dependency) => {
      const field = fieldById.get(dependency.fieldId);
      const symbol = symbolById.get(dependency.symbolId);
      const filePath = symbol ? (fileById.get(symbol.fileId)?.filePath ?? null) : null;
      const context = dependency.context ?? "";
      const accessKind = /ParamByName\s*\(/i.test(context) ? "param" : "field";
      const ownerMatch = context.match(/([A-Za-z_][\w.]*)\s*\.\s*(?:FieldByName|ParamByName)\s*\(/i);

      return {
        filePath: filePath ?? field?.tableName ?? "unknown",
        lineNumber: dependency.lineNumber ?? null,
        owner: ownerMatch?.[1] ?? "unknown",
        accessKind,
        name: field?.fieldName ?? "unknown",
        operation: dependency.operationType,
        context: context || null,
        symbolName: symbol?.name ?? null,
      };
    })
    .filter((item) => item.filePath.toLowerCase().endsWith(".pas") || item.accessKind === "param" || item.context?.match(/FieldByName|ParamByName/i));
  const confidence = resolveReportConfidence({
    report: input.report,
    importWarnings,
    analyzerWarnings,
    fileTypes: sortedFiles.map((file) => file.fileType).filter((fileType): fileType is string => Boolean(fileType)),
    risks: sortedRisks,
  });

  const projectOverviewMarkdown = [
    "# PROJECT_OVERVIEW",
    "",
    `- Project name: ${input.metadata.projectName}`,
    `- Import source type: ${input.project?.sourceType ?? "unknown"}`,
    `- Analysis time: ${input.metadata.createdAt}`,
    `- Total scanned files: ${sortedFiles.length}`,
    `- Delphi-like files: ${languageCounts.delphiLike}`,
    `- Go files: ${languageCounts.go}`,
    `- SQL files: ${languageCounts.sql}`,
    `- Unknown files: ${languageCounts.unknown}`,
    `- Limited-analysis files: ${limitedFilePaths.size}`,
    "",
    "## Analysis Confidence",
    `- Score: ${confidence.score}/100`,
    `- Level: ${confidence.level}`,
    "",
    renderMarkdownTable(
      ["Label", "Impact", "Reason"],
      confidence.breakdown.map((item) => [item.label, item.impact > 0 ? `+${item.impact}` : item.impact, item.reason])
    ),
    "",
    "## Findings Summary",
    `- Symbols: ${sortedSymbols.length}`,
    `- Dependencies: ${sortedDependencies.length}`,
    `- Risks: ${sortedRisks.length}`,
    `- Field accesses: ${fieldAccessItems.length}`,
    `- Import warnings: ${importWarnings.length}`,
    `- Analyzer warnings: ${analyzerWarnings.length}`,
    "",
    "## Report Limits",
    ...reportLimitationLines(),
    "",
  ].join("\n");

  const fileInventoryMarkdown = [
    "# FILE_INVENTORY",
    "",
    renderMarkdownTable(
      ["File path", "File type", "Language", "Analyzed", "Symbol count", "Dependency count", "Risk count", "Warning count"],
      fileInventoryItems.map((item) => [
        item.filePath,
        item.fileType,
        item.language,
        item.analysisSucceeded ? "yes" : "no",
        item.symbolCount,
        item.dependencyCount,
        item.riskCount,
        item.warningCount,
      ])
    ),
    "",
  ].join("\n");

  const delphiFieldAccessMarkdown = [
    "# DELPHI_FIELD_ACCESS",
    "",
    fieldAccessItems.length === 0
      ? "No Pascal FieldByName or ParamByName accesses were detected in persisted analysis artifacts."
      : renderMarkdownTable(
          ["File path", "Line", "Owner", "Field/param", "Read/write", "Context"],
          fieldAccessItems.map((item) => [
            item.filePath,
            item.lineNumber ?? "unknown",
            item.owner,
            `${item.accessKind}:${item.name}`,
            item.operation,
            item.context ?? "",
          ])
        ),
    "",
    "Owner note: when dataset or parameter ownership cannot be inferred from the static context, owner is reported as `unknown`.",
    "",
  ].join("\n");

  const delphiEventMapMarkdown = renderDelphiEventMapMarkdown(delphiEventMap);
  const delphiDataBindingsMarkdown = renderDelphiDataBindingsMarkdown(delphiDataBindings);
  const limitationsMarkdown = ["# LIMITATIONS", "", ...reportLimitationLines(), ""].join("\n");
  const executiveSummaryMarkdown = renderExecutiveSummaryMarkdown({
    metadata: input.metadata,
    project: input.project,
    metrics: input.report.summaryJson,
    confidence,
    languageCounts,
    limitedFileCount: limitedFilePaths.size,
    fileInventoryItems,
    risks: sortedRisks,
    warnings: analyzerWarnings,
    importWarnings,
    delphiEventMap,
    delphiDataBindings,
    fieldAccessItems,
  });

  const fullFindings = {
    metadata: {
      ...input.metadata,
      confidence,
      projectId: input.projectId,
      sourceType: input.project?.sourceType ?? "unknown",
      reportStatus: input.report.status,
      reportId: input.report.id,
    },
    confidence,
    files: fileInventoryItems,
    symbols: sortedSymbols.map((symbol) => ({
      id: symbol.id,
      filePath: fileById.get(symbol.fileId)?.filePath ?? null,
      name: symbol.name,
      type: symbol.type,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      signature: symbol.signature ?? null,
      description: symbol.description ?? null,
      metadata: symbol.metadata ?? null,
    })),
    dependencies: sortedDependencies.map((dependency) => ({
      id: dependency.id,
      sourceSymbolId: dependency.sourceSymbolId,
      sourceSymbolName: symbolById.get(dependency.sourceSymbolId)?.name ?? null,
      targetSymbolId: dependency.targetSymbolId ?? null,
      targetSymbolName: dependency.targetSymbolId ? (symbolById.get(dependency.targetSymbolId)?.name ?? null) : null,
      targetExternalName: dependency.targetExternalName ?? null,
      targetKind: dependency.targetKind,
      dependencyType: dependency.dependencyType,
      lineNumber: dependency.lineNumber ?? null,
    })),
    risks: sortedRisks.map((risk) => ({
      id: risk.id,
      riskType: risk.riskType,
      severity: risk.severity,
      title: risk.title,
      description: risk.description ?? null,
      sourceFile: risk.sourceFile ?? null,
      lineNumber: risk.lineNumber ?? null,
      codeSnippet: risk.codeSnippet ?? null,
      recommendation: risk.recommendation ?? null,
    })),
    rules: sortedRules.map((rule) => ({
      id: rule.id,
      ruleType: rule.ruleType,
      name: rule.name,
      description: rule.description ?? null,
      condition: rule.condition ?? null,
      sourceFile: rule.sourceFile ?? null,
      lineNumber: rule.lineNumber ?? null,
    })),
    fieldAccesses: fieldAccessItems,
    delphiEventMap,
    delphiDataBindings,
    importWarnings,
    analyzerWarnings,
  };

  return {
    executiveSummaryMarkdown,
    projectOverviewMarkdown,
    fileInventoryMarkdown,
    delphiFieldAccessMarkdown,
    delphiEventMapMarkdown,
    delphiDataBindingsMarkdown,
    limitationsMarkdown,
    confidence,
    fullFindingsJson: JSON.stringify(fullFindings, null, 2),
  };
}

async function generateProjectImpactSummary(db: Awaited<ReturnType<typeof requireDb>>, projectId: number) {
  const [rawProjectFiles, rawProjectSymbols, rawProjectDependencies, rawProjectRisks, rawProjectRules] = await Promise.all([
    db.select().from(files).where(eq(files.projectId, projectId)),
    db.select().from(symbols).where(eq(symbols.projectId, projectId)),
    db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),
    db.select().from(risks).where(eq(risks.projectId, projectId)),
    db.select().from(rules).where(eq(rules.projectId, projectId)),
  ]);

  const projectFiles = sortProjectFiles(rawProjectFiles);
  const projectSymbols = sortProjectSymbols(rawProjectSymbols);
  const projectDependencies = sortProjectDependencies(rawProjectDependencies);
  const projectRisks = sortProjectRisks(rawProjectRisks);
  const projectRules = sortProjectRules(rawProjectRules);

  const fileById = new Map(projectFiles.map((file) => [file.id, file.filePath]));
  const symbolById = new Map(projectSymbols.map((symbol) => [symbol.id, symbol]));
  const fileImpactCounts = new Map<string, number>();

  const incrementFileImpact = (filePath: string | null | undefined) => {
    if (!filePath) return;
    fileImpactCounts.set(filePath, (fileImpactCounts.get(filePath) ?? 0) + 1);
  };

  projectRisks.forEach((risk) => incrementFileImpact(risk.sourceFile));
  projectRules.forEach((rule) => incrementFileImpact(rule.sourceFile));
  projectDependencies.forEach((dependency) => {
    incrementFileImpact(fileById.get(symbolById.get(dependency.sourceSymbolId)?.fileId ?? -1));
    incrementFileImpact(fileById.get(symbolById.get(dependency.targetSymbolId ?? -1)?.fileId ?? -1));
  });

  const dependencySummaries = projectDependencies
    .map((dependency) => {
      const source = symbolById.get(dependency.sourceSymbolId);
      const target = dependency.targetSymbolId ? symbolById.get(dependency.targetSymbolId) : null;
      const sourceName = source?.name ?? `symbol:${dependency.sourceSymbolId}`;
      const targetName = target?.name ?? dependency.targetExternalName ?? "unresolved";
      return `${sourceName} -> ${targetName} (${dependency.dependencyType})`;
    })
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 10);

  const topImpactedFiles = Array.from(fileImpactCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([filePath, impactCount]) => ({ filePath, impactCount }));

  const highRiskItems = projectRisks
    .filter((risk) => severityRank(risk.severity) >= severityRank("high"))
    .slice(0, 10)
    .map((risk) => ({
      title: risk.title,
      severity: risk.severity,
      sourceFile: risk.sourceFile,
      lineNumber: risk.lineNumber,
    }));

  const ruleTypeCounts = new Map<string, number>();
  for (const rule of projectRules) {
    ruleTypeCounts.set(rule.ruleType, (ruleTypeCounts.get(rule.ruleType) ?? 0) + 1);
  }
  const rulesByType = Object.fromEntries(Array.from(ruleTypeCounts.entries()).sort((left, right) => left[0].localeCompare(right[0])));

  const businessRules = projectRules.map((rule) => ({
    name: rule.name,
    ruleType: rule.ruleType,
    sourceFile: rule.sourceFile,
    lineNumber: rule.lineNumber,
  }));

  return {
    totals: {
      files: projectFiles.length,
      symbols: projectSymbols.length,
      dependencies: projectDependencies.length,
      risks: projectRisks.length,
      rules: projectRules.length,
    },
    topImpactedFiles,
    topDependencies: dependencySummaries,
    highRiskItems,
    businessRules: {
      countsByType: rulesByType,
      items: businessRules.slice(0, 10),
    },
  };
}

export async function getAnalysisSnapshot(projectId: number, userId: number): Promise<AnalysisSnapshot> {
  return getAnalysisSnapshotImpl({ requireDb, getOwnedProject, getProjectAnalysisRecord }, projectId, userId);
}

export async function getSymbolsPage(input: SymbolsPageInput, userId: number): Promise<PagedResult<SymbolListItem>> {
  return getSymbolsPageImpl({ requireDb, getOwnedProject }, input, userId);
}

export async function getFieldsPage(input: FieldsPageInput, userId: number): Promise<PagedResult<FieldListItem>> {
  return getFieldsPageImpl({ requireDb, getOwnedProject }, input, userId);
}

export async function getRisksPage(input: RisksPageInput, userId: number) {
  return getRisksPageImpl({ requireDb, getOwnedProject }, input, userId);
}

export async function getRulesPage(input: RulesPageInput, userId: number) {
  return getRulesPageImpl({ requireDb, getOwnedProject }, input, userId);
}

export async function getDependenciesPage(input: DependenciesPageInput, userId: number) {
  return getDependenciesPageImpl({ requireDb, getOwnedProject }, input, userId);
}

export async function getFieldDependenciesPage(
  input: FieldDependenciesPageInput,
  userId: number
): Promise<PagedResult<FieldDependencyListItem>> {
  return getFieldDependenciesPageImpl({ requireDb, getOwnedProject }, input, userId);
}

export async function buildReportArchiveBuffer(projectId: number, userId: number): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
  await getOwnedProject(projectId, userId);
  logger.info("Export started", { projectId, action: "export.zip.start", status: "ok" });
  const db = await requireDb();
  const [project, report] = await Promise.all([
    db.select().from(projects).where(eq(projects.id, projectId)).limit(1).then((rows) => rows[0] ?? null),
    getProjectAnalysisRecord(db, projectId),
  ]);

  if (!isReportReadyForExport(report)) {
    logger.warn("Export not ready", { projectId, action: "export.zip.complete", status: "error", code: "REPORT_NOT_READY" });
    throw new AppError("REPORT_NOT_READY", "Analysis report is not ready for download.");
  }
  const readyReport = report;

  const version = getAppVersion();
  const metrics = readyReport.summaryJson ?? null;
  const createdAtSource = readyReport.createdAt ?? readyReport.updatedAt ?? new Date(0);
  const createdAtIso = createdAtSource instanceof Date ? createdAtSource.toISOString() : new Date(createdAtSource).toISOString();
  const impactSummary = await generateProjectImpactSummary(db, projectId);
  const impactMarkdown = renderProjectImpactSummaryMarkdown(impactSummary, createdAtIso);

  const metadata = {
    projectName: project?.name ?? "project",
    analysisVersion: version,
    createdAt: createdAtIso,
    focusLanguage: project?.language ?? null,
    fileCount: metrics?.fileCount ?? 0,
    symbolCount: metrics?.symbolCount ?? 0,
    dependencyCount: metrics?.dependencyCount ?? 0,
    warningCount: metrics?.warningCount ?? 0,
    importWarningCount: project?.importWarningsJson?.length ?? 0,
  } as const;
  const reportCompletenessArtifacts = await buildReportCompletenessArtifacts(db, {
    project,
    report: readyReport,
    metadata,
    projectId,
  });

  const archiveEntries = [
    { path: "FLOW.md", content: readyReport.flowMarkdown },
    { path: "DATA_DEPENDENCY.md", content: readyReport.dataDependencyMarkdown },
    { path: "RISKS.md", content: readyReport.risksMarkdown },
    { path: "RULES.yaml", content: readyReport.rulesYaml },
    { path: "IMPACT_ANALYSIS.md", content: impactMarkdown },
    { path: "EXECUTIVE_SUMMARY.md", content: reportCompletenessArtifacts.executiveSummaryMarkdown },
    { path: "PROJECT_OVERVIEW.md", content: reportCompletenessArtifacts.projectOverviewMarkdown },
    { path: "FILE_INVENTORY.md", content: reportCompletenessArtifacts.fileInventoryMarkdown },
    { path: "DELPHI_FIELD_ACCESS.md", content: reportCompletenessArtifacts.delphiFieldAccessMarkdown },
    { path: "DELPHI_EVENT_MAP.md", content: reportCompletenessArtifacts.delphiEventMapMarkdown },
    { path: "DELPHI_DATA_BINDINGS.md", content: reportCompletenessArtifacts.delphiDataBindingsMarkdown },
    { path: "LIMITATIONS.md", content: reportCompletenessArtifacts.limitationsMarkdown },
    { path: "FULL_FINDINGS.json", content: reportCompletenessArtifacts.fullFindingsJson },
    { path: "impact-analysis.json", content: JSON.stringify(impactSummary, null, 2) },
    { path: "import-warnings.json", content: JSON.stringify(project?.importWarningsJson ?? [], null, 2) },
    { path: "metadata.json", content: JSON.stringify({ ...metadata, confidence: reportCompletenessArtifacts.confidence }, null, 2) },
    {
      path: "analysis-summary.json",
      content: JSON.stringify(
        {
          analysisResultId: readyReport.id,
          status: readyReport.status,
          metrics: readyReport.summaryJson,
          confidence: reportCompletenessArtifacts.confidence,
          warnings: readyReport.warningsJson,
          importWarnings: project?.importWarningsJson ?? [],
          limitationSummary:
            "Legacy Lens is a legacy impact review assistant that uses heuristic static analysis for Go, SQL, and Delphi. Review skipped files, degraded files, warnings, dynamic SQL paths, complex Delphi inheritance, Go interface dispatch, and cross-package type resolution limits before treating the report as source-of-truth.",
        },
        null,
        2
      ),
    },
  ] as const;

  logger.info("Export completed", { projectId, action: "export.zip.complete", status: "ok", analysisResultId: readyReport.id });
  return buildProjectReportArchiveBuffer(projectId, [...archiveEntries]);
}

export async function buildReportArchive(projectId: number, userId: number): Promise<ReportArchivePayload> {
  const archive = await buildReportArchiveBuffer(projectId, userId);
  return {
    fileName: archive.fileName,
    mimeType: archive.mimeType,
    base64: archive.buffer.toString("base64"),
  };
}

export async function getAnalysisResult(projectId: number, userId: number) {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();
  return getProjectAnalysisRecord(db, projectId);
}

export async function getProjectJob(jobId: number, userId: number): Promise<ProjectJobRecord> {
  const db = await requireDb();
  const [job] = await db.select().from(projectJobs).where(and(eq(projectJobs.id, jobId), eq(projectJobs.userId, userId))).limit(1);
  if (!job) {
    throw new AppError("PROJECT_JOB_NOT_FOUND", "Project job not found.");
  }
  return toPublicProjectJobRecord(job);
}

export async function getLatestJobsByProjectIds(projectIds: number[], userId: number) {
  const db = await requireDb();
  if (projectIds.length === 0) {
    return new Map<number, ProjectJobRecord>();
  }

  if (isInMemoryDb(db)) {
    const rows = await db.select().from(projectJobs).where(eq(projectJobs.userId, userId));
    const jobByProjectId = new Map<number, ProjectJobRecord>();

    rows
      .filter((row) => projectIds.includes(row.projectId))
      .sort((left, right) => Number(right.id) - Number(left.id))
      .forEach((row) => {
        if (!jobByProjectId.has(row.projectId)) {
          jobByProjectId.set(row.projectId, toPublicProjectJobRecord(row as ProjectJobRow));
        }
      });

    return jobByProjectId;
  }

  const latestIds = await db
    .select({
      projectId: projectJobs.projectId,
      latestId: sql<number>`max(${projectJobs.id})`,
    })
    .from(projectJobs)
    .where(and(eq(projectJobs.userId, userId), inArray(projectJobs.projectId, projectIds)))
    .groupBy(projectJobs.projectId);

  const ids = latestIds.map((row) => Number(row.latestId)).filter((value) => value > 0);
  if (ids.length === 0) {
    return new Map<number, ProjectJobRecord>();
  }

  const rows = await db.select().from(projectJobs).where(inArray(projectJobs.id, ids));
  return new Map(rows.map((row) => [row.projectId, toPublicProjectJobRecord(row)]));
}

export async function getActiveImportZipTempFilePaths() {
  const db = await getDb();
  if (!db) {
    return new Set<string>();
  }

  const rows = await db
    .select()
    .from(projectJobs)
    .where(and(eq(projectJobs.type, "import_zip"), inArray(projectJobs.status, ["queued", "running"])));
  const activeTempPaths = new Set<string>();

  for (const row of rows) {
    if (!row.payloadJson) {
      continue;
    }

    try {
      const payload = parseProjectJobPayload(row);
      const tempFilePath = getImportZipPayloadTempPath(payload);
      if (tempFilePath) {
        activeTempPaths.add(tempFilePath);
      }
    } catch {
      // Ignore malformed payloads during cleanup scanning; worker recovery handles them separately.
    }
  }

  return activeTempPaths;
}

export async function deleteProjectCascade(projectId: number, userId: number) {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();

  await db.transaction(async (tx) => {
    const activeJobs = await tx
      .select()
      .from(projectJobs)
      .where(and(eq(projectJobs.projectId, projectId), eq(projectJobs.userId, userId)));

    if (activeJobs.some((job) => isActiveProjectJobStatus(job.status))) {
      throw new AppError(
        "DELETE_FAILED",
        "Project cannot be deleted while an import or analysis job is queued or running. Wait for it to finish or recover first."
      );
    }

    await clearPreviousAnalysisData(tx, projectId, true);
    await tx.delete(projectJobs).where(eq(projectJobs.projectId, projectId));
    await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });
}

export async function runImpactAnalysis(projectId: number, userId: number, target: string, type: ImpactTargetType) {
  await getOwnedProject(projectId, userId);
  const analyzer = new ImpactAnalyzer();
  return await analyzer.analyze(projectId, target, type);
}
