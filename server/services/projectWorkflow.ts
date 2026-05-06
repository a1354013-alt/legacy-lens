import JSZip from "jszip";
import { and, eq } from "drizzle-orm";
import type { AnalysisSnapshot, ReportArchivePayload } from "../../shared/contracts";
import type { ProjectStatus } from "../../shared/contracts";
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
import type { AnalyzedSymbol, ProjectAnalysisResult } from "../analyzer/types";
import { getDb } from "../db";
import { deleteProjectFiles, getProjectFiles, saveExtractedFiles } from "../utils/fileExtractor";
import { cleanupTempDir, cloneAndExtractFiles, isValidGitUrl } from "../utils/gitHandler";
import { extractFilesFromZip, validateZipFile } from "../utils/zipHandler";
import { logger } from "../_core/logger";
import { getAppVersion } from "../_core/version";

const projectStatusTransitions: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ["importing", "failed"],
  importing: ["ready", "failed"],
  ready: ["importing", "analyzing", "failed"],
  analyzing: ["completed", "failed"],
  completed: ["importing", "analyzing", "failed"],
  failed: ["importing", "analyzing"],
};

type DbHandle = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

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

function sanitizeExportBaseName(value: string) {
  const normalized = String(value ?? "").trim();
  const fallback = normalized.length > 0 ? normalized : "project";
  const withoutReserved = fallback.replace(/[<>:"/\\|?*]/g, "_");
  const collapsed = withoutReserved.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? collapsed.slice(0, 80).trim() : collapsed;
}

function compareStrings(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "");
}

function compareNumbers(left: number | null | undefined, right: number | null | undefined) {
  return (left ?? 0) - (right ?? 0);
}

function sortProjectFiles<T extends { id?: number; filePath?: string | null; fileName?: string | null }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.filePath, right.filePath) ||
      compareStrings(left.fileName, right.fileName) ||
      compareNumbers(left.id, right.id)
  );
}

function sortProjectSymbols<T extends { id?: number; name?: string | null; fileId?: number | null; startLine?: number | null }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.name, right.name) ||
      compareNumbers(left.fileId, right.fileId) ||
      compareNumbers(left.startLine, right.startLine) ||
      compareNumbers(left.id, right.id)
  );
}

function sortProjectDependencies<
  T extends { id?: number; sourceSymbolId?: number | null; targetSymbolId?: number | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareNumbers(left.sourceSymbolId, right.sourceSymbolId) ||
      compareNumbers(left.targetSymbolId, right.targetSymbolId) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

function sortProjectFields<T extends { id?: number; tableName?: string | null; fieldName?: string | null }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.tableName, right.tableName) ||
      compareStrings(left.fieldName, right.fieldName) ||
      compareNumbers(left.id, right.id)
  );
}

function sortProjectRisks<
  T extends { id?: number; severity?: string | null; title?: string | null; sourceFile?: string | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      compareStrings(left.title, right.title) ||
      compareStrings(left.sourceFile, right.sourceFile) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

function sortProjectRules<
  T extends { id?: number; ruleType?: string | null; name?: string | null; sourceFile?: string | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.ruleType, right.ruleType) ||
      compareStrings(left.name, right.name) ||
      compareStrings(left.sourceFile, right.sourceFile) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

function sortFieldDependencies<
  T extends { id?: number; fieldId?: number | null; symbolId?: number | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareNumbers(left.fieldId, right.fieldId) ||
      compareNumbers(left.symbolId, right.symbolId) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
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
  updates: Partial<typeof projects.$inferInsert> & { status: ProjectStatus },
  userId?: number
) {
  const current = userId ? await getOwnedProject(projectId, userId) : (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!current) {
    throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
  }

  assertProjectTransition(current.status, updates.status);

  const condition = userId ? and(eq(projects.id, projectId), eq(projects.userId, userId)) : eq(projects.id, projectId);
  await db
    .update(projects)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(condition);
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
    });

    await clearProjectAnalysisGraph(tx, projectId, true);
    const fileIds = await saveExtractedFiles(projectId, extractedFiles.files, tx);

    await transitionProjectState(tx, projectId, {
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
    });

    return fileIds;
  });
}

