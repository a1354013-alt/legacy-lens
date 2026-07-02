import { and, eq } from "drizzle-orm";
import type { AnalysisWarning, ImportWarning, ProjectStatus } from "../../../shared/contracts";
import { projectStatusLabels } from "../../../shared/contracts";
import { analysisResults, projectJobs, projects } from "../../../drizzle/schema";
import { AppError } from "../../appError";
import { Analyzer } from "../../analyzer/analyzer";
import type { ProjectAnalysisResult } from "../../analyzer/types";
import type { DatabaseClient, InsertProjectRecord } from "../../dbTypes";
import { getProjectFiles } from "../../utils/fileExtractor";
import { logger } from "../../_core/logger";
import { ProjectJobExecutionAbortedError, type ProjectJobExecutionState } from "./projectJobLease";
import type { AnalysisPersistCheckpoint } from "./projectAnalysisPersistence";
import { writeFailedAnalysis, writeSuccessfulAnalysis } from "./projectAnalysisPersistence";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;
type RootDbHandle = DbHandle & Pick<DatabaseClient, "transaction">;

type AnalysisFailureContextLike = {
  fileCount?: number;
  filePath?: string;
  stackPreview?: string[];
};

export type ProjectAnalysisRunnerDeps = {
  requireDb: () => Promise<RootDbHandle>;
  getOwnedProject: (projectId: number, userId: number) => Promise<typeof projects.$inferSelect>;
  assertProjectJobExecutionActive: (
    executionState: ProjectJobExecutionState | undefined,
    action: string,
    options?: { refreshLease?: boolean }
  ) => Promise<void>;
  transitionProjectState: (
    db: DbHandle,
    projectId: number,
    updates: Partial<InsertProjectRecord> & { status: ProjectStatus },
    userId?: number
  ) => Promise<void>;
  writeProcessingAnalysisResultIfNoUsableSnapshot: (db: DbHandle, projectId: number) => Promise<void>;
  toAnalysisStageError: (
    error: unknown,
    context: {
      stage: "ANALYSIS_PARSE_FAILED" | "ANALYSIS_PERSIST_FAILED" | "ANALYSIS_SUMMARY_FAILED" | "ANALYSIS_UNKNOWN_FAILED";
      projectId: number;
      jobId: number | null;
      focusLanguage?: string | null;
      fileCount?: number;
      filePath?: string;
      operation?: string;
      table?: string;
    }
  ) => AppError;
  createAnalysisStageError: (
    code: "ANALYSIS_SUMMARY_FAILED",
    message: string,
    context: {
      stage: "ANALYSIS_SUMMARY_FAILED";
      projectId: number;
      jobId: number | null;
      focusLanguage?: string | null;
      fileCount?: number;
      operation?: string;
      rawMessage: string;
    }
  ) => AppError;
  getAnalysisFailureContext: (error: AppError) => AnalysisFailureContextLike | null;
  buildAnalysisErrorMessage: (context: {
    stage: "ANALYSIS_PARSE_FAILED" | "ANALYSIS_PERSIST_FAILED" | "ANALYSIS_SUMMARY_FAILED" | "ANALYSIS_UNKNOWN_FAILED";
    rawMessage: string;
    filePath?: string;
    operation?: string;
    table?: string;
  }) => string;
  applyAdditionalAnalysisWarnings: (
    result: ProjectAnalysisResult,
    additionalWarnings: AnalysisWarning[],
    context?: { importWarnings?: ImportWarning[]; fileTypes?: string[] }
  ) => ProjectAnalysisResult;
  buildImportWarningSummaryWarnings: (
    projectFiles: Awaited<ReturnType<typeof getProjectFiles>>,
    importWarnings: ImportWarning[]
  ) => AnalysisWarning[];
  makeAnalysisPartialResultPersistable: (
    result: ProjectAnalysisResult,
    context?: { importWarnings?: ImportWarning[]; fileTypes?: string[] }
  ) => ProjectAnalysisResult;
  recalculateAnalysisResultConfidence: (
    result: ProjectAnalysisResult,
    context?: { importWarnings?: ImportWarning[]; fileTypes?: string[] }
  ) => ProjectAnalysisResult;
  replaceAnalysisResult: (
    db: DbHandle,
    projectId: number,
    values: Omit<typeof analysisResults.$inferInsert, "projectId">
  ) => Promise<void>;
  getAnalysisResultErrorMessage: (result: Pick<ProjectAnalysisResult, "status">) => string | null;
  throwAnalysisPersistError: (
    error: unknown,
    context: {
      projectId: number;
      executionState?: ProjectJobExecutionState;
      operation: string;
      table: string;
      filePath?: string;
    }
  ) => never;
  insertInChunks: <T extends Record<string, unknown>>(db: DbHandle, table: object, rows: T[]) => Promise<void>;
  resolveOwningSymbol: (symbolsForProject: ProjectAnalysisResult["symbols"], file: string, line: number) => ProjectAnalysisResult["symbols"][number] | undefined;
  resolveInsertedTargetSymbolId: (
    dependency: ProjectAnalysisResult["dependencies"][number],
    symbolsForProject: ProjectAnalysisResult["symbols"],
    insertedSymbolIds: Map<string, number>
  ) => number | undefined;
  getExistingUsableAnalysisResult: (db: DbHandle, projectId: number) => Promise<(typeof analysisResults.$inferSelect) | null>;
  mergeAnalysisWarnings: (base: AnalysisWarning[], additions: AnalysisWarning[]) => AnalysisWarning[];
};

