import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type {
  AnalysisDiff,
  AnalysisRunDetail,
  AnalysisRunProjectContext,
  AnalysisRunSnapshotV1,
  AnalysisRunSummary,
  DelphiFlowTrace,
} from "../../shared/contracts";
import {
  analysisDiffSchema,
  analysisRunSnapshotV1Schema,
  delphiBuildDoctorResultSchema,
} from "../../shared/contracts";
import {
  analysisBaselines,
  analysisResults,
  dependencies,
  fieldDependencies,
  fields,
  files,
  risks,
  rules,
  symbols,
  projects,
} from "../../drizzle/schema";
import type { ProjectAnalysisResult } from "../analyzer/types";
import type { DatabaseClient } from "../dbTypes";
import { AppError } from "../appError";
import { mapSnapshotReport } from "./projectWorkflow.helpers";
import { buildSourceManifest, calculateSourceFingerprint, normalizeSourcePath, stableSourceJson } from "./sourceFingerprint";

export const ANALYSIS_SNAPSHOT_SCHEMA_VERSION = 1;
export const ANALYZER_VERSION = "1.1.0-rc2";
export const MAX_SNAPSHOT_BYTES = 15 * 1024 * 1024;
const DIFF_LIMIT = 200;
const USABLE_STATUSES = ["completed", "completed_with_warnings", "partial"] as const;
const ANALYSIS_DIFF_METRIC_KEYS = [
  "fileCount",
  "eligibleFileCount",
  "analyzedFileCount",
  "skippedFileCount",
  "heuristicFileCount",
  "degradedFileCount",
  "symbolCount",
  "dependencyCount",
  "fieldCount",
  "fieldDependencyCount",
  "riskCount",
  "ruleCount",
  "warningCount",
] as const;
const LEGACY_UNKNOWN_PROJECT_CONTEXT: AnalysisRunProjectContext = {
  projectName: "unknown",
  sourceType: "unknown",
  focusLanguage: null,
  importWarnings: [],
};

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;
type ProjectFileRecord = { id?: number | null; filePath: string; fileType?: string | null; lineCount?: number | null; content?: string | null };

