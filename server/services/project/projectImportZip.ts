import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { ProjectStatus } from "../../../shared/contracts";
import { projectJobs, projects } from "../../../drizzle/schema";
import { AppError, toAppError } from "../../appError";
import type { DatabaseClient, InsertProjectRecord } from "../../dbTypes";
import { saveExtractedFiles } from "../../utils/fileExtractor";
import { extractFilesFromZip, extractFilesFromZipBuffer } from "../../utils/zipHandler";
import { logger } from "../../_core/logger";
import { calculateSourceFingerprint } from "../sourceFingerprint";
import { ProjectJobExecutionAbortedError, type ProjectJobExecutionState } from "./projectJobLease";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete" | "transaction">;
type ExtractedProjectFiles = Awaited<ReturnType<typeof extractFilesFromZip>>;

export type ProjectImportDeps = {
  requireDb: () => Promise<DbHandle>;
  getOwnedProject: (projectId: number, userId: number) => Promise<unknown>;
  assertProjectJobExecutionActive: (
    executionState: ProjectJobExecutionState | undefined,
    action: string,
    options?: { refreshLease?: boolean }
  ) => Promise<void>;
  updateImportExecutionProgress: (
    projectId: number,
    progress: number,
    executionState?: ProjectJobExecutionState
  ) => Promise<void>;
  transitionProjectState: (
    db: DbHandle,
    projectId: number,
    updates: Partial<InsertProjectRecord> & { status: ProjectStatus },
    userId?: number
  ) => Promise<void>;
  clearLatestAnalysisProjection: (db: DbHandle, projectId: number) => Promise<void>;
  deleteProjectFiles: (db: DbHandle, projectId: number) => Promise<void>;
};

function summarizeImportedFiles(extractedFiles: ExtractedProjectFiles, fileIds: number[]) {
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
}

export async function replaceProjectFiles(
  deps: ProjectImportDeps,
  projectId: number,
  extractedFiles: ExtractedProjectFiles,
  sourceUrl?: string,
  executionState?: ProjectJobExecutionState
) {
  const db = await deps.requireDb();
  await deps.assertProjectJobExecutionActive(executionState, "import.replace_files.prepare", { refreshLease: true });
  await deps.updateImportExecutionProgress(projectId, 80, executionState);
  return db.transaction(async (tx) => {
    await deps.assertProjectJobExecutionActive(executionState, "import.replace_files.transaction");
    await deps.transitionProjectState(tx, projectId, {
      status: "importing",
      importProgress: 80,
      analysisProgress: 0,
      sourceUrl: sourceUrl ?? null,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: [],
    });

    await deps.clearLatestAnalysisProjection(tx, projectId);
    await deps.deleteProjectFiles(tx, projectId);
    const fileIds = await saveExtractedFiles(projectId, extractedFiles.files, tx);
    const sourceFingerprint = calculateSourceFingerprint(extractedFiles.files);
    await deps.assertProjectJobExecutionActive(executionState, "import.replace_files.persist");
    if (executionState?.ownership) {
      await tx
        .update(projectJobs)
        .set({ progress: 90 })
        .where(
          and(
            eq(projectJobs.id, executionState.ownership.jobId),
            eq(projectJobs.status, "running"),
            eq(projectJobs.lockedBy, executionState.ownership.lockedBy),
            eq(projectJobs.attemptCount, executionState.ownership.attemptCount)
          )
        );
    }

    await deps.transitionProjectState(tx, projectId, {
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      sourceFingerprint,
      lastAnalyzedAt: null,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: extractedFiles.warnings,
    });

    return fileIds;
  });
}

