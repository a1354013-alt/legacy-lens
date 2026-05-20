import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "inArray"; column: string; values: unknown[] }
  | { type: "and"; conditions: Condition[] }
  | undefined;
type SortOrder = { type: "desc"; column: string } | undefined;

let zipFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let gitFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let importWarnings: Array<{ code: string; message: string; filePath?: string }> = [];
let analyzerResult: Record<string, unknown> | null = null;
let fakeDb: ReturnType<typeof createFakeDb>;
let failRootProjectReadsDuringTransaction = false;
let transactionDepth = 0;
let lastValidatedGitUrl: { gitUrl: string; host: string; resolvedAddresses: Array<{ address: string; family: 4 | 6 }>; allowlist: string[] | null; production: boolean } | null = null;
const cloneAndExtractFilesMock = vi.fn(async () => ({ files: gitFiles, warnings: importWarnings }));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ type: "eq", column: column.name, value }),
    inArray: (column: { name: string }, values: unknown[]) => ({ type: "inArray", column: column.name, values }),
    and: (...conditions: Condition[]) => ({ type: "and", conditions: conditions.filter(Boolean) as Condition[] }),
    desc: (column: { name: string }) => ({ type: "desc", column: column.name }),
  };
});

vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

vi.mock("../utils/zipHandler", () => ({
  SUPPORTED_SOURCE_EXTENSIONS: [".go", ".sql", ".pas"],
  extractFilesFromZip: vi.fn(async () => ({ files: zipFiles, warnings: importWarnings })),
}));

vi.mock("../utils/gitHandler", () => ({
  validateSafeGitUrl: vi.fn(async (url: string) => {
    const normalizedUrl = String(url).trim();
    if (!/^https:\/\/example\.com\/.+/.test(normalizedUrl)) {
      throw new Error("Repository URL is invalid or unsupported.");
    }

    lastValidatedGitUrl = {
      gitUrl: normalizedUrl,
      host: "example.com",
      resolvedAddresses: [{ address: "93.184.216.34", family: 4 }],
      allowlist: null,
      production: false,
    };

    return lastValidatedGitUrl;
  }),
  cloneAndExtractFiles: cloneAndExtractFilesMock,
  cleanupTempDir: vi.fn(async () => undefined),
}));

vi.mock("../analyzer/analyzer", () => ({
  Analyzer: class Analyzer {
    async analyzeProject() {
      return analyzerResult;
    }
  },
}));

function getTableName(table: object): string {
  const symbol = Object.getOwnPropertySymbols(table).find((entry) => String(entry) === "Symbol(drizzle:Name)");
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "unknown";
}

function matches(condition: Condition, row: Row): boolean {
  if (!condition) return true;
  if (condition.type === "eq") {
    return row[condition.column] === condition.value;
  }
  if (condition.type === "inArray") {
    return condition.values.includes(row[condition.column]);
  }
  return condition.conditions.every((child) => matches(child, row));
}

function selectRows(store: Store, table: object, condition: Condition, sort: SortOrder, limit?: number, selection?: Row) {
  let rows = [...store[getTableName(table)]];
  rows = rows.filter((row) => matches(condition, row));

  if (sort?.type === "desc") {
    rows.sort((left, right) => Number(right[sort.column] ?? 0) - Number(left[sort.column] ?? 0));
  }

  if (typeof limit === "number") {
    rows = rows.slice(0, limit);
  }

  if (!selection) {
    return rows;
  }

  return rows.map((row) => {
    const mapped: Row = {};
    for (const [key, column] of Object.entries(selection)) {
      mapped[key] = row[(column as { name: string }).name];
    }
    return mapped;
  });
}

