import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { MAX_REPORT_ARCHIVE_BYTES } from "../../shared/const";
import type {
  AnalysisSnapshot,
  DependenciesPageInput,
  DependencyListItem,
  FieldDependenciesPageInput,
  FieldDependencyListItem,
  FieldListItem,
  FieldsPageInput,
  PagedResult,
  ProjectJobCreateResult,
  ProjectJobRecord,
  ReportArchivePayload,
  RiskListItem,
  RisksPageInput,
  RuleListItem,
  RulesPageInput,
  SymbolListItem,
  SymbolsPageInput,
} from "../../shared/contracts";
import type { ImpactTargetType, ProjectStatus } from "../../shared/contracts";
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
import { Analyzer } from "../analyzer/analyzer";
import { buildFieldIdentityKey, parseFieldIdentityKey } from "../analyzer/fieldIdentity";
import { ImpactAnalyzer } from "../analyzer/impactAnalyzer";
import { resolveMostSpecificSymbol } from "../analyzer/symbolOwner";
import type { AnalyzedSymbol, ProjectAnalysisResult } from "../analyzer/types";
import { getDb } from "../db";
import type { DatabaseClient, InsertProjectRecord } from "../dbTypes";
import { deleteProjectFiles, getProjectFiles, saveExtractedFiles } from "../utils/fileExtractor";
import { cleanupTempDir, cloneAndExtractFiles, validateSafeGitUrl } from "../utils/gitHandler";
import { extractFilesFromZip, extractFilesFromZipBuffer } from "../utils/zipHandler";
import { logger } from "../_core/logger";
import { buildContainsLikePattern, likeContainsEscaped } from "../_core/sqlLike";
import { getAppVersion } from "../_core/version";
import { runProjectJob } from "./jobWorker";
import {
  mapSnapshotReport,
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

const projectStatusTransitions: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ["importing", "failed"],
  importing: ["ready", "failed"],
  ready: ["importing", "analyzing", "failed"],
  analyzing: ["completed", "failed"],
  completed: ["importing", "analyzing", "failed"],
  failed: ["importing", "analyzing"],
};

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;
type ProjectJobRow = typeof projectJobs.$inferSelect;
type ProjectJobPayload =
  | { type: "import_zip"; zipContent: string }
  | { type: "import_zip"; tempFilePath: string; originalFileName?: string | null }
  | { type: "import_git"; gitUrl: string }
  | { type: "analyze" };

const queuedJobPromises = new Map<number, Promise<void>>();
const ACTIVE_PROJECT_JOB_KEY = "active";
const STALE_PROJECT_JOB_MS = Number.parseInt(process.env.PROJECT_JOB_STALE_MS ?? "900000", 10);
const PROJECT_JOB_LEASE_MS = Number.parseInt(process.env.PROJECT_JOB_LEASE_MS ?? "30000", 10);
const PROJECT_JOB_HEARTBEAT_MS = Number.parseInt(process.env.PROJECT_JOB_HEARTBEAT_MS ?? "10000", 10);
const DEFAULT_PROJECT_JOB_MAX_ATTEMPTS = Number.parseInt(process.env.PROJECT_JOB_MAX_ATTEMPTS ?? "3", 10);
const PROJECT_JOB_LOCK_OWNER = process.env.PROJECT_WORKER_ID?.trim() || `worker-${process.pid}-${randomUUID()}`;
let projectJobWorkerLoop: Promise<void> | null = null;

function isProjectWorkerEnabled() {
  return process.env.PROJECT_WORKER_ENABLED !== "false";
}

function assertProjectTransition(current: ProjectStatus, next: ProjectStatus) {
  if (current === next) {
    return;
  }

  if (!projectStatusTransitions[current].includes(next)) {
    throw new AppError("INVALID_PROJECT_STATE", `Invalid project transition: ${current} -> ${next}.`);
  }
}

function buildSymbolInsertKey(symbol: AnalyzedSymbol) {
  return symbol.stableKey;
}

