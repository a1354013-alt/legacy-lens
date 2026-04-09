import JSZip from "jszip";
import { and, desc, eq } from "drizzle-orm";
import type { AnalysisSnapshot, ReportArchivePayload } from "../../shared/contracts";
import { projectStatusLabels } from "../../shared/contracts";
import {
  analysisResults,
  dependencies,
  fieldDependencies,
  fields,
  files,
  projects,
  risks,
  rules,
  symbols,
} from "../../drizzle/schema";
import { AppError, toAppError } from "../appError";
import { Analyzer } from "../analyzer/analyzer";
import { getDb } from "../db";
import { deleteProjectFiles, getProjectFiles, saveExtractedFiles } from "../utils/fileExtractor";
import { cleanupTempDir, cloneAndExtractFiles, isValidGitUrl } from "../utils/gitHandler";
import { extractFilesFromZip, validateZipFile } from "../utils/zipHandler";

export async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AppError("DATABASE_UNAVAILABLE", "Database connection is not configured.");
  }
  return db;
}

export async function getOwnedProject(projectId: number, userId: number) {
  const db = await requireDb();
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

async function updateProjectState(
  projectId: number,
  updates: Partial<typeof projects.$inferInsert>,
  userId?: number
) {
  const db = await requireDb();
  let query = db.update(projects).set(updates).where(eq(projects.id, projectId));
  if (userId) {
    query = db.update(projects).set(updates).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  }
  await query;
}

export async function createProjectForUser(
  userId: number,
  input: Pick<typeof projects.$inferInsert, "name" | "language" | "sourceType" | "description">
) {
  const db = await requireDb();
  const insertResult = await db.insert(projects).values({
    userId,
    name: input.name,
    description: input.description,
    language: input.language,
    sourceType: input.sourceType,
    status: "draft",
    importProgress: 0,
    analysisProgress: 0,
    errorMessage: null,
    lastErrorCode: null,
  });

  const insertId = Number((insertResult as { insertId?: number }).insertId ?? 0);
  if (insertId > 0) {
    return insertId;
  }

  const latestProject = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.id))
    .limit(1);

  const projectId = latestProject[0]?.id;
  if (!projectId) {
    throw new AppError("DATABASE_UNAVAILABLE", "Project was created but its identifier could not be resolved.");
  }

  return projectId;
}

async function replaceProjectFiles(
  projectId: number,
  extractedFiles: Awaited<ReturnType<typeof extractFilesFromZip>>,
  sourceUrl?: string
) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        status: "importing",
        importProgress: 10,
        analysisProgress: 0,
        sourceUrl: sourceUrl ?? null,
        errorMessage: null,
        lastErrorCode: null,
      })
      .where(eq(projects.id, projectId));

    await deleteProjectFiles(projectId, tx);
    const fileIds = await saveExtractedFiles(projectId, extractedFiles, tx);

    await tx
      .update(projects)
      .set({
        status: "ready",
        importProgress: 100,
        analysisProgress: 0,
        errorMessage: null,
        lastErrorCode: null,
      })
      .where(eq(projects.id, projectId));

    return fileIds;
  });
}

export async function importProjectZip(projectId: number, userId: number, zipContent: string) {
  await getOwnedProject(projectId, userId);

  try {
    const isValid = await validateZipFile(zipContent);
    if (!isValid) {
      throw new AppError("ZIP_INVALID", "Uploaded file is not a valid ZIP archive.");
    }

    const extractedFiles = await extractFilesFromZip(zipContent);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles);

    return {
      fileIds,
      files: extractedFiles.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        language: file.language,
        size: file.size,
      })),
    };
  } catch (error) {
    const appError = toAppError(error, new AppError("IMPORT_FAILED", "ZIP import failed."));
    await updateProjectState(projectId, {
      status: "failed",
      errorMessage: appError.message,
      lastErrorCode: appError.code,
    }, userId);
    throw appError;
  }
}

export async function importProjectGit(projectId: number, userId: number, gitUrl: string) {
  await getOwnedProject(projectId, userId);
  if (!isValidGitUrl(gitUrl)) {
    throw new AppError("INVALID_GIT_URL", "Repository URL is invalid or unsupported.");
  }

  let tempDir = "";
  try {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tempDir = join(tmpdir(), `legacy-lens-${projectId}-${Date.now()}`);
    const extractedFiles = await cloneAndExtractFiles(gitUrl, tempDir);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles, gitUrl);

    return {
      fileIds,
      files: extractedFiles.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        language: file.language,
        size: file.size,
      })),
    };
  } catch (error) {
    const appError = toAppError(error, new AppError("GIT_CLONE_FAILED", "Git import failed."));
    await updateProjectState(projectId, {
      status: "failed",
      errorMessage: appError.message,
      lastErrorCode: appError.code,
    }, userId);
    throw appError;
  } finally {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  }
}

