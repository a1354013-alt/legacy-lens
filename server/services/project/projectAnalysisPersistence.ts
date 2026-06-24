import { eq } from "drizzle-orm";
import type { AnalysisWarning } from "../../../shared/contracts";
import {
  analysisResults,
  dependencies,
  fieldDependencies,
  fields,
  files,
  risks,
  rules,
  symbols,
} from "../../../drizzle/schema";
import { buildFieldIdentityKey, normalizeFieldIdentity } from "../../analyzer/fieldIdentity";
import type { AnalyzedSymbol, ProjectAnalysisResult } from "../../analyzer/types";
import type { AppError } from "../../appError";
import type { DatabaseClient } from "../../dbTypes";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;
type ProjectFileRecord = { id?: number | null; filePath: string };

export type AnalysisPersistCheckpoint = {
  operation: string;
  table: string;
  filePath?: string;
};

type PersistenceDeps = {
  assertProjectJobExecutionActive: (...args: any[]) => Promise<void>;
  replaceAnalysisResult: (
    db: DbHandle,
    projectId: number,
    values: Omit<typeof analysisResults.$inferInsert, "projectId">
  ) => Promise<void>;
  getAnalysisResultErrorMessage: (result: Pick<ProjectAnalysisResult, "status">) => string | null;
  throwAnalysisPersistError: (error: unknown, context: any) => never;
  insertInChunks: <T extends Record<string, unknown>>(db: DbHandle, table: object, rows: T[]) => Promise<void>;
  resolveOwningSymbol: (symbolsForProject: AnalyzedSymbol[], file: string, line: number) => AnalyzedSymbol | undefined;
  resolveInsertedTargetSymbolId: (
    dependency: ProjectAnalysisResult["dependencies"][number],
    symbolsForProject: AnalyzedSymbol[],
    insertedSymbolIds: Map<string, number>
  ) => number | undefined;
  transitionProjectState: (...args: any[]) => Promise<void>;
  getExistingUsableAnalysisResult: (db: DbHandle, projectId: number) => Promise<(typeof analysisResults.$inferSelect) | null>;
  mergeAnalysisWarnings: (base: AnalysisWarning[], additions: AnalysisWarning[]) => AnalysisWarning[];
};

function updatePersistCheckpoint(checkpoint: AnalysisPersistCheckpoint, next: AnalysisPersistCheckpoint) {
  checkpoint.operation = next.operation;
  checkpoint.table = next.table;
  checkpoint.filePath = next.filePath;
}

function getSymbolStableKey(row: Pick<typeof symbols.$inferSelect, "metadata">) {
  const metadata = row.metadata as { stableKey?: unknown } | null;
  return typeof metadata?.stableKey === "string" ? metadata.stableKey : null;
}

export async function clearPreviousAnalysisData(db: DbHandle, projectId: number, includeFiles = false) {
  await db.delete(analysisResults).where(eq(analysisResults.projectId, projectId));
  await db.delete(fieldDependencies).where(eq(fieldDependencies.projectId, projectId));
  await db.delete(dependencies).where(eq(dependencies.projectId, projectId));
  await db.delete(risks).where(eq(risks.projectId, projectId));
  await db.delete(rules).where(eq(rules.projectId, projectId));
  await db.delete(fields).where(eq(fields.projectId, projectId));
  await db.delete(symbols).where(eq(symbols.projectId, projectId));
  if (includeFiles) {
    await db.delete(files).where(eq(files.projectId, projectId));
  }
}