function normalizeSearch(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeLikeSearch(value: string | null | undefined) {
  return buildContainsLikePattern(value);
}

function normalizePagination(page: number, pageSize: number, total: number) {
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const pageCount = total === 0 ? 0 : Math.ceil(total / safePageSize);
  const safePage = pageCount === 0 ? 1 : Math.min(Math.max(page, 1), pageCount);

  return {
    page: safePage,
    pageSize: safePageSize,
    pageCount,
    offset: (safePage - 1) * safePageSize,
  };
}

function andAll(conditions: any[]) {
  return conditions.length === 1 ? conditions[0] : and(conditions[0], ...conditions.slice(1));
}

function orAll(conditions: any[]) {
  return conditions.length === 1 ? conditions[0] : or(conditions[0], ...conditions.slice(1));
}

function paginateItems<T>(items: T[], page: number, pageSize: number): PagedResult<T> {
  const total = items.length;
  const pagination = normalizePagination(page, pageSize, total);

  return {
    items: items.slice(pagination.offset, pagination.offset + pagination.pageSize),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

function isInMemoryDb(db: DbHandle): db is DbHandle & { store: Record<string, Array<Record<string, unknown>>> } {
  return typeof db === "object" && db !== null && "store" in db;
}

function isActiveProjectJobStatus(status: ProjectJobRow["status"]) {
  return status === "queued" || status === "running";
}

function isProjectJobLeaseExpired(job: Pick<ProjectJobRow, "status" | "leaseUntil">, now = new Date()) {
  if (job.status !== "running") {
    return false;
  }

  const leaseUntil = toDate(job.leaseUntil);
  return !leaseUntil || leaseUntil.getTime() <= now.getTime();
}

function hasProjectJobLease(job: Pick<ProjectJobRow, "leaseUntil">) {
  return toDate(job.leaseUntil) !== null;
}

function getProjectJobAttemptCount(job: Pick<ProjectJobRow, "attemptCount">) {
  return Number(job.attemptCount ?? 0);
}

function getProjectJobMaxAttempts(job: Pick<ProjectJobRow, "maxAttempts">) {
  return Math.max(1, Number(job.maxAttempts ?? DEFAULT_PROJECT_JOB_MAX_ATTEMPTS));
}

function canRetryProjectJob(job: Pick<ProjectJobRow, "attemptCount" | "maxAttempts">) {
  return getProjectJobAttemptCount(job) < getProjectJobMaxAttempts(job);
}

function buildProjectJobLease(now = new Date()) {
  return {
    heartbeatAt: now,
    leaseUntil: new Date(now.getTime() + PROJECT_JOB_LEASE_MS),
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

function serializeProjectJobPayload(payload: ProjectJobPayload) {
  return JSON.stringify(payload);
}

function parseProjectJobPayload(job: Pick<ProjectJobRow, "id" | "type" | "payloadJson">): ProjectJobPayload {
  if (!job.payloadJson) {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is missing.`);
  }

  let parsed: ProjectJobPayload;
  try {
    parsed = JSON.parse(job.payloadJson) as ProjectJobPayload;
  } catch {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is invalid.`);
  }

  if (!parsed || parsed.type !== job.type) {
    throw new AppError("PROJECT_JOB_STALE", `Project job ${job.id} cannot be recovered because its payload is invalid.`);
  }

  return parsed;
}

function toDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function getImportZipPayloadTempPath(payload: ProjectJobPayload) {
  return payload.type === "import_zip" && "tempFilePath" in payload ? payload.tempFilePath : null;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /duplicate entry|unique/i.test(error.message);
}

function extractAffectedRows(result: unknown) {
  if (typeof (result as { affectedRows?: number } | undefined)?.affectedRows === "number") {
    return (result as { affectedRows: number }).affectedRows;
  }

  if (Array.isArray(result) && typeof (result[0] as { affectedRows?: number } | undefined)?.affectedRows === "number") {
    return (result[0] as { affectedRows: number }).affectedRows;
  }

  return undefined;
}

async function countRows(
  table: typeof files | typeof symbols | typeof dependencies | typeof fields | typeof fieldDependencies | typeof risks | typeof rules,
  condition: any
) {
  const db = await requireDb();
  const [row] = await db.select({ value: count() }).from(table).where(condition);
  return Number(row?.value ?? 0);
}

async function listMatchingFileIds(projectId: number, searchLike: string) {
  const db = await requireDb();
  if (!searchLike) return [];

  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.projectId, projectId), likeContainsEscaped(files.filePath, searchLike)));

  return rows.map((row) => row.id);
}

async function listMatchingSymbolIds(projectId: number, searchLike: string) {
  const db = await requireDb();
  if (!searchLike) return [];

  const rows = await db
    .select({ id: symbols.id })
    .from(symbols)
    .where(and(eq(symbols.projectId, projectId), likeContainsEscaped(symbols.name, searchLike)));

  return rows.map((row) => row.id);
}

async function listMatchingFieldIds(projectId: number, searchLike: string) {
  const db = await requireDb();
  if (!searchLike) return [];

  const rows = await db
    .select({ id: fields.id })
    .from(fields)
    .where(
      and(
        eq(fields.projectId, projectId),
        or(likeContainsEscaped(fields.tableName, searchLike), likeContainsEscaped(fields.fieldName, searchLike))
      )
    );

  return rows.map((row) => row.id);
}

async function clearProjectAnalysisGraph(db: DbHandle, projectId: number, includeFiles = false) {
  await db.delete(analysisResults).where(eq(analysisResults.projectId, projectId));
  await db.delete(fieldDependencies).where(eq(fieldDependencies.projectId, projectId));
  await db.delete(dependencies).where(eq(dependencies.projectId, projectId));
  await db.delete(risks).where(eq(risks.projectId, projectId));
  await db.delete(rules).where(eq(rules.projectId, projectId));
  await db.delete(fields).where(eq(fields.projectId, projectId));
  await db.delete(symbols).where(eq(symbols.projectId, projectId));

  if (includeFiles) {
    await deleteProjectFiles(projectId, db);
  }
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

async function updateProjectJob(jobId: number, updates: Partial<typeof projectJobs.$inferInsert>) {
  const db = await requireDb();
  await db.update(projectJobs).set(updates).where(eq(projectJobs.id, jobId));
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

      const jobId = Number((insertResult as { insertId?: number }).insertId ?? 0);
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
        await replaceAnalysisResult(tx, projectId, {
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
  if (!isProjectWorkerEnabled()) {
    return null;
  }

  if (projectJobWorkerLoop) {
    return projectJobWorkerLoop;
  }

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
        attemptCount: getProjectJobAttemptCount(nextJob) + 1,
      })
      .where(andAll(updateConditions));

    const affectedRows = extractAffectedRows(updateResult);
    if (typeof affectedRows === "number" && affectedRows === 0) {
      continue;
    }

    const [claimedJob] = await db.select().from(projectJobs).where(eq(projectJobs.id, nextJob.id)).limit(1);
    if (!claimedJob || claimedJob.status !== "running" || claimedJob.lockedBy !== PROJECT_JOB_LOCK_OWNER) {
      continue;
    }

    const queuedAt = toDate(claimedJob.createdAt);
    logger.info("Project job claimed", {
      action: "project.job.claimed",
      status: "ok",
      jobId: claimedJob.id,
      projectId: claimedJob.projectId,
      type: claimedJob.type,
      queueWaitMs: queuedAt ? Math.max(0, now.getTime() - queuedAt.getTime()) : null,
      attemptCount: claimedJob.attemptCount,
      maxAttempts: claimedJob.maxAttempts,
      leaseUntil: claimedJob.leaseUntil,
      lockedBy: claimedJob.lockedBy,
    });

    return claimedJob;
  }
}

export async function claimNextQueuedProjectJobForTests() {
  return claimNextQueuedProjectJob();
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
      importProgress: 0,
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

  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        status: "failed",
        analysisProgress: 0,
        errorMessage: error?.message ?? "Analysis failed.",
        lastErrorCode: error?.code ?? null,
        updatedAt: now,
      })
      .where(eq(projects.id, job.projectId));

    const existingResult = await tx.select().from(analysisResults).where(eq(analysisResults.projectId, job.projectId)).limit(1);

    if (!existingResult[0]) {
      return;
    }

    await tx
      .update(analysisResults)
      .set({
        status: "failed",
        errorMessage: error?.message ?? "Analysis failed.",
        updatedAt: now,
      })
      .where(eq(analysisResults.projectId, job.projectId));
  });
}

async function executeProjectJob(job: ProjectJobRow) {
  const payload = parseProjectJobPayload(job);

  if (payload.type === "import_zip") {
    if ("tempFilePath" in payload) {
      await importProjectZipFromTempFile(job.projectId, job.userId, payload.tempFilePath);
      return;
    }

    await importProjectZip(job.projectId, job.userId, payload.zipContent);
    return;
  }

  if (payload.type === "import_git") {
    await importProjectGit(job.projectId, job.userId, payload.gitUrl);
    return;
  }

  await analyzeProject(job.projectId, job.userId);
}

function buildProjectJobFailureFallback(job: Pick<ProjectJobRow, "type">) {
  if (job.type === "analyze") {
    return new AppError("ANALYSIS_FAILED", "Project job failed.");
  }

  return new AppError("IMPORT_FAILED", "Project job failed.");
}

async function heartbeatProjectJobLease(jobId: number, lockedBy: string) {
  const db = await requireDb();
  const lease = buildProjectJobLease();
  await db
    .update(projectJobs)
    .set({
      heartbeatAt: lease.heartbeatAt,
      leaseUntil: lease.leaseUntil,
    })
    .where(and(eq(projectJobs.id, jobId), eq(projectJobs.status, "running"), eq(projectJobs.lockedBy, lockedBy)));
}

async function assertProjectJobProjectExists(projectId: number) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new AppError("PROJECT_NOT_FOUND", "Project no longer exists.");
  }
}

async function finalizeProjectJob(job: ProjectJobRow, status: "completed" | "failed", error?: AppError) {
  const now = new Date();
  const queuedAt = toDate(job.createdAt);
  const startedAt = toDate(job.startedAt);
  const queueDurationMs = queuedAt && startedAt ? Math.max(0, startedAt.getTime() - queuedAt.getTime()) : null;
  const runDurationMs = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;

  await updateProjectJob(job.id, {
    status,
    progress: 100,
    activeKey: null,
    payloadJson: null,
    lockedBy: null,
    leaseUntil: null,
    heartbeatAt: null,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    finishedAt: now,
  });

  if (status === "failed") {
    if (job.type === "import_zip" || job.type === "import_git") {
      await failImportProjectIfStillImporting(job, now, error);
    }

    if (job.type === "analyze") {
      await failAnalysisProjectIfStillAnalyzing(job, now, error);
    }
  }

  logger.info("Project job finalized", {
    action: "project.job.finalized",
    status,
    jobId: job.id,
    projectId: job.projectId,
    type: job.type,
    queueDurationMs,
    runDurationMs,
    errorCode: error?.code ?? null,
  });
}