function normalizePath(value: string | null | undefined) {
  return normalizeSourcePath(value);
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

const stableJson = stableSourceJson;

function sortByJson<T>(items: T[]) {
  return [...items].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

const sourceManifest = buildSourceManifest;

function serializeSnapshot(snapshot: AnalysisRunSnapshotV1) {
  const parsed = analysisRunSnapshotV1Schema.parse(snapshot);
  const text = stableJson(parsed);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new AppError("ANALYSIS_PERSIST_FAILED", `Analysis snapshot is too large to persist (${bytes} bytes; limit ${MAX_SNAPSHOT_BYTES}).`);
  }
  return text;
}

function isUsableStatus(status: string | null | undefined): status is (typeof USABLE_STATUSES)[number] {
  return USABLE_STATUSES.includes(status as (typeof USABLE_STATUSES)[number]);
}

function getProjectContextOrLegacyDefault(snapshot: AnalysisRunSnapshotV1 | null | undefined) {
  return snapshot?.projectContext ?? LEGACY_UNKNOWN_PROJECT_CONTEXT;
}

function normalizeMetrics(result: ProjectAnalysisResult) {
  return {
    fileCount: result.metrics?.fileCount ?? 0,
    eligibleFileCount: result.metrics?.eligibleFileCount ?? result.metrics?.fileCount ?? 0,
    analyzedFileCount: result.metrics?.analyzedFileCount ?? result.metrics?.fileCount ?? 0,
    skippedFileCount: result.metrics?.skippedFileCount ?? 0,
    heuristicFileCount: result.metrics?.heuristicFileCount ?? 0,
    degradedFileCount: result.metrics?.degradedFileCount ?? 0,
    symbolCount: result.metrics?.symbolCount ?? result.symbols?.length ?? 0,
    dependencyCount: result.metrics?.dependencyCount ?? result.dependencies?.length ?? 0,
    fieldCount: result.metrics?.fieldCount ?? result.schemaFields?.length ?? 0,
    fieldDependencyCount: result.metrics?.fieldDependencyCount ?? result.fieldReferences?.length ?? 0,
    riskCount: result.metrics?.riskCount ?? result.risks?.length ?? 0,
    ruleCount: result.metrics?.ruleCount ?? result.rules?.length ?? 0,
    warningCount: result.metrics?.warningCount ?? result.warnings?.length ?? 0,
    delphiEventMap: result.metrics?.delphiEventMap,
    delphiDataBindings: result.metrics?.delphiDataBindings,
    confidence: result.metrics?.confidence,
  };
}

function normalizeLegacyMetrics(metrics: ProjectAnalysisResult["metrics"] | null | undefined, counts: {
  files: number;
  symbols: number;
  dependencies: number;
  fields: number;
  fieldDependencies: number;
  risks: number;
  rules: number;
  warnings: number;
}) {
  return {
    fileCount: metrics?.fileCount ?? counts.files,
    eligibleFileCount: metrics?.eligibleFileCount ?? counts.files,
    analyzedFileCount: metrics?.analyzedFileCount ?? counts.files,
    skippedFileCount: metrics?.skippedFileCount ?? 0,
    heuristicFileCount: metrics?.heuristicFileCount ?? 0,
    degradedFileCount: metrics?.degradedFileCount ?? 0,
    symbolCount: metrics?.symbolCount ?? counts.symbols,
    dependencyCount: metrics?.dependencyCount ?? counts.dependencies,
    fieldCount: metrics?.fieldCount ?? counts.fields,
    fieldDependencyCount: metrics?.fieldDependencyCount ?? counts.fieldDependencies,
    riskCount: metrics?.riskCount ?? counts.risks,
    ruleCount: metrics?.ruleCount ?? counts.rules,
    warningCount: metrics?.warningCount ?? counts.warnings,
    delphiEventMap: metrics?.delphiEventMap,
    delphiDataBindings: metrics?.delphiDataBindings,
    confidence: metrics?.confidence,
  };
}

export function parseAnalysisSnapshot(snapshotJson: string | null | undefined) {
  if (!snapshotJson) {
    return { snapshot: null, warning: "This legacy run does not have a persisted snapshot yet." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(snapshotJson);
  } catch {
    return { snapshot: null, warning: "Persisted snapshot JSON is invalid." };
  }
  const schemaVersion = typeof raw === "object" && raw ? (raw as { schemaVersion?: unknown }).schemaVersion : null;
  if (schemaVersion !== 1) {
    return { snapshot: null, warning: `Snapshot schema version ${String(schemaVersion)} is not supported by this Legacy Lens build.` };
  }
  const parsed = analysisRunSnapshotV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { snapshot: null, warning: "Persisted snapshot failed strict validation." };
  }
  return { snapshot: parsed.data, warning: null };
}

export function parseAnalysisSnapshotStrict(snapshotJson: string | null | undefined) {
  if (!snapshotJson) {
    throw new AppError("REPORT_NOT_READY", "Historical report snapshot is missing for the selected run.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(snapshotJson);
  } catch {
    throw new AppError("REPORT_NOT_READY", "Historical report snapshot JSON is invalid for the selected run.");
  }

  const schemaVersion = typeof raw === "object" && raw ? (raw as { schemaVersion?: unknown }).schemaVersion : null;
  if (schemaVersion !== 1) {
    throw new AppError("UNSUPPORTED_SNAPSHOT_VERSION", `Snapshot schema version ${String(schemaVersion)} is not supported by this Legacy Lens build.`);
  }

  const parsed = analysisRunSnapshotV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("REPORT_NOT_READY", "Historical report snapshot failed strict validation for the selected run.");
  }

  return parsed.data;
}

export function buildAnalysisRunSnapshot(
  projectFiles: ProjectFileRecord[],
  result: ProjectAnalysisResult,
  projectContext?: AnalysisRunProjectContext
): { snapshot: AnalysisRunSnapshotV1; sourceFingerprint: string; snapshotJson: string } {
  const manifest = sourceManifest(projectFiles);
  const snapshot: AnalysisRunSnapshotV1 = {
    schemaVersion: 1,
    projectContext,
    sourceManifest: manifest,
    metrics: normalizeMetrics(result),
    warnings: sortByJson(result.warnings ?? []),
    symbols: sortByJson((result.symbols ?? []).map((symbol) => ({ ...symbol, file: normalizePath(symbol.file) }))),
    dependencies: sortByJson(result.dependencies ?? []),
    fields: sortByJson((result.schemaFields ?? []).map((field) => ({ ...field, file: normalizePath(field.file), line: field.line ?? 0 }))),
    fieldDependencies: sortByJson((result.fieldReferences ?? []).map((reference) => ({ ...reference, file: normalizePath(reference.file), line: reference.line ?? 0 }))),
    risks: sortByJson((result.risks ?? []).map((risk) => ({ ...risk, sourceFile: normalizePath(risk.sourceFile) }))),
    rules: sortByJson((result.rules ?? []).map((rule) => ({ ...rule, sourceFile: rule.sourceFile ? normalizePath(rule.sourceFile) : undefined }))),
    delphiEventMap: sortByJson((result.delphiEventMap ?? []).map((entry) => ({ ...entry, filePath: normalizePath(entry.filePath), resolvedFile: entry.resolvedFile ? normalizePath(entry.resolvedFile) : null }))),
    delphiDataBindings: sortByJson((result.delphiDataBindings ?? []).map((binding) => ({ ...binding, sourceFile: normalizePath(binding.sourceFile) }))),
    sqlStatements: sortByJson(result.sqlStatements ?? []),
    buildDoctor: delphiBuildDoctorResultSchema.parse(result.buildDoctor ?? { status: "not_applicable", score: 100, compilerFamily: { value: null, confidence: "low", evidence: [] }, projectEntries: [], configurations: [], platforms: [], defines: [], searchPaths: [], includePaths: [], outputPaths: [], runtimePackages: [], requiredPackages: [], packageResolutions: [], requiredUnits: [], missingUnits: [], unresolvedUnits: [], missingPackages: [], externalDependencies: [], findings: [], limitations: [] }),
    flowTraces: sortByJson(result.flowTraces ?? []),
    flowTraceSummary: result.flowTraceSummary ?? { candidateTraceCount: result.flowTraces?.length ?? 0, persistedTraceCount: result.flowTraces?.length ?? 0, globalTruncated: false },
  };
  const snapshotJson = serializeSnapshot(snapshot);
  return { snapshot, sourceFingerprint: calculateSourceFingerprint(projectFiles), snapshotJson };
}

export async function allocateNextRunNumber(db: DbHandle, projectId: number) {
  const rows = await db.select({ runNumber: analysisResults.runNumber }).from(analysisResults).where(eq(analysisResults.projectId, projectId));
  return rows.reduce((max, row) => Math.max(max, Number(row.runNumber ?? 0)), 0) + 1;
}

async function getBaselineId(db: DbHandle, projectId: number) {
  const [baseline] = await db.select().from(analysisBaselines).where(eq(analysisBaselines.projectId, projectId)).limit(1);
  return baseline?.analysisResultId ?? null;
}

export async function getLatestUsableAnalysisRun(db: DbHandle, projectId: number) {
  const [report] = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.projectId, projectId), inArray(analysisResults.status, [...USABLE_STATUSES])))
    .orderBy(desc(analysisResults.runNumber), desc(analysisResults.createdAt), desc(analysisResults.id))
    .limit(1);
  return report ?? null;
}

