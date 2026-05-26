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
const cloneAndExtractFilesMock = vi.fn(async () => ({ files: gitFiles, warnings: importWarnings }));
const { readFileMock, rmMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(async () => Buffer.from("zip-bytes")),
  rmMock: vi.fn(async () => undefined),
}));

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

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: readFileMock,
    rm: rmMock,
  };
});

vi.mock("../utils/zipHandler", () => ({
  SUPPORTED_SOURCE_EXTENSIONS: [".go", ".sql", ".pas"],
  extractFilesFromZip: vi.fn(async () => ({ files: zipFiles, warnings: importWarnings })),
  extractFilesFromZipBuffer: vi.fn(async () => ({ files: zipFiles, warnings: importWarnings })),
}));

vi.mock("../utils/gitHandler", () => ({
  validateSafeGitUrl: vi.fn(async (url: string) => ({
    gitUrl: String(url).trim(),
    host: "example.com",
    resolvedAddresses: [{ address: "93.184.216.34", family: 4 }],
    allowlist: null,
    production: false,
  })),
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
  if (condition.type === "eq") return row[condition.column] === condition.value;
  if (condition.type === "inArray") return condition.values.includes(row[condition.column]);
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

  if (!selection) return rows;

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
    projectJobs: [],
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
            let affectedRows = 0;
            store[tableName] = store[tableName].map((row) => {
              if (!matches(condition, row)) {
                return row;
              }

              affectedRows += 1;
              return { ...row, ...updates };
            });

            return { affectedRows };
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

function seedProject(projectId = 1, overrides?: Row) {
  fakeDb.store.projects.push({
    id: projectId,
    userId: 7,
    name: `project-${projectId}`,
    language: "go",
    sourceType: "upload",
    status: "ready",
    importProgress: 100,
    analysisProgress: 0,
    errorMessage: null,
    lastErrorCode: null,
    importWarningsJson: [],
    ...overrides,
  });
}

beforeEach(() => {
  fakeDb = createFakeDb();
  zipFiles = [];
  gitFiles = [];
  importWarnings = [];
  analyzerResult = null;
  failRootProjectReadsDuringTransaction = false;
  transactionDepth = 0;
  cloneAndExtractFilesMock.mockClear();
  readFileMock.mockClear();
  readFileMock.mockImplementation(async () => Buffer.from("zip-bytes"));
  rmMock.mockClear();
  rmMock.mockImplementation(async () => undefined);
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
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
    });
  });

  it("imports files from ZIP and Git, persisting warnings and source url", async () => {
    const { getOwnedProject, importProjectGit, importProjectZip } = await import("./projectWorkflow");
    fakeDb.store.projects.push(
      {
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
        importWarningsJson: [],
      },
      {
        id: 2,
        userId: 7,
        name: "git-project",
        language: "go",
        sourceType: "git",
        status: "draft",
        importProgress: 0,
        analysisProgress: 0,
        errorMessage: null,
        lastErrorCode: null,
        importWarningsJson: [],
      }
    );
    zipFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
    gitFiles = [{ path: "repo/main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
    importWarnings = [{ code: "IMPORT_LIMITED_ANALYSIS", message: "Imported with limited analysis.", filePath: "form.dfm" }];

    const zipResult = await importProjectZip(1, 7, "encoded");
    const gitResult = await importProjectGit(2, 7, "https://example.com/org/repo.git");
    const zipProject = await getOwnedProject(1, 7);
    const gitProject = await getOwnedProject(2, 7);

    expect(zipResult.files).toHaveLength(1);
    expect(gitResult.files).toHaveLength(1);
    expect(zipProject.importWarningsJson).toEqual(importWarnings);
    expect(gitProject.importWarningsJson).toEqual(importWarnings);
    expect(gitProject.sourceUrl).toBe("https://example.com/org/repo.git");
  });

  it("writes back analysis artifacts and keeps transitions on the transaction handle", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    failRootProjectReadsDuringTransaction = true;
    seedProject();
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
      schemaFields: [],
      risks: [{ title: "Date literal", description: "hard-coded date", severity: "medium", category: "magic_value", sourceFile: "main.go", lineNumber: 2, suggestion: "Use a constant." }],
      rules: [{ ruleType: "magic_value", name: "externalize_main_go_2", description: "Date literal", condition: "hard-coded date", sourceFile: "main.go", lineNumber: 2 }],
      warnings: [{ code: "LANGUAGE_UNSUPPORTED", message: "Skipped 1 file", level: "warning", filePath: "legacy.txt" }],
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
    expect(fakeDb.store.analysisResults[0]).toMatchObject({ status: "partial" });
    expect(fakeDb.store.symbols).toHaveLength(2);
    expect(fakeDb.store.dependencies).toHaveLength(1);
    expect(fakeDb.store.fields).toHaveLength(1);
    expect(fakeDb.store.fieldDependencies).toHaveLength(1);
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed", analysisProgress: 100 });
  });

  it("returns a light snapshot summary instead of full arrays", async () => {
    const { getAnalysisSnapshot } = await import("./projectWorkflow");
    seedProject(1, { status: "completed", importWarningsJson: [{ code: "IMPORT_ENCODING_DETECTED", message: "Detected Big5 encoding.", filePath: "legacy.pas" }] });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
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
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "main", type: "function", startLine: 1, endLine: 3 });
    fakeDb.store.fields.push({ id: 1, projectId: 1, tableName: "orders", fieldName: "amount", fieldType: null, description: null });
    fakeDb.store.fieldDependencies.push({ id: 1, projectId: 1, fieldId: 1, symbolId: 1, operationType: "read", lineNumber: 2, context: "SELECT amount FROM orders" });
    fakeDb.store.risks.push({ id: 1, projectId: 1, riskType: "magic_value", severity: "high", title: "Risk", sourceFile: "main.go", lineNumber: 2 });
    fakeDb.store.rules.push({ id: 1, projectId: 1, ruleType: "validation", name: "Rule", sourceFile: "main.go", lineNumber: 3 });

    const snapshot = await getAnalysisSnapshot(1, 7);

    expect(snapshot.report?.status).toBe("completed");
    expect(snapshot.importWarnings).toHaveLength(1);
    expect(snapshot.totals).toMatchObject({
      files: 1,
      symbols: 1,
      fields: 1,
      fieldDependencies: 1,
      risks: 1,
      rules: 1,
    });
    expect(snapshot.topSymbols).toHaveLength(1);
    expect(snapshot.fieldTables).toEqual([
      expect.objectContaining({ tableName: "orders", fieldCount: 1, readCount: 1, writeCount: 0, referenceCount: 1 }),
    ]);
    expect("symbols" in snapshot).toBe(false);
  });

  it("pages and filters symbols, fields, risks, dependencies, and field dependencies on the backend", async () => {
    const { getDependenciesPage, getFieldDependenciesPage, getFieldsPage, getRisksPage, getSymbolsPage } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.files.push(
      { id: 1, projectId: 1, filePath: "src/users.pas", fileName: "users.pas", fileType: ".pas", status: "stored" },
      { id: 2, projectId: 1, filePath: "src/orders.pas", fileName: "orders.pas", fileType: ".pas", status: "stored" }
    );
    for (let index = 0; index < 30; index += 1) {
      fakeDb.store.symbols.push({
        id: index + 1,
        projectId: 1,
        fileId: index % 2 === 0 ? 1 : 2,
        name: index % 2 === 0 ? `LoadUser${index}` : `SaveOrder${index}`,
        type: index % 2 === 0 ? "procedure" : "method",
        startLine: index + 1,
        endLine: index + 2,
      });
    }
    fakeDb.store.fields.push(
      { id: 1, projectId: 1, tableName: "dbo.Users", fieldName: "Name", fieldType: null, description: null },
      { id: 2, projectId: 1, tableName: "ERP.SIGNB", fieldName: "MARK_2", fieldType: null, description: null }
    );
    fakeDb.store.fieldDependencies.push(
      { id: 1, projectId: 1, fieldId: 1, symbolId: 1, operationType: "read", lineNumber: 2, context: "SELECT Name FROM dbo.Users" },
      { id: 2, projectId: 1, fieldId: 2, symbolId: 2, operationType: "write", lineNumber: 3, context: "UPDATE ERP.SIGNB SET MARK_2 = 1" }
    );
    fakeDb.store.risks.push(
      { id: 1, projectId: 1, riskType: "magic_value", severity: "high", title: "Shared risk", description: "message one", sourceFile: "src/users.pas", lineNumber: 10, recommendation: null },
      { id: 2, projectId: 1, riskType: "other", severity: "low", title: "Minor issue", description: "message two", sourceFile: "src/orders.pas", lineNumber: 20, recommendation: null }
    );
    fakeDb.store.dependencies.push(
      { id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: 2, targetExternalName: null, targetKind: "internal", dependencyType: "calls", lineNumber: 11 },
      { id: 2, projectId: 1, sourceSymbolId: 2, targetSymbolId: null, targetExternalName: "LegacyApi", targetKind: "external", dependencyType: "references", lineNumber: 22 }
    );

    const symbolsPage = await getSymbolsPage({ projectId: 1, page: 2, pageSize: 10, search: "loaduser", kind: "procedure" }, 7);
    const fieldsPage = await getFieldsPage({ projectId: 1, page: 1, pageSize: 25, tableName: "ERP.SIGNB", search: "mark" }, 7);
    const risksPage = await getRisksPage({ projectId: 1, page: 1, pageSize: 25, severity: "high", search: "shared" }, 7);
    const dependenciesPage = await getDependenciesPage({ projectId: 1, page: 1, pageSize: 25, targetKind: "external", search: "legacy" }, 7);
    const fieldDependenciesPage = await getFieldDependenciesPage({ projectId: 1, page: 1, pageSize: 25, tableName: "ERP.SIGNB", operationType: "write", search: "mark" }, 7);

    expect(symbolsPage.total).toBe(15);
    expect(symbolsPage.page).toBe(2);
    expect(symbolsPage.items).toHaveLength(5);
    expect(symbolsPage.items[0]?.name).toContain("LoadUser");
    expect(fieldsPage.items).toEqual([expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_2", writeCount: 1 })]);
    expect(risksPage.items).toEqual([expect.objectContaining({ title: "Shared risk", severity: "high" })]);
    expect(dependenciesPage.items).toEqual([expect.objectContaining({ targetExternalName: "LegacyApi", targetKind: "external" })]);
    expect(fieldDependenciesPage.items).toEqual([expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_2", operationType: "write" })]);
  });

  it("recovers stale running jobs during server startup", async () => {
    const { recoverStaleProjectJobsOnStartup } = await import("./projectWorkflow");
    seedProject(1, { status: "analyzing", analysisProgress: 42 });
    seedProject(2, { status: "ready", analysisProgress: 0 });
    fakeDb.store.projectJobs.push(
      {
        id: 1,
        projectId: 1,
        userId: 7,
        type: "analyze",
        status: "running",
        progress: 70,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        finishedAt: null,
      },
      {
        id: 2,
        projectId: 2,
        userId: 7,
        type: "analyze",
        status: "running",
        progress: 20,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        startedAt: new Date("2026-01-02T00:14:00.000Z"),
        finishedAt: null,
      }
    );

    const recovered = await recoverStaleProjectJobsOnStartup(new Date("2026-01-02T00:16:00.000Z"), 15 * 60 * 1000);

    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "analyzing" });
    expect(fakeDb.store.projectJobs[1]).toMatchObject({ status: "running" });
  });

  it("replays queued analyze jobs on startup and fails stuck project states without active jobs", async () => {
    const { recoverStaleProjectJobsOnStartup, waitForProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "analyzing", analysisProgress: 0 });
    seedProject(2, { status: "importing", importProgress: 50 });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });
    analyzerResult = {
      projectId: 1,
      status: "completed",
      language: "go",
      symbols: [],
      dependencies: [],
      fieldReferences: [],
      schemaFields: [],
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

    const recovered = await recoverStaleProjectJobsOnStartup(new Date("2026-01-02T00:16:00.000Z"), 15 * 60 * 1000);
    await waitForProjectJobForTests(1);

    expect(recovered).toBe(1);
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ status: "completed", activeKey: null });
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed" });
    expect(fakeDb.store.projects[1]).toMatchObject({
      status: "failed",
      lastErrorCode: "PROJECT_JOB_STALE",
      importProgress: 0,
    });
  });

  it("skips startup recovery when the project worker is disabled", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";
    seedProject(1, { status: "analyzing", analysisProgress: 42 });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "running",
      progress: 70,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: null,
    });

    const { recoverStaleProjectJobsOnStartup } = await import("./projectWorkflow");

    try {
      const recovered = await recoverStaleProjectJobsOnStartup(new Date("2026-01-02T00:16:00.000Z"), 15 * 60 * 1000);

      expect(recovered).toBe(0);
      expect(fakeDb.store.projectJobs[0]).toMatchObject({ status: "running" });
      expect(fakeDb.store.projects[0]).toMatchObject({ status: "analyzing" });
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("creates async jobs, persists success/failure, and rejects duplicate analyze jobs", async () => {
    const { getProjectJob, queueAnalyzeProject, waitForProjectJobForTests } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    analyzerResult = {
      projectId: 1,
      status: "completed",
      language: "go",
      symbols: [],
      dependencies: [],
      fieldReferences: [],
      schemaFields: [],
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

    const queued = await queueAnalyzeProject(1, 7);
    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await waitForProjectJobForTests(queued.jobId);
    const completedJob = await getProjectJob(queued.jobId, 7);
    expect(completedJob.status).toBe("completed");
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed" });

    fakeDb.store.projects[0] = { ...fakeDb.store.projects[0], status: "ready", analysisProgress: 0, errorMessage: null, lastErrorCode: null };
    analyzerResult = {
      projectId: 1,
      status: "failed",
      language: "go",
      symbols: [],
      dependencies: [],
      fieldReferences: [],
      schemaFields: [],
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

    const failed = await queueAnalyzeProject(1, 7);
    await waitForProjectJobForTests(failed.jobId);
    const failedJob = await getProjectJob(failed.jobId, 7);
    expect(failedJob.status).toBe("failed");
    expect(failedJob.errorCode).toBe("ANALYSIS_FAILED");
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "failed", lastErrorCode: "ANALYSIS_FAILED" });
  });

  it("fails a claimed job when payloadJson is invalid instead of leaving it running", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    seedProject(1, { status: "importing", importProgress: 10 });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 10,
      errorCode: null,
      errorMessage: null,
      payloadJson: "{invalid-json",
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
    });

    await expect(runClaimedProjectJob(1)).rejects.toMatchObject({ code: "PROJECT_JOB_STALE" });

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      activeKey: null,
      errorCode: "PROJECT_JOB_STALE",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "PROJECT_JOB_STALE",
    });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("fails a claimed import job, preserves an import failure code, and cleans its temp file", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    seedProject(1, { status: "importing", importProgress: 10 });
    readFileMock.mockRejectedValueOnce(new Error("disk read failed"));
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 10,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/queued-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
    });

    await expect(runClaimedProjectJob(1)).rejects.toMatchObject({ code: "IMPORT_FAILED" });

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      errorCode: "IMPORT_FAILED",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "IMPORT_FAILED",
    });
    expect(rmMock).toHaveBeenCalledWith("C:/tmp/queued-upload.zip", { force: true });
  });

  it("still fails the job when temp file cleanup itself errors", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    seedProject(1, { status: "importing", importProgress: 10 });
    readFileMock.mockRejectedValueOnce(new Error("disk read failed"));
    rmMock.mockRejectedValueOnce(new Error("cleanup denied"));
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 10,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/queued-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
    });

    await expect(runClaimedProjectJob(1)).rejects.toMatchObject({ code: "IMPORT_FAILED" });

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      errorCode: "IMPORT_FAILED",
    });
    expect(rmMock).toHaveBeenCalledWith("C:/tmp/queued-upload.zip", { force: true });
  });

  it("prevents the same queued job from being claimed twice", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "ready" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });

    const firstClaim = await claimNextQueuedProjectJobForTests();
    const secondClaim = await claimNextQueuedProjectJobForTests();

    expect(firstClaim).toMatchObject({ id: 1, status: "running" });
    expect(secondClaim).toBeNull();
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ id: 1, status: "running" });
  });

  it("treats a queued job as claimed even when the stored timestamp loses milliseconds", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "ready" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });

    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) =>
          baseUpdate.set({
            ...updates,
            startedAt:
              updates.startedAt instanceof Date
                ? new Date(Math.floor(updates.startedAt.getTime() / 1000) * 1000)
                : updates.startedAt,
          }),
      };
    };

    const claim = await claimNextQueuedProjectJobForTests();

    expect(claim).toMatchObject({ id: 1, status: "running" });
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ id: 1, status: "running" });
    expect(fakeDb.store.projectJobs[0]?.startedAt).toBeInstanceOf(Date);
  });

  it("allows only one worker to claim the same queued job under concurrent pressure", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "ready" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });

    let releaseFirstUpdate: (() => void) | null = null;
    let updateCallCount = 0;
    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            updateCallCount += 1;
            if (getTableName(table) === "projectJobs" && updateCallCount === 1) {
              await new Promise<void>((resolve) => {
                releaseFirstUpdate = resolve;
              });
            }
            return baseUpdate.set(updates).where(condition);
          },
        }),
      };
    };

    const firstClaimPromise = claimNextQueuedProjectJobForTests();
    await Promise.resolve();
    const secondClaimPromise = claimNextQueuedProjectJobForTests();
    const secondClaim = await secondClaimPromise;
    const unblockFirstUpdate: () => void =
      releaseFirstUpdate ??
      (() => {
        throw new Error("Expected first project job update to be blocked before releasing it.");
      });
    unblockFirstUpdate();
    const firstClaim = await firstClaimPromise;
    const claimedJobs = [firstClaim, secondClaim].filter(Boolean);

    expect(claimedJobs).toHaveLength(1);
    expect(claimedJobs[0]).toMatchObject({ id: 1, status: "running" });
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ id: 1, status: "running" });
  });

  it("reclaims a running job after its lease expires", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "analyzing" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "running",
      progress: 25,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      lockedBy: "worker-old",
      heartbeatAt: new Date("2026-01-01T00:00:10.000Z"),
      leaseUntil: new Date("2026-01-01T00:00:20.000Z"),
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      finishedAt: null,
    });

    const claim = await claimNextQueuedProjectJobForTests();

    expect(claim).toMatchObject({ id: 1, status: "running", attemptCount: 2 });
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      id: 1,
      status: "running",
      attemptCount: 2,
      lockedBy: expect.any(String),
      heartbeatAt: expect.any(Date),
      leaseUntil: expect.any(Date),
    });
  });

  it("rejects overlapping import and analyze jobs for the same project", async () => {
    const { queueAnalyzeProject, queueImportProjectGit, queueImportProjectZip } = await import("./projectWorkflow");
    seedProject(1, { status: "ready" });

    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", zipContent: "encoded" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });
    fakeDb.store.projects[0] = { ...fakeDb.store.projects[0], status: "importing" };

    await expect(queueImportProjectZip(1, 7, "encoded")).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await expect(queueImportProjectGit(1, 7, "https://example.com/repo.git")).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });

    fakeDb.store.projectJobs = [];
    fakeDb.store.projects[0] = { ...fakeDb.store.projects[0], status: "ready", importProgress: 0, analysisProgress: 0 };

    fakeDb.store.projectJobs.push({
      id: 2,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "running",
      progress: 50,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
    });
    fakeDb.store.projects[0] = { ...fakeDb.store.projects[0], status: "analyzing" };

    await expect(queueImportProjectGit(1, 7, "https://example.com/repo.git")).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await expect(queueImportProjectZip(1, 7, "encoded")).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
  });

  it("refuses to delete a project while queued or running jobs still exist", async () => {
    const { deleteProjectCascade } = await import("./projectWorkflow");
    seedProject(1, { status: "importing" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });

    await expect(deleteProjectCascade(1, 7)).rejects.toMatchObject({ code: "DELETE_FAILED" });
    expect(fakeDb.store.projects).toHaveLength(1);
    expect(fakeDb.store.projectJobs).toHaveLength(1);
  });

  it("enforces ownership on paged reads and job reads", async () => {
    const { getProjectJob, getSymbolsPage, queueAnalyzeProject, waitForProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { userId: 7 });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    analyzerResult = {
      projectId: 1,
      status: "completed",
      language: "go",
      symbols: [],
      dependencies: [],
      fieldReferences: [],
      schemaFields: [],
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

    const job = await queueAnalyzeProject(1, 7);
    await waitForProjectJobForTests(job.jobId);

    await expect(getSymbolsPage({ projectId: 1, page: 1, pageSize: 25 }, 99)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(getProjectJob(job.jobId, 99)).rejects.toMatchObject({ code: "PROJECT_JOB_NOT_FOUND" });
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
    fakeDb.store.risks.push({ id: 1, projectId: 1, riskType: "magic_value", title: "Critical risk", severity: "high", sourceFile: "main.go", lineNumber: 1 });
    fakeDb.store.rules.push({ id: 1, projectId: 1, ruleType: "validation", name: "MainRule", sourceFile: "main.go", lineNumber: 1 });
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
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));

    expect(archive.mimeType).toBe("application/zip");
    expect(zip.file("FLOW.md")).toBeTruthy();
    expect(zip.file("DATA_DEPENDENCY.md")).toBeTruthy();
    expect(zip.file("RISKS.md")).toBeTruthy();
    expect(zip.file("RULES.yaml")).toBeTruthy();
    expect(zip.file("IMPACT_ANALYSIS.md")).toBeTruthy();
    await expect(zip.file("impact-analysis.json")!.async("text")).resolves.toContain("\"topImpactedFiles\"");
  });

  it("fails oversized report exports before ZIP generation allocates the archive buffer", async () => {
    const { buildReportArchiveBuffer } = await import("./projectWorkflow");
    const generateSpy = vi.spyOn(JSZip.prototype, "generateAsync");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "oversized-report",
      language: "go",
      status: "completed",
      importWarningsJson: [],
    });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "A".repeat(10 * 1024 * 1024),
      dataDependencyMarkdown: "B".repeat(10 * 1024 * 1024),
      risksMarkdown: "C".repeat(10 * 1024 * 1024),
      rulesYaml: "rules: []",
      summaryJson: { fileCount: 1 },
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(buildReportArchiveBuffer(1, 7)).rejects.toMatchObject({ code: "REPORT_TOO_LARGE" });
    expect(generateSpy).not.toHaveBeenCalled();
  });
});