export async function writeSuccessfulAnalysis(
  args: {
    tx: DbHandle;
    projectId: number;
    projectFiles: ProjectFileRecord[];
    result: ProjectAnalysisResult;
    persistCheckpoint: AnalysisPersistCheckpoint;
    executionState?: unknown;
  },
  deps: PersistenceDeps
) {
  const { tx, projectId, projectFiles, result, persistCheckpoint, executionState } = args;
  const {
    assertProjectJobExecutionActive,
    getAnalysisResultErrorMessage,
    insertInChunks,
    replaceAnalysisResult,
    resolveInsertedTargetSymbolId,
    resolveOwningSymbol,
    throwAnalysisPersistError,
    transitionProjectState,
  } = deps;

  await assertProjectJobExecutionActive(executionState, "analysis.write_success.prepare", { refreshLease: true });
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "delete previous analysis data",
    table: "analysisResults,fieldDependencies,dependencies,risks,rules,fields,symbols",
  });
  await clearPreviousAnalysisData(tx, projectId);

  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert analysis result",
    table: "analysisResults",
  });
  try {
    await replaceAnalysisResult(tx, projectId, {
      status: result.status,
      flowMarkdown: result.flowDocument,
      dataDependencyMarkdown: result.dataDependencyDocument,
      risksMarkdown: result.risksDocument,
      rulesYaml: result.rulesYaml,
      summaryJson: result.metrics,
      warningsJson: result.warnings,
      errorMessage: getAnalysisResultErrorMessage(result),
    });
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert analysis result",
      table: "analysisResults",
    });
  }

  const fileByPath = new Map(projectFiles.map((file) => [file.filePath.replace(/\\/g, "/"), file]));
  const symbolRows: Array<typeof symbols.$inferInsert> = [];
  for (const symbol of result.symbols) {
    const fileRecord = fileByPath.get(symbol.file.replace(/\\/g, "/"));
    if (!fileRecord?.id) continue;

    symbolRows.push({
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
  }
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert symbols",
    table: "symbols",
    filePath: result.symbols[0]?.file,
  });
  try {
    await insertInChunks(tx, symbols, symbolRows);
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert symbols",
      table: "symbols",
      filePath: result.symbols[0]?.file,
    });
  }

  let insertedSymbolRows: typeof symbols.$inferSelect[] = [];
  try {
    insertedSymbolRows = await tx.select().from(symbols).where(eq(symbols.projectId, projectId));
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "read persisted symbols",
      table: "symbols",
    });
  }
  const insertedSymbolIds = new Map<string, number>();
  for (const row of insertedSymbolRows) {
    const stableKey = getSymbolStableKey(row);
    if (stableKey && typeof row.id === "number") {
      insertedSymbolIds.set(stableKey, row.id);
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
  const fieldDisplayByKey = new Map<string, { tableName: string; fieldName: string }>();
  for (const field of schemaFields) {
    const key = buildFieldIdentityKey({ table: field.table, field: field.field });
    const normalized = normalizeFieldIdentity({ table: field.table, field: field.field });
    fieldDisplayByKey.set(key, { tableName: normalized.originalTable, fieldName: normalized.originalField });
  }
  for (const reference of result.fieldReferences) {
    const key = buildFieldIdentityKey(reference);
    if (!fieldDisplayByKey.has(key)) {
      const normalized = normalizeFieldIdentity(reference);
      fieldDisplayByKey.set(key, { tableName: normalized.originalTable, fieldName: normalized.originalField });
    }
  }
  const uniqueFieldKeys = Array.from(
    new Set([
      ...schemaFields.map((field) => buildFieldIdentityKey({ table: field.table, field: field.field })),
      ...result.fieldReferences.map((reference) => buildFieldIdentityKey(reference)),
    ])
  );
  const fieldRows: Array<typeof fields.$inferInsert> = [];
  for (const fieldKey of uniqueFieldKeys) {
    const schemaField = schemaFieldByKey.get(fieldKey);
    const display = fieldDisplayByKey.get(fieldKey);
    if (!display) continue;
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
    fieldRows.push({
      projectId,
      tableName: display.tableName,
      fieldName: display.fieldName,
      fieldType: schemaField?.fieldType ?? null,
      description,
    });
  }
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert fields",
    table: "fields",
    filePath: schemaFields[0]?.file ?? result.fieldReferences[0]?.file,
  });
  try {
    await insertInChunks(tx, fields, fieldRows);
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert fields",
      table: "fields",
      filePath: schemaFields[0]?.file ?? result.fieldReferences[0]?.file,
    });
  }

  let insertedFieldRows: typeof fields.$inferSelect[] = [];
  try {
    insertedFieldRows = await tx.select().from(fields).where(eq(fields.projectId, projectId));
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "read persisted fields",
      table: "fields",
    });
  }
  for (const row of insertedFieldRows) {
    if (typeof row.id !== "number") {
      continue;
    }
    fieldIds.set(buildFieldIdentityKey({ table: row.tableName, field: row.fieldName }), row.id);
  }

  const fieldDependencyRows: Array<typeof fieldDependencies.$inferInsert> = [];
  for (const reference of result.fieldReferences) {
    const fieldId = fieldIds.get(buildFieldIdentityKey(reference));
    const ownerSymbol = reference.symbolStableKey
      ? result.symbols.find((symbol) => symbol.stableKey === reference.symbolStableKey)
      : resolveOwningSymbol(result.symbols, reference.file, reference.line);
    const symbolId = ownerSymbol ? insertedSymbolIds.get(ownerSymbol.stableKey) : undefined;

    if (!fieldId || !symbolId) continue;
    fieldDependencyRows.push({
      projectId,
      fieldId,
      symbolId,
      operationType: reference.type,
      lineNumber: reference.line,
      context: reference.context ?? `${reference.table}.${reference.field}`,
    });
  }
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert field dependencies",
    table: "fieldDependencies",
    filePath: result.fieldReferences[0]?.file,
  });
  try {
    await insertInChunks(tx, fieldDependencies, fieldDependencyRows);
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert field dependencies",
      table: "fieldDependencies",
      filePath: result.fieldReferences[0]?.file,
    });
  }

  const dependencyRows: Array<typeof dependencies.$inferInsert> = [];
  for (const dependency of result.dependencies) {
    const sourceSymbolId = insertedSymbolIds.get(dependency.from);
    if (!sourceSymbolId) continue;

    const targetSymbolId = resolveInsertedTargetSymbolId(dependency, result.symbols, insertedSymbolIds);
    dependencyRows.push({
      projectId,
      sourceSymbolId,
      targetSymbolId: targetSymbolId ?? null,
      targetExternalName: targetSymbolId ? null : dependency.toName,
      targetKind: targetSymbolId ? "internal" : "unresolved",
      dependencyType: dependency.type,
      lineNumber: dependency.line,
    });
  }
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert symbol dependencies",
    table: "dependencies",
    filePath: result.dependencies[0] ? result.symbols.find((symbol) => symbol.stableKey === result.dependencies[0]?.from)?.file : undefined,
  });
  try {
    await insertInChunks(tx, dependencies, dependencyRows);
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert symbol dependencies",
      table: "dependencies",
      filePath: result.dependencies[0] ? result.symbols.find((symbol) => symbol.stableKey === result.dependencies[0]?.from)?.file : undefined,
    });
  }

  const riskRows: Array<typeof risks.$inferInsert> = [];
  for (const risk of result.risks) {
    riskRows.push({
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
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert detected risks",
    table: "risks",
    filePath: result.risks[0]?.sourceFile,
  });
  try {
    await insertInChunks(tx, risks, riskRows);
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert detected risks",
      table: "risks",
      filePath: result.risks[0]?.sourceFile,
    });
  }

  const ruleRows: Array<typeof rules.$inferInsert> = [];
  for (const rule of result.rules) {
    ruleRows.push({
      projectId,
      ruleType: rule.ruleType,
      name: rule.name,
      description: rule.description,
      condition: rule.condition,
      sourceFile: rule.sourceFile,
      lineNumber: rule.lineNumber,
    });
  }
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "insert detected rules",
    table: "rules",
    filePath: result.rules[0]?.sourceFile,
  });
  try {
    await insertInChunks(tx, rules, ruleRows);
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "insert detected rules",
      table: "rules",
      filePath: result.rules[0]?.sourceFile,
    });
  }

  await assertProjectJobExecutionActive(executionState, "analysis.write_success.persist");
  updatePersistCheckpoint(persistCheckpoint, {
    operation: "finalize project status",
    table: "projects",
  });
  try {
    await transitionProjectState(tx, projectId, {
      status: "completed",
      analysisProgress: 100,
      errorMessage: getAnalysisResultErrorMessage(result),
      lastErrorCode: null,
      lastAnalyzedAt: new Date(),
    });
  } catch (error) {
    throwAnalysisPersistError(error, {
      projectId,
      executionState,
      operation: "finalize project status",
      table: "projects",
    });
  }
}