export async function ensureProjectSourceFingerprint(db: DbHandle, projectId: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
  }
  if (project.sourceFingerprint) {
    return project.sourceFingerprint;
  }

  const fileRows = await db.select().from(files).where(eq(files.projectId, projectId));
  if (fileRows.length === 0) {
    return null;
  }
  const fingerprint = calculateSourceFingerprint(fileRows);
  await db.update(projects).set({ sourceFingerprint: fingerprint, updatedAt: new Date() }).where(eq(projects.id, projectId));
  return fingerprint;
}

export async function getLatestUsableCurrentSourceRun(db: DbHandle, projectId: number) {
  const sourceFingerprint = await ensureProjectSourceFingerprint(db, projectId);
  if (!sourceFingerprint) {
    return null;
  }
  const [report] = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.projectId, projectId), eq(analysisResults.sourceFingerprint, sourceFingerprint), inArray(analysisResults.status, [...USABLE_STATUSES])))
    .orderBy(desc(analysisResults.runNumber), desc(analysisResults.createdAt), desc(analysisResults.id))
    .limit(1);
  return report ?? null;
}

async function getUsableRunById(db: DbHandle, projectId: number, runId: number) {
  const [run] = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.projectId, projectId), eq(analysisResults.id, runId)))
    .limit(1);
  if (!run) {
    throw new AppError("PROJECT_NOT_FOUND", "Analysis run not found for this project.");
  }
  if (!isUsableStatus(run.status)) {
    throw new AppError("REPORT_NOT_READY", "Historical analysis artifacts are only available for usable immutable runs.");
  }
  return run;
}