export async function runClaimedProjectJob(jobId: number) {
  const claimedJob = await getProjectJobById(jobId);
  if (!claimedJob) {
    throw new AppError("PROJECT_JOB_NOT_FOUND", `Project job ${jobId} was not found.`);
  }
  let tempFilePath: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  try {
    const payload = parseProjectJobPayload(claimedJob);
    tempFilePath = getImportZipPayloadTempPath(payload);
    await assertProjectJobProjectExists(claimedJob.projectId);
    if (claimedJob.lockedBy) {
      heartbeatTimer = setInterval(() => {
        void heartbeatProjectJobLease(claimedJob.id, claimedJob.lockedBy ?? "")
          .catch(() => undefined);
      }, Math.max(1_000, PROJECT_JOB_HEARTBEAT_MS));
    }
    await executeProjectJob(claimedJob);
    await assertProjectJobProjectExists(claimedJob.projectId);
    await finalizeProjectJob(claimedJob, "completed");
  } catch (error) {
    const appError = toAppError(error, buildProjectJobFailureFallback(claimedJob));
    await finalizeProjectJob(claimedJob, "failed", appError);
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

  const promise = runProjectJob(claimedJob.id)
    .catch(() => undefined)
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
  const updates: Partial<InsertProjectRecord> & { status: ProjectStatus } = {
    status: "failed",
    errorMessage: message,
    lastErrorCode: "PROJECT_JOB_STALE",
    updatedAt: now,
  };
  if (status === "importing") {
    updates.importProgress = 0;
  }
  if (status === "analyzing") {
    updates.analysisProgress = 0;
  }

  await db.update(projects).set(updates).where(eq(projects.id, projectId));

  if (status === "analyzing") {
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
  if (!isProjectWorkerEnabled()) {
    logger.info("Project worker disabled; skipping startup recovery.", {
      action: "project.job.recovery.skipped",
      status: "ok",
    });
    return 0;
  }

  const db = await requireDb();
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const allJobs = await db.select().from(projectJobs);
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
    const isLeaseExpired = hasProjectJobLease(job) && isProjectJobLeaseExpired(job, now);
    const isStaleByLegacyWindow = !heartbeatAt && !leaseUntil && (!startedAt || startedAt.getTime() <= staleBefore.getTime());

    if (!isLeaseExpired && !isStaleByLegacyWindow) {
      continue;
    }

    if (canRetryProjectJob(job)) {
      await db
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
        .where(eq(projectJobs.id, job.id));
      recoveredJobCount += 1;
      continue;
    }

    const retryMessage = `Project job exceeded its retry budget (${getProjectJobAttemptCount(job)}/${getProjectJobMaxAttempts(job)}) after lease recovery.`;
    await db
      .update(projectJobs)
      .set({
        status: "failed",
        progress: 100,
        activeKey: null,
        payloadJson: null,
        lockedBy: null,
        leaseUntil: null,
        heartbeatAt: null,
        errorCode: "PROJECT_JOB_STALE",
        errorMessage: retryMessage,
        finishedAt: now,
      })
      .where(eq(projectJobs.id, job.id));

    if (job.type === "analyze") {
      await failAnalysisProjectIfStillAnalyzing(job, now, new AppError("PROJECT_JOB_STALE", retryMessage));
    } else {
      await failImportProjectIfStillImporting(job, now, new AppError("PROJECT_JOB_STALE", retryMessage));
    }
  }

  const activeJobsAfterRecovery = await db.select().from(projectJobs);
  const projectRows = await db.select().from(projects);
  for (const project of projectRows) {
    if (project.status !== "importing" && project.status !== "analyzing") {
      continue;
    }

    const hasActiveJob = activeJobsAfterRecovery.some((job) => job.projectId === project.id && isActiveProjectJobStatus(job.status));
    if (hasActiveJob) {
      continue;
    }

    const recoveryMessage =
      project.status === "importing"
        ? "Project import was left in an active state without a recoverable job after server startup."
        : "Project analysis was left in an active state without a recoverable job after server startup.";
    await markProjectAsRecoveryFailed(project.id, project.status, recoveryMessage, now);
  }

  if (recoveredJobCount > 0) {
    void kickProjectJobWorker();
  }

  return recoveredJobCount;
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

  const insertId = Number((insertResult as { insertId?: number }).insertId ?? 0);
  if (insertId <= 0) {
    throw new AppError("DATABASE_UNAVAILABLE", "Project was created but its identifier could not be resolved from the insert result.");
  }

  return insertId;
}

async function replaceProjectFiles(
  projectId: number,
  extractedFiles: Awaited<ReturnType<typeof extractFilesFromZip>>,
  sourceUrl?: string
) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    await transitionProjectState(tx, projectId, {
      status: "importing",
      importProgress: 10,
      analysisProgress: 0,
      sourceUrl: sourceUrl ?? null,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: [],
    });

    await clearProjectAnalysisGraph(tx, projectId, true);
    const fileIds = await saveExtractedFiles(projectId, extractedFiles.files, tx);

    await transitionProjectState(tx, projectId, {
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: extractedFiles.warnings,
    });

    return fileIds;
  });
}

