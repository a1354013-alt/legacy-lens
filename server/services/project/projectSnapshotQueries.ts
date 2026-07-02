import { asc, count, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  AnalysisSnapshot,
  DependencyListItem,
} from "../../../shared/contracts";
import {
  analysisResults,
  dependencies,
  fieldDependencies,
  fields,
  files,
  risks,
  rules,
  symbols,
  projects,
} from "../../../drizzle/schema";
import type { DatabaseClient } from "../../dbTypes";
import {
  buildDependencySummary,
  groupRisks,
  groupRules,
  summarizeAffectedFiles,
  summarizePartialReasons,
  summarizeWarnings,
} from "../analysisPresentation";
import {
  mapSnapshotReport,
  sortFieldDependencies,
  sortProjectFields,
  sortProjectRisks,
  sortProjectRules,
  sortProjectSymbols,
} from "../projectWorkflow.helpers";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;

export type ProjectSnapshotQueryDeps = {
  requireDb: () => Promise<DbHandle>;
  getOwnedProject: (
    projectId: number,
    userId: number
  ) => Promise<typeof projects.$inferSelect>;
  getProjectAnalysisRecord: (
    db: DbHandle,
    projectId: number
  ) => Promise<typeof analysisResults.$inferSelect | null>;
};

function isInMemoryDb(
  db: DbHandle
): db is DbHandle & { store: Record<string, Array<Record<string, unknown>>> } {
  return typeof db === "object" && db !== null && "store" in db;
}

function buildDependencyListItems(
  dependencyRows: Array<typeof dependencies.$inferSelect>,

  symbolById: Map<number, { name?: string | null } | string>
): DependencyListItem[] {
  return dependencyRows.map(row => {
    const sourceSymbol = symbolById.get(row.sourceSymbolId);

    const targetSymbol = row.targetSymbolId
      ? symbolById.get(row.targetSymbolId)
      : null;

    const sourceSymbolName =
      typeof sourceSymbol === "string"
        ? sourceSymbol
        : (sourceSymbol?.name ?? `symbol:${row.sourceSymbolId}`);

    const targetSymbolName =
      typeof targetSymbol === "string"
        ? targetSymbol
        : (targetSymbol?.name ?? null);

    return {
      id: row.id,

      sourceSymbolId: row.sourceSymbolId,

      sourceSymbolName,

      targetSymbolId: row.targetSymbolId ?? null,

      targetSymbolName,

      targetExternalName: row.targetExternalName ?? null,

      targetKind: row.targetKind,

      dependencyType: row.dependencyType,

      lineNumber: row.lineNumber ?? null,
    };
  });
}

async function countRows(
  db: DbHandle,
  table:
    | typeof files
    | typeof symbols
    | typeof dependencies
    | typeof fields
    | typeof fieldDependencies
    | typeof risks
    | typeof rules,
  condition: SQL
) {
  const [row] = await db
    .select({ value: count() })
    .from(table)
    .where(condition);
  return Number(row?.value ?? 0);
}