function logAnalysisEvent(
  level: "info" | "warn" | "error",
  event: "started" | "files.loaded" | "parser.started" | "parser.completed" | "persist.started" | "persist.completed" | "failed",
  context: {
    projectId: number;
    jobId: number | null;
    focusLanguage?: string | null;
    fileCount?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    filePath?: string;
    stackPreview?: string[];
    warningCount?: number;
    resultStatus?: string;
  }
) {
  logger[level](`Analysis ${event}`, {
    action: `analysis.${event}`,
    status: level === "error" ? "error" : "ok",
    projectId: context.projectId,
    jobId: context.jobId,
    focusLanguage: context.focusLanguage ?? null,
    fileCount: context.fileCount ?? null,
    errorCode: context.errorCode ?? null,
    errorMessage: context.errorMessage ?? null,
    filePath: context.filePath ?? null,
    stackPreview: context.stackPreview ?? null,
    warningCount: context.warningCount ?? null,
    resultStatus: context.resultStatus ?? null,
  });
}

async function updateAnalysisExecutionProgress(
  deps: ProjectAnalysisRunnerDeps,
  projectId: number,
  progress: number,
  executionState?: ProjectJobExecutionState
) {
  const safeProgress = Math.min(100, Math.max(0, Math.floor(progress)));
  const db = await deps.requireDb();
  await db.update(projects).set({ analysisProgress: safeProgress, updatedAt: new Date() }).where(eq(projects.id, projectId));

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

export async function analyzeProjectImpl(
  deps: ProjectAnalysisRunnerDeps,
  projectId: number,
  userId: number,
  executionState?: ProjectJobExecutionState
) {
  const project = await deps.getOwnedProject(projectId, userId);
  const jobId = executionState?.ownership?.jobId ?? null;
  if (!["ready", "completed", "failed", "analyzing"].includes(project.status)) {
    throw new AppError("INVALID_PROJECT_STATE", `Project is currently "${projectStatusLabels[project.status]}".`);
  }

  await deps.assertProjectJobExecutionActive(executionState, "analysis.start", { refreshLease: true });
  logAnalysisEvent("info", "started", {
    projectId,
    jobId,
    focusLanguage: project.language,
  });
  const db = await deps.requireDb();
  await db.transaction(async (tx) => {
    await deps.assertProjectJobExecutionActive(executionState, "analysis.bootstrap");
    await deps.transitionProjectState(
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
    await deps.writeProcessingAnalysisResultIfNoUsableSnapshot(tx, projectId);
  });

  try {
    let projectFiles: Awaited<ReturnType<typeof getProjectFiles>>;
    try {
      projectFiles = await getProjectFiles(projectId);
    } catch (error) {
      throw deps.toAnalysisStageError(error, {
        stage: "ANALYSIS_PARSE_FAILED",
        projectId,
        jobId,
        focusLanguage: project.language,
        operation: "load project files",
      });
    }

    if (projectFiles.length === 0) {
      throw deps.createAnalysisStageError(
        "ANALYSIS_SUMMARY_FAILED",
        deps.buildAnalysisErrorMessage({
          stage: "ANALYSIS_SUMMARY_FAILED",
          rawMessage: "Project does not contain any files to analyze.",
          operation: "validate project files",
        }),
        {
          stage: "ANALYSIS_SUMMARY_FAILED",
          projectId,
          jobId,
          focusLanguage: project.language,
          fileCount: 0,
          operation: "validate project files",
          rawMessage: "Project does not contain any files to analyze.",
        }
      );
    }

    await deps.assertProjectJobExecutionActive(executionState, "analysis.files_loaded", { refreshLease: true });
    logAnalysisEvent("info", "files.loaded", {
      projectId,
      jobId,
      focusLanguage: project.language,
      fileCount: projectFiles.length,
    });
    await updateAnalysisExecutionProgress(deps, projectId, 20, executionState);
    const analyzer = new Analyzer();
    await updateAnalysisExecutionProgress(deps, projectId, 45, executionState);
    logAnalysisEvent("info", "parser.started", {
      projectId,
      jobId,
      focusLanguage: project.language,
      fileCount: projectFiles.length,
    });
    let result: ProjectAnalysisResult;
    try {
      result = await analyzer.analyzeProject(
        projectFiles.map((file) => ({
          path: file.filePath,
          content: file.content ?? "",
          language: file.fileType?.replace(/^\./, "") ?? "unknown",
        })),
        projectId
      );
    } catch (error) {
      throw deps.toAnalysisStageError(error, {
        stage: "ANALYSIS_PARSE_FAILED",
        projectId,
        jobId,
        focusLanguage: project.language,
        fileCount: projectFiles.length,
        operation: "parse project files",
      });
    }

    const confidenceContext = {
      importWarnings: project.importWarningsJson ?? [],
      fileTypes: projectFiles.map((file) => file.fileType ?? file.filePath.match(/\.[^.\\/]+$/)?.[0] ?? file.fileName),
    };
    result = deps.applyAdditionalAnalysisWarnings(result, deps.buildImportWarningSummaryWarnings(projectFiles, project.importWarningsJson ?? []), confidenceContext);
    result = deps.makeAnalysisPartialResultPersistable(result, confidenceContext);
    result = deps.recalculateAnalysisResultConfidence(result, confidenceContext);
    logAnalysisEvent("info", "parser.completed", {
      projectId,
      jobId,
      focusLanguage: project.language,
      fileCount: projectFiles.length,
      warningCount: result.warnings.length,
      resultStatus: result.status,
    });

    if (result.status === "failed") {
      throw deps.createAnalysisStageError(
        "ANALYSIS_SUMMARY_FAILED",
        deps.buildAnalysisErrorMessage({
          stage: "ANALYSIS_SUMMARY_FAILED",
          rawMessage:
            "No analyzable files produced persisted analysis artifacts. Review skipped-file warnings, parser errors, and import warnings.",
          operation: "summarize analysis results",
        }),
        {
          stage: "ANALYSIS_SUMMARY_FAILED",
          projectId,
          jobId,
          focusLanguage: project.language,
          fileCount: projectFiles.length,
          operation: "summarize analysis results",
          rawMessage:
            "No analyzable files produced persisted analysis artifacts. Review skipped-file warnings, parser errors, and import warnings.",
        }
      );
    }

    await deps.assertProjectJobExecutionActive(executionState, "analysis.result_ready", { refreshLease: true });
    await updateAnalysisExecutionProgress(deps, projectId, 70, executionState);
    await updateAnalysisExecutionProgress(deps, projectId, 85, executionState);
    const persistCheckpoint: AnalysisPersistCheckpoint = {
      operation: "start analysis persistence transaction",
      table: "analysisResults,symbols,fields,fieldDependencies,dependencies,risks,rules,projects",
    };
    logAnalysisEvent("info", "persist.started", {
      projectId,
      jobId,
      focusLanguage: project.language,
      fileCount: projectFiles.length,
      warningCount: result.warnings.length,
      resultStatus: result.status,
    });
    try {
      await db.transaction(async (tx) => {
        await writeSuccessfulAnalysis(
          {
            tx,
            projectId,
            projectFiles,
            result,
            persistCheckpoint,
            executionState,
          },
          deps
        );
      });
    } catch (error) {
      throw deps.toAnalysisStageError(error, {
        stage: "ANALYSIS_PERSIST_FAILED",
        projectId,
        jobId,
        focusLanguage: project.language,
        fileCount: projectFiles.length,
        operation: persistCheckpoint.operation,
        table: persistCheckpoint.table,
        filePath: persistCheckpoint.filePath,
      });
    }

    logAnalysisEvent("info", "persist.completed", {
      projectId,
      jobId,
      focusLanguage: project.language,
      fileCount: projectFiles.length,
      warningCount: result.warnings.length,
      resultStatus: result.status,
    });
    return result;
  } catch (error) {
    if (error instanceof ProjectJobExecutionAbortedError) {
      throw error;
    }
    const appError =
      error instanceof AppError
        ? error
        : deps.toAnalysisStageError(error, {
            stage: "ANALYSIS_UNKNOWN_FAILED",
            projectId,
            jobId,
            focusLanguage: project.language,
          });
    const errorContext = deps.getAnalysisFailureContext(appError);
    logAnalysisEvent("error", "failed", {
      projectId,
      jobId,
      focusLanguage: project.language,
      fileCount: errorContext?.fileCount,
      errorCode: appError.code,
      errorMessage: appError.message,
      filePath: errorContext?.filePath,
      stackPreview: errorContext?.stackPreview,
    });
    if (executionState?.ownership) {
      await deps.assertProjectJobExecutionActive(executionState, "analysis.error_finalize", { refreshLease: true });
    }
    await db.transaction(async (tx) => {
      await writeFailedAnalysis(
        {
          tx,
          projectId,
          appError,
          executionState,
        },
        deps
      );
    });
    throw appError;
  }
}
