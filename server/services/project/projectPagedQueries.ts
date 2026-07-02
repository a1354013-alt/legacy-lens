import { and, asc, count, eq, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  DependenciesPageInput,
  DependencyListItem,
  FieldDependenciesPageInput,
  FieldDependencyListItem,
  FieldListItem,
  FieldsPageInput,
  PagedResult,
  RisksPageInput,
  RulesPageInput,
  SymbolListItem,
  SymbolsPageInput,
} from "../../../shared/contracts";
import {
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
  buildContainsLikePattern,
  likeContainsEscaped,
} from "../../_core/sqlLike";
import {
  buildDependencySummary,
  groupRisks,
  groupRules,
  isDelphiStandardLibrary,
} from "../analysisPresentation";
import {
  sortFieldDependencies,
  sortProjectDependencies,
  sortProjectFields,
  sortProjectRisks,
  sortProjectRules,
  sortProjectSymbols,
} from "../projectWorkflow.helpers";

type DbHandle = Pick<DatabaseClient, "select" | "insert" | "update" | "delete">;

export type ProjectPagedQueryDeps = {
  requireDb: () => Promise<DbHandle>;
  getOwnedProject: (
    projectId: number,
    userId: number
  ) => Promise<typeof projects.$inferSelect>;
};

function normalizeSearch(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
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

function andAll(conditions: SQL[]): SQL {
  const [first, ...rest] = conditions;

  if (!first) {
    throw new Error("andAll requires at least one SQL condition.");
  }

  return rest.length === 0 ? first : (and(first, ...rest) as SQL);
}

function orAll(conditions: SQL[]): SQL {
  const [first, ...rest] = conditions;

  if (!first) {
    throw new Error("orAll requires at least one SQL condition.");
  }

  return rest.length === 0 ? first : (or(first, ...rest) as SQL);
}

function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number
): PagedResult<T> {
  const total = items.length;

  const pagination = normalizePagination(page, pageSize, total);

  return {
    items: items.slice(
      pagination.offset,
      pagination.offset + pagination.pageSize
    ),

    total,

    page: pagination.page,

    pageSize: pagination.pageSize,

    pageCount: pagination.pageCount,
  };
}