export async function importProjectZip(projectId: number, userId: number, zipContent: string) {
  await getOwnedProject(projectId, userId);
  logger.info("Import started", { projectId, action: "import.zip.start", status: "ok" });

  try {
    const extractedFiles = await extractFilesFromZip(zipContent);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles);

    logger.info("Import completed", {
      projectId,
      action: "import.zip.complete",
      status: "ok",
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    return {
      fileIds,
      files: extractedFiles.files.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        language: file.language,
        size: file.size,
      })),
      warnings: extractedFiles.warnings,
    };
  } catch (error) {
    const appError = toAppError(error, new AppError("IMPORT_FAILED", "ZIP import failed."));
    logger.error("Import failed", {
      projectId,
      action: "import.zip.complete",
      status: "error",
      code: appError.code,
      message: appError.message,
    });
    const db = await requireDb();
    await db
      .update(projects)
      .set({
        status: "failed",
        errorMessage: appError.message,
        lastErrorCode: appError.code,
        importWarningsJson: [],
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    throw appError;
  }
}

export async function importProjectZipFromTempFile(projectId: number, userId: number, tempFilePath: string) {
  await getOwnedProject(projectId, userId);
  logger.info("Import started", { projectId, action: "import.zip.start", status: "ok", source: "temp_file" });

  try {
    const zipBuffer = await readFile(tempFilePath);
    const extractedFiles = await extractFilesFromZipBuffer(zipBuffer);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles);

    logger.info("Import completed", {
      projectId,
      action: "import.zip.complete",
      status: "ok",
      source: "temp_file",
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    return {
      fileIds,
      files: extractedFiles.files.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        language: file.language,
        size: file.size,
      })),
      warnings: extractedFiles.warnings,
    };
  } catch (error) {
    const appError = toAppError(error, new AppError("IMPORT_FAILED", "ZIP import failed."));
    logger.error("Import failed", {
      projectId,
      action: "import.zip.complete",
      status: "error",
      source: "temp_file",
      code: appError.code,
      message: appError.message,
    });
    const db = await requireDb();
    await db
      .update(projects)
      .set({
        status: "failed",
        errorMessage: appError.message,
        lastErrorCode: appError.code,
        importWarningsJson: [],
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    throw appError;
  }
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

export async function importProjectGit(projectId: number, userId: number, gitUrl: string) {
  await getOwnedProject(projectId, userId);
  const validatedGitUrl = await validateSafeGitUrl(gitUrl);

  logger.info("Import started", { projectId, action: "import.git.start", status: "ok" });
  let tempDir = "";
  try {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tempDir = join(tmpdir(), `legacy-lens-${projectId}-${Date.now()}`);
    const extractedFiles = await cloneAndExtractFiles(validatedGitUrl, tempDir);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles, gitUrl);

    logger.info("Import completed", {
      projectId,
      action: "import.git.complete",
      status: "ok",
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    return {
      fileIds,
      files: extractedFiles.files.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        language: file.language,
        size: file.size,
      })),
      warnings: extractedFiles.warnings,
    };
  } catch (error) {
    const appError = toAppError(error, new AppError("GIT_CLONE_FAILED", "Git import failed."));
    logger.error("Import failed", {
      projectId,
      action: "import.git.complete",
      status: "error",
      code: appError.code,
      message: appError.message,
    });
    const db = await requireDb();
    await db
      .update(projects)
      .set({
        status: "failed",
        errorMessage: appError.message,
        lastErrorCode: appError.code,
        importWarningsJson: [],
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    throw appError;
  } finally {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  }
}

export async function queueImportProjectGit(projectId: number, userId: number, gitUrl: string) {
  return enqueueProjectJob(projectId, userId, {
    type: "import_git",
    gitUrl,
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

  const targetSymbol = symbolsForProject.find((symbol) => {
    const shortName = symbol.qualifiedName?.split(".").at(-1) ?? symbol.name;
    return symbol.name === dependency.toName || symbol.qualifiedName === dependency.toName || shortName === dependency.toName;
  });

  return targetSymbol ? insertedSymbolIds.get(buildSymbolInsertKey(targetSymbol)) : undefined;
}

async function writeSuccessfulAnalysis(
  tx: DbHandle,
  projectId: number,
  projectFiles: Awaited<ReturnType<typeof getProjectFiles>>,
  result: ProjectAnalysisResult
) {
  await clearProjectAnalysisGraph(tx, projectId);

  await replaceAnalysisResult(tx, projectId, {
    status: result.status,
    flowMarkdown: result.flowDocument,
    dataDependencyMarkdown: result.dataDependencyDocument,
    risksMarkdown: result.risksDocument,
    rulesYaml: result.rulesYaml,
    summaryJson: result.metrics,
    warningsJson: result.warnings,
    errorMessage: result.status === "partial" ? "Analysis completed with warnings." : null,
  });

  const fileByPath = new Map(projectFiles.map((file) => [file.filePath.replace(/\\/g, "/"), file]));
  const insertedSymbolIds = new Map<string, number>();

  for (const symbol of result.symbols) {
    const fileRecord = fileByPath.get(symbol.file.replace(/\\/g, "/"));
    if (!fileRecord?.id) continue;

    const insertResult = await tx.insert(symbols).values({
      projectId,
      fileId: fileRecord.id,
      name: symbol.qualifiedName ?? symbol.name,
      type: symbol.type,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      signature: symbol.signature,
      description: symbol.description,
      metadata: {
        stableKey: symbol.stableKey,
        qualifiedName: symbol.qualifiedName ?? symbol.name,
        parser: "heuristic",
      },
    });
    const symbolId = Number((insertResult as { insertId?: number }).insertId ?? 0);
    if (symbolId > 0) {
      insertedSymbolIds.set(buildSymbolInsertKey(symbol), symbolId);
    }
  }

  const fieldIds = new Map<string, number>();
  const schemaFields = result.schemaFields ?? [];
  const schemaFieldByKey = new Map(
    schemaFields.map((field) => [
      buildFieldIdentityKey({ table: field.table, field: field.field }),
      field,
    ])
  );
  const uniqueFieldKeys = Array.from(
    new Set([
      ...schemaFields.map((field) => buildFieldIdentityKey({ table: field.table, field: field.field })),
      ...result.fieldReferences.map((reference) => buildFieldIdentityKey(reference)),
    ])
  );
  for (const fieldKey of uniqueFieldKeys) {
    const { table: tableName, field: fieldName } = parseFieldIdentityKey(fieldKey);
    const schemaField = schemaFieldByKey.get(fieldKey);
    const description = schemaField
      ? [
          schemaField.nullable === false ? "NOT NULL" : schemaField.nullable === true ? "NULL" : null,
          schemaField.primaryKey ? "PRIMARY KEY" : null,
          schemaField.defaultValue ? `DEFAULT ${schemaField.defaultValue}` : null,
          schemaField.comment ? `COMMENT ${schemaField.comment}` : null,
        ]
          .filter(Boolean)
          .join("; ") || null
      : null;
    const insertResult = await tx.insert(fields).values({
      projectId,
      tableName,
      fieldName,
      fieldType: schemaField?.fieldType ?? null,
      description,
    });
    const fieldId = Number((insertResult as { insertId?: number }).insertId ?? 0);
    if (fieldId > 0) {
      fieldIds.set(fieldKey, fieldId);
    }
  }

  for (const reference of result.fieldReferences) {
    const fieldId = fieldIds.get(buildFieldIdentityKey(reference));
    const ownerSymbol = reference.symbolStableKey
      ? result.symbols.find((symbol) => symbol.stableKey === reference.symbolStableKey)
      : resolveOwningSymbol(result.symbols, reference.file, reference.line);
    const symbolId = ownerSymbol ? insertedSymbolIds.get(buildSymbolInsertKey(ownerSymbol)) : undefined;

    if (!fieldId || !symbolId) continue;
    await tx.insert(fieldDependencies).values({
      projectId,
      fieldId,
      symbolId,
      operationType: reference.type,
      lineNumber: reference.line,
      context: reference.context ?? `${reference.table}.${reference.field}`,
    });
  }

  for (const dependency of result.dependencies) {
    const sourceSymbolId = insertedSymbolIds.get(dependency.from);
    if (!sourceSymbolId) continue;

    const targetSymbolId = resolveInsertedTargetSymbolId(dependency, result.symbols, insertedSymbolIds);
    await tx.insert(dependencies).values({
      projectId,
      sourceSymbolId,
      targetSymbolId: targetSymbolId ?? null,
      targetExternalName: targetSymbolId ? null : dependency.toName,
      targetKind: targetSymbolId ? "internal" : "unresolved",
      dependencyType: dependency.type,
      lineNumber: dependency.line,
    });
  }

  for (const risk of result.risks) {
    await tx.insert(risks).values({
      projectId,
      riskType: risk.category,
      severity: risk.severity,
      title: risk.title,
      description: risk.description,
      sourceFile: risk.sourceFile,
      lineNumber: risk.lineNumber,
      codeSnippet: risk.codeSnippet,
      recommendation: risk.suggestion,
    });
  }

  for (const rule of result.rules) {
    await tx.insert(rules).values({
      projectId,
      ruleType: rule.ruleType,
      name: rule.name,
      description: rule.description,
      condition: rule.condition,
      sourceFile: rule.sourceFile,
      lineNumber: rule.lineNumber,
    });
  }

  await transitionProjectState(tx, projectId, {
    status: "completed",
    analysisProgress: 100,
    errorMessage: result.status === "partial" ? "Analysis completed with warnings." : null,
    lastErrorCode: null,
    lastAnalyzedAt: new Date(),
  });
}

async function writeFailedAnalysis(tx: DbHandle, projectId: number, appError: AppError) {
  await clearProjectAnalysisGraph(tx, projectId);
  await replaceAnalysisResult(tx, projectId, {
    status: "failed",
    flowMarkdown: null,
    dataDependencyMarkdown: null,
    risksMarkdown: null,
    rulesYaml: null,
    summaryJson: null,
    warningsJson: [],
    errorMessage: appError.message,
  });
  await transitionProjectState(tx, projectId, {
    status: "failed",
    analysisProgress: 0,
    errorMessage: appError.message,
    lastErrorCode: appError.code,
  });
}

export async function analyzeProject(projectId: number, userId: number) {
  const project = await getOwnedProject(projectId, userId);
  if (!["ready", "completed", "failed", "analyzing"].includes(project.status)) {
    throw new AppError("INVALID_PROJECT_STATE", `Project is currently "${projectStatusLabels[project.status]}".`);
  }

  logger.info("Analysis started", { projectId, action: "analysis.start", status: "ok", focusLanguage: project.language });
  const db = await requireDb();
  await db.transaction(async (tx) => {
    await transitionProjectState(
      tx,
      projectId,
      {
        status: "analyzing",
        analysisProgress: 5,
        errorMessage: null,
        lastErrorCode: null,
      },
      userId
    );
    await replaceAnalysisResult(tx, projectId, {
      status: "processing",
      flowMarkdown: null,
      dataDependencyMarkdown: null,
      risksMarkdown: null,
      rulesYaml: null,
      summaryJson: null,
      warningsJson: [],
      errorMessage: null,
    });
  });

  try {
    const projectFiles = await getProjectFiles(projectId);
    if (projectFiles.length === 0) {
      throw new AppError("EMPTY_SOURCE", "Project does not contain any files to analyze.");
    }

    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      projectFiles.map((file) => ({
        path: file.filePath,
        content: file.content ?? "",
        language: file.fileType?.replace(/^\./, "") ?? "unknown",
      })),
      projectId
    );

    if (result.status === "failed") {
      throw new AppError(
        "ANALYSIS_FAILED",
        "No analyzable files were found in the imported source. Focus language affects UI navigation and summaries, not what files are eligible for analysis."
      );
    }

    await db.transaction(async (tx) => {
      await writeSuccessfulAnalysis(tx, projectId, projectFiles, result);
    });

    logger.info("Analysis completed", {
      projectId,
      action: "analysis.complete",
      status: "ok",
      resultStatus: result.status,
      metrics: result.metrics,
      warningCount: result.warnings?.length ?? 0,
    });
    return result;
  } catch (error) {
    const appError = toAppError(error, new AppError("ANALYSIS_FAILED", "Analysis failed."));
    logger.error("Analysis failed", {
      projectId,
      action: "analysis.complete",
      status: "error",
      code: appError.code,
      message: appError.message,
    });
    await db.transaction(async (tx) => {
      await writeFailedAnalysis(tx, projectId, appError);
    });
    throw appError;
  }
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
      (report.status === "completed" || report.status === "partial") &&
      report.flowMarkdown &&
      report.dataDependencyMarkdown &&
      report.risksMarkdown &&
      report.rulesYaml
  );
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

function buildFieldUsageSummary(rows: Array<typeof fieldDependencies.$inferSelect>) {
  const fieldUsageById = new Map<number, { readCount: number; writeCount: number; referenceCount: number }>();

  for (const dependency of rows) {
    const current = fieldUsageById.get(dependency.fieldId) ?? {
      readCount: 0,
      writeCount: 0,
      referenceCount: 0,
    };

    current.referenceCount += 1;
    if (dependency.operationType === "read") current.readCount += 1;
    if (dependency.operationType === "write") current.writeCount += 1;
    fieldUsageById.set(dependency.fieldId, current);
  }

  return fieldUsageById;
}

export async function getAnalysisSnapshot(projectId: number, userId: number): Promise<AnalysisSnapshot> {
  const project = await getOwnedProject(projectId, userId);
  const db = await requireDb();
  const report = await getProjectAnalysisRecord(db, projectId);
  if (isInMemoryDb(db)) {
    const [fileRows, symbolRows, dependencyRows, fieldRows, fieldDependencyRows, riskRows, ruleRows] = await Promise.all([
      db.select().from(files).where(eq(files.projectId, projectId)),
      db.select().from(symbols).where(eq(symbols.projectId, projectId)),
      db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),
      db.select().from(fields).where(eq(fields.projectId, projectId)),
      db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, projectId)),
      db.select().from(risks).where(eq(risks.projectId, projectId)),
      db.select().from(rules).where(eq(rules.projectId, projectId)),
    ]);

    const sortedFields = sortProjectFields(fieldRows);
    const sortedFieldDependencies = sortFieldDependencies(fieldDependencyRows);
    const fieldUsageById = buildFieldUsageSummary(sortedFieldDependencies);
    const fieldSummaryByTable = new Map<string, { fieldCount: number; readCount: number; writeCount: number; referenceCount: number }>();

    for (const field of sortedFields) {
      const usage = fieldUsageById.get(field.id) ?? { readCount: 0, writeCount: 0, referenceCount: 0 };
      const current = fieldSummaryByTable.get(field.tableName) ?? {
        fieldCount: 0,
        readCount: 0,
        writeCount: 0,
        referenceCount: 0,
      };
      current.fieldCount += 1;
      current.readCount += usage.readCount;
      current.writeCount += usage.writeCount;
      current.referenceCount += usage.referenceCount;
      fieldSummaryByTable.set(field.tableName, current);
    }

    const filePathById = new Map(fileRows.map((row) => [row.id, row.filePath]));

    return {
      report: report ? mapSnapshotReport(report) : null,
      importWarnings: project.importWarningsJson ?? [],
      totals: {
        files: fileRows.length,
        symbols: symbolRows.length,
        dependencies: dependencyRows.length,
        fields: fieldRows.length,
        fieldDependencies: fieldDependencyRows.length,
        risks: riskRows.length,
        rules: ruleRows.length,
        importWarnings: project.importWarningsJson?.length ?? 0,
      },
      topSymbols: sortProjectSymbols(symbolRows)
        .slice(0, 10)
        .map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          filePath: filePathById.get(row.fileId) ?? null,
          startLine: row.startLine,
          endLine: row.endLine,
        })),
      topRisks: sortProjectRisks(riskRows)
        .slice(0, 10)
        .map((row) => ({
          id: row.id,
          riskType: row.riskType,
          severity: row.severity,
          title: row.title,
          sourceFile: row.sourceFile,
          lineNumber: row.lineNumber,
        })),
      topRules: sortProjectRules(ruleRows)
        .slice(0, 10)
        .map((row) => ({
          id: row.id,
          ruleType: row.ruleType,
          name: row.name,
          sourceFile: row.sourceFile,
          lineNumber: row.lineNumber,
        })),
      fieldTables: Array.from(fieldSummaryByTable.entries())
        .map(([tableName, summary]) => ({ tableName, ...summary }))
        .sort((left, right) => left.tableName.localeCompare(right.tableName)),
    };
  }

  const [
    fileTotal,
    symbolTotal,
    dependencyTotal,
    fieldTotal,
    fieldDependencyTotal,
    riskTotal,
    ruleTotal,
    topSymbolRows,
    topRiskRows,
    topRuleRows,
    fieldCountRows,
    fieldUsageRows,
  ] = await Promise.all([
    countRows(files, eq(files.projectId, projectId)),
    countRows(symbols, eq(symbols.projectId, projectId)),
    countRows(dependencies, eq(dependencies.projectId, projectId)),
    countRows(fields, eq(fields.projectId, projectId)),
    countRows(fieldDependencies, eq(fieldDependencies.projectId, projectId)),
    countRows(risks, eq(risks.projectId, projectId)),
    countRows(rules, eq(rules.projectId, projectId)),
    db
      .select()
      .from(symbols)
      .where(eq(symbols.projectId, projectId))
      .orderBy(asc(symbols.name), asc(symbols.fileId), asc(symbols.startLine), asc(symbols.id))
      .limit(10),
    db
      .select()
      .from(risks)
      .where(eq(risks.projectId, projectId))
      .orderBy(
        sql`case ${risks.severity} when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end desc`,
        asc(risks.title),
        asc(risks.sourceFile),
        asc(risks.lineNumber),
        asc(risks.id)
      )
      .limit(10),
    db
      .select()
      .from(rules)
      .where(eq(rules.projectId, projectId))
      .orderBy(asc(rules.ruleType), asc(rules.name), asc(rules.sourceFile), asc(rules.lineNumber), asc(rules.id))
      .limit(10),
    db
      .select({
        tableName: fields.tableName,
        fieldCount: count(),
      })
      .from(fields)
      .where(eq(fields.projectId, projectId))
      .groupBy(fields.tableName),
    db
      .select({
        tableName: fields.tableName,
        readCount: sql<number>`sum(case when ${fieldDependencies.operationType} = 'read' then 1 else 0 end)`,
        writeCount: sql<number>`sum(case when ${fieldDependencies.operationType} = 'write' then 1 else 0 end)`,
        referenceCount: count(),
      })
      .from(fieldDependencies)
      .innerJoin(fields, eq(fieldDependencies.fieldId, fields.id))
      .where(eq(fieldDependencies.projectId, projectId))
      .groupBy(fields.tableName),
  ]);

  const topSymbolFileIds = Array.from(new Set(topSymbolRows.map((row) => row.fileId)));
  const topSymbolFiles =
    topSymbolFileIds.length > 0
      ? await db.select({ id: files.id, filePath: files.filePath }).from(files).where(inArray(files.id, topSymbolFileIds))
      : [];
  const filePathById = new Map(topSymbolFiles.map((row) => [row.id, row.filePath]));
  const fieldSummaryByTable = new Map<string, { fieldCount: number; readCount: number; writeCount: number; referenceCount: number }>();

  for (const row of fieldCountRows) {
    fieldSummaryByTable.set(row.tableName, {
      fieldCount: Number(row.fieldCount ?? 0),
      readCount: 0,
      writeCount: 0,
      referenceCount: 0,
    });
  }

  for (const row of fieldUsageRows) {
    const current = fieldSummaryByTable.get(row.tableName) ?? {
      fieldCount: 0,
      readCount: 0,
      writeCount: 0,
      referenceCount: 0,
    };
    current.readCount = Number(row.readCount ?? 0);
    current.writeCount = Number(row.writeCount ?? 0);
    current.referenceCount = Number(row.referenceCount ?? 0);
    fieldSummaryByTable.set(row.tableName, current);
  }

  return {
    report: report ? mapSnapshotReport(report) : null,
    importWarnings: project.importWarningsJson ?? [],
    totals: {
      files: fileTotal,
      symbols: symbolTotal,
      dependencies: dependencyTotal,
      fields: fieldTotal,
      fieldDependencies: fieldDependencyTotal,
      risks: riskTotal,
      rules: ruleTotal,
      importWarnings: project.importWarningsJson?.length ?? 0,
    },
    topSymbols: topSymbolRows
      .map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        filePath: filePathById.get(row.fileId) ?? null,
        startLine: row.startLine,
        endLine: row.endLine,
      })),
    topRisks: topRiskRows
      .map((row) => ({
        id: row.id,
        riskType: row.riskType,
        severity: row.severity,
        title: row.title,
        sourceFile: row.sourceFile,
        lineNumber: row.lineNumber,
      })),
    topRules: topRuleRows
      .map((row) => ({
        id: row.id,
        ruleType: row.ruleType,
        name: row.name,
        sourceFile: row.sourceFile,
        lineNumber: row.lineNumber,
      })),
    fieldTables: Array.from(fieldSummaryByTable.entries())
      .map(([tableName, summary]) => ({ tableName, ...summary }))
      .sort((left, right) => left.tableName.localeCompare(right.tableName)),
  };
}