function toSummary(report: typeof analysisResults.$inferSelect, baselineId: number | null, latestUsableId: number | null): AnalysisRunSummary {
  const metrics = report.summaryJson;
  return {
    id: report.id,
    projectId: report.projectId,
    runNumber: Number(report.runNumber ?? 1),
    status: report.status,
    createdAt: report.createdAt instanceof Date ? report.createdAt : new Date(String(report.createdAt)),
    completedAt: report.completedAt ? (report.completedAt instanceof Date ? report.completedAt : new Date(String(report.completedAt))) : null,
    jobId: report.jobId ?? null,
    sourceFingerprint: report.sourceFingerprint ?? null,
    analyzerVersion: report.analyzerVersion ?? "legacy",
    metricsSummary: {
      files: metrics?.fileCount ?? 0,
      symbols: metrics?.symbolCount ?? 0,
      risks: metrics?.riskCount ?? 0,
      rules: metrics?.ruleCount ?? 0,
    },
    confidence: metrics?.confidence ?? null,
    warningCount: report.warningsJson?.length ?? metrics?.warningCount ?? 0,
    riskCount: metrics?.riskCount ?? 0,
    isBaseline: report.id === baselineId,
    isLatestUsable: report.id === latestUsableId,
  };
}

export async function materializeLegacySnapshotIfMissing(db: DbHandle, projectId: number, runId?: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
  }

  const candidates = await db
    .select()
    .from(analysisResults)
    .where(runId ? and(eq(analysisResults.projectId, projectId), eq(analysisResults.id, runId)) : eq(analysisResults.projectId, projectId))
    .orderBy(asc(analysisResults.runNumber), asc(analysisResults.id));
  const usableLegacyRows = candidates.filter((row) => isUsableStatus(row.status));
  const missingSnapshots = usableLegacyRows.filter((row) => !row.snapshotJson);
  if (missingSnapshots.length === 0) return null;
  let legacy = missingSnapshots[0];
  if (missingSnapshots.length > 1) {
    const currentSourceMissing = missingSnapshots.filter((row) => row.sourceFingerprint && row.sourceFingerprint === project.sourceFingerprint);
    if (!runId && currentSourceMissing.length === 1) {
      legacy = currentSourceMissing[0];
    } else if (runId && currentSourceMissing.length === 1 && currentSourceMissing[0].id === runId) {
      legacy = currentSourceMissing[0];
    } else {
      throw new AppError(
        "REPORT_NOT_READY",
        "Historical snapshots cannot be reconstructed safely because multiple usable legacy runs are missing immutable snapshots."
      );
    }
  }

  const [fileRows, symbolRows, dependencyRows, fieldRows, fieldDependencyRows, riskRows, ruleRows] = await Promise.all([
    db.select().from(files).where(eq(files.projectId, projectId)),
    db.select().from(symbols).where(eq(symbols.projectId, projectId)),
    db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),
    db.select().from(fields).where(eq(fields.projectId, projectId)),
    db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, projectId)),
    db.select().from(risks).where(eq(risks.projectId, projectId)),
    db.select().from(rules).where(eq(rules.projectId, projectId)),
  ]);
  const filePathById = new Map(fileRows.map((file) => [file.id, normalizePath(file.filePath)]));
  const symbolStableById = new Map<number, string>();
  const snapshotSymbols = symbolRows.map((symbol) => {
    const metadata = symbol.metadata as { stableKey?: string; qualifiedName?: string } | null;
    const stableKey = metadata?.stableKey ?? `${filePathById.get(symbol.fileId) ?? "unknown"}::${symbol.name}::${symbol.startLine}`;
    symbolStableById.set(symbol.id, stableKey);
    return {
      stableKey,
      name: symbol.name,
      qualifiedName: metadata?.qualifiedName ?? symbol.name,
      type: symbol.type,
      file: filePathById.get(symbol.fileId) ?? "unknown",
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      signature: symbol.signature ?? undefined,
      description: symbol.description ?? undefined,
    };
  });
  const fieldById = new Map(fieldRows.map((field) => [field.id, field]));
  const snapshot: AnalysisRunSnapshotV1 = {
    schemaVersion: 1,
    projectContext: {
      projectName: project.name ?? "unknown",
      sourceType: project.sourceType ?? "unknown",
      focusLanguage: project.language ?? null,
      importWarnings: project.importWarningsJson ?? [],
    },
    sourceManifest: sourceManifest(fileRows),
    metrics: normalizeLegacyMetrics(legacy.summaryJson, {
      files: fileRows.length,
      symbols: symbolRows.length,
      dependencies: dependencyRows.length,
      fields: fieldRows.length,
      fieldDependencies: fieldDependencyRows.length,
      risks: riskRows.length,
      rules: ruleRows.length,
      warnings: legacy.warningsJson?.length ?? 0,
    }),
    warnings: legacy.warningsJson ?? [],
    symbols: sortByJson(snapshotSymbols),
    dependencies: sortByJson(dependencyRows.map((dependency) => ({
      from: symbolStableById.get(dependency.sourceSymbolId) ?? `symbol:${dependency.sourceSymbolId}`,
      to: dependency.targetSymbolId ? symbolStableById.get(dependency.targetSymbolId) : undefined,
      fromName: symbolRows.find((symbol) => symbol.id === dependency.sourceSymbolId)?.name ?? `symbol:${dependency.sourceSymbolId}`,
      toName: dependency.targetExternalName ?? (dependency.targetSymbolId ? symbolRows.find((symbol) => symbol.id === dependency.targetSymbolId)?.name : null) ?? "unknown",
      targetKind: dependency.targetKind,
      type: dependency.dependencyType,
      line: dependency.lineNumber ?? 0,
    }))),
    fields: sortByJson(fieldRows.map((field) => ({ table: field.tableName, field: field.fieldName, fieldType: field.fieldType ?? undefined, file: "legacy-projection", line: 0 }))),
    fieldDependencies: sortByJson(fieldDependencyRows.map((dependency) => {
      const field = fieldById.get(dependency.fieldId);
      return {
        table: field?.tableName ?? "unknown",
        field: field?.fieldName ?? "unknown",
        type: dependency.operationType,
        file: "legacy-projection",
        line: dependency.lineNumber ?? 0,
        symbolStableKey: symbolStableById.get(dependency.symbolId),
        context: dependency.context ?? undefined,
      };
    })),
    risks: sortByJson(riskRows.map((risk) => ({
      title: risk.title,
      description: risk.description ?? "",
      severity: risk.severity,
      category: risk.riskType,
      sourceFile: risk.sourceFile ?? "unknown",
      lineNumber: risk.lineNumber ?? 0,
      suggestion: risk.recommendation ?? undefined,
      codeSnippet: risk.codeSnippet ?? undefined,
    }))),
    rules: sortByJson(ruleRows.map((rule) => ({
      ruleType: rule.ruleType,
      name: rule.name,
      description: rule.description ?? "",
      condition: rule.condition ?? undefined,
      sourceFile: rule.sourceFile ?? undefined,
      lineNumber: rule.lineNumber ?? undefined,
    }))),
    delphiEventMap: legacy.summaryJson?.delphiEventMap ?? [],
    delphiDataBindings: legacy.summaryJson?.delphiDataBindings ?? [],
    sqlStatements: [],
    buildDoctor: { status: "not_applicable", score: 100, compilerFamily: { value: null, confidence: "low", evidence: [] }, projectEntries: [], configurations: [], platforms: [], defines: [], searchPaths: [], includePaths: [], outputPaths: [], runtimePackages: [], requiredPackages: [], packageResolutions: [], requiredUnits: [], missingUnits: [], unresolvedUnits: [], missingPackages: [], externalDependencies: [], findings: [], limitations: ["Legacy snapshot was backfilled from projection tables; Build Doctor was not available for the original run."] },
    flowTraces: [],
    flowTraceSummary: { candidateTraceCount: 0, persistedTraceCount: 0, globalTruncated: false },
  };
  const snapshotJson = serializeSnapshot(snapshot);
  await db.update(analysisResults).set({
    runNumber: legacy.runNumber ?? 1,
    analyzerVersion: legacy.analyzerVersion ?? "legacy-backfill",
    sourceFingerprint: legacy.sourceFingerprint ?? calculateSourceFingerprint(fileRows),
    snapshotSchemaVersion: 1,
    snapshotJson,
    completedAt: legacy.completedAt ?? legacy.updatedAt ?? legacy.createdAt,
  }).where(eq(analysisResults.id, legacy.id));
  return snapshot;
}