export async function analyzeProject(projectId: number, userId: number) {
  const project = await getOwnedProject(projectId, userId);
  if (!["ready", "completed", "failed"].includes(project.status)) {
    throw new AppError("INVALID_PROJECT_STATE", `Project is currently "${projectStatusLabels[project.status]}".`);
  }

  const db = await requireDb();
  await updateProjectState(projectId, {
    status: "analyzing",
    analysisProgress: 5,
    errorMessage: null,
    lastErrorCode: null,
  }, userId);

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
      throw new AppError("ANALYSIS_FAILED", "No analyzable files were found for the selected project language.");
    }

    await db.transaction(async (tx) => {
      await tx.delete(analysisResults).where(eq(analysisResults.projectId, projectId));
      await tx.delete(dependencies).where(eq(dependencies.projectId, projectId));
      await tx.delete(fieldDependencies).where(eq(fieldDependencies.projectId, projectId));
      await tx.delete(fields).where(eq(fields.projectId, projectId));
      await tx.delete(risks).where(eq(risks.projectId, projectId));
      await tx.delete(rules).where(eq(rules.projectId, projectId));
      await tx.delete(symbols).where(eq(symbols.projectId, projectId));

      await tx.insert(analysisResults).values({
        projectId,
        status: result.status,
        flowMarkdown: result.flowDocument,
        dataDependencyMarkdown: result.dataDependencyDocument,
        risksMarkdown: result.risksDocument,
        rulesYaml: result.rulesYaml,
        summaryJson: result.metrics,
        warningsJson: result.warnings,
        errorMessage: result.status === "partial" ? "Analysis completed with warnings." : null,
      });

      const fileByPath = new Map(
        projectFiles.map((file) => [file.filePath.replace(/\\/g, "/"), file])
      );

      const insertedSymbolIds = new Map<string, number>();
      for (const symbol of result.symbols) {
        const fileRecord = fileByPath.get(symbol.file.replace(/\\/g, "/"));
        if (!fileRecord?.id) continue;
        const insertResult = await tx.insert(symbols).values({
          projectId,
          fileId: fileRecord.id,
          name: symbol.name,
          type: symbol.type,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature,
          description: symbol.description,
        });
        const symbolId = Number((insertResult as { insertId?: number }).insertId ?? 0);
        if (symbolId > 0) {
          insertedSymbolIds.set(`${symbol.name}:${symbol.file}:${symbol.startLine}`, symbolId);
        }
      }

      const fieldIds = new Map<string, number>();
      const uniqueFieldKeys = Array.from(new Set(result.fieldReferences.map((reference) => `${reference.table}.${reference.field}`)));
      for (const fieldKey of uniqueFieldKeys) {
        const [tableName, fieldName] = fieldKey.split(".");
        const insertResult = await tx.insert(fields).values({ projectId, tableName, fieldName });
        const fieldId = Number((insertResult as { insertId?: number }).insertId ?? 0);
        if (fieldId > 0) {
          fieldIds.set(fieldKey, fieldId);
        }
      }

      for (const reference of result.fieldReferences) {
        const fieldId = fieldIds.get(`${reference.table}.${reference.field}`);
        const ownerSymbol = result.symbols.find(
          (symbol) => symbol.file === reference.file && symbol.startLine <= reference.line && symbol.endLine >= reference.line
        );
        const symbolId = ownerSymbol
          ? insertedSymbolIds.get(`${ownerSymbol.name}:${ownerSymbol.file}:${ownerSymbol.startLine}`)
          : undefined;

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

      const symbolRows = await tx.select().from(symbols).where(eq(symbols.projectId, projectId));
      const symbolIdByName = new Map(symbolRows.map((row) => [row.name, row.id]));
      for (const dependency of result.dependencies) {
        const sourceSymbolId = symbolIdByName.get(dependency.from);
        const targetSymbolId = symbolIdByName.get(dependency.to);
        if (!sourceSymbolId || !targetSymbolId) continue;
        await tx.insert(dependencies).values({
          projectId,
          sourceSymbolId,
          targetSymbolId,
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

      await tx
        .update(projects)
        .set({
          status: "completed",
          analysisProgress: 100,
          errorMessage: result.status === "partial" ? "Analysis completed with warnings." : null,
          lastErrorCode: null,
        })
        .where(eq(projects.id, projectId));
    });

    return result;
  } catch (error) {
    const appError = toAppError(error, new AppError("ANALYSIS_FAILED", "Analysis failed."));
    await db
      .delete(analysisResults)
      .where(eq(analysisResults.projectId, projectId));
    await db.insert(analysisResults).values({
      projectId,
      status: "failed",
      flowMarkdown: null,
      dataDependencyMarkdown: null,
      risksMarkdown: null,
      rulesYaml: null,
      summaryJson: null,
      warningsJson: [],
      errorMessage: appError.message,
    });
    await updateProjectState(projectId, {
      status: "failed",
      errorMessage: appError.message,
      lastErrorCode: appError.code,
      analysisProgress: 0,
    }, userId);
    throw appError;
  }
}

export async function getAnalysisSnapshot(projectId: number, userId: number): Promise<AnalysisSnapshot> {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();

  const [report] = await db.select().from(analysisResults).where(eq(analysisResults.projectId, projectId)).limit(1);
  const [symbolRows, dependencyRows, fieldRows, fieldDependencyRows, riskRows, ruleRows] = await Promise.all([
    db.select().from(symbols).where(eq(symbols.projectId, projectId)).orderBy(symbols.startLine),
    db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),
    db.select().from(fields).where(eq(fields.projectId, projectId)),
    db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, projectId)),
    db.select().from(risks).where(eq(risks.projectId, projectId)).orderBy(desc(risks.id)),
    db.select().from(rules).where(eq(rules.projectId, projectId)).orderBy(desc(rules.id)),
  ]);

  return {
    report: report
      ? {
          id: report.id,
          projectId: report.projectId,
          status: report.status,
          flowMarkdown: report.flowMarkdown,
          dataDependencyMarkdown: report.dataDependencyMarkdown,
          risksMarkdown: report.risksMarkdown,
          rulesYaml: report.rulesYaml,
          summaryJson: report.summaryJson,
          warningsJson: report.warningsJson,
          errorMessage: report.errorMessage,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
        }
      : null,
    symbols: symbolRows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      fileId: row.fileId,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature,
      description: row.description,
    })),
    dependencies: dependencyRows.map((row) => ({
      id: row.id,
      sourceSymbolId: row.sourceSymbolId,
      targetSymbolId: row.targetSymbolId,
      dependencyType: row.dependencyType,
      lineNumber: row.lineNumber,
    })),
    fields: fieldRows.map((row) => ({
      id: row.id,
      tableName: row.tableName,
      fieldName: row.fieldName,
      fieldType: row.fieldType,
      description: row.description,
    })),
    fieldDependencies: fieldDependencyRows.map((row) => ({
      id: row.id,
      fieldId: row.fieldId,
      symbolId: row.symbolId,
      operationType: row.operationType,
      lineNumber: row.lineNumber,
      context: row.context,
    })),
    risks: riskRows.map((row) => ({
      id: row.id,
      riskType: row.riskType,
      severity: row.severity,
      title: row.title,
      description: row.description,
      sourceFile: row.sourceFile,
      lineNumber: row.lineNumber,
      recommendation: row.recommendation,
    })),
    rules: ruleRows.map((row) => ({
      id: row.id,
      ruleType: row.ruleType,
      name: row.name,
      description: row.description,
      condition: row.condition,
      sourceFile: row.sourceFile,
      lineNumber: row.lineNumber,
    })),
  };
}

