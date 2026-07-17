import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type {
  AnalysisDiff,
  AnalysisRunDetail,
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
} from "../../drizzle/schema";
import type { ProjectAnalysisResult } from "../analyzer/types";
import type { DatabaseClient } from "../dbTypes";
import { AppError } from "../appError";
import { mapSnapshotReport } from "./projectWorkflow.helpers";

export const ANALYSIS_SNAPSHOT_SCHEMA_VERSION = 1;
export const ANALYZER_VERSION = "1.1.0-rc1";
export const MAX_SNAPSHOT_BYTES = 15 * 1024 * 1024;
const DIFF_LIMIT = 200;
const USABLE_STATUSES = ["completed", "completed_with_warnings", "partial"] as const;

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;
type ProjectFileRecord = { id?: number | null; filePath: string; fileType?: string | null; lineCount?: number | null; content?: string | null };

function normalizePath(value: string | null | undefined) {
  return (value ?? "unknown").replace(/\\/g, "/");
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sortByJson<T>(items: T[]) {
  return [...items].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function sourceManifest(projectFiles: ProjectFileRecord[]) {
  return projectFiles
    .map((file) => ({
      path: normalizePath(file.filePath),
      fileType: file.fileType ?? null,
      lineCount: file.lineCount ?? (file.content ? file.content.split(/\r?\n/).length : null),
      sha256: hash(file.content ?? ""),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function serializeSnapshot(snapshot: AnalysisRunSnapshotV1) {
  const parsed = analysisRunSnapshotV1Schema.parse(snapshot);
  const text = stableJson(parsed);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new AppError("ANALYSIS_PERSIST_FAILED", `Analysis snapshot is too large to persist (${bytes} bytes; limit ${MAX_SNAPSHOT_BYTES}).`);
  }
  return text;
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

export function buildAnalysisRunSnapshot(projectFiles: ProjectFileRecord[], result: ProjectAnalysisResult): { snapshot: AnalysisRunSnapshotV1; sourceFingerprint: string; snapshotJson: string } {
  const manifest = sourceManifest(projectFiles);
  const snapshot: AnalysisRunSnapshotV1 = {
    schemaVersion: 1,
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
    buildDoctor: delphiBuildDoctorResultSchema.parse(result.buildDoctor ?? { status: "not_applicable", score: 100, compilerFamily: { value: null, confidence: "low", evidence: [] }, projectEntries: [], configurations: [], platforms: [], defines: [], searchPaths: [], runtimePackages: [], requiredPackages: [], requiredUnits: [], missingUnits: [], unresolvedUnits: [], missingPackages: [], externalDependencies: [], findings: [], limitations: [] }),
    flowTraces: sortByJson(result.flowTraces ?? []),
  };
  const snapshotJson = serializeSnapshot(snapshot);
  return { snapshot, sourceFingerprint: hash(stableJson(manifest)), snapshotJson };
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
  const candidates = await db
    .select()
    .from(analysisResults)
    .where(runId ? and(eq(analysisResults.projectId, projectId), eq(analysisResults.id, runId)) : eq(analysisResults.projectId, projectId))
    .orderBy(asc(analysisResults.runNumber), asc(analysisResults.id));
  const legacy = candidates.find((row) => !row.snapshotJson && USABLE_STATUSES.includes(row.status as (typeof USABLE_STATUSES)[number]));
  if (!legacy) return null;

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
    buildDoctor: { status: "not_applicable", score: 100, compilerFamily: { value: null, confidence: "low", evidence: [] }, projectEntries: [], configurations: [], platforms: [], defines: [], searchPaths: [], runtimePackages: [], requiredPackages: [], requiredUnits: [], missingUnits: [], unresolvedUnits: [], missingPackages: [], externalDependencies: [], findings: [], limitations: ["Legacy snapshot was backfilled from projection tables; Build Doctor was not available for the original run."] },
    flowTraces: [],
  };
  const snapshotJson = serializeSnapshot(snapshot);
  await db.update(analysisResults).set({
    runNumber: legacy.runNumber ?? 1,
    analyzerVersion: legacy.analyzerVersion ?? "legacy-backfill",
    sourceFingerprint: legacy.sourceFingerprint ?? hash(stableJson(snapshot.sourceManifest)),
    snapshotSchemaVersion: 1,
    snapshotJson,
    completedAt: legacy.completedAt ?? legacy.updatedAt ?? legacy.createdAt,
  }).where(eq(analysisResults.id, legacy.id));
  return snapshot;
}

export async function listAnalysisRuns(db: DbHandle, projectId: number, page: number, pageSize: number) {
  await materializeLegacySnapshotIfMissing(db, projectId);
  const offset = (page - 1) * pageSize;
  const [totalRow] = await db.select({ value: count() }).from(analysisResults).where(eq(analysisResults.projectId, projectId));
  const rows = await db.select().from(analysisResults).where(eq(analysisResults.projectId, projectId)).orderBy(desc(analysisResults.runNumber), desc(analysisResults.id)).limit(pageSize).offset(offset);
  const baselineId = await getBaselineId(db, projectId);
  const latest = await getLatestUsableAnalysisRun(db, projectId);
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
  const [report] = await db.select().from(analysisResults).where(and(eq(analysisResults.projectId, projectId), eq(analysisResults.id, runId))).limit(1);
  if (!report) throw new AppError("PROJECT_NOT_FOUND", "Analysis run not found for this project.");
  const baselineId = await getBaselineId(db, projectId);
  const latest = await getLatestUsableAnalysisRun(db, projectId);
  const parsed = parseAnalysisSnapshot(report.snapshotJson);
  return {
    ...toSummary(report, baselineId, latest?.id ?? null),
    report: mapSnapshotReport(report),
    snapshot: parsed.snapshot,
    snapshotWarning: parsed.warning,
  };
}

export async function setAnalysisBaseline(db: DbHandle, projectId: number, runId: number) {
  const [run] = await db.select().from(analysisResults).where(and(eq(analysisResults.projectId, projectId), eq(analysisResults.id, runId))).limit(1);
  if (!run) throw new AppError("PROJECT_NOT_FOUND", "Analysis run not found for this project.");
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
  return { items: items.slice(0, DIFF_LIMIT), total: items.length, displayed: Math.min(items.length, DIFF_LIMIT), truncated: items.length > DIFF_LIMIT };
}

function keyed<T>(items: T[], key: (item: T) => string) {
  return new Map(items.map((item) => [key(item), item]));
}

function diffKeys<T>(base: Map<string, T>, compare: Map<string, T>) {
  const added = Array.from(compare.keys()).filter((key) => !base.has(key)).sort();
  const removed = Array.from(base.keys()).filter((key) => !compare.has(key)).sort();
  const changed = Array.from(compare.keys()).filter((key) => base.has(key) && stableJson(base.get(key)) !== stableJson(compare.get(key))).sort();
  return { added, removed, changed };
}

function riskKey(item: AnalysisRunSnapshotV1["risks"][number]) {
  return `${item.category}:${item.title.toLowerCase()}:${normalizePath(item.sourceFile).toLowerCase()}`;
}

function ruleKey(item: AnalysisRunSnapshotV1["rules"][number]) {
  return `${item.ruleType}:${item.name.toLowerCase()}:${normalizePath(item.sourceFile ?? "").toLowerCase()}`;
}

export async function getAnalysisDiff(db: DbHandle, projectId: number, baseRunId: number, compareRunId: number): Promise<AnalysisDiff> {
  const [base, compare] = await Promise.all([getAnalysisRunDetail(db, projectId, baseRunId), getAnalysisRunDetail(db, projectId, compareRunId)]);
  if (!base.snapshot || !compare.snapshot) throw new AppError("REPORT_NOT_READY", "Both analysis runs need a valid snapshot before they can be compared.");
  const baseSnapshot = base.snapshot;
  const compareSnapshot = compare.snapshot;
  const fileDiff = diffKeys(keyed(baseSnapshot.sourceManifest, (item) => item.path), keyed(compareSnapshot.sourceManifest, (item) => item.path));
  const symbolDiff = diffKeys(keyed(baseSnapshot.symbols, (item) => item.stableKey), keyed(compareSnapshot.symbols, (item) => item.stableKey));
  const dependencyDiff = diffKeys(keyed(baseSnapshot.dependencies, (item) => `${item.from}:${item.to ?? item.toName}:${item.type}`), keyed(compareSnapshot.dependencies, (item) => `${item.from}:${item.to ?? item.toName}:${item.type}`));
  const fieldDiff = diffKeys(keyed(baseSnapshot.fields, (item) => `${item.table}.${item.field}`.toLowerCase()), keyed(compareSnapshot.fields, (item) => `${item.table}.${item.field}`.toLowerCase()));
  const riskDiff = diffKeys(keyed(baseSnapshot.risks, riskKey), keyed(compareSnapshot.risks, riskKey));
  const ruleDiff = diffKeys(keyed(baseSnapshot.rules, ruleKey), keyed(compareSnapshot.rules, ruleKey));
  const eventDiff = diffKeys(keyed(baseSnapshot.delphiEventMap, (item) => `${item.formName}.${item.componentName}.${item.eventName}`.toLowerCase()), keyed(compareSnapshot.delphiEventMap, (item) => `${item.formName}.${item.componentName}.${item.eventName}`.toLowerCase()));
  const bindingDiff = diffKeys(keyed(baseSnapshot.delphiDataBindings, (item) => `${item.formName}.${item.componentName}.${item.dataField ?? ""}`.toLowerCase()), keyed(compareSnapshot.delphiDataBindings, (item) => `${item.formName}.${item.componentName}.${item.dataField ?? ""}`.toLowerCase()));
  const buildDiff = diffKeys(keyed(baseSnapshot.buildDoctor.findings, (item) => `${item.code}:${item.evidence ?? item.title}`.toLowerCase()), keyed(compareSnapshot.buildDoctor.findings, (item) => `${item.code}:${item.evidence ?? item.title}`.toLowerCase()));
  const flowDiff = diffKeys(keyed(baseSnapshot.flowTraces, (item) => item.stableKey), keyed(compareSnapshot.flowTraces, (item) => item.stableKey));
  const metricsDelta = Object.fromEntries(["fileCount", "symbolCount", "dependencyCount", "fieldCount", "riskCount", "ruleCount", "warningCount"].map((key) => [key, Number(compareSnapshot.metrics[key as keyof typeof compareSnapshot.metrics] ?? 0) - Number(baseSnapshot.metrics[key as keyof typeof baseSnapshot.metrics] ?? 0)]));
  const result = {
    baseRun: base,
    compareRun: compare,
    metricsDelta,
    files: { added: bucket(fileDiff.added), removed: bucket(fileDiff.removed), changed: bucket(fileDiff.changed) },
    symbols: { added: bucket(symbolDiff.added), removed: bucket(symbolDiff.removed) },
    dependencies: { added: bucket(dependencyDiff.added), removed: bucket(dependencyDiff.removed) },
    fields: { added: bucket(fieldDiff.added), removed: bucket(fieldDiff.removed), changed: bucket(fieldDiff.changed) },
    risks: { introduced: bucket(riskDiff.added.map((key) => keyed(compareSnapshot.risks, riskKey).get(key))), resolved: bucket(riskDiff.removed.map((key) => keyed(baseSnapshot.risks, riskKey).get(key))), changed: bucket(riskDiff.changed) },
    rules: { introduced: bucket(ruleDiff.added.map((key) => keyed(compareSnapshot.rules, ruleKey).get(key))), resolved: bucket(ruleDiff.removed.map((key) => keyed(baseSnapshot.rules, ruleKey).get(key))), changed: bucket(ruleDiff.changed) },
    delphiEvents: { introduced: bucket(eventDiff.added), removed: bucket(eventDiff.removed), resolutionChanged: bucket(eventDiff.changed) },
    dataBindings: { introduced: bucket(bindingDiff.added), removed: bucket(bindingDiff.removed), changed: bucket(bindingDiff.changed) },
    buildDoctor: { introduced: bucket(buildDiff.added), resolved: bucket(buildDiff.removed), changed: bucket(buildDiff.changed), scoreDelta: compareSnapshot.buildDoctor.score - baseSnapshot.buildDoctor.score },
    flowTraces: { introduced: bucket(flowDiff.added), removed: bucket(flowDiff.removed), changed: bucket(flowDiff.changed) },
    truncated: false,
  };
  result.truncated = stableJson(result).includes('"truncated":true');
  return analysisDiffSchema.parse(result);
}

export async function getFlowTracesFromRun(db: DbHandle, projectId: number, runId?: number) {
  const run = runId ? await getAnalysisRunDetail(db, projectId, runId) : await getLatestUsableAnalysisRun(db, projectId).then(async (latest) => {
    if (!latest) throw new AppError("REPORT_NOT_READY", "No usable analysis run exists for this project.");
    return getAnalysisRunDetail(db, projectId, latest.id);
  });
  return run.snapshot?.flowTraces ?? [];
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