export async function listAnalysisRuns(db: DbHandle, projectId: number, page: number, pageSize: number) {
  await materializeLegacySnapshotIfMissing(db, projectId);
  const offset = (page - 1) * pageSize;
  const usableCondition = and(eq(analysisResults.projectId, projectId), inArray(analysisResults.status, [...USABLE_STATUSES]));
  const [totalRow] = await db.select({ value: count() }).from(analysisResults).where(usableCondition);
  const rows = await db.select().from(analysisResults).where(usableCondition).orderBy(desc(analysisResults.runNumber), desc(analysisResults.id)).limit(pageSize).offset(offset);
  const baselineId = await getBaselineId(db, projectId);
  const latest = await getLatestUsableCurrentSourceRun(db, projectId);
  return {
    items: rows.map((row) => toSummary(row, baselineId, latest?.id ?? null)),
    total: Number(totalRow?.value ?? 0),
    page,
    pageSize,
    pageCount: Math.ceil(Number(totalRow?.value ?? 0) / pageSize),
  };
}

export async function getAnalysisRunDetail(db: DbHandle, projectId: number, runId: number): Promise<AnalysisRunDetail> {
  await materializeLegacySnapshotIfMissing(db, projectId, runId);
  const report = await getUsableRunById(db, projectId, runId);
  const baselineId = await getBaselineId(db, projectId);
  const latest = await getLatestUsableCurrentSourceRun(db, projectId);
  const parsed = parseAnalysisSnapshot(report.snapshotJson);
  return {
    ...toSummary(report, baselineId, latest?.id ?? null),
    report: mapSnapshotReport(report),
    snapshot: parsed.snapshot,
    snapshotWarning: parsed.warning,
  };
}