export async function importProjectZipImpl(
  deps: ProjectImportDeps,
  projectId: number,
  userId: number,
  zipContent: string,
  executionState?: ProjectJobExecutionState
) {
  await deps.getOwnedProject(projectId, userId);
  await deps.assertProjectJobExecutionActive(executionState, "import.zip.start", { refreshLease: true });
  await deps.updateImportExecutionProgress(projectId, 10, executionState);
  logger.info("ZIP import started", { projectId, action: "import.zip.started", status: "running", source: "inline_payload" });

  try {
    const extractedFiles = await extractFilesFromZip(zipContent);
    await deps.assertProjectJobExecutionActive(executionState, "import.zip.extracted", { refreshLease: true });
    await deps.updateImportExecutionProgress(projectId, 60, executionState);
    logger.info("ZIP import extracted files", {
      projectId,
      action: "import.zip.extracted",
      status: "running",
      source: "inline_payload",
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    const fileIds = await replaceProjectFiles(deps, projectId, extractedFiles, undefined, executionState);

    logger.info("ZIP import persisted files", {
      projectId,
      action: "import.zip.persisted",
      status: "running",
      source: "inline_payload",
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    logger.info("ZIP import completed", {
      projectId,
      action: "import.zip.completed",
      status: "completed",
      source: "inline_payload",
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    return summarizeImportedFiles(extractedFiles, fileIds);
  } catch (error) {
    if (error instanceof ProjectJobExecutionAbortedError) {
      throw error;
    }
    const appError = toAppError(error, new AppError("IMPORT_FAILED", "ZIP import failed."));
    logger.error("ZIP import failed", {
      projectId,
      action: "import.zip.failed",
      status: "failed",
      source: "inline_payload",
      code: appError.code,
      message: appError.message,
    });
    if (!executionState?.ownership) {
      const db = await deps.requireDb();
      await db
        .update(projects)
        .set({
          status: "failed",
          errorMessage: appError.message,
          lastErrorCode: appError.code,
          importWarningsJson: [],
        })
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    }
    throw appError;
  }
}

export async function importProjectZipFromTempFileImpl(
  deps: ProjectImportDeps,
  projectId: number,
  userId: number,
  tempFilePath: string,
  executionState?: ProjectJobExecutionState
) {
  await deps.getOwnedProject(projectId, userId);
  await deps.assertProjectJobExecutionActive(executionState, "import.zip_temp.start", { refreshLease: true });
  await deps.updateImportExecutionProgress(projectId, 10, executionState);
  logger.info("ZIP import started", {
    projectId,
    action: "import.zip.started",
    status: "running",
    source: "temp_file",
    tempFilePath,
  });

  try {
    logger.info("ZIP import reading temp file", {
      projectId,
      action: "import.zip.temp_file",
      status: "running",
      source: "temp_file",
      tempFilePath,
    });
    const zipBuffer = await readFile(tempFilePath);
    const extractedFiles = await extractFilesFromZipBuffer(zipBuffer);
    await deps.assertProjectJobExecutionActive(executionState, "import.zip_temp.extracted", { refreshLease: true });
    await deps.updateImportExecutionProgress(projectId, 60, executionState);
    logger.info("ZIP import extracted files", {
      projectId,
      action: "import.zip.extracted",
      status: "running",
      source: "temp_file",
      tempFilePath,
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    const fileIds = await replaceProjectFiles(deps, projectId, extractedFiles, undefined, executionState);

    logger.info("ZIP import persisted files", {
      projectId,
      action: "import.zip.persisted",
      status: "running",
      source: "temp_file",
      tempFilePath,
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    logger.info("ZIP import completed", {
      projectId,
      action: "import.zip.completed",
      status: "completed",
      source: "temp_file",
      tempFilePath,
      fileCount: extractedFiles.files.length,
      warningCount: extractedFiles.warnings.length,
    });
    return summarizeImportedFiles(extractedFiles, fileIds);
  } catch (error) {
    if (error instanceof ProjectJobExecutionAbortedError) {
      throw error;
    }
    const appError = toAppError(error, new AppError("IMPORT_FAILED", "ZIP import failed."));
    logger.error("ZIP import failed", {
      projectId,
      action: "import.zip.failed",
      status: "failed",
      source: "temp_file",
      tempFilePath,
      code: appError.code,
      message: appError.message,
    });
    if (!executionState?.ownership) {
      const db = await deps.requireDb();
      await db
        .update(projects)
        .set({
          status: "failed",
          errorMessage: appError.message,
          lastErrorCode: appError.code,
          importWarningsJson: [],
        })
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    }
    throw appError;
  }
}