function isInMemoryDb(
  db: DbHandle
): db is DbHandle & { store: Record<string, Array<Record<string, unknown>>> } {
  return typeof db === "object" && db !== null && "store" in db;
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

async function listMatchingFileIds(
  db: DbHandle,
  projectId: number,
  searchLike: string
) {
  if (!searchLike) return [];

  const rows = await db

    .select({ id: files.id })

    .from(files)

    .where(
      and(
        eq(files.projectId, projectId),
        likeContainsEscaped(files.filePath, searchLike)
      )
    );

  return rows.map(row => row.id);
}

async function listMatchingSymbolIds(
  db: DbHandle,
  projectId: number,
  searchLike: string
) {
  if (!searchLike) return [];

  const rows = await db

    .select({ id: symbols.id })

    .from(symbols)

    .where(
      and(
        eq(symbols.projectId, projectId),
        likeContainsEscaped(symbols.name, searchLike)
      )
    );

  return rows.map(row => row.id);
}

async function listMatchingFieldIds(
  db: DbHandle,
  projectId: number,
  searchLike: string
) {
  if (!searchLike) return [];

  const rows = await db

    .select({ id: fields.id })

    .from(fields)

    .where(
      and(
        eq(fields.projectId, projectId),

        or(
          likeContainsEscaped(fields.tableName, searchLike),
          likeContainsEscaped(fields.fieldName, searchLike)
        )
      )
    );

  return rows.map(row => row.id);
}

export async function getSymbolsPageImpl(
  deps: ProjectPagedQueryDeps,
  input: SymbolsPageInput,
  userId: number
): Promise<PagedResult<SymbolListItem>> {
  await deps.getOwnedProject(input.projectId, userId);
  const db = await deps.requireDb();

  if (isInMemoryDb(db)) {
    const [symbolRows, fileRows] = await Promise.all([
      db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),

      db.select().from(files).where(eq(files.projectId, input.projectId)),
    ]);

    const filePathById = new Map(fileRows.map(row => [row.id, row.filePath]));

    const search = normalizeSearch(input.search);

    const items = sortProjectSymbols(symbolRows)
      .map(row => ({
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

      .filter(row => (input.kind ? row.type === input.kind : true))

      .filter(row => {
        if (!search) return true;

        return (
          normalizeSearch(row.name).includes(search) ||
          normalizeSearch(row.filePath).includes(search)
        );
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);

  const matchingFileIds = await listMatchingFileIds(
    db,
    input.projectId,
    searchLike
  );

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

  const total = await countRows(db, symbols, whereCondition);

  const pagination = normalizePagination(input.page, input.pageSize, total);

  const symbolRows = await db

    .select()

    .from(symbols)

    .where(whereCondition)

    .orderBy(
      asc(symbols.name),
      asc(symbols.fileId),
      asc(symbols.startLine),
      asc(symbols.id)
    )

    .limit(pagination.pageSize)

    .offset(pagination.offset);

  const fileIds = Array.from(new Set(symbolRows.map(row => row.fileId)));

  const fileRows =
    fileIds.length > 0
      ? await db
          .select({ id: files.id, filePath: files.filePath })
          .from(files)
          .where(inArray(files.id, fileIds))
      : [];

  const filePathById = new Map(fileRows.map(row => [row.id, row.filePath]));

  return {
    items: symbolRows.map(row => ({
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

export async function getFieldsPageImpl(
  deps: ProjectPagedQueryDeps,
  input: FieldsPageInput,
  userId: number
): Promise<PagedResult<FieldListItem>> {
  await deps.getOwnedProject(input.projectId, userId);
  const db = await deps.requireDb();

  if (isInMemoryDb(db)) {
    const [fieldRows, fieldDependencyRows] = await Promise.all([
      db.select().from(fields).where(eq(fields.projectId, input.projectId)),

      db
        .select()
        .from(fieldDependencies)
        .where(eq(fieldDependencies.projectId, input.projectId)),
    ]);

    const fieldUsageById = buildFieldUsageSummary(
      sortFieldDependencies(fieldDependencyRows)
    );

    const search = normalizeSearch(input.search);

    const items = sortProjectFields(fieldRows)
      .map(row => ({
        id: row.id,

        tableName: row.tableName,

        fieldName: row.fieldName,

        fieldType: row.fieldType ?? null,

        description: row.description ?? null,

        readCount: fieldUsageById.get(row.id)?.readCount ?? 0,

        writeCount: fieldUsageById.get(row.id)?.writeCount ?? 0,

        referenceCount: fieldUsageById.get(row.id)?.referenceCount ?? 0,
      }))

      .filter(row =>
        input.tableName ? row.tableName === input.tableName : true
      )

      .filter(row => {
        if (!search) return true;

        return (
          normalizeSearch(row.tableName).includes(search) ||
          normalizeSearch(row.fieldName).includes(search)
        );
      });

    return paginateItems(items, input.page, input.pageSize);
  }

  const searchLike = normalizeLikeSearch(input.search);

  const conditions = [eq(fields.projectId, input.projectId)];

  if (input.tableName) {
    conditions.push(eq(fields.tableName, input.tableName));
  }

  if (searchLike) {
    conditions.push(
      orAll([
        likeContainsEscaped(fields.tableName, searchLike),
        likeContainsEscaped(fields.fieldName, searchLike),
      ])
    );
  }

  const whereCondition = andAll(conditions);

  const total = await countRows(db, fields, whereCondition);

  const pagination = normalizePagination(input.page, input.pageSize, total);

  const fieldRows = await db

    .select()

    .from(fields)

    .where(whereCondition)

    .orderBy(asc(fields.tableName), asc(fields.fieldName), asc(fields.id))

    .limit(pagination.pageSize)

    .offset(pagination.offset);

  const fieldIds = fieldRows.map(row => row.id);

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

          .where(
            and(
              eq(fieldDependencies.projectId, input.projectId),
              inArray(fieldDependencies.fieldId, fieldIds)
            )
          )

          .groupBy(fieldDependencies.fieldId)
      : [];

  const usageById = new Map(
    usageRows.map(row => [
      row.fieldId,

      {
        readCount: Number(row.readCount ?? 0),

        writeCount: Number(row.writeCount ?? 0),

        referenceCount: Number(row.referenceCount ?? 0),
      },
    ])
  );

  return {
    items: fieldRows.map(row => ({
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

export async function getRisksPageImpl(
  deps: ProjectPagedQueryDeps,
  input: RisksPageInput,
  userId: number
) {
  await deps.getOwnedProject(input.projectId, userId);
  const db = await deps.requireDb();

  const hideDuplicates = input.hideDuplicates ?? true;

  const criticalOnly = input.criticalOnly ?? false;

  if (isInMemoryDb(db)) {
    const riskRows = await db
      .select()
      .from(risks)
      .where(eq(risks.projectId, input.projectId));

    return paginateItems(
      groupRisks(
        sortProjectRisks(riskRows).map(row => ({
          id: String(row.id),

          riskType: row.riskType,

          severity: row.severity,

          title: row.title,

          description: row.description ?? null,

          sourceFile: row.sourceFile ?? null,

          lineNumber: row.lineNumber ?? null,

          recommendation: row.recommendation ?? null,
        })),

        {
          severity: input.severity,

          riskType: input.riskType,

          search: input.search,

          file: input.filePath,

          criticalOnly,

          hideDuplicates,
        }
      ),

      input.page,

      input.pageSize
    );
  }

  const riskRows = await db
    .select()
    .from(risks)
    .where(eq(risks.projectId, input.projectId));

  return paginateItems(
    groupRisks(
      riskRows.map(row => ({
        id: String(row.id),

        riskType: row.riskType,

        severity: row.severity,

        title: row.title,

        description: row.description ?? null,

        sourceFile: row.sourceFile ?? null,

        lineNumber: row.lineNumber ?? null,

        recommendation: row.recommendation ?? null,
      })),

      {
        severity: input.severity,

        riskType: input.riskType,

        search: input.search,

        file: input.filePath,

        criticalOnly,

        hideDuplicates,
      }
    ),

    input.page,

    input.pageSize
  );
}

export async function getRulesPageImpl(
  deps: ProjectPagedQueryDeps,
  input: RulesPageInput,
  userId: number
) {
  await deps.getOwnedProject(input.projectId, userId);
  const db = await deps.requireDb();

  const hideDuplicates = input.hideDuplicates ?? true;

  if (isInMemoryDb(db)) {
    const ruleRows = await db
      .select()
      .from(rules)
      .where(eq(rules.projectId, input.projectId));

    return paginateItems(
      groupRules(
        sortProjectRules(ruleRows).map(row => ({
          id: String(row.id),

          ruleType: row.ruleType,

          name: row.name,

          description: row.description ?? null,

          condition: row.condition ?? null,

          sourceFile: row.sourceFile ?? null,

          lineNumber: row.lineNumber ?? null,
        })),

        {
          ruleType: input.ruleType,

          search: input.search,

          file: input.filePath,

          hideDuplicates,
        }
      ),

      input.page,

      input.pageSize
    );
  }

  const ruleRows = await db
    .select()
    .from(rules)
    .where(eq(rules.projectId, input.projectId));

  return paginateItems(
    groupRules(
      ruleRows.map(row => ({
        id: String(row.id),

        ruleType: row.ruleType,

        name: row.name,

        description: row.description ?? null,

        condition: row.condition ?? null,

        sourceFile: row.sourceFile ?? null,

        lineNumber: row.lineNumber ?? null,
      })),

      {
        ruleType: input.ruleType,

        search: input.search,

        file: input.filePath,

        hideDuplicates,
      }
    ),

    input.page,

    input.pageSize
  );
}

export async function getDependenciesPageImpl(
  deps: ProjectPagedQueryDeps,
  input: DependenciesPageInput,
  userId: number
) {
  await deps.getOwnedProject(input.projectId, userId);
  const db = await deps.requireDb();

  const hideStandardLibrary = input.hideStandardLibrary ?? true;

  if (isInMemoryDb(db)) {
    const [dependencyRows, symbolRows] = await Promise.all([
      db
        .select()
        .from(dependencies)
        .where(eq(dependencies.projectId, input.projectId)),

      db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),
    ]);

    const symbolById = new Map(symbolRows.map(row => [row.id, row]));

    const search = normalizeSearch(input.search);

    const items = buildDependencyListItems(
      sortProjectDependencies(dependencyRows),
      symbolById
    )
      .filter(row =>
        input.dependencyType
          ? row.dependencyType === input.dependencyType
          : true
      )

      .filter(row =>
        input.targetKind ? row.targetKind === input.targetKind : true
      )

      .filter(row =>
        hideStandardLibrary
          ? !isDelphiStandardLibrary(
              row.targetExternalName ?? row.targetSymbolName
            )
          : true
      )

      .filter(row => {
        if (!search) return true;

        return (
          normalizeSearch(row.sourceSymbolName).includes(search) ||
          normalizeSearch(row.targetSymbolName).includes(search) ||
          normalizeSearch(row.targetExternalName).includes(search)
        );
      });

    return {
      ...paginateItems(items, input.page, input.pageSize),

      summary: buildDependencySummary(
        buildDependencyListItems(dependencyRows, symbolById)
      ),
    };
  }

  const dependencyRows = await db
    .select()
    .from(dependencies)
    .where(eq(dependencies.projectId, input.projectId));

  const symbolIds = Array.from(
    new Set(
      dependencyRows.flatMap(row =>
        [row.sourceSymbolId, row.targetSymbolId].filter(
          (value): value is number => typeof value === "number"
        )
      )
    )
  );

  const symbolRows =
    symbolIds.length > 0
      ? await db
          .select({ id: symbols.id, name: symbols.name })
          .from(symbols)
          .where(inArray(symbols.id, symbolIds))
      : [];

  const symbolById = new Map(symbolRows.map(row => [row.id, row.name]));

  const mappedItems = buildDependencyListItems(dependencyRows, symbolById);

  const search = normalizeSearch(input.search);

  const filteredItems = mappedItems

    .filter(row =>
      input.dependencyType ? row.dependencyType === input.dependencyType : true
    )

    .filter(row =>
      input.targetKind ? row.targetKind === input.targetKind : true
    )

    .filter(row =>
      hideStandardLibrary
        ? !isDelphiStandardLibrary(
            row.targetExternalName ?? row.targetSymbolName
          )
        : true
    )

    .filter(row => {
      if (!search) return true;

      return (
        normalizeSearch(row.sourceSymbolName).includes(search) ||
        normalizeSearch(row.targetSymbolName).includes(search) ||
        normalizeSearch(row.targetExternalName).includes(search)
      );
    });

  return {
    ...paginateItems(filteredItems, input.page, input.pageSize),

    summary: buildDependencySummary(mappedItems),
  };
}

export async function getFieldDependenciesPageImpl(
  deps: ProjectPagedQueryDeps,
  input: FieldDependenciesPageInput,
  userId: number
): Promise<PagedResult<FieldDependencyListItem>> {
  await deps.getOwnedProject(input.projectId, userId);
  const db = await deps.requireDb();

  if (isInMemoryDb(db)) {
    const [fieldDependencyRows, fieldRows, symbolRows] = await Promise.all([
      db
        .select()
        .from(fieldDependencies)
        .where(eq(fieldDependencies.projectId, input.projectId)),

      db.select().from(fields).where(eq(fields.projectId, input.projectId)),

      db.select().from(symbols).where(eq(symbols.projectId, input.projectId)),
    ]);

    const fieldById = new Map(fieldRows.map(row => [row.id, row]));

    const symbolById = new Map(symbolRows.map(row => [row.id, row]));

    const search = normalizeSearch(input.search);

    const items = sortFieldDependencies(fieldDependencyRows)
      .map(row => ({
        id: row.id,

        fieldId: row.fieldId,

        tableName: fieldById.get(row.fieldId)?.tableName ?? "unknown",

        fieldName: fieldById.get(row.fieldId)?.fieldName ?? "unknown",

        symbolId: row.symbolId,

        symbolName:
          symbolById.get(row.symbolId)?.name ?? `symbol:${row.symbolId}`,

        operationType: row.operationType,

        lineNumber: row.lineNumber ?? null,

        context: row.context ?? null,
      }))

      .filter(row =>
        input.tableName ? row.tableName === input.tableName : true
      )

      .filter(row =>
        input.operationType ? row.operationType === input.operationType : true
      )

      .filter(row => {
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

          .where(
            and(
              eq(fields.projectId, input.projectId),
              eq(fields.tableName, input.tableName)
            )
          )
      ).map(row => row.id)
    : [];

  if (input.tableName && tableFieldIds.length === 0) {
    return paginateItems([], input.page, input.pageSize);
  }

  const [searchFieldIds, searchSymbolIds] = await Promise.all([
    listMatchingFieldIds(db, input.projectId, searchLike),

    listMatchingSymbolIds(db, input.projectId, searchLike),
  ]);

  const conditions = [eq(fieldDependencies.projectId, input.projectId)];

  if (input.operationType) {
    conditions.push(eq(fieldDependencies.operationType, input.operationType));
  }

  if (input.tableName) {
    conditions.push(inArray(fieldDependencies.fieldId, tableFieldIds));
  }

  if (searchLike) {
    const searchClauses = [
      likeContainsEscaped(fieldDependencies.context, searchLike),
    ];

    if (searchFieldIds.length > 0) {
      searchClauses.push(inArray(fieldDependencies.fieldId, searchFieldIds));
    }

    if (searchSymbolIds.length > 0) {
      searchClauses.push(inArray(fieldDependencies.symbolId, searchSymbolIds));
    }

    conditions.push(orAll(searchClauses));
  }

  const whereCondition = andAll(conditions);

  const total = await countRows(db, fieldDependencies, whereCondition);

  const pagination = normalizePagination(input.page, input.pageSize, total);

  const fieldDependencyRows = await db

    .select()

    .from(fieldDependencies)

    .where(whereCondition)

    .orderBy(
      asc(fieldDependencies.fieldId),
      asc(fieldDependencies.symbolId),
      asc(fieldDependencies.lineNumber),
      asc(fieldDependencies.id)
    )

    .limit(pagination.pageSize)

    .offset(pagination.offset);

  const fieldIds = Array.from(
    new Set(fieldDependencyRows.map(row => row.fieldId))
  );

  const symbolIds = Array.from(
    new Set(fieldDependencyRows.map(row => row.symbolId))
  );

  const [fieldRows, symbolRows] = await Promise.all([
    fieldIds.length > 0
      ? db
          .select({
            id: fields.id,
            tableName: fields.tableName,
            fieldName: fields.fieldName,
          })
          .from(fields)
          .where(inArray(fields.id, fieldIds))
      : Promise.resolve([]),

    symbolIds.length > 0
      ? db
          .select({ id: symbols.id, name: symbols.name })
          .from(symbols)
          .where(inArray(symbols.id, symbolIds))
      : Promise.resolve([]),
  ]);

  const fieldById = new Map(fieldRows.map(row => [row.id, row]));

  const symbolById = new Map(symbolRows.map(row => [row.id, row.name]));

  return {
    items: fieldDependencyRows.map(row => ({
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