export async function setAnalysisBaseline(db: DbHandle, projectId: number, runId: number) {
  await getUsableRunById(db, projectId, runId);
  const [existing] = await db.select().from(analysisBaselines).where(eq(analysisBaselines.projectId, projectId)).limit(1);
  if (existing) {
    await db.update(analysisBaselines).set({ analysisResultId: runId, updatedAt: new Date() }).where(eq(analysisBaselines.projectId, projectId));
  } else {
    await db.insert(analysisBaselines).values({ projectId, analysisResultId: runId });
  }
  return { success: true as const };
}

export async function clearAnalysisBaseline(db: DbHandle, projectId: number) {
  await db.delete(analysisBaselines).where(eq(analysisBaselines.projectId, projectId));
  return { success: true as const };
}

function bucket<T>(items: T[]) {
  const filtered = items.filter((item): item is T => item !== undefined);
  return { items: filtered.slice(0, DIFF_LIMIT), total: filtered.length, displayed: Math.min(filtered.length, DIFF_LIMIT), truncated: filtered.length > DIFF_LIMIT };
}

function keyed<T>(items: T[], key: (item: T) => string) {
  return new Map(items.map((item) => [key(item), item]));
}

function diffEntries<T>(base: Map<string, T>, compare: Map<string, T>) {
  const keys = Array.from(new Set([...base.keys(), ...compare.keys()])).sort((left, right) => left.localeCompare(right));
  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<{ key: string; before: T; after: T }> = [];

  for (const key of keys) {
    const before = base.get(key);
    const after = compare.get(key);
    if (before && !after) {
      removed.push(before);
      continue;
    }
    if (!before && after) {
      added.push(after);
      continue;
    }
    if (before && after && stableJson(before) !== stableJson(after)) {
      changed.push({ key, before, after });
    }
  }

  return { added, removed, changed };
}

function riskKey(item: AnalysisRunSnapshotV1["risks"][number]) {
  return `${item.category}:${item.title.toLowerCase()}:${normalizePath(item.sourceFile).toLowerCase()}`;
}

function ruleKey(item: AnalysisRunSnapshotV1["rules"][number]) {
  return `${item.ruleType}:${item.name.toLowerCase()}:${normalizePath(item.sourceFile ?? "").toLowerCase()}`;
}

function fieldKey(item: AnalysisRunSnapshotV1["fields"][number]) {
  return `${normalize(item.table)}:${normalize(item.field)}`;
}

function fileKey(item: AnalysisRunSnapshotV1["sourceManifest"][number]) {
  return normalizePath(item.path).toLowerCase();
}

function dependencyKey(item: AnalysisRunSnapshotV1["dependencies"][number]) {
  return `${item.from}:${item.to ?? item.toName}:${item.type}:${item.line}`;
}

function eventKey(item: AnalysisRunSnapshotV1["delphiEventMap"][number]) {
  return `${normalize(item.formName)}:${normalize(item.componentName)}:${normalize(item.eventName)}`;
}

function bindingKey(item: AnalysisRunSnapshotV1["delphiDataBindings"][number]) {
  return `${normalize(item.formName)}:${normalize(item.componentName)}:${normalize(item.dataField ?? "")}:${normalize(item.dataSet ?? "")}`;
}

function buildDoctorFindingKey(item: AnalysisRunSnapshotV1["buildDoctor"]["findings"][number]) {
  return `${item.code}:${normalize(item.title)}:${normalizePath(item.sourceFile ?? "")}:${item.lineNumber ?? 0}:${normalize(item.rawValue ?? item.evidence ?? "")}`;
}

function flowTraceKey(item: AnalysisRunSnapshotV1["flowTraces"][number]) {
  return item.stableKey;
}

