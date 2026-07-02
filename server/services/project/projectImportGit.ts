import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { projects } from "../../../drizzle/schema";
import { AppError, toAppError } from "../../appError";
import { cleanupTempDir, cloneAndExtractFiles, validateSafeGitUrl } from "../../utils/gitHandler";
import { logger } from "../../_core/logger";
import { ProjectJobExecutionAbortedError, type ProjectJobExecutionState } from "./projectJobLease";
import { replaceProjectFiles, type ProjectImportDeps } from "./projectImportZip";

export async function importProjectGitImpl(
  deps: ProjectImportDeps,
  projectId: number,
  userId: number,
  gitUrl: string,
  executionState?: ProjectJobExecutionState
) {
  await deps.getOwnedProject(projectId, userId);
  await deps.assertProjectJobExecutionActive(executionState, "import.git.start", { refreshLease: true });
  const validatedGitUrl = await validateSafeGitUrl(gitUrl);

  logger.info("Import started", { projectId, action: "import.git.start", status: "ok" });
  let tempDir = "";
  try {
    tempDir = join(tmpdir(), `legacy-lens-${projectId}-${Date.now()}`);
    const extractedFiles = await cloneAndExtractFiles(validatedGitUrl, tempDir);
    await deps.assertProjectJobExecutionActive(executionState, "import.git.extracted", { refreshLease: true });
    const fileIds = await replaceProjectFiles(deps, projectId, extractedFiles, gitUrl, executionState);

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
    if (error instanceof ProjectJobExecutionAbortedError) {
      throw error;
    }
    const appError = toAppError(error, new AppError("GIT_CLONE_FAILED", "Git import failed."));
    logger.error("Import failed", {
      projectId,
      action: "import.git.complete",
      status: "error",
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
  } finally {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  }
}