export async function writeFailedAnalysis(
  args: {
    tx: DbHandle;
    projectId: number;
    appError: AppError;
    executionState?: unknown;
  },
  deps: PersistenceDeps
) {
  const { tx, projectId, appError, executionState } = args;
  const {
    assertProjectJobExecutionActive,
    getExistingUsableAnalysisResult,
    mergeAnalysisWarnings,
    replaceAnalysisResult,
    transitionProjectState,
  } = deps;

  await assertProjectJobExecutionActive(executionState, "analysis.write_failed.prepare", { refreshLease: true });
  const existingReport = await getExistingUsableAnalysisResult(tx, projectId);
  const failureWarning: AnalysisWarning = {
    code: appError.code,
    message: appError.message,
    level: "error",
    heuristic: true,
  };

  if (existingReport) {
    await replaceAnalysisResult(tx, projectId, {
      status: existingReport.status,
      flowMarkdown: existingReport.flowMarkdown ?? null,
      dataDependencyMarkdown: existingReport.dataDependencyMarkdown ?? null,
      risksMarkdown: existingReport.risksMarkdown ?? null,
      rulesYaml: existingReport.rulesYaml ?? null,
      summaryJson: existingReport.summaryJson ?? null,
      warningsJson: mergeAnalysisWarnings(existingReport.warningsJson ?? [], [failureWarning]),
      errorMessage: appError.message,
    });
  } else {
    await clearPreviousAnalysisData(tx, projectId);
    await replaceAnalysisResult(tx, projectId, {
      status: "failed",
      flowMarkdown: null,
      dataDependencyMarkdown: null,
      risksMarkdown: null,
      rulesYaml: null,
      summaryJson: null,
      warningsJson: [failureWarning],
      errorMessage: appError.message,
    });
  }

  await assertProjectJobExecutionActive(executionState, "analysis.write_failed.persist");
  await transitionProjectState(tx, projectId, {
    status: "failed",
    analysisProgress: 0,
    errorMessage: appError.message,
    lastErrorCode: appError.code,
  });
}