function fieldDependencyKey(item: AnalysisRunSnapshotV1["fieldDependencies"][number]) {
  const symbolIdentity = normalize(item.symbolStableKey ?? item.symbolName ?? "unknown");
  return [
    normalize(item.table),
    normalize(item.field),
    symbolIdentity,
    normalize(item.type),
    normalizePath(item.file).toLowerCase(),
  ].join(":");
}

async function getComparableRunDetail(db: DbHandle, projectId: number, runId: number) {
  const [run] = await db.select().from(analysisResults).where(eq(analysisResults.id, runId)).limit(1);
  if (!run) {
    throw new AppError("PROJECT_NOT_FOUND", "Analysis run not found.");
  }
  if (run.projectId !== projectId) {
    throw new AppError("PROJECT_NOT_FOUND", "Analysis runs from another project cannot be compared here.");
  }
  if (!isUsableStatus(run.status)) {
    throw new AppError("REPORT_NOT_READY", "Historical analysis artifacts are only available for usable immutable runs.");
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
  }

  const baselineId = await getBaselineId(db, projectId);
  const latest = await getLatestUsableCurrentSourceRun(db, projectId);
  return {
    summary: toSummary(run, baselineId, latest?.id ?? null),
    snapshot: parseAnalysisSnapshotStrict(run.snapshotJson),
  };
}

export async function getAnalysisDiff(db: DbHandle, projectId: number, baseRunId: number, compareRunId: number): Promise<AnalysisDiff> {
  if (baseRunId === compareRunId) {
    throw new AppError("REPORT_NOT_READY", "An analysis run cannot be compared with itself.");
  }

  const [base, compare] = await Promise.all([getComparableRunDetail(db, projectId, baseRunId), getComparableRunDetail(db, projectId, compareRunId)]);
  if (base.snapshot.schemaVersion !== ANALYSIS_SNAPSHOT_SCHEMA_VERSION || compare.snapshot.schemaVersion !== ANALYSIS_SNAPSHOT_SCHEMA_VERSION) {
    throw new AppError("UNSUPPORTED_SNAPSHOT_VERSION", "Only immutable snapshot schema version 1 can be compared.");
  }

  const baseSnapshot = base.snapshot;
  const compareSnapshot = compare.snapshot;
  const fileDiff = diffEntries(keyed(baseSnapshot.sourceManifest, fileKey), keyed(compareSnapshot.sourceManifest, fileKey));
  const symbolDiff = diffEntries(keyed(baseSnapshot.symbols, (item) => item.stableKey), keyed(compareSnapshot.symbols, (item) => item.stableKey));
  const dependencyDiff = diffEntries(keyed(baseSnapshot.dependencies, dependencyKey), keyed(compareSnapshot.dependencies, dependencyKey));
  const fieldDiff = diffEntries(keyed(baseSnapshot.fields, fieldKey), keyed(compareSnapshot.fields, fieldKey));
  const fieldDependencyDiff = diffEntries(keyed(baseSnapshot.fieldDependencies, fieldDependencyKey), keyed(compareSnapshot.fieldDependencies, fieldDependencyKey));
  const riskDiff = diffEntries(keyed(baseSnapshot.risks, riskKey), keyed(compareSnapshot.risks, riskKey));
  const ruleDiff = diffEntries(keyed(baseSnapshot.rules, ruleKey), keyed(compareSnapshot.rules, ruleKey));
  const eventDiff = diffEntries(keyed(baseSnapshot.delphiEventMap, eventKey), keyed(compareSnapshot.delphiEventMap, eventKey));
  const bindingDiff = diffEntries(keyed(baseSnapshot.delphiDataBindings, bindingKey), keyed(compareSnapshot.delphiDataBindings, bindingKey));
  const buildDiff = diffEntries(keyed(baseSnapshot.buildDoctor.findings, buildDoctorFindingKey), keyed(compareSnapshot.buildDoctor.findings, buildDoctorFindingKey));
  const flowDiff = diffEntries(keyed(baseSnapshot.flowTraces, flowTraceKey), keyed(compareSnapshot.flowTraces, flowTraceKey));
  const metricsDelta = Object.fromEntries(
    ANALYSIS_DIFF_METRIC_KEYS.map((key) => [key, Number(compareSnapshot.metrics[key] ?? 0) - Number(baseSnapshot.metrics[key] ?? 0)])
  );

  const result = {
    baseRun: base.summary,
    compareRun: compare.summary,
    metricsDelta,
    files: { added: bucket(fileDiff.added), removed: bucket(fileDiff.removed), changed: bucket(fileDiff.changed) },
    symbols: { added: bucket(symbolDiff.added), removed: bucket(symbolDiff.removed) },
    dependencies: { added: bucket(dependencyDiff.added), removed: bucket(dependencyDiff.removed) },
    fields: { added: bucket(fieldDiff.added), removed: bucket(fieldDiff.removed), changed: bucket(fieldDiff.changed) },
    fieldDependencies: { introduced: bucket(fieldDependencyDiff.added), removed: bucket(fieldDependencyDiff.removed), changed: bucket(fieldDependencyDiff.changed) },
    risks: { introduced: bucket(riskDiff.added), resolved: bucket(riskDiff.removed), changed: bucket(riskDiff.changed) },
    rules: { introduced: bucket(ruleDiff.added), resolved: bucket(ruleDiff.removed), changed: bucket(ruleDiff.changed) },
    delphiEvents: { introduced: bucket(eventDiff.added), removed: bucket(eventDiff.removed), resolutionChanged: bucket(eventDiff.changed) },
    dataBindings: { introduced: bucket(bindingDiff.added), removed: bucket(bindingDiff.removed), changed: bucket(bindingDiff.changed) },
    buildDoctor: { introduced: bucket(buildDiff.added), resolved: bucket(buildDiff.removed), changed: bucket(buildDiff.changed), scoreDelta: compareSnapshot.buildDoctor.score - baseSnapshot.buildDoctor.score },
    flowTraces: { introduced: bucket(flowDiff.added), removed: bucket(flowDiff.removed), changed: bucket(flowDiff.changed) },
    truncated: false,
  };
  result.truncated = [
    result.files.added,
    result.files.removed,
    result.files.changed,
    result.symbols.added,
    result.symbols.removed,
    result.dependencies.added,
    result.dependencies.removed,
    result.fields.added,
    result.fields.removed,
    result.fields.changed,
    result.fieldDependencies.introduced,
    result.fieldDependencies.removed,
    result.fieldDependencies.changed,
    result.risks.introduced,
    result.risks.resolved,
    result.risks.changed,
    result.rules.introduced,
    result.rules.resolved,
    result.rules.changed,
    result.delphiEvents.introduced,
    result.delphiEvents.removed,
    result.delphiEvents.resolutionChanged,
    result.dataBindings.introduced,
    result.dataBindings.removed,
    result.dataBindings.changed,
    result.buildDoctor.introduced,
    result.buildDoctor.resolved,
    result.buildDoctor.changed,
    result.flowTraces.introduced,
    result.flowTraces.removed,
    result.flowTraces.changed,
  ].some((entry) => entry.truncated)
    || baseSnapshot.flowTraceSummary.globalTruncated
    || compareSnapshot.flowTraceSummary.globalTruncated;
  return analysisDiffSchema.parse(result);
}