export async function getSymbolsPage(input: SymbolsPageInput, userId: number): Promise<PagedResult<SymbolListItem>> {
  await getOwnedProject(input.projectId, userId);
  const db = await requireDb();
  if (isInMemoryDb(db)) {
    const [symbolRows, fileRows] = await Promise.all([
      db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),
      db.select().from(files).where(eq(files.projectId, input.projectId)),
    ]);
    const filePathById = new Map(fileRows.map((row) => [row.id, row.filePath]));
    const search = normalizeSearch(input.search);

    const items = sortProjectSymbols(symbolRows)
      .map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        fileId: row.fileId,
        filePath: filePathById.get(row.fileId) ?? null,
        startLine: row.startLine,
        endLine: row.endLine,
        signature: row.signature ?? null,
        description: row.description ?? null,
      }))
      .filter((row) => (input.kind ? row.type === input.kind : true))
      .filter((row) => {
        if (!search) return true;
        return normalizeSearch(row.name).includes(search) || normalizeSearch(row.filePath).includes(search);
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);
  const matchingFileIds = await listMatchingFileIds(input.projectId, searchLike);
  const conditions = [eq(symbols.projectId, input.projectId)];

  if (input.kind) {
    conditions.push(eq(symbols.type, input.kind));
  }

  if (searchLike) {
    const searchClauses = [likeContainsEscaped(symbols.name, searchLike)];
    if (matchingFileIds.length > 0) {
      searchClauses.push(inArray(symbols.fileId, matchingFileIds));
    }
    conditions.push(orAll(searchClauses));
  }

  const whereCondition = andAll(conditions);
  const total = await countRows(symbols, whereCondition);
  const pagination = normalizePagination(input.page, input.pageSize, total);
  const symbolRows = await db
    .select()
    .from(symbols)
    .where(whereCondition)
    .orderBy(asc(symbols.name), asc(symbols.fileId), asc(symbols.startLine), asc(symbols.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);
  const fileIds = Array.from(new Set(symbolRows.map((row) => row.fileId)));
  const fileRows = fileIds.length > 0 ? await db.select({ id: files.id, filePath: files.filePath }).from(files).where(inArray(files.id, fileIds)) : [];
  const filePathById = new Map(fileRows.map((row) => [row.id, row.filePath]));

  return {
    items: symbolRows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      fileId: row.fileId,
      filePath: filePathById.get(row.fileId) ?? null,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature ?? null,
      description: row.description ?? null,
    })),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

