import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "and"; conditions: Condition[] }
  | undefined;
type SortOrder = { type: "desc"; column: string } | undefined;

let zipFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let gitFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let analyzerResult: Record<string, unknown> | null = null;
let fakeDb: ReturnType<typeof createFakeDb>;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ type: "eq", column: column.name, value }),
    and: (...conditions: Condition[]) => ({ type: "and", conditions: conditions.filter(Boolean) as Condition[] }),
    desc: (column: { name: string }) => ({ type: "desc", column: column.name }),
  };
});

vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

vi.mock("../utils/zipHandler", () => ({
  SUPPORTED_EXTENSIONS: [".go", ".sql", ".pas"],
  validateZipFile: vi.fn(async () => true),
  extractFilesFromZip: vi.fn(async () => zipFiles),
}));

vi.mock("../utils/gitHandler", () => ({
  isValidGitUrl: vi.fn((url: string) => /^https:\/\/example\.com\/.+/.test(url)),
  cloneAndExtractFiles: vi.fn(async () => gitFiles),
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
    transaction: async <T>(callback: (tx: typeof db) => Promise<T>) => callback(db),
  };

  return db;
}

beforeEach(() => {
  fakeDb = createFakeDb();
  zipFiles = [];
  gitFiles = [];
  analyzerResult = null;
});

describe("project workflow", () => {
  it("creates a project in draft state", async () => {
    const { createProjectForUser } = await import("./projectWorkflow");

    const projectId = await createProjectForUser(7, {
      name: "demo",
      description: "sample",
      language: "go",
      sourceType: "upload",
    });

    expect(projectId).toBe(1);
    expect(fakeDb.store.projects[0]).toMatchObject({
      userId: 7,
      name: "demo",
      status: "draft",
      importProgress: 0,
      analysisProgress: 0,
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
    expect(fakeDb.store.files).toHaveLength(2);
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "ready",
      importProgress: 100,
      analysisProgress: 0,
    });
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
    expect(fakeDb.store.projects[0]).toMatchObject({
      sourceUrl: "https://example.com/org/repo.git",
      status: "ready",
    });
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
        analyzedFileCount: 1,
        skippedFileCount: 1,
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

  it("returns a complete analysis snapshot", async () => {
    const { getAnalysisSnapshot } = await import("./projectWorkflow");
    fakeDb.store.projects.push({ id: 1, userId: 7, status: "completed" });
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "main", type: "function", startLine: 1, endLine: 3, signature: "func main()", description: null });
    fakeDb.store.fields.push({ id: 1, projectId: 1, tableName: "orders", fieldName: "amount", fieldType: null, description: null });
    fakeDb.store.fieldDependencies.push({ id: 1, projectId: 1, fieldId: 1, symbolId: 1, operationType: "read", lineNumber: 2, context: "SELECT amount FROM orders" });

    const snapshot = await getAnalysisSnapshot(1, 7);

    expect(snapshot.report?.status).toBe("completed");
    expect(snapshot.symbols).toHaveLength(1);
    expect(snapshot.fields).toHaveLength(1);
    expect(snapshot.fieldDependencies[0]?.fieldId).toBe(1);
  });

  it("builds a downloadable report archive with the expected files", async () => {
    const { buildReportArchive } = await import("./projectWorkflow");
    fakeDb.store.projects.push({ id: 1, userId: 7, name: "report-project", status: "completed" });
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const archive = await buildReportArchive(1, 7);
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));

    expect(archive.mimeType).toBe("application/zip");
    expect(zip.file("FLOW.md")).toBeTruthy();
    expect(zip.file("analysis-summary.json")).toBeTruthy();
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