export async function getFlowTracesFromRun(db: DbHandle, projectId: number, runId?: number) {
  const run = runId ? await getAnalysisRunDetail(db, projectId, runId) : await getLatestUsableCurrentSourceRun(db, projectId).then(async (latest) => {
    if (!latest) throw new AppError("REPORT_NOT_READY", "No usable analysis run exists for this project.");
    return getAnalysisRunDetail(db, projectId, latest.id);
  });
  return run.snapshot?.flowTraces ?? [];
}

export async function getStrictSnapshotRunDetail(db: DbHandle, projectId: number, runId: number) {
  await materializeLegacySnapshotIfMissing(db, projectId, runId);
  const report = await getUsableRunById(db, projectId, runId);
  const snapshot = parseAnalysisSnapshotStrict(report.snapshotJson);
  return {
    report,
    snapshot,
    projectContext: getProjectContextOrLegacyDefault(snapshot),
  };
}

export function filterFlowTraces(traces: DelphiFlowTrace[], input: {
  search?: string;
  form?: string;
  component?: string;
  event?: string;
  status?: "complete" | "partial" | "unresolved";
  table?: string;
  operation?: "read" | "write" | "calculate" | "unknown";
  confidence?: "high" | "medium" | "low";
}) {
  const search = normalize(input.search);
  return traces.filter((trace) => {
    if (search && !stableJson(trace).toLowerCase().includes(search)) return false;
    if (input.form && normalize(trace.formName) !== normalize(input.form)) return false;
    if (input.component && normalize(trace.componentName) !== normalize(input.component)) return false;
    if (input.event && normalize(trace.eventName) !== normalize(input.event)) return false;
    if (input.status && trace.status !== input.status) return false;
    if (input.confidence && trace.confidence !== input.confidence) return false;
    if (input.table && !trace.affectedTables.some((table) => normalize(table) === normalize(input.table))) return false;
    if (input.operation && !trace.affectedFields.some((field) => field.operation === input.operation)) return false;
    return true;
  });
}