function createFakeDb(initialStore?: Partial<Store>) {
  const store: Store = {
    users: [],
    projects: [],
    files: [],
    symbols: [],
    dependencies: [],
    fields: [],
    fieldDependencies: [],
    risks: [],
    rules: [],
    analysisResults: [],
    ...initialStore,
  };

  const idCounters = new Map<string, number>(
    Object.entries(store).map(([key, rows]) => [key, rows.reduce((max, row) => Math.max(max, Number(row.id ?? 0)), 0)])
  );

  class SelectQuery {
    private condition: Condition;
    private limitCount?: number;
    private sort?: SortOrder;

    constructor(private readonly selection?: Row, private readonly table?: object) {}

    from(table: object) {
      return new SelectQuery(this.selection, table);
    }

    where(condition: Condition) {
      this.condition = condition;
      return this;
    }

    orderBy(sort: SortOrder) {
      this.sort = sort;
      return this;
    }

    limit(count: number) {
      this.limitCount = count;
      return this;
    }

    then<TResult1 = Row[], TResult2 = never>(
      onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      const value = selectRows(store, this.table as object, this.condition, this.sort, this.limitCount, this.selection);
      return Promise.resolve(value).then(onfulfilled, onrejected);
    }
  }

  const db: any = {
    store,
    select(selection?: Row) {
      if (failRootProjectReadsDuringTransaction && transactionDepth > 0) {
        throw new Error("Root database handle was used while a transaction was active.");
      }
      return new SelectQuery(selection);
    },
    insert(table: object) {
      return {
        values: async (payload: Row | Row[]) => {
          const rows = Array.isArray(payload) ? payload : [payload];
          const tableName = getTableName(table);
          let lastId = 0;
          for (const row of rows) {
            const nextId = (idCounters.get(tableName) ?? 0) + 1;
            idCounters.set(tableName, nextId);
            lastId = nextId;
            store[tableName].push({ ...row, id: nextId });
          }
          return { insertId: lastId };
        },
      };
    },
    update(table: object) {
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            const tableName = getTableName(table);
            store[tableName] = store[tableName].map((row) => (matches(condition, row) ? { ...row, ...updates } : row));
          },
        }),
      };
    },
    delete(table: object) {
      return {
        where: async (condition: Condition) => {
          const tableName = getTableName(table);
          store[tableName] = store[tableName].filter((row) => !matches(condition, row));
        },
      };
    },
    transaction: async <T>(callback: (tx: typeof db) => Promise<T>) => {
      transactionDepth += 1;
      const tx = {
        ...db,
        select(selection?: Row) {
          return new SelectQuery(selection);
        },
      };

      try {
        return await callback(tx);
      } finally {
        transactionDepth -= 1;
      }
    },
  };

  return db;
}

beforeEach(() => {
  fakeDb = createFakeDb();
  zipFiles = [];
  gitFiles = [];
  importWarnings = [];
  analyzerResult = null;
  failRootProjectReadsDuringTransaction = false;
  transactionDepth = 0;
  lastValidatedGitUrl = null;
  cloneAndExtractFilesMock.mockClear();
});