export async function getFieldsPage(input: FieldsPageInput, userId: number): Promise<PagedResult<FieldListItem>> {
  await getOwnedProject(input.projectId, userId);
  const db = await requireDb();
  if (isInMemoryDb(db)) {
    const [fieldRows, fieldDependencyRows] = await Promise.all([
      db.select().from(fields).where(eq(fields.projectId, input.projectId)),
      db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, input.projectId)),
    ]);
    const fieldUsageById = buildFieldUsageSummary(sortFieldDependencies(fieldDependencyRows));
    const search = normalizeSearch(input.search);

    const items = sortProjectFields(fieldRows)
      .map((row) => ({
        id: row.id,
        tableName: row.tableName,
        fieldName: row.fieldName,
        fieldType: row.fieldType ?? null,
        description: row.description ?? null,
        readCount: fieldUsageById.get(row.id)?.readCount ?? 0,
        writeCount: fieldUsageById.get(row.id)?.writeCount ?? 0,
        referenceCount: fieldUsageById.get(row.id)?.referenceCount ?? 0,
      }))
      .filter((row) => (input.tableName ? row.tableName === input.tableName : true))
      .filter((row) => {
        if (!search) return true;
        return normalizeSearch(row.tableName).includes(search) || normalizeSearch(row.fieldName).includes(search);
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);
  const conditions = [eq(fields.projectId, input.projectId)];

  if (input.tableName) {
    conditions.push(eq(fields.tableName, input.tableName));
  }

  if (searchLike) {
    conditions.push(orAll([likeContainsEscaped(fields.tableName, searchLike), likeContainsEscaped(fields.fieldName, searchLike)]));
  }

  const whereCondition = andAll(conditions);
  const total = await countRows(fields, whereCondition);
  const pagination = normalizePagination(input.page, input.pageSize, total);
  const fieldRows = await db
    .select()
    .from(fields)
    .where(whereCondition)
    .orderBy(asc(fields.tableName), asc(fields.fieldName), asc(fields.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);
  const fieldIds = fieldRows.map((row) => row.id);
  const usageRows =
    fieldIds.length > 0
      ? await db
          .select({
            fieldId: fieldDependencies.fieldId,
            readCount: sql<number>`sum(case when ${fieldDependencies.operationType} = 'read' then 1 else 0 end)`,
            writeCount: sql<number>`sum(case when ${fieldDependencies.operationType} = 'write' then 1 else 0 end)`,
            referenceCount: count(),
          })
          .from(fieldDependencies)
          .where(and(eq(fieldDependencies.projectId, input.projectId), inArray(fieldDependencies.fieldId, fieldIds)))
          .groupBy(fieldDependencies.fieldId)
      : [];
  const usageById = new Map(
    usageRows.map((row) => [
      row.fieldId,
      {
        readCount: Number(row.readCount ?? 0),
        writeCount: Number(row.writeCount ?? 0),
        referenceCount: Number(row.referenceCount ?? 0),
      },
    ])
  );

  return {
    items: fieldRows.map((row) => ({
      id: row.id,
      tableName: row.tableName,
      fieldName: row.fieldName,
      fieldType: row.fieldType ?? null,
      description: row.description ?? null,
      readCount: usageById.get(row.id)?.readCount ?? 0,
      writeCount: usageById.get(row.id)?.writeCount ?? 0,
      referenceCount: usageById.get(row.id)?.referenceCount ?? 0,
    })),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

export async function getRisksPage(input: RisksPageInput, userId: number): Promise<PagedResult<RiskListItem>> {
  await getOwnedProject(input.projectId, userId);
  const db = await requireDb();
  if (isInMemoryDb(db)) {
    const riskRows = await db.select().from(risks).where(eq(risks.projectId, input.projectId));
    const search = normalizeSearch(input.search);

    const items = sortProjectRisks(riskRows)
      .map((row) => ({
        id: row.id,
        riskType: row.riskType,
        severity: row.severity,
        title: row.title,
        description: row.description ?? null,
        sourceFile: row.sourceFile ?? null,
        lineNumber: row.lineNumber,
        recommendation: row.recommendation ?? null,
      }))
      .filter((row) => (input.severity ? row.severity === input.severity : true))
      .filter((row) => {
        if (!search) return true;
        return (
          normalizeSearch(row.title).includes(search) ||
          normalizeSearch(row.description).includes(search) ||
          normalizeSearch(row.sourceFile).includes(search)
        );
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);
  const conditions = [eq(risks.projectId, input.projectId)];

  if (input.severity) {
    conditions.push(eq(risks.severity, input.severity));
  }

  if (searchLike) {
    conditions.push(
      orAll([
        likeContainsEscaped(risks.title, searchLike),
        likeContainsEscaped(risks.description, searchLike),
        likeContainsEscaped(risks.sourceFile, searchLike),
      ])
    );
  }

  const whereCondition = andAll(conditions);
  const total = await countRows(risks, whereCondition);
  const pagination = normalizePagination(input.page, input.pageSize, total);
  const riskRows = await db
    .select()
    .from(risks)
    .where(whereCondition)
    .orderBy(
      sql`case ${risks.severity} when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end desc`,
      asc(risks.title),
      asc(risks.sourceFile),
      asc(risks.lineNumber),
      asc(risks.id)
    )
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return {
    items: riskRows.map((row) => ({
      id: row.id,
      riskType: row.riskType,
      severity: row.severity,
      title: row.title,
      description: row.description ?? null,
      sourceFile: row.sourceFile ?? null,
      lineNumber: row.lineNumber,
      recommendation: row.recommendation ?? null,
    })),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

export async function getRulesPage(input: RulesPageInput, userId: number): Promise<PagedResult<RuleListItem>> {
  await getOwnedProject(input.projectId, userId);
  const db = await requireDb();
  if (isInMemoryDb(db)) {
    const ruleRows = await db.select().from(rules).where(eq(rules.projectId, input.projectId));
    const search = normalizeSearch(input.search);

    const items = sortProjectRules(ruleRows)
      .map((row) => ({
        id: row.id,
        ruleType: row.ruleType,
        name: row.name,
        description: row.description ?? null,
        condition: row.condition ?? null,
        sourceFile: row.sourceFile ?? null,
        lineNumber: row.lineNumber,
      }))
      .filter((row) => (input.ruleType ? row.ruleType === input.ruleType : true))
      .filter((row) => {
        if (!search) return true;
        return normalizeSearch(row.name).includes(search) || normalizeSearch(row.description).includes(search);
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);
  const conditions = [eq(rules.projectId, input.projectId)];

  if (input.ruleType) {
    conditions.push(eq(rules.ruleType, input.ruleType));
  }

  if (searchLike) {
    conditions.push(orAll([likeContainsEscaped(rules.name, searchLike), likeContainsEscaped(rules.description, searchLike)]));
  }

  const whereCondition = andAll(conditions);
  const total = await countRows(rules, whereCondition);
  const pagination = normalizePagination(input.page, input.pageSize, total);
  const ruleRows = await db
    .select()
    .from(rules)
    .where(whereCondition)
    .orderBy(asc(rules.ruleType), asc(rules.name), asc(rules.sourceFile), asc(rules.lineNumber), asc(rules.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return {
    items: ruleRows.map((row) => ({
      id: row.id,
      ruleType: row.ruleType,
      name: row.name,
      description: row.description ?? null,
      condition: row.condition ?? null,
      sourceFile: row.sourceFile ?? null,
      lineNumber: row.lineNumber,
    })),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

export async function getDependenciesPage(
  input: DependenciesPageInput,
  userId: number
): Promise<PagedResult<DependencyListItem>> {
  await getOwnedProject(input.projectId, userId);
  const db = await requireDb();
  if (isInMemoryDb(db)) {
    const [dependencyRows, symbolRows] = await Promise.all([
      db.select().from(dependencies).where(eq(dependencies.projectId, input.projectId)),
      db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),
    ]);
    const symbolById = new Map(symbolRows.map((row) => [row.id, row]));
    const search = normalizeSearch(input.search);

    const items = sortProjectDependencies(dependencyRows)
      .map((row) => ({
        id: row.id,
        sourceSymbolId: row.sourceSymbolId,
        sourceSymbolName: symbolById.get(row.sourceSymbolId)?.name ?? `symbol:${row.sourceSymbolId}`,
        targetSymbolId: row.targetSymbolId ?? null,
        targetSymbolName: row.targetSymbolId ? symbolById.get(row.targetSymbolId)?.name ?? null : null,
        targetExternalName: row.targetExternalName ?? null,
        targetKind: row.targetKind,
        dependencyType: row.dependencyType,
        lineNumber: row.lineNumber ?? null,
      }))
      .filter((row) => (input.dependencyType ? row.dependencyType === input.dependencyType : true))
      .filter((row) => (input.targetKind ? row.targetKind === input.targetKind : true))
      .filter((row) => {
        if (!search) return true;
        return (
          normalizeSearch(row.sourceSymbolName).includes(search) ||
          normalizeSearch(row.targetSymbolName).includes(search) ||
          normalizeSearch(row.targetExternalName).includes(search)
        );
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);
  const matchingSymbolIds = await listMatchingSymbolIds(input.projectId, searchLike);
  const conditions = [eq(dependencies.projectId, input.projectId)];

  if (input.dependencyType) {
    conditions.push(eq(dependencies.dependencyType, input.dependencyType));
  }

  if (input.targetKind) {
    conditions.push(eq(dependencies.targetKind, input.targetKind));
  }

  if (searchLike) {
    const searchClauses = [likeContainsEscaped(dependencies.targetExternalName, searchLike)];
    if (matchingSymbolIds.length > 0) {
      searchClauses.push(inArray(dependencies.sourceSymbolId, matchingSymbolIds));
      searchClauses.push(inArray(dependencies.targetSymbolId, matchingSymbolIds));
    }
    conditions.push(orAll(searchClauses));
  }

  const whereCondition = andAll(conditions);
  const total = await countRows(dependencies, whereCondition);
  const pagination = normalizePagination(input.page, input.pageSize, total);
  const dependencyRows = await db
    .select()
    .from(dependencies)
    .where(whereCondition)
    .orderBy(asc(dependencies.sourceSymbolId), asc(dependencies.targetSymbolId), asc(dependencies.lineNumber), asc(dependencies.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);
  const symbolIds = Array.from(
    new Set(
      dependencyRows.flatMap((row) => [row.sourceSymbolId, row.targetSymbolId].filter((value): value is number => typeof value === "number"))
    )
  );
  const symbolRows =
    symbolIds.length > 0 ? await db.select({ id: symbols.id, name: symbols.name }).from(symbols).where(inArray(symbols.id, symbolIds)) : [];
  const symbolById = new Map(symbolRows.map((row) => [row.id, row.name]));

  return {
    items: dependencyRows.map((row) => ({
      id: row.id,
      sourceSymbolId: row.sourceSymbolId,
      sourceSymbolName: symbolById.get(row.sourceSymbolId) ?? `symbol:${row.sourceSymbolId}`,
      targetSymbolId: row.targetSymbolId ?? null,
      targetSymbolName: row.targetSymbolId ? symbolById.get(row.targetSymbolId) ?? null : null,
      targetExternalName: row.targetExternalName ?? null,
      targetKind: row.targetKind,
      dependencyType: row.dependencyType,
      lineNumber: row.lineNumber ?? null,
    })),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

export async function getFieldDependenciesPage(
  input: FieldDependenciesPageInput,
  userId: number
): Promise<PagedResult<FieldDependencyListItem>> {
  await getOwnedProject(input.projectId, userId);
  const db = await requireDb();
  if (isInMemoryDb(db)) {
    const [fieldDependencyRows, fieldRows, symbolRows] = await Promise.all([
      db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, input.projectId)),
      db.select().from(fields).where(eq(fields.projectId, input.projectId)),
      db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),
    ]);
    const fieldById = new Map(fieldRows.map((row) => [row.id, row]));
    const symbolById = new Map(symbolRows.map((row) => [row.id, row]));
    const search = normalizeSearch(input.search);

    const items = sortFieldDependencies(fieldDependencyRows)
      .map((row) => ({
        id: row.id,
        fieldId: row.fieldId,
        tableName: fieldById.get(row.fieldId)?.tableName ?? "unknown",
        fieldName: fieldById.get(row.fieldId)?.fieldName ?? "unknown",
        symbolId: row.symbolId,
        symbolName: symbolById.get(row.symbolId)?.name ?? `symbol:${row.symbolId}`,
        operationType: row.operationType,
        lineNumber: row.lineNumber ?? null,
        context: row.context ?? null,
      }))
      .filter((row) => (input.tableName ? row.tableName === input.tableName : true))
      .filter((row) => (input.operationType ? row.operationType === input.operationType : true))
      .filter((row) => {
        if (!search) return true;
        return (
          normalizeSearch(row.tableName).includes(search) ||
          normalizeSearch(row.fieldName).includes(search) ||
          normalizeSearch(row.symbolName).includes(search) ||
          normalizeSearch(row.context).includes(search)
        );
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);
  const tableFieldIds = input.tableName
    ? (
        await db
          .select({ id: fields.id })
          .from(fields)
          .where(and(eq(fields.projectId, input.projectId), eq(fields.tableName, input.tableName)))
      ).map((row) => row.id)
    : [];

  if (input.tableName && tableFieldIds.length === 0) {
    return paginateItems([], input.page, input.pageSize);
  }

  const [searchFieldIds, searchSymbolIds] = await Promise.all([
    listMatchingFieldIds(input.projectId, searchLike),
    listMatchingSymbolIds(input.projectId, searchLike),
  ]);

  const conditions = [eq(fieldDependencies.projectId, input.projectId)];

  if (input.operationType) {
    conditions.push(eq(fieldDependencies.operationType, input.operationType));
  }

  if (input.tableName) {
    conditions.push(inArray(fieldDependencies.fieldId, tableFieldIds));
  }

  if (searchLike) {
    const searchClauses = [likeContainsEscaped(fieldDependencies.context, searchLike)];
    if (searchFieldIds.length > 0) {
      searchClauses.push(inArray(fieldDependencies.fieldId, searchFieldIds));
    }
    if (searchSymbolIds.length > 0) {
      searchClauses.push(inArray(fieldDependencies.symbolId, searchSymbolIds));
    }
    conditions.push(orAll(searchClauses));
  }

  const whereCondition = andAll(conditions);
  const total = await countRows(fieldDependencies, whereCondition);
  const pagination = normalizePagination(input.page, input.pageSize, total);
  const fieldDependencyRows = await db
    .select()
    .from(fieldDependencies)
    .where(whereCondition)
    .orderBy(asc(fieldDependencies.fieldId), asc(fieldDependencies.symbolId), asc(fieldDependencies.lineNumber), asc(fieldDependencies.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);
  const fieldIds = Array.from(new Set(fieldDependencyRows.map((row) => row.fieldId)));
  const symbolIds = Array.from(new Set(fieldDependencyRows.map((row) => row.symbolId)));
  const [fieldRows, symbolRows] = await Promise.all([
    fieldIds.length > 0
      ? db.select({ id: fields.id, tableName: fields.tableName, fieldName: fields.fieldName }).from(fields).where(inArray(fields.id, fieldIds))
      : Promise.resolve([]),
    symbolIds.length > 0 ? db.select({ id: symbols.id, name: symbols.name }).from(symbols).where(inArray(symbols.id, symbolIds)) : Promise.resolve([]),
  ]);
  const fieldById = new Map(fieldRows.map((row) => [row.id, row]));
  const symbolById = new Map(symbolRows.map((row) => [row.id, row.name]));

  return {
    items: fieldDependencyRows.map((row) => ({
      id: row.id,
      fieldId: row.fieldId,
      tableName: fieldById.get(row.fieldId)?.tableName ?? "unknown",
      fieldName: fieldById.get(row.fieldId)?.fieldName ?? "unknown",
      symbolId: row.symbolId,
      symbolName: symbolById.get(row.symbolId) ?? `symbol:${row.symbolId}`,
      operationType: row.operationType,
      lineNumber: row.lineNumber ?? null,
      context: row.context ?? null,
    })),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
  };
}

function buildReportFileName(projectId: number) {
  return `legacy-lens-report-${projectId}.zip`;
}

function estimateReportArchiveBytes(entries: Array<{ path: string; content: string }>) {
  const rawBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
  const zipOverheadBytes = entries.length * 512 + 4096;
  return rawBytes + zipOverheadBytes;
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

  const deterministicFileOptions = { date: new Date(0) };
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

  const archiveEntries = [
    { path: "FLOW.md", content: readyReport.flowMarkdown },
    { path: "DATA_DEPENDENCY.md", content: readyReport.dataDependencyMarkdown },
    { path: "RISKS.md", content: readyReport.risksMarkdown },
    { path: "RULES.yaml", content: readyReport.rulesYaml },
    { path: "IMPACT_ANALYSIS.md", content: impactMarkdown },
    { path: "impact-analysis.json", content: JSON.stringify(impactSummary, null, 2) },
    { path: "import-warnings.json", content: JSON.stringify(project?.importWarningsJson ?? [], null, 2) },
    { path: "metadata.json", content: JSON.stringify(metadata, null, 2) },
    {
      path: "analysis-summary.json",
      content: JSON.stringify(
        {
          analysisResultId: readyReport.id,
          status: readyReport.status,
          metrics: readyReport.summaryJson,
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

  const estimatedArchiveBytes = estimateReportArchiveBytes([...archiveEntries]);
  if (estimatedArchiveBytes > MAX_REPORT_ARCHIVE_BYTES) {
    throw new AppError(
      "REPORT_TOO_LARGE",
      `Report export is too large to package safely (estimated ${estimatedArchiveBytes} bytes, limit ${MAX_REPORT_ARCHIVE_BYTES}). Try a smaller project slice, narrower import scope, or paged API results.`
    );
  }

  const archive = new JSZip();
  for (const entry of archiveEntries) {
    archive.file(entry.path, entry.content, deterministicFileOptions);
  }

  logger.info("Export completed", { projectId, action: "export.zip.complete", status: "ok", analysisResultId: readyReport.id });
  const buffer = await archive.generateAsync({ type: "nodebuffer" });
  if (buffer.length > MAX_REPORT_ARCHIVE_BYTES) {
    throw new AppError("REPORT_TOO_LARGE", `Report ZIP exceeds the ${MAX_REPORT_ARCHIVE_BYTES} byte safety limit.`);
  }
  return {
    fileName: buildReportFileName(projectId),
    mimeType: "application/zip",
    buffer,
  };
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

  const rows = await db.select().from(projectJobs);
  const activeTempPaths = new Set<string>();

  for (const row of rows) {
    if (!isActiveProjectJobStatus(row.status) || row.type !== "import_zip" || !row.payloadJson) {
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

    await clearProjectAnalysisGraph(tx, projectId, true);
    await tx.delete(projectJobs).where(eq(projectJobs.projectId, projectId));
    await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });
}

export async function runImpactAnalysis(projectId: number, userId: number, target: string, type: ImpactTargetType) {
  await getOwnedProject(projectId, userId);
  const analyzer = new ImpactAnalyzer();
  return await analyzer.analyze(projectId, target, type);
}