function buildFieldUsageSummary(
  rows: Array<typeof fieldDependencies.$inferSelect>
) {
  const fieldUsageById = new Map<
    number,
    { readCount: number; writeCount: number; referenceCount: number }
  >();

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

export async function getAnalysisSnapshotImpl(
  deps: ProjectSnapshotQueryDeps,
  projectId: number,
  userId: number
): Promise<AnalysisSnapshot> {
  const project = await deps.getOwnedProject(projectId, userId);

  const db = await deps.requireDb();

  const report = await deps.getProjectAnalysisRecord(db, projectId);

  if (isInMemoryDb(db)) {
    const [
      fileRows,
      symbolRows,
      dependencyRows,
      fieldRows,
      fieldDependencyRows,
      riskRows,
      ruleRows,
    ] = await Promise.all([
      db.select().from(files).where(eq(files.projectId, projectId)),

      db.select().from(symbols).where(eq(symbols.projectId, projectId)),

      db
        .select()
        .from(dependencies)
        .where(eq(dependencies.projectId, projectId)),

      db.select().from(fields).where(eq(fields.projectId, projectId)),

      db
        .select()
        .from(fieldDependencies)
        .where(eq(fieldDependencies.projectId, projectId)),

      db.select().from(risks).where(eq(risks.projectId, projectId)),

      db.select().from(rules).where(eq(rules.projectId, projectId)),
    ]);

    const sortedFields = sortProjectFields(fieldRows);

    const sortedFieldDependencies = sortFieldDependencies(fieldDependencyRows);

    const groupedWarnings = summarizeWarnings([
      ...(project.importWarningsJson ?? []),
      ...(report?.warningsJson ?? []),
    ]);

    const groupedRisks = groupRisks(
      riskRows.map(row => ({
        id: String(row.id),

        riskType: row.riskType,

        severity: row.severity,

        title: row.title,

        description: row.description ?? null,

        sourceFile: row.sourceFile ?? null,

        lineNumber: row.lineNumber ?? null,

        recommendation: row.recommendation ?? null,
      }))
    );

    const groupedRules = groupRules(
      ruleRows.map(row => ({
        id: String(row.id),

        ruleType: row.ruleType,

        title: row.name,

        description: row.description ?? null,

        recommendation: row.condition ?? null,

        sourceFile: row.sourceFile ?? null,

        lineNumber: row.lineNumber ?? null,
      }))
    );

    const fieldUsageById = buildFieldUsageSummary(sortedFieldDependencies);

    const fieldSummaryByTable = new Map<
      string,
      {
        fieldCount: number;
        readCount: number;
        writeCount: number;
        referenceCount: number;
      }
    >();

    for (const field of sortedFields) {
      const usage = fieldUsageById.get(field.id) ?? {
        readCount: 0,
        writeCount: 0,
        referenceCount: 0,
      };

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

    const filePathById = new Map(fileRows.map(row => [row.id, row.filePath]));

    const symbolById = new Map(symbolRows.map(row => [row.id, row]));

    const dependencyItems = buildDependencyListItems(
      dependencyRows,
      symbolById
    );

    return {
      report: report ? mapSnapshotReport(report) : null,

      importWarnings: project.importWarningsJson ?? [],

      warningSummary: groupedWarnings,

      partialReasons: summarizePartialReasons(
        project.importWarningsJson ?? [],
        report?.warningsJson ?? [],
        report?.errorMessage
      ),

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

        .map(row => ({
          id: row.id,

          name: row.name,

          type: row.type,

          filePath: filePathById.get(row.fileId) ?? null,

          startLine: row.startLine,

          endLine: row.endLine,
        })),

      topRisks: sortProjectRisks(riskRows)
        .slice(0, 10)

        .map(row => ({
          id: row.id,

          riskType: row.riskType,

          severity: row.severity,

          title: row.title,

          sourceFile: row.sourceFile,

          lineNumber: row.lineNumber,
        })),

      topRules: sortProjectRules(ruleRows)
        .slice(0, 10)

        .map(row => ({
          id: row.id,

          ruleType: row.ruleType,

          name: row.name,

          sourceFile: row.sourceFile,

          lineNumber: row.lineNumber,
        })),

      topRiskGroups: groupedRisks.slice(0, 20),

      topRuleGroups: groupedRules.slice(0, 20),

      topAffectedFiles: summarizeAffectedFiles(groupedRisks, groupedRules),

      dependencySummary: buildDependencySummary(dependencyItems),

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

    allDependencyRows,

    allRiskRows,

    allRuleRows,

    topSymbolRows,

    topRiskRows,

    topRuleRows,

    fieldCountRows,

    fieldUsageRows,
  ] = await Promise.all([
    countRows(db, files, eq(files.projectId, projectId)),

    countRows(db, symbols, eq(symbols.projectId, projectId)),

    countRows(db, dependencies, eq(dependencies.projectId, projectId)),

    countRows(db, fields, eq(fields.projectId, projectId)),

    countRows(
      db,
      fieldDependencies,
      eq(fieldDependencies.projectId, projectId)
    ),

    countRows(db, risks, eq(risks.projectId, projectId)),

    countRows(db, rules, eq(rules.projectId, projectId)),

    db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),

    db.select().from(risks).where(eq(risks.projectId, projectId)),

    db.select().from(rules).where(eq(rules.projectId, projectId)),

    db

      .select()

      .from(symbols)

      .where(eq(symbols.projectId, projectId))

      .orderBy(
        asc(symbols.name),
        asc(symbols.fileId),
        asc(symbols.startLine),
        asc(symbols.id)
      )

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

      .orderBy(
        asc(rules.ruleType),
        asc(rules.name),
        asc(rules.sourceFile),
        asc(rules.lineNumber),
        asc(rules.id)
      )

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

  const topSymbolFileIds = Array.from(
    new Set(topSymbolRows.map(row => row.fileId))
  );

  const topSymbolFiles =
    topSymbolFileIds.length > 0
      ? await db
          .select({ id: files.id, filePath: files.filePath })
          .from(files)
          .where(inArray(files.id, topSymbolFileIds))
      : [];

  const filePathById = new Map(
    topSymbolFiles.map(row => [row.id, row.filePath])
  );

  const dependencySymbolIds = Array.from(
    new Set(
      allDependencyRows.flatMap(row =>
        [row.sourceSymbolId, row.targetSymbolId].filter(
          (value): value is number => typeof value === "number"
        )
      )
    )
  );

  const dependencySymbolRows =
    dependencySymbolIds.length > 0
      ? await db
          .select({ id: symbols.id, name: symbols.name })
          .from(symbols)
          .where(inArray(symbols.id, dependencySymbolIds))
      : [];

  const dependencyItems = buildDependencyListItems(
    allDependencyRows,
    new Map(dependencySymbolRows.map(row => [row.id, row.name]))
  );

  const groupedWarnings = summarizeWarnings([
    ...(project.importWarningsJson ?? []),
    ...(report?.warningsJson ?? []),
  ]);

  const groupedRisks = groupRisks(
    allRiskRows.map(row => ({
      id: String(row.id),

      riskType: row.riskType,

      severity: row.severity,

      title: row.title,

      description: row.description ?? null,

      sourceFile: row.sourceFile ?? null,

      lineNumber: row.lineNumber ?? null,

      recommendation: row.recommendation ?? null,
    }))
  );

  const groupedRules = groupRules(
    allRuleRows.map(row => ({
      id: String(row.id),

      ruleType: row.ruleType,

      title: row.name,

      description: row.description ?? null,

      recommendation: row.condition ?? null,

      sourceFile: row.sourceFile ?? null,

      lineNumber: row.lineNumber ?? null,
    }))
  );

  const fieldSummaryByTable = new Map<
    string,
    {
      fieldCount: number;
      readCount: number;
      writeCount: number;
      referenceCount: number;
    }
  >();

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

    warningSummary: groupedWarnings,

    partialReasons: summarizePartialReasons(
      project.importWarningsJson ?? [],
      report?.warningsJson ?? [],
      report?.errorMessage
    ),

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

    topSymbols: topSymbolRows.map(row => ({
      id: row.id,

      name: row.name,

      type: row.type,

      filePath: filePathById.get(row.fileId) ?? null,

      startLine: row.startLine,

      endLine: row.endLine,
    })),

    topRisks: topRiskRows.map(row => ({
      id: row.id,

      riskType: row.riskType,

      severity: row.severity,

      title: row.title,

      sourceFile: row.sourceFile,

      lineNumber: row.lineNumber,
    })),

    topRules: topRuleRows.map(row => ({
      id: row.id,

      ruleType: row.ruleType,

      name: row.name,

      sourceFile: row.sourceFile,

      lineNumber: row.lineNumber,
    })),

    topRiskGroups: groupedRisks.slice(0, 20),

    topRuleGroups: groupedRules.slice(0, 20),

    topAffectedFiles: summarizeAffectedFiles(groupedRisks, groupedRules),

    dependencySummary: buildDependencySummary(dependencyItems),

    fieldTables: Array.from(fieldSummaryByTable.entries())

      .map(([tableName, summary]) => ({ tableName, ...summary }))

      .sort((left, right) => left.tableName.localeCompare(right.tableName)),
  };
}