describe("project workflow", () => {
  it("creates a project in draft state", async () => {
    const { createProjectForUser } = await import("./projectWorkflow");

    const projectId = await createProjectForUser(7, {
      name: "demo",
      description: "sample",
      focusLanguage: "go",
      sourceType: "upload",
    });

    expect(projectId).toBe(1);
    expect(fakeDb.store.projects[0]).toMatchObject({
      userId: 7,
      name: "demo",
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
      importWarningsJson: [],
    });
  });

  it("imports files from a ZIP archive and marks the project as ready", async () => {
    const { importProjectZip } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "zip-project",
      language: "go",
      sourceType: "upload",
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
    });
    zipFiles = [
      { path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 },
      { path: "schema.sql", fileName: "schema.sql", content: "SELECT id FROM users", language: "sql", size: 20 },
    ];

    const result = await importProjectZip(1, 7, "encoded");

    expect(result.files).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
    expect(fakeDb.store.files).toHaveLength(2);
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      importWarningsJson: [],
    });
  });

  it("persists ZIP import warnings on the project record", async () => {
    const { getOwnedProject, importProjectZip } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "zip-warning-project",
      language: "go",
      sourceType: "upload",
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: [],
    });
    zipFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
    importWarnings = [{ code: "IMPORT_FILE_TOO_LARGE", message: "Skipped an oversized file.", filePath: "big.sql" }];

    const result = await importProjectZip(1, 7, "encoded");
    const project = await getOwnedProject(1, 7);

    expect(result.warnings).toEqual(importWarnings);
    expect(project.importWarningsJson).toEqual(importWarnings);
  });

  it("clears stale analysis records before replacing imported files", async () => {
    const { buildReportArchive, importProjectZip } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "reimport-project",
      language: "go",
      sourceType: "upload",
      status: "completed",
      importProgress: 100,
      analysisProgress: 100,
      errorMessage: null,
      lastErrorCode: null,
    });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "old.go", fileName: "old.go", fileType: ".go", content: "package old", lineCount: 1, status: "stored" });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "OldSymbol", type: "function", startLine: 1, endLine: 1 });
    fakeDb.store.dependencies.push({ id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetExternalName: "legacy", targetKind: "unresolved", dependencyType: "references", lineNumber: 1 });
    fakeDb.store.fields.push({ id: 1, projectId: 1, tableName: "orders", fieldName: "amount" });
    fakeDb.store.fieldDependencies.push({ id: 1, projectId: 1, fieldId: 1, symbolId: 1, operationType: "read", lineNumber: 1, context: "orders.amount" });
    fakeDb.store.risks.push({ id: 1, projectId: 1, title: "Legacy risk", severity: "high", sourceFile: "old.go", lineNumber: 1 });
    fakeDb.store.rules.push({ id: 1, projectId: 1, name: "LegacyRule", ruleType: "validation", sourceFile: "old.go", lineNumber: 1 });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# OLD",
      dataDependencyMarkdown: "# OLD",
      risksMarkdown: "# OLD",
      rulesYaml: "rules: []",
      summaryJson: { fileCount: 1 },
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    zipFiles = [{ path: "new.go", fileName: "new.go", content: "package main", language: "go", size: 12 }];

    await importProjectZip(1, 7, "encoded");

    expect(fakeDb.store.analysisResults).toHaveLength(0);
    expect(fakeDb.store.symbols).toHaveLength(0);
    expect(fakeDb.store.dependencies).toHaveLength(0);
    expect(fakeDb.store.fields).toHaveLength(0);
    expect(fakeDb.store.fieldDependencies).toHaveLength(0);
    expect(fakeDb.store.risks).toHaveLength(0);
    expect(fakeDb.store.rules).toHaveLength(0);
    expect(fakeDb.store.files).toEqual([
      expect.objectContaining({
        projectId: 1,
        filePath: "new.go",
      }),
    ]);
    await expect(buildReportArchive(1, 7)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
  });

  it("imports files from git and persists the source URL", async () => {
    const { importProjectGit } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "git-project",
      language: "go",
      sourceType: "git",
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
    });
    gitFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];

    const result = await importProjectGit(1, 7, "https://example.com/org/repo.git");

    expect(result.files).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
    expect(cloneAndExtractFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gitUrl: "https://example.com/org/repo.git",
        host: "example.com",
      }),
      expect.any(String)
    );
    expect(fakeDb.store.projects[0]).toMatchObject({
      sourceUrl: "https://example.com/org/repo.git",
      status: "ready",
      importWarningsJson: [],
    });
  });

  it("persists Git import warnings on the project record", async () => {
    const { getOwnedProject, importProjectGit } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "git-warning-project",
      language: "go",
      sourceType: "git",
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
      importWarningsJson: [],
    });
    gitFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
    importWarnings = [{ code: "IMPORT_LIMITED_ANALYSIS", message: "Imported with limited analysis.", filePath: "form.dfm" }];

    await importProjectGit(1, 7, "https://example.com/org/repo.git");
    const project = await getOwnedProject(1, 7);

    expect(project.importWarningsJson).toEqual(importWarnings);
  });

  it("writes back analysis artifacts, symbols, dependencies, fields, rules, and risks", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "analysis-project",
      language: "go",
      sourceType: "upload",
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
    });
    fakeDb.store.files.push(
      { id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 12, status: "stored" },
      { id: 2, projectId: 1, filePath: "repo.sql", fileName: "repo.sql", fileType: ".sql", content: "SELECT amount FROM orders", lineCount: 8, status: "stored" }
    );
    analyzerResult = {
      projectId: 1,
      status: "partial",
      language: "go",
      symbols: [
        { stableKey: "main.go::main::1", name: "main", type: "function", file: "main.go", startLine: 1, endLine: 5, signature: "func main()" },
        { stableKey: "repo.sql::query_1::1", name: "query_1", type: "query", file: "repo.sql", startLine: 1, endLine: 1, signature: "SELECT amount FROM orders" },
      ],
      dependencies: [{ from: "main.go::main::1", to: "repo.sql::query_1::1", fromName: "main", toName: "query_1", type: "calls", line: 3 }],
      fieldReferences: [{ table: "orders", field: "amount", type: "read", file: "repo.sql", line: 1, symbolStableKey: "repo.sql::query_1::1", context: "SELECT amount FROM orders" }],
      risks: [
        {
          title: "Date literal embedded in code",
          description: "Found hard-coded date value.",
          severity: "medium",
          category: "magic_value",
          sourceFile: "main.go",
          lineNumber: 2,
          suggestion: "Use a constant.",
        },
      ],
      rules: [
        {
          ruleType: "magic_value",
          name: "externalize_main_go_2",
          description: "Date literal embedded in code",
          condition: "Found hard-coded date value.",
          sourceFile: "main.go",
          lineNumber: 2,
        },
      ],
      warnings: [{ code: "LANGUAGE_UNSUPPORTED", message: "Skipped 1 file", filePath: "legacy.txt" }],
      flowDocument: "# FLOW",
      dataDependencyDocument: "# DATA_DEPENDENCY",
      risksDocument: "# RISKS",
      rulesYaml: "rules:\n  - name: externalize_main_go_2",
      riskScore: 8,
      metrics: {
        fileCount: 2,
        eligibleFileCount: 2,
        analyzedFileCount: 1,
        skippedFileCount: 1,
        heuristicFileCount: 1,
        degradedFileCount: 1,
        symbolCount: 2,
        dependencyCount: 1,
        fieldCount: 1,
        fieldDependencyCount: 1,
        riskCount: 1,
        ruleCount: 1,
        warningCount: 1,
      },
    };

    const result = await analyzeProject(1, 7);

    expect(result.status).toBe("partial");
    expect(fakeDb.store.analysisResults[0]).toMatchObject({
      projectId: 1,
      status: "partial",
      errorMessage: "Analysis completed with warnings.",
    });
    expect(fakeDb.store.symbols).toHaveLength(2);
    expect(fakeDb.store.dependencies).toHaveLength(1);
    expect(fakeDb.store.fields).toHaveLength(1);
    expect(fakeDb.store.fieldDependencies).toHaveLength(1);
    expect(fakeDb.store.risks).toHaveLength(1);
    expect(fakeDb.store.rules).toHaveLength(1);
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "completed",
      analysisProgress: 100,
    });
  });

  it("keeps state transitions on the transaction handle while analyzing", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    failRootProjectReadsDuringTransaction = true;
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "tx-analysis-project",
      language: "go",
      sourceType: "upload",
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
    });
    fakeDb.store.files.push({
      id: 1,
      projectId: 1,
      filePath: "main.go",
      fileName: "main.go",
      fileType: ".go",
      content: "package main",
      lineCount: 1,
      status: "stored",
    });
    analyzerResult = {
      projectId: 1,
      status: "completed",
      language: "go",
      symbols: [],
      dependencies: [],
      fieldReferences: [],
      risks: [],
      rules: [],
      warnings: [],
      flowDocument: "# FLOW",
      dataDependencyDocument: "# DATA_DEPENDENCY",
      risksDocument: "# RISKS",
      rulesYaml: "rules: []",
      riskScore: 0,
      metrics: {
        fileCount: 1,
        eligibleFileCount: 1,
        analyzedFileCount: 1,
        skippedFileCount: 0,
        heuristicFileCount: 0,
        degradedFileCount: 0,
        symbolCount: 0,
        dependencyCount: 0,
        fieldCount: 0,
        fieldDependencyCount: 0,
        riskCount: 0,
        ruleCount: 0,
        warningCount: 0,
      },
    };

    await expect(analyzeProject(1, 7)).resolves.toMatchObject({ status: "completed" });
  });

  it("preserves valid importing/analyzing/completed/failed workflow transitions", async () => {
    const { analyzeProject, importProjectZip } = await import("./projectWorkflow");
    fakeDb.store.projects.push(
      {
        id: 1,
        userId: 7,
        name: "importing-project",
        language: "go",
        sourceType: "upload",
        status: "draft",
        importProgress: 0,
        analysisProgress: 0,
        errorMessage: null,
        lastErrorCode: null,
      },
      {
        id: 2,
        userId: 7,
        name: "failing-project",
        language: "go",
        sourceType: "upload",
        status: "ready",
        importProgress: 100,
        analysisProgress: 0,
        errorMessage: null,
        lastErrorCode: null,
      }
    );
    fakeDb.store.files.push({
      id: 1,
      projectId: 2,
      filePath: "main.go",
      fileName: "main.go",
      fileType: ".go",
      content: "package main",
      lineCount: 1,
      status: "stored",
    });
    zipFiles = [{ path: "fresh.go", fileName: "fresh.go", content: "package main", language: "go", size: 10 }];
    analyzerResult = {
      projectId: 2,
      status: "failed",
      language: "go",
      symbols: [],
      dependencies: [],
      fieldReferences: [],
      risks: [],
      rules: [],
      warnings: [],
      flowDocument: "",
      dataDependencyDocument: "",
      risksDocument: "",
      rulesYaml: "",
      riskScore: 0,
      metrics: {
        fileCount: 1,
        eligibleFileCount: 1,
        analyzedFileCount: 0,
        skippedFileCount: 1,
        heuristicFileCount: 0,
        degradedFileCount: 0,
        symbolCount: 0,
        dependencyCount: 0,
        fieldCount: 0,
        fieldDependencyCount: 0,
        riskCount: 0,
        ruleCount: 0,
        warningCount: 0,
      },
    };

    await expect(importProjectZip(1, 7, "encoded")).resolves.toMatchObject({ files: [expect.objectContaining({ path: "fresh.go" })] });
    expect(fakeDb.store.projects.find((project: Row) => project.id === 1)).toMatchObject({
      status: "ready",
      importProgress: 100,
    });

    await expect(analyzeProject(2, 7)).rejects.toMatchObject({ code: "ANALYSIS_FAILED" });
    expect(fakeDb.store.projects.find((project: Row) => project.id === 2)).toMatchObject({
      status: "failed",
      analysisProgress: 0,
      lastErrorCode: "ANALYSIS_FAILED",
    });
    expect(fakeDb.store.analysisResults.find((report: Row) => report.projectId === 2)).toMatchObject({
      status: "failed",
    });
  });

  it("assigns field ownership to the most specific Delphi procedure and preserves schema-qualified field names", async () => {
    const { analyzeProject, getAnalysisSnapshot, runImpactAnalysis } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "delphi-analysis-project",
      language: "delphi",
      sourceType: "upload",
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
      errorMessage: null,
      lastErrorCode: null,
    });
    fakeDb.store.files.push({
      id: 1,
      projectId: 1,
      filePath: "InvoiceUnit.pas",
      fileName: "InvoiceUnit.pas",
      fileType: ".pas",
      content: "unit InvoiceUnit;",
      lineCount: 20,
      status: "stored",
    });
    analyzerResult = {
      projectId: 1,
      status: "completed",
      language: "delphi",
      symbols: [
        { stableKey: "InvoiceUnit.pas::InvoiceUnit::1", name: "InvoiceUnit", qualifiedName: "InvoiceUnit", type: "class", file: "InvoiceUnit.pas", startLine: 1, endLine: 20, signature: "unit InvoiceUnit" },
        { stableKey: "InvoiceUnit.pas::LoadUsers::4", name: "LoadUsers", type: "procedure", file: "InvoiceUnit.pas", startLine: 4, endLine: 8, signature: "procedure LoadUsers;" },
        { stableKey: "InvoiceUnit.pas::SaveOrders::10", name: "SaveOrders", type: "procedure", file: "InvoiceUnit.pas", startLine: 10, endLine: 14, signature: "procedure SaveOrders;" },
      ],
      dependencies: [],
      fieldReferences: [
        { table: "dbo.Users", field: "Name", type: "read", file: "InvoiceUnit.pas", line: 6, context: "SELECT u.Name FROM dbo.Users u" },
        { table: "ERP.SIGNB", field: "MARK_2", type: "write", file: "InvoiceUnit.pas", line: 12, context: "UPDATE ERP.SIGNB SET MARK_2 = :P1" },
      ],
      risks: [],
      rules: [],
      warnings: [],
      flowDocument: "# FLOW",
      dataDependencyDocument: "# DATA_DEPENDENCY",
      risksDocument: "# RISKS",
      rulesYaml: "rules: []",
      riskScore: 0,
      metrics: {
        fileCount: 1,
        eligibleFileCount: 1,
        analyzedFileCount: 1,
        skippedFileCount: 0,
        heuristicFileCount: 0,
        degradedFileCount: 0,
        symbolCount: 3,
        dependencyCount: 0,
        fieldCount: 2,
        fieldDependencyCount: 2,
        riskCount: 0,
        ruleCount: 0,
        warningCount: 0,
      },
    };

    await analyzeProject(1, 7);
    const snapshot = await getAnalysisSnapshot(1, 7);

    expect(snapshot.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tableName: "dbo.Users", fieldName: "Name" }),
        expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_2" }),
      ])
    );

    const symbolById = new Map(snapshot.symbols.map((symbol) => [symbol.id, symbol.name]));
    const fieldById = new Map(snapshot.fields.map((field) => [field.id, `${field.tableName}.${field.fieldName}`]));

    expect(
      snapshot.fieldDependencies.map((dependency) => ({
        field: fieldById.get(dependency.fieldId),
        owner: symbolById.get(dependency.symbolId),
      }))
    ).toEqual(
      expect.arrayContaining([
        { field: "dbo.Users.Name", owner: "LoadUsers" },
        { field: "ERP.SIGNB.MARK_2", owner: "SaveOrders" },
      ])
    );

    const impact = await runImpactAnalysis(1, 7, "ERP.SIGNB.MARK_2", "sql_field");
    expect(impact.affectedFields).toEqual([{ table: "ERP.SIGNB", field: "MARK_2" }]);
    expect(impact.affectedSymbols.map((symbol) => symbol.name)).toEqual(["SaveOrders"]);
  });

  it("returns a complete analysis snapshot", async () => {
    const { getAnalysisSnapshot } = await import("./projectWorkflow");
    fakeDb.store.projects.push({ id: 1, userId: 7, status: "completed", importWarningsJson: [{ code: "IMPORT_ENCODING_DETECTED", message: "Detected Big5 encoding.", filePath: "legacy.pas" }] });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# FLOW",
      dataDependencyMarkdown: "# DATA_DEPENDENCY",
      risksMarkdown: "# RISKS",
      rulesYaml: "rules: []",
      summaryJson: { fileCount: 1 },
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "main", type: "function", startLine: 1, endLine: 3, signature: "func main()", description: null });
    fakeDb.store.fields.push({ id: 1, projectId: 1, tableName: "orders", fieldName: "amount", fieldType: null, description: null });
    fakeDb.store.dependencies.push({ id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetExternalName: "external", targetKind: "unresolved", dependencyType: "references", lineNumber: 2 });
    fakeDb.store.fieldDependencies.push({ id: 1, projectId: 1, fieldId: 1, symbolId: 1, operationType: "read", lineNumber: 2, context: "SELECT amount FROM orders" });

    const snapshot = await getAnalysisSnapshot(1, 7);

    expect(snapshot.report?.status).toBe("completed");
    expect(snapshot.symbols).toHaveLength(1);
    expect(snapshot.dependencies[0]).toMatchObject({
      targetSymbolId: null,
      targetExternalName: "external",
      targetKind: "unresolved",
    });
    expect(snapshot.fields).toHaveLength(1);
    expect(snapshot.fieldDependencies[0]?.fieldId).toBe(1);
    expect(snapshot.importWarnings).toEqual([{ code: "IMPORT_ENCODING_DETECTED", message: "Detected Big5 encoding.", filePath: "legacy.pas" }]);
  });

  it("builds a downloadable report archive with the expected files", async () => {
    const { buildReportArchive } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "report-project",
      language: "go",
      status: "completed",
      importWarningsJson: [{ code: "IMPORT_LIMITED_ANALYSIS", message: "Imported with limited analysis.", filePath: "Form1.dfm" }],
    });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "main", type: "function", startLine: 1, endLine: 1, signature: "func main()", description: null });
    fakeDb.store.dependencies.push({ id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetExternalName: "external.Dependency", targetKind: "unresolved", dependencyType: "references", lineNumber: 1 });
    fakeDb.store.risks.push({ id: 1, projectId: 1, title: "Critical risk", severity: "high", sourceFile: "main.go", lineNumber: 1 });
    fakeDb.store.rules.push({ id: 1, projectId: 1, name: "MainRule", ruleType: "validation", sourceFile: "main.go", lineNumber: 1 });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# FLOW",
      dataDependencyMarkdown: "# DATA_DEPENDENCY",
      risksMarkdown: "# RISKS",
      rulesYaml: "rules: []",
      summaryJson: { fileCount: 1 },
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const archive = await buildReportArchive(1, 7);
    const archiveAgain = await buildReportArchive(1, 7);
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));
    const zipAgain = await JSZip.loadAsync(Buffer.from(archiveAgain.base64, "base64"));
    const zipFileNames = Object.keys(zip.files).sort((left, right) => left.localeCompare(right));

    expect(archive.mimeType).toBe("application/zip");
    expect(archive.base64).toBe(archiveAgain.base64);
    expect(zip.file("FLOW.md")).toBeTruthy();
    expect(zip.file("metadata.json")).toBeTruthy();
    expect(zip.file("analysis-summary.json")).toBeTruthy();
    expect(zip.file("import-warnings.json")).toBeTruthy();
    expect(zip.file("DATA_DEPENDENCY.md")).toBeTruthy();
    expect(zip.file("RISKS.md")).toBeTruthy();
    expect(zip.file("RULES.yaml")).toBeTruthy();
    expect(zip.file("IMPACT_ANALYSIS.md")).toBeTruthy();
    await expect(zip.file("impact-analysis.json")!.async("text")).resolves.toContain("\"topImpactedFiles\"");
    await expect(zip.file("analysis-summary.json")!.async("text")).resolves.toContain("\"importWarnings\"");
    await expect(zip.file("analysis-summary.json")!.async("text")).resolves.toContain("\"limitationSummary\"");
    await expect(zip.file("import-warnings.json")!.async("text")).resolves.toContain("IMPORT_LIMITED_ANALYSIS");
    await Promise.all(
      zipFileNames.map(async (fileName) => {
        const [firstContent, secondContent] = await Promise.all([
          zip.file(fileName)!.async("text"),
          zipAgain.file(fileName)!.async("text"),
        ]);
        expect(firstContent).toBe(secondContent);
      })
    );
  });

  it("deletes the full project graph", async () => {
    const { deleteProjectCascade } = await import("./projectWorkflow");
    fakeDb.store.projects.push({ id: 1, userId: 7, status: "completed" });
    fakeDb.store.files.push({ id: 1, projectId: 1 });
    fakeDb.store.analysisResults.push({ id: 1, projectId: 1 });
    fakeDb.store.symbols.push({ id: 1, projectId: 1 });
    fakeDb.store.dependencies.push({ id: 1, projectId: 1 });
    fakeDb.store.fields.push({ id: 1, projectId: 1 });
    fakeDb.store.fieldDependencies.push({ id: 1, projectId: 1 });
    fakeDb.store.risks.push({ id: 1, projectId: 1 });
    fakeDb.store.rules.push({ id: 1, projectId: 1 });

    await deleteProjectCascade(1, 7);

    expect(fakeDb.store.projects).toHaveLength(0);
    expect(fakeDb.store.files).toHaveLength(0);
    expect(fakeDb.store.analysisResults).toHaveLength(0);
    expect(fakeDb.store.symbols).toHaveLength(0);
    expect(fakeDb.store.dependencies).toHaveLength(0);
    expect(fakeDb.store.fields).toHaveLength(0);
    expect(fakeDb.store.fieldDependencies).toHaveLength(0);
    expect(fakeDb.store.risks).toHaveLength(0);
    expect(fakeDb.store.rules).toHaveLength(0);
  });
});