export async function importProjectZip(projectId: number, userId: number, zipContent: string) {
  await getOwnedProject(projectId, userId);
  logger.info("Import started", { projectId, action: "import.zip.start", status: "ok" });

  try {
    const isValid = await validateZipFile(zipContent);
    if (!isValid) {
      throw new AppError("ZIP_INVALID", "Uploaded file is not a valid ZIP archive.");
    }

    const extractedFiles = await extractFilesFromZip(zipContent);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles);

    logger.info("Import completed", { projectId, action: "import.zip.complete", status: "ok", fileCount: extractedFiles.files.length, warningCount: extractedFiles.warnings.length });
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
    logger.error("Import failed", { projectId, action: "import.zip.complete", status: "error", code: appError.code, message: appError.message });
    const db = await requireDb();
    await db
      .update(projects)
      .set({
        status: "failed",
        errorMessage: appError.message,
        lastErrorCode: appError.code,
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    throw appError;
  }
}

export async function importProjectGit(projectId: number, userId: number, gitUrl: string) {
  await getOwnedProject(projectId, userId);
  if (!isValidGitUrl(gitUrl)) {
    throw new AppError("INVALID_GIT_URL", "Repository URL is invalid or unsupported.");
  }

  logger.info("Import started", { projectId, action: "import.git.start", status: "ok" });
  let tempDir = "";
  try {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tempDir = join(tmpdir(), `legacy-lens-${projectId}-${Date.now()}`);
    const extractedFiles = await cloneAndExtractFiles(gitUrl, tempDir);
    const fileIds = await replaceProjectFiles(projectId, extractedFiles, gitUrl);

    logger.info("Import completed", { projectId, action: "import.git.complete", status: "ok", fileCount: extractedFiles.files.length, warningCount: extractedFiles.warnings.length });
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
    logger.error("Import failed", { projectId, action: "import.git.complete", status: "error", code: appError.code, message: appError.message });
    const db = await requireDb();
    await db
      .update(projects)
      .set({
        status: "failed",
        errorMessage: appError.message,
        lastErrorCode: appError.code,
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    throw appError;
  } finally {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  }
}

function resolveOwningSymbol(symbolsForProject: AnalyzedSymbol[], file: string, line: number) {
  return symbolsForProject.find(
    (symbol) => symbol.file === file.replace(/\\/g, "/") && symbol.startLine <= line && symbol.endLine >= line
  );
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
    return (
      symbol.name === dependency.toName ||
      symbol.qualifiedName === dependency.toName ||
      shortName === dependency.toName
    );
  });

  return targetSymbol ? insertedSymbolIds.get(buildSymbolInsertKey(targetSymbol)) : undefined;
}

async function writeSuccessfulAnalysis(tx: DbHandle, projectId: number, projectFiles: Awaited<ReturnType<typeof getProjectFiles>>, result: ProjectAnalysisResult) {
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
  if (!["ready", "completed", "failed"].includes(project.status)) {
    throw new AppError("INVALID_PROJECT_STATE", `Project is currently "${projectStatusLabels[project.status]}".`);
  }

  logger.info("Analysis started", { projectId, action: "analysis.start", status: "ok", focusLanguage: project.language });
  const db = await requireDb();
  await db.transaction(async (tx) => {
    await transitionProjectState(tx, projectId, {
      status: "analyzing",
      analysisProgress: 5,
      errorMessage: null,
      lastErrorCode: null,
    }, userId);
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

    logger.info("Analysis completed", { projectId, action: "analysis.complete", status: "ok", resultStatus: result.status, metrics: result.metrics, warningCount: result.warnings?.length ?? 0 });
    return result;
  } catch (error) {
    const appError = toAppError(error, new AppError("ANALYSIS_FAILED", "Analysis failed."));
    logger.error("Analysis failed", { projectId, action: "analysis.complete", status: "error", code: appError.code, message: appError.message });
    await db.transaction(async (tx) => {
      await writeFailedAnalysis(tx, projectId, appError);
    });
    throw appError;
  }
}

async function getProjectAnalysisRecord(db: DbHandle, projectId: number) {
  const [report] = await db.select().from(analysisResults).where(eq(analysisResults.projectId, projectId)).limit(1);
  return report ?? null;
}

function severityRank(severity: string | null | undefined) {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
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

  projectSymbols.forEach((symbol) => incrementFileImpact(fileById.get(symbol.fileId)));
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
  const rulesByType = Object.fromEntries(
    Array.from(ruleTypeCounts.entries()).sort((left, right) => left[0].localeCompare(right[0]))
  );

  const businessRules = projectRules
    .map((rule) => ({
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

function renderProjectImpactSummaryMarkdown(
  summary: Awaited<ReturnType<typeof generateProjectImpactSummary>>,
  generatedAtIso: string
) {
  const lines = [
    "# IMPACT_ANALYSIS",
    "",
    `Snapshot timestamp: ${generatedAtIso}`,
    "",
    "## Totals",
    `- Files: ${summary.totals.files}`,
    `- Symbols: ${summary.totals.symbols}`,
    `- Dependencies: ${summary.totals.dependencies}`,
    `- Risks: ${summary.totals.risks}`,
    `- Rules: ${summary.totals.rules}`,
    "",
    "## Top Impacted Files",
  ];

  if (summary.topImpactedFiles.length === 0) {
    lines.push("- No impacted files recorded.");
  } else {
    summary.topImpactedFiles.forEach((entry) => {
      lines.push(`- ${entry.filePath}: ${entry.impactCount}`);
    });
  }

  lines.push("", "## Top Dependencies");
  if (summary.topDependencies.length === 0) {
    lines.push("- No dependencies recorded.");
  } else {
    summary.topDependencies.forEach((entry) => lines.push(`- ${entry}`));
  }

  lines.push("", "## High Risk Items");
  if (summary.highRiskItems.length === 0) {
    lines.push("- No high-severity risks recorded.");
  } else {
    summary.highRiskItems.forEach((risk) => {
      const location = risk.sourceFile ? `${risk.sourceFile}${risk.lineNumber ? `:${risk.lineNumber}` : ""}` : "unknown";
      lines.push(`- [${risk.severity}] ${risk.title} (${location})`);
    });
  }

  lines.push("", "## Business Rules Summary");
  const ruleTypeEntries = Object.entries(summary.businessRules.countsByType).sort((left, right) => left[0].localeCompare(right[0]));
  if (ruleTypeEntries.length === 0) {
    lines.push("- No business rules recorded.");
  } else {
    ruleTypeEntries.forEach(([ruleType, count]) => lines.push(`- ${ruleType}: ${count}`));
  }

  if (summary.businessRules.items.length > 0) {
    lines.push("", "## Sample Rules");
    summary.businessRules.items.forEach((rule) => {
      const location = rule.sourceFile ? `${rule.sourceFile}${rule.lineNumber ? `:${rule.lineNumber}` : ""}` : "no source file";
      lines.push(`- ${rule.name} (${rule.ruleType}, ${location})`);
    });
  }

  return lines.join("\n");
}

export async function getAnalysisSnapshot(projectId: number, userId: number): Promise<AnalysisSnapshot> {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();

  const report = await getProjectAnalysisRecord(db, projectId);
  const [symbolRows, dependencyRows, fieldRows, fieldDependencyRows, riskRows, ruleRows] = await Promise.all([
    db.select().from(symbols).where(eq(symbols.projectId, projectId)),
    db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),
    db.select().from(fields).where(eq(fields.projectId, projectId)),
    db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, projectId)),
    db.select().from(risks).where(eq(risks.projectId, projectId)),
    db.select().from(rules).where(eq(rules.projectId, projectId)),
  ]);

  const sortedSymbolRows = sortProjectSymbols(symbolRows);
  const sortedDependencyRows = sortProjectDependencies(dependencyRows);
  const sortedFieldRows = sortProjectFields(fieldRows);
  const sortedFieldDependencyRows = sortFieldDependencies(fieldDependencyRows);
  const sortedRiskRows = sortProjectRisks(riskRows);
  const sortedRuleRows = sortProjectRules(ruleRows);

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
    symbols: sortedSymbolRows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      fileId: row.fileId,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature,
      description: row.description,
    })),
    dependencies: sortedDependencyRows.map((row) => ({
      id: row.id,
      sourceSymbolId: row.sourceSymbolId,
      targetSymbolId: row.targetSymbolId,
      targetExternalName: row.targetExternalName,
      targetKind: row.targetKind,
      dependencyType: row.dependencyType,
      lineNumber: row.lineNumber,
    })),
    fields: sortedFieldRows.map((row) => ({
      id: row.id,
      tableName: row.tableName,
      fieldName: row.fieldName,
      fieldType: row.fieldType,
      description: row.description,
    })),
    fieldDependencies: sortedFieldDependencyRows.map((row) => ({
      id: row.id,
      fieldId: row.fieldId,
      symbolId: row.symbolId,
      operationType: row.operationType,
      lineNumber: row.lineNumber,
      context: row.context,
    })),
    risks: sortedRiskRows.map((row) => ({
      id: row.id,
      riskType: row.riskType,
      severity: row.severity,
      title: row.title,
      description: row.description,
      sourceFile: row.sourceFile,
      lineNumber: row.lineNumber,
      recommendation: row.recommendation,
    })),
    rules: sortedRuleRows.map((row) => ({
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
  logger.info("Export started", { projectId, action: "export.zip.start", status: "ok" });
  const db = await requireDb();
  const [project, report] = await Promise.all([
    db.select().from(projects).where(eq(projects.id, projectId)).limit(1).then((rows) => rows[0] ?? null),
    getProjectAnalysisRecord(db, projectId),
  ]);

  if (!report || !report.flowMarkdown || !report.dataDependencyMarkdown || !report.risksMarkdown || !report.rulesYaml) {
    logger.warn("Export not ready", { projectId, action: "export.zip.complete", status: "error", code: "REPORT_NOT_READY" });
    throw new AppError("REPORT_NOT_READY", "Analysis report is not ready for download.");
  }

  const archive = new JSZip();
  const deterministicFileOptions = { date: new Date(0) };
  archive.file("FLOW.md", report.flowMarkdown, deterministicFileOptions);
  archive.file("DATA_DEPENDENCY.md", report.dataDependencyMarkdown, deterministicFileOptions);
  archive.file("RISKS.md", report.risksMarkdown, deterministicFileOptions);
  archive.file("RULES.yaml", report.rulesYaml, deterministicFileOptions);

  const version = getAppVersion();
  const metrics = report.summaryJson ?? null;
  const createdAtSource = (report as any).createdAt ?? (report as any).updatedAt ?? new Date(0);
  const createdAtIso = createdAtSource instanceof Date ? createdAtSource.toISOString() : new Date(createdAtSource).toISOString();
  const impactSummary = await generateProjectImpactSummary(db, projectId);
  const impactMarkdown = renderProjectImpactSummaryMarkdown(impactSummary, createdAtIso);

  archive.file("IMPACT_ANALYSIS.md", impactMarkdown, deterministicFileOptions);
  archive.file("impact-analysis.json", JSON.stringify(impactSummary, null, 2), deterministicFileOptions);

  const metadata = {
    projectName: project?.name ?? "project",
    analysisVersion: version,
    createdAt: createdAtIso,
    focusLanguage: project?.language ?? null,
    fileCount: metrics?.fileCount ?? 0,
    symbolCount: metrics?.symbolCount ?? 0,
    dependencyCount: metrics?.dependencyCount ?? 0,
    warningCount: metrics?.warningCount ?? 0,
  } as const;

  archive.file("metadata.json", JSON.stringify(metadata, null, 2), deterministicFileOptions);
  archive.file(
    "analysis-summary.json",
    JSON.stringify(
      {
        analysisResultId: report.id,
        status: report.status,
        metrics: report.summaryJson,
        warnings: report.warningsJson,
      },
      null,
      2
    ),
    deterministicFileOptions
  );

  logger.info("Export completed", { projectId, action: "export.zip.complete", status: "ok", analysisResultId: report.id });
  const exportBaseName = sanitizeExportBaseName(project?.name ?? "project");
  return {
    fileName: `${exportBaseName}-analysis-report.zip`,
    mimeType: "application/zip",
    base64: await archive.generateAsync({ type: "base64" }),
  };
}

export async function getAnalysisResult(projectId: number, userId: number) {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();
  return getProjectAnalysisRecord(db, projectId);
}

export async function deleteProjectCascade(projectId: number, userId: number) {
  await getOwnedProject(projectId, userId);
  const db = await requireDb();

  await db.transaction(async (tx) => {
    await clearProjectAnalysisGraph(tx, projectId, true);
    await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });
}

import { ImpactAnalyzer } from "../analyzer/impactAnalyzer";
import type { ImpactTargetType } from "../../shared/contracts";

export async function runImpactAnalysis(projectId: number, userId: number, target: string, type: ImpactTargetType) {
  await getOwnedProject(projectId, userId);
  const analyzer = new ImpactAnalyzer();
  return await analyzer.analyze(projectId, target, type);
}