export async function buildReportArchive(projectId: number, userId: number): Promise<ReportArchivePayload> {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const [report] = await db.select().from(analysisResults).where(eq(analysisResults.projectId, projectId)).limit(1);

  if (!report || !report.flowMarkdown || !report.dataDependencyMarkdown || !report.risksMarkdown || !report.rulesYaml) {
    throw new AppError("REPORT_NOT_READY", "Analysis report is not ready for download.");
  }

  const archive = new JSZip();
  archive.file("FLOW.md", report.flowMarkdown);
  archive.file("DATA_DEPENDENCY.md", report.dataDependencyMarkdown);
  archive.file("RISKS.md", report.risksMarkdown);
  archive.file("RULES.yaml", report.rulesYaml);
  archive.file(
    "analysis-summary.json",
    JSON.stringify(
      {
        status: report.status,
        metrics: report.summaryJson,
        warnings: report.warningsJson,
      },
      null,
      2
    )
  );

  return {
    fileName: `${project?.name ?? "project"}-analysis-report.zip`,
    mimeType: "application/zip",
    base64: await archive.generateAsync({ type: "base64" }),
  };
}

export async function deleteProjectCascade(projectId: number, userId: number) {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();

  await db.transaction(async (tx) => {
    await tx.delete(analysisResults).where(eq(analysisResults.projectId, projectId));
    await tx.delete(fieldDependencies).where(eq(fieldDependencies.projectId, projectId));
    await tx.delete(fields).where(eq(fields.projectId, projectId));
    await tx.delete(dependencies).where(eq(dependencies.projectId, projectId));
    await tx.delete(symbols).where(eq(symbols.projectId, projectId));
    await tx.delete(risks).where(eq(risks.projectId, projectId));
    await tx.delete(rules).where(eq(rules.projectId, projectId));
    await tx.delete(files).where(eq(files.projectId, projectId));
    await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });
}
