import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DependenciesPageInput, RisksPageInput } from "../../shared/contracts";
import type { ProjectAnalysisResult } from "../analyzer/types";
import { AppError } from "../appError";
import { parseAnalysisSnapshotStrict } from "./analysisHistory";
import { calculateSourceFingerprint } from "./sourceFingerprint";
import { createAnalysisResultFixture, createValidAnalysisRunFixture } from "./projectWorkflow.test.helpers";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type DependencyListOptions = Omit<DependenciesPageInput, "hideStandardLibrary"> & Partial<Pick<DependenciesPageInput, "hideStandardLibrary">>;
type RiskListOptions = Omit<RisksPageInput, "criticalOnly" | "hideDuplicates"> &
  Partial<Pick<RisksPageInput, "criticalOnly" | "hideDuplicates">>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "inArray"; column: string; values: unknown[] }
  | { type: "and"; conditions: Condition[] }
  | undefined;
type SortOrder = Array<{ type: "asc" | "desc"; column: string }> | undefined;

let zipFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let gitFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let importWarnings: Array<{ code: string; message: string; filePath?: string }> = [];
let analyzerResult: ProjectAnalysisResult | null = null;
let analyzerError: Error | null = null;
let fakeDb: ReturnType<typeof createFakeDb>;
let failRootProjectReadsDuringTransaction = false;
let failNextProjectJobInsert = false;
let transactionDepth = 0;
let projectProgressUpdates: number[] = [];
let jobProgressUpdates: number[] = [];
const cloneAndExtractFilesMock = vi.fn(async () => ({ files: gitFiles, warnings: importWarnings }));
const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const { readFileMock, rmMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(async () => Buffer.from("zip-bytes")),
  rmMock: vi.fn(async () => undefined),
}));

function dependencyListOptions(options: DependencyListOptions): DependenciesPageInput {
  return { hideStandardLibrary: false, ...options };
}

function riskListOptions(options: RiskListOptions): RisksPageInput {
  return { criticalOnly: false, hideDuplicates: false, ...options };
}

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ type: "eq", column: column.name, value }),
    inArray: (column: { name: string }, values: unknown[]) => ({ type: "inArray", column: column.name, values }),
    and: (...conditions: Condition[]) => ({ type: "and", conditions: conditions.filter(Boolean) as Condition[] }),
    asc: (column: { name: string }) => ({ type: "asc", column: column.name }),
    desc: (column: { name: string }) => ({ type: "desc", column: column.name }),
  };
});

vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

vi.mock("../_core/logger", () => ({
  logger: loggerMock,
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
      if (analyzerError) {
        throw analyzerError;
      }
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

function selectRows(store: Store, table: object, condition: Condition, sort: SortOrder, limit?: number, selection?: Row, offset = 0) {
  let rows = [...store[getTableName(table)]];
  rows = rows.filter((row) => matches(condition, row));

  if (sort && sort.length > 0) {
    rows.sort((left, right) => {
      for (const entry of sort) {
        const leftValue = left[entry.column];
        const rightValue = right[entry.column];
        if (leftValue === rightValue) continue;
        const leftComparable = leftValue instanceof Date ? leftValue.getTime() : leftValue;
        const rightComparable = rightValue instanceof Date ? rightValue.getTime() : rightValue;
        if (leftComparable === rightComparable) continue;
        const comparison = leftComparable! < rightComparable! ? -1 : 1;
        return entry.type === "desc" ? comparison * -1 : comparison;
      }
      return 0;
    });
  }

  if (offset > 0) {
    rows = rows.slice(offset);
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
    analysisBaselines: [],
    ...initialStore,
  };

  const idCounters = new Map<string, number>(
    Object.entries(store).map(([key, rows]) => [key, rows.reduce((max, row) => Math.max(max, Number(row.id ?? 0)), 0)])
  );

  const cloneStore = () =>
    Object.fromEntries(Object.entries(store).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))])) as Store;

  const cloneCounters = () => new Map(idCounters);

  const restoreStore = (snapshot: Store) => {
    for (const key of Object.keys(store)) {
      store[key] = snapshot[key].map((row) => ({ ...row }));
    }
  };

  class SelectQuery {
    private condition: Condition;
    private limitCount?: number;
    private sort?: SortOrder;
    private offsetCount = 0;

    constructor(private readonly selection?: Row, private readonly table?: object) {}

    from(table: object) {
      return new SelectQuery(this.selection, table);
    }

    where(condition: Condition) {
      this.condition = condition;
      return this;
    }

    orderBy(...sorts: Array<{ type: "asc" | "desc"; column: string } | undefined>) {
      this.sort = sorts.filter(Boolean) as SortOrder;
      return this;
    }

    limit(count: number) {
      this.limitCount = count;
      return this;
    }

    offset(count: number) {
      this.offsetCount = count;
      return this;
    }

    then<TResult1 = Row[], TResult2 = never>(
      onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      const value = selectRows(store, this.table as object, this.condition, this.sort, this.limitCount, this.selection, this.offsetCount);
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
          if (tableName === "projectJobs" && failNextProjectJobInsert) {
            failNextProjectJobInsert = false;
            throw new Error("project job insert failed");
          }

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
            if (tableName === "projects") {
              if (typeof updates.analysisProgress === "number") {
                projectProgressUpdates.push(updates.analysisProgress);
              }
              if (typeof updates.importProgress === "number") {
                projectProgressUpdates.push(updates.importProgress);
              }
            }
            if (tableName === "projectJobs" && typeof updates.progress === "number") {
              jobProgressUpdates.push(updates.progress);
            }
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
      const storeSnapshot = cloneStore();
      const counterSnapshot = cloneCounters();
      transactionDepth += 1;
      const tx = {
        ...db,
        select(selection?: Row) {
          return new SelectQuery(selection);
        },
      };
      try {
        return await callback(tx);
      } catch (error) {
        restoreStore(storeSnapshot);
        idCounters.clear();
        for (const [key, value] of counterSnapshot) {
          idCounters.set(key, value);
        }
        throw error;
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
    sourceFingerprint: null,
    ...overrides,
  });
}

function claimedOwnership(overrides: Row = {}): Row {
  return {
    lockedBy: "worker-a",
    heartbeatAt: new Date("2026-01-01T00:01:05.000Z"),
    leaseUntil: new Date("2099-01-01T00:02:00.000Z"),
    attemptCount: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function createPersistenceAnalysisResult() {
  return createAnalysisResultFixture({
    projectId: 1,
    status: "completed",
    symbols: [
      { stableKey: "main.go::main::1", name: "main", type: "function", file: "main.go", startLine: 1, endLine: 5, signature: "func main()" },
      { stableKey: "repo.sql::query_1::1", name: "query_1", type: "query", file: "repo.sql", startLine: 1, endLine: 1, signature: "SELECT amount FROM orders" },
    ],
    dependencies: [{ from: "main.go::main::1", to: "repo.sql::query_1::1", fromName: "main", toName: "query_1", type: "calls", line: 3 }],
    fieldReferences: [{ table: "orders", field: "amount", type: "read", file: "repo.sql", line: 1, symbolStableKey: "repo.sql::query_1::1", context: "SELECT amount FROM orders" }],
    risks: [{ title: "Date literal", description: "hard-coded date", severity: "medium", category: "magic_value", sourceFile: "main.go", lineNumber: 2, suggestion: "Use a constant." }],
    rules: [{ ruleType: "magic_value", name: "externalize_main_go_2", description: "Date literal", condition: "hard-coded date", sourceFile: "main.go", lineNumber: 2 }],
    flowDocument: "# FLOW",
    dataDependencyDocument: "# DATA_DEPENDENCY",
    risksDocument: "# RISKS",
    rulesYaml: "rules:\n  - name: externalize_main_go_2",
    riskScore: 8,
    metrics: {
      fileCount: 2,
      eligibleFileCount: 2,
      analyzedFileCount: 2,
      skippedFileCount: 0,
      heuristicFileCount: 0,
      degradedFileCount: 0,
      symbolCount: 2,
      dependencyCount: 1,
      fieldCount: 1,
      fieldDependencyCount: 1,
      riskCount: 1,
      ruleCount: 1,
      warningCount: 0,
    },
  });
}

beforeEach(() => {
  fakeDb = createFakeDb();
  zipFiles = [];
  gitFiles = [];
  importWarnings = [];
  analyzerResult = null;
  analyzerError = null;
  failRootProjectReadsDuringTransaction = false;
  failNextProjectJobInsert = false;
  transactionDepth = 0;
  projectProgressUpdates = [];
  jobProgressUpdates = [];
  cloneAndExtractFilesMock.mockClear();
  readFileMock.mockClear();
  readFileMock.mockImplementation(async () => Buffer.from("zip-bytes"));
  rmMock.mockClear();
  rmMock.mockImplementation(async () => undefined);
  loggerMock.debug.mockClear();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  try {
    const { resetProjectJobWorkerSchedulerStateForTests } = await import("./projectWorkflow");
    resetProjectJobWorkerSchedulerStateForTests();
  } catch {
    // Ignore module-load failures in cleanup; the test itself should surface them.
  }
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

  it("creates a project and queued ZIP import job in one workflow transaction", async () => {
    const { createProjectWithQueuedZipImport } = await import("./projectWorkflow");

    const result = await createProjectWithQueuedZipImport(
      7,
      {
        name: "delphi-demo",
        description: "sample",
        focusLanguage: "delphi",
        sourceType: "upload",
      },
      "C:/tmp/demo.zip",
      "demo.zip"
    );

    expect(result).toMatchObject({ projectId: 1, jobId: 1, status: "queued" });
    expect(fakeDb.store.projects[0]).toMatchObject({
      userId: 7,
      name: "delphi-demo",
      language: "delphi",
      sourceType: "upload",
      status: "importing",
    });
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "queued",
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/demo.zip", originalFileName: "demo.zip" }),
    });
  });

  it("rolls back the project when queued import job creation fails", async () => {
    const { createProjectWithQueuedZipImport } = await import("./projectWorkflow");
    failNextProjectJobInsert = true;

    await expect(
      createProjectWithQueuedZipImport(
        7,
        {
          name: "rollback-demo",
          description: "sample",
          focusLanguage: "delphi",
          sourceType: "upload",
        },
        "C:/tmp/rollback.zip",
        "rollback.zip"
      )
    ).rejects.toThrow("project job insert failed");

    expect(fakeDb.store.projects).toHaveLength(0);
    expect(fakeDb.store.projectJobs).toHaveLength(0);
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

  it("re-imports source files without deleting immutable analysis history", async () => {
    const { getOwnedProject, importProjectZip } = await import("./projectWorkflow");
    seedProject(1, { status: "completed", analysisProgress: 100, sourceFingerprint: "old-source" });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "old.go", fileName: "old.go", fileType: ".go", content: "package old", lineCount: 1, status: "stored" });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "old", type: "function", startLine: 1, endLine: 1 });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      runNumber: 1,
      sourceFingerprint: "old-source",
      flowMarkdown: "# OLD FLOW",
      warningsJson: [],
    });
    fakeDb.store.analysisBaselines.push({ projectId: 1, analysisResultId: 1, createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z") });
    zipFiles = [{ path: "new.go", fileName: "new.go", content: "package new", language: "go", size: 11 }];

    await importProjectZip(1, 7, "encoded");
    const project = await getOwnedProject(1, 7);

    expect(fakeDb.store.analysisResults).toHaveLength(1);
    expect(fakeDb.store.analysisResults[0]).toMatchObject({ runNumber: 1, sourceFingerprint: "old-source", flowMarkdown: "# OLD FLOW" });
    expect(fakeDb.store.analysisBaselines).toHaveLength(1);
    expect(fakeDb.store.symbols).toHaveLength(0);
    expect(fakeDb.store.files).toHaveLength(1);
    expect(fakeDb.store.files[0]).toMatchObject({ filePath: "new.go", content: "package new" });
    expect(project).toMatchObject({ status: "ready", analysisProgress: 0, lastAnalyzedAt: null });
    expect(project.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(project.sourceFingerprint).not.toBe("old-source");
  });

  it("writes back analysis artifacts and keeps transitions on the transaction handle", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    failRootProjectReadsDuringTransaction = true;
    seedProject();
    fakeDb.store.files.push(
      { id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 12, status: "stored" },
      { id: 2, projectId: 1, filePath: "repo.sql", fileName: "repo.sql", fileType: ".sql", content: "SELECT amount FROM orders", lineCount: 8, status: "stored" }
    );
    analyzerResult = createAnalysisResultFixture({
      status: "partial",
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
    });

    const result = await analyzeProject(1, 7);
    const persistedRun = fakeDb.store.analysisResults[0];
    const parsedSnapshot = parseAnalysisSnapshotStrict(String(persistedRun?.snapshotJson ?? ""));

    expect(result.status).toBe("partial");
    expect(persistedRun).toMatchObject({
      status: "partial",
      runNumber: 1,
      snapshotSchemaVersion: 1,
      analyzerVersion: expect.any(String),
      completedAt: expect.any(Date),
    });
    expect(String(persistedRun?.sourceFingerprint ?? "")).toMatch(/^[a-f0-9]{64}$/);
    expect(fakeDb.store.projects[0].sourceFingerprint).toBe(persistedRun.sourceFingerprint);
    expect(parsedSnapshot.schemaVersion).toBe(1);
    expect(fakeDb.store.symbols).toHaveLength(2);
    expect(fakeDb.store.dependencies).toHaveLength(1);
    expect(fakeDb.store.fields).toHaveLength(1);
    expect(fakeDb.store.fieldDependencies).toHaveLength(1);
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed", analysisProgress: 100 });
    expect(projectProgressUpdates).toEqual([5, 20, 45, 70, 85, 100]);
    expect(projectProgressUpdates.every((progress, index, values) => progress <= 100 && (index === 0 || progress >= values[index - 1]))).toBe(true);
  });

  it("persists stage-specific analysis errors instead of a generic failure message", async () => {
    const { queueAnalyzeProject, waitForProjectJobForTests, getProjectJob } = await import("./projectWorkflow");
    seedProject(1, { language: "delphi" });
    fakeDb.store.files.push({
      id: 1,
      projectId: 1,
      filePath: "src/Form1.pas",
      fileName: "Form1.pas",
      fileType: ".pas",
      content: "unit Form1;",
      lineCount: 1,
      status: "stored",
    });
    analyzerError = new Error("Unexpected token while parsing unit at src/Form1.pas");

    const job = await queueAnalyzeProject(1, 7);
    await waitForProjectJobForTests(job.jobId);
    const jobRecord = await getProjectJob(job.jobId, 7);

    expect(jobRecord.status).toBe("failed");
    expect(jobRecord.errorCode).toBe("ANALYSIS_PARSE_FAILED");
    expect(jobRecord.errorMessage).toContain("ANALYSIS_PARSE_FAILED");
    expect(jobRecord.errorMessage).toContain("Unexpected token while parsing unit at src/Form1.pas");
    expect(fakeDb.store.projects[0]?.errorMessage).toContain("ANALYSIS_PARSE_FAILED");
    expect(fakeDb.store.projects[0]?.errorMessage).toContain("Unexpected token while parsing unit at src/Form1.pas");
    expect(fakeDb.store.analysisResults).toHaveLength(0);
    expect(String(jobRecord.errorMessage)).not.toBe("Analysis failed.");
    expect(String(fakeDb.store.projects[0]?.errorMessage)).not.toBe("Analysis failed.");
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Analysis failed",
      expect.objectContaining({
        action: "analysis.failed",
        errorCode: "ANALYSIS_PARSE_FAILED",
      })
    );
  });

  it("keeps analyze successful and records import warnings as completed_with_warnings results", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    seedProject(1, {
      language: "delphi",
      importWarningsJson: [
        { code: "IMPORT_LIMITED_ANALYSIS", message: "Imported with limited analysis.", filePath: "forms/MainForm.dfm" },
        { code: "IMPORT_ENCODING_DETECTED", message: "Detected Big5 encoding.", filePath: "legacy/OrderRepo.pas" },
      ],
    });
    fakeDb.store.files.push(
      {
        id: 1,
        projectId: 1,
        filePath: "legacy/OrderRepo.pas",
        fileName: "OrderRepo.pas",
        fileType: ".pas",
        content: "unit OrderRepo;",
        lineCount: 1,
        status: "stored",
      },
      {
        id: 2,
        projectId: 1,
        filePath: "forms/MainForm.dfm",
        fileName: "MainForm.dfm",
        fileType: ".dfm",
        content: "object MainForm: TMainForm\nend",
        lineCount: 2,
        status: "stored",
      }
    );
    analyzerResult = createAnalysisResultFixture({
      status: "completed",
      language: "delphi",
      symbols: [{ stableKey: "legacy/OrderRepo.pas::OrderRepo::1", name: "OrderRepo", type: "class", file: "legacy/OrderRepo.pas", startLine: 1, endLine: 1 }],
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
        fileCount: 2,
        eligibleFileCount: 2,
        analyzedFileCount: 2,
        skippedFileCount: 0,
        heuristicFileCount: 0,
        degradedFileCount: 0,
        symbolCount: 1,
        dependencyCount: 0,
        fieldCount: 0,
        fieldDependencyCount: 0,
        riskCount: 0,
        ruleCount: 0,
        warningCount: 0,
      },
    });

    const result = await analyzeProject(1, 7);

    expect(result.status).toBe("completed_with_warnings");
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed", lastErrorCode: null });
    expect(fakeDb.store.analysisResults[0]).toMatchObject({
      status: "completed_with_warnings",
      errorMessage: "Analysis completed with warnings.",
    });
    expect(fakeDb.store.analysisResults[0]?.warningsJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "IMPORT_LIMITED_ANALYSIS", filePath: "forms/MainForm.dfm" }),
        expect.objectContaining({ code: "IMPORT_ENCODING_DETECTED", filePath: "legacy/OrderRepo.pas" }),
        expect.objectContaining({ code: "ANALYSIS_INPUT_SUMMARY", level: "note" }),
      ])
    );
    const persistedMetrics = fakeDb.store.analysisResults[0]?.summaryJson as {
      warningCount?: number;
      confidence?: { score: number; level: string; breakdown: Array<{ label: string; reason: string }> };
    };
    expect(persistedMetrics.warningCount).toBe(3);
    expect(persistedMetrics.confidence).toEqual(expect.objectContaining({ score: expect.any(Number), level: expect.any(String) }));
    expect(persistedMetrics.confidence?.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Import warnings", reason: "2 import warnings were recorded." }),
        expect.objectContaining({ label: "Analyzer warnings", reason: "2 analyzer warnings were recorded." }),
      ])
    );
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Analysis parser.completed",
      expect.objectContaining({
        action: "analysis.parser.completed",
        resultStatus: "completed_with_warnings",
      })
    );
  });

  it.each([
    ["symbols", "insert symbols"],
    ["fieldDependencies", "insert field dependencies"],
    ["dependencies", "insert symbol dependencies"],
    ["risks", "insert detected risks"],
  ] as const)("reports the correct persistence checkpoint when %s insert fails", async (tableName, operation) => {
    const { analyzeProject } = await import("./projectWorkflow");
    seedProject(1, { status: "completed", analysisProgress: 100 });
    fakeDb.store.files.push(
      { id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 12, status: "stored" },
      { id: 2, projectId: 1, filePath: "repo.sql", fileName: "repo.sql", fileType: ".sql", content: "SELECT amount FROM orders", lineCount: 8, status: "stored" }
    );
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# OLD FLOW",
      dataDependencyMarkdown: "# OLD DATA",
      risksMarkdown: "# OLD RISKS",
      rulesYaml: "rules: []",
      summaryJson: { fileCount: 1 },
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "old_symbol", type: "function", startLine: 1, endLine: 1 });
    analyzerResult = createPersistenceAnalysisResult();

    let failed = false;
    const originalInsert = fakeDb.insert.bind(fakeDb);
    fakeDb.insert = (table: object) => {
      const baseInsert = originalInsert(table);
      return {
        values: async (payload: Row | Row[]) => {
          if (!failed && getTableName(table) === tableName) {
            failed = true;
            throw new Error(`${tableName} insert failed`);
          }
          return baseInsert.values(payload);
        },
      };
    };

    await expect(analyzeProject(1, 7)).rejects.toMatchObject({ code: "ANALYSIS_PERSIST_FAILED" });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "ANALYSIS_PERSIST_FAILED",
      errorMessage: expect.stringContaining(`db=${operation} @ ${tableName}`),
    });
    expect(fakeDb.store.analysisResults[0]).toMatchObject({
      status: "completed",
      flowMarkdown: "# OLD FLOW",
      errorMessage: null,
    });
    expect(fakeDb.store.analysisResults[0]?.warningsJson).toEqual([]);
  });

  it("leaves ambiguous same-name dependency targets unresolved", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.files.push(
      { id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 12, status: "stored" },
      { id: 2, projectId: 1, filePath: "pkg/a.go", fileName: "a.go", fileType: ".go", content: "package pkg", lineCount: 8, status: "stored" },
      { id: 3, projectId: 1, filePath: "pkg/b.go", fileName: "b.go", fileType: ".go", content: "package pkg", lineCount: 8, status: "stored" }
    );
    analyzerResult = createAnalysisResultFixture({
      symbols: [
        { stableKey: "main.go::main::1", name: "main", type: "function", file: "main.go", startLine: 1, endLine: 5 },
        { stableKey: "pkg/a.go::Run::1", name: "Run", qualifiedName: "a.Run", type: "function", file: "pkg/a.go", startLine: 1, endLine: 5 },
        { stableKey: "pkg/b.go::Run::1", name: "Run", qualifiedName: "b.Run", type: "function", file: "pkg/b.go", startLine: 1, endLine: 5 },
      ],
      dependencies: [{ from: "main.go::main::1", fromName: "main", toName: "Run", type: "calls", line: 3 }],
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
        fileCount: 3,
        eligibleFileCount: 3,
        analyzedFileCount: 3,
        skippedFileCount: 0,
        heuristicFileCount: 0,
        degradedFileCount: 0,
        symbolCount: 3,
        dependencyCount: 1,
        fieldCount: 0,
        fieldDependencyCount: 0,
        riskCount: 0,
        ruleCount: 0,
        warningCount: 0,
      },
    });

    await analyzeProject(1, 7);

    expect(fakeDb.store.dependencies[0]).toMatchObject({
      targetSymbolId: null,
      targetExternalName: "Run",
      targetKind: "unresolved",
    });
  });

  it("deduplicates normalized SQL field identities while preserving display names", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "schema.sql", fileName: "schema.sql", fileType: ".sql", content: "schema", lineCount: 3, status: "stored" });
    analyzerResult = createAnalysisResultFixture({
      language: "sql",
      fieldReferences: [
        { table: "customer", field: "id", type: "read", file: "schema.sql", line: 2 },
        { table: "dbo.Customer", field: "Id", type: "write", file: "schema.sql", line: 3 },
      ],
      schemaFields: [{ table: "[Customer]", field: "[Id]", file: "schema.sql", line: 1 }],
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
        fieldCount: 1,
        fieldDependencyCount: 0,
        riskCount: 0,
        ruleCount: 0,
        warningCount: 0,
      },
    });

    await analyzeProject(1, 7);

    expect(fakeDb.store.fields).toEqual([expect.objectContaining({ tableName: "Customer", fieldName: "Id" })]);
  });

  it("queues re-analysis without replacing the previous usable analysis result", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";
    const { queueAnalyzeProject } = await import("./projectWorkflow");
    seedProject(1, { status: "completed", analysisProgress: 100 });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# OLD FLOW",
      dataDependencyMarkdown: "# OLD DATA",
      risksMarkdown: "# OLD RISKS",
      rulesYaml: "rules: []",
      summaryJson: { fileCount: 1 },
      warningsJson: [],
      errorMessage: null,
    });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "old_symbol", type: "function", startLine: 1, endLine: 1 });

    try {
      await queueAnalyzeProject(1, 7);

      expect(fakeDb.store.projects[0]).toMatchObject({ status: "analyzing", analysisProgress: 0 });
      expect(fakeDb.store.analysisResults).toHaveLength(1);
      expect(fakeDb.store.analysisResults[0]).toMatchObject({ status: "completed", flowMarkdown: "# OLD FLOW" });
      expect(fakeDb.store.symbols).toHaveLength(1);
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("preserves the previous usable snapshot when re-analysis fails", async () => {
    const { analyzeProject, buildReportArchive } = await import("./projectWorkflow");
    seedProject(1, { status: "completed", analysisProgress: 100 });
    const currentFile = {
      id: 1,
      projectId: 1,
      filePath: "main.go",
      fileName: "main.go",
      fileType: ".go",
      content: "package main",
      lineCount: 1,
      status: "stored",
    };
    fakeDb.store.files.push(currentFile);
    const oldRun = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "main.go", content: "package main" }],
      projectContext: { projectName: "project-1", sourceType: "upload", focusLanguage: "go", importWarnings: [] },
      result: {
        status: "completed",
        symbols: [{ stableKey: "main.go::old_symbol::1", name: "old_symbol", type: "function", file: "main.go", startLine: 1, endLine: 1 }],
        dependencies: [{ from: "main.go::old_symbol::1", fromName: "old_symbol", toName: "LegacyApi", targetKind: "external", type: "references", line: 1 }],
        schemaFields: [{ table: "orders", field: "amount", file: "main.go", line: 1 }],
        risks: [{ title: "Old risk", description: "legacy", severity: "high", category: "magic_value", sourceFile: "main.go", lineNumber: 1 }],
        rules: [{ ruleType: "validation", name: "OldRule", description: "legacy", sourceFile: "main.go", lineNumber: 1 }],
        flowDocument: "# OLD FLOW",
        dataDependencyDocument: "# OLD DATA",
        risksDocument: "# OLD RISKS",
        rulesYaml: "rules: []",
        metrics: {
          fileCount: 1,
          eligibleFileCount: 1,
          analyzedFileCount: 1,
          skippedFileCount: 0,
          heuristicFileCount: 0,
          degradedFileCount: 0,
          symbolCount: 1,
          dependencyCount: 1,
          fieldCount: 1,
          fieldDependencyCount: 0,
          riskCount: 1,
          ruleCount: 1,
          warningCount: 0,
        },
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = oldRun.sourceFingerprint;
    fakeDb.store.analysisResults.push(oldRun.row);
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "old_symbol", type: "function", startLine: 1, endLine: 1 });
    fakeDb.store.fields.push({ id: 1, projectId: 1, tableName: "orders", fieldName: "amount", fieldType: null, description: null });
    fakeDb.store.dependencies.push({ id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetExternalName: "LegacyApi", targetKind: "external", dependencyType: "references", lineNumber: 1 });
    fakeDb.store.risks.push({ id: 1, projectId: 1, riskType: "magic_value", severity: "high", title: "Old risk", sourceFile: "main.go", lineNumber: 1 });
    fakeDb.store.rules.push({ id: 1, projectId: 1, ruleType: "validation", name: "OldRule", sourceFile: "main.go", lineNumber: 1 });
    const beforeSnapshotJson = String(oldRun.row.snapshotJson);
    analyzerResult = createAnalysisResultFixture({
      status: "failed",
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
    });

    await expect(analyzeProject(1, 7)).rejects.toMatchObject({ code: "ANALYSIS_SUMMARY_FAILED" });

    expect(fakeDb.store.projects[0]).toMatchObject({ status: "failed", lastErrorCode: "ANALYSIS_SUMMARY_FAILED" });
    expect(fakeDb.store.analysisResults[0]).toMatchObject({ status: "completed", flowMarkdown: "# OLD FLOW", sourceFingerprint: oldRun.sourceFingerprint });
    expect(String(fakeDb.store.analysisResults[0].snapshotJson)).toBe(beforeSnapshotJson);
    expect(fakeDb.store.symbols).toHaveLength(1);
    expect(fakeDb.store.dependencies).toHaveLength(1);
    expect(fakeDb.store.fields).toHaveLength(1);
    expect(fakeDb.store.risks).toHaveLength(1);
    expect(fakeDb.store.rules).toHaveLength(1);
    expect(fakeDb.store.projects[0].sourceFingerprint).toBe(oldRun.sourceFingerprint);

    const archive = await buildReportArchive(1, 7);
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));
    await expect(zip.file("FLOW.md")!.async("text")).resolves.toBe("# OLD FLOW");
  });

  it("batch inserts ID-independent analysis artifacts in chunks", async () => {
    const { analyzeProject } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    const riskBatchSizes: number[] = [];
    const ruleBatchSizes: number[] = [];
    const originalInsert = fakeDb.insert.bind(fakeDb);
    fakeDb.insert = (table: object) => {
      const tableName = getTableName(table);
      const baseInsert = originalInsert(table);
      return {
        values: async (payload: Row | Row[]) => {
          if (tableName === "risks") {
            riskBatchSizes.push(Array.isArray(payload) ? payload.length : 1);
          }
          if (tableName === "rules") {
            ruleBatchSizes.push(Array.isArray(payload) ? payload.length : 1);
          }
          return baseInsert.values(payload);
        },
      };
    };
    analyzerResult = createAnalysisResultFixture({
      risks: Array.from({ length: 251 }, (_value, index) => ({
        title: `Risk ${index}`,
        description: "risk",
        severity: "medium",
        category: "magic_value",
        sourceFile: "main.go",
        lineNumber: index + 1,
        suggestion: "Review.",
      })),
      rules: Array.from({ length: 251 }, (_value, index) => ({
        ruleType: "magic_value",
        name: `rule_${index}`,
        description: "rule",
        condition: "condition",
        sourceFile: "main.go",
        lineNumber: index + 1,
      })),
      warnings: [],
      flowDocument: "# FLOW",
      dataDependencyDocument: "# DATA",
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
        riskCount: 251,
        ruleCount: 251,
        warningCount: 0,
      },
    });

    await analyzeProject(1, 7);

    expect(riskBatchSizes).toEqual([250, 1]);
    expect(ruleBatchSizes).toEqual([250, 1]);
  });

  it("batch inserts symbols and fields without breaking downstream mappings", async () => {
    const { analyzeProject, getDependenciesPage, getFieldDependenciesPage } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.files.push({
      id: 1,
      projectId: 1,
      filePath: "main.go",
      fileName: "main.go",
      fileType: ".go",
      content: "package main",
      lineCount: 300,
      status: "stored",
    });
    const symbolBatchSizes: number[] = [];
    const fieldBatchSizes: number[] = [];
    const originalInsert = fakeDb.insert.bind(fakeDb);
    fakeDb.insert = (table: object) => {
      const tableName = getTableName(table);
      const baseInsert = originalInsert(table);
      return {
        values: async (payload: Row | Row[]) => {
          if (tableName === "symbols") {
            symbolBatchSizes.push(Array.isArray(payload) ? payload.length : 1);
          }
          if (tableName === "fields") {
            fieldBatchSizes.push(Array.isArray(payload) ? payload.length : 1);
          }
          return baseInsert.values(payload);
        },
      };
    };
    const analyzedSymbols: ProjectAnalysisResult["symbols"] = Array.from({ length: 251 }, (_value, index) => ({
      stableKey: `main.go::Symbol${index}::${index + 1}`,
      name: `Symbol${index}`,
      type: "function" as const,
      file: "main.go",
      startLine: index + 1,
      endLine: index + 1,
    }));
    const analyzedFields = Array.from({ length: 251 }, (_value, index) => ({
      table: "orders",
      field: `field_${index}`,
      fieldType: "varchar",
      file: "main.go",
      line: index + 1,
    }));
    analyzerResult = createAnalysisResultFixture({
      symbols: analyzedSymbols,
      dependencies: [
        {
          from: analyzedSymbols[0].stableKey,
          to: analyzedSymbols[250].stableKey,
          fromName: "Symbol0",
          toName: "Symbol250",
          type: "calls",
          line: 1,
        },
        {
          from: analyzedSymbols[1].stableKey,
          fromName: "Symbol1",
          toName: "ExternalApi",
          targetKind: "external",
          type: "references",
          line: 2,
        },
      ],
      fieldReferences: analyzedFields.map((field, index) => ({
        table: field.table,
        field: field.field,
        type: "read",
        file: "main.go",
        line: index + 1,
        symbolStableKey: analyzedSymbols[index].stableKey,
        context: `SELECT ${field.field} FROM orders`,
      })),
      schemaFields: analyzedFields,
      risks: [{ title: "Risk", description: "risk", severity: "medium", category: "magic_value", sourceFile: "main.go", lineNumber: 1 }],
      rules: [{ ruleType: "magic_value", name: "rule", description: "rule", condition: "condition", sourceFile: "main.go", lineNumber: 1 }],
      warnings: [],
      flowDocument: "# FLOW",
      dataDependencyDocument: "# DATA",
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
        symbolCount: 251,
        dependencyCount: 2,
        fieldCount: 251,
        fieldDependencyCount: 251,
        riskCount: 1,
        ruleCount: 1,
        warningCount: 0,
      },
    });

    await analyzeProject(1, 7);

    expect(symbolBatchSizes).toEqual([250, 1]);
    expect(fieldBatchSizes).toEqual([250, 1]);
    expect(fakeDb.store.symbols).toHaveLength(251);
    expect(fakeDb.store.fields).toHaveLength(251);
    expect(fakeDb.store.fieldDependencies).toHaveLength(251);
    expect(fakeDb.store.dependencies).toHaveLength(2);
    expect(fakeDb.store.dependencies[0]).toMatchObject({
      sourceSymbolId: fakeDb.store.symbols[0].id,
      targetSymbolId: fakeDb.store.symbols[250].id,
      targetExternalName: null,
      targetKind: "internal",
    });
    expect(fakeDb.store.dependencies[1]).toMatchObject({
      sourceSymbolId: fakeDb.store.symbols[1].id,
      targetSymbolId: null,
      targetExternalName: "ExternalApi",
      targetKind: "external",
    });

    const dependenciesPage = await getDependenciesPage(dependencyListOptions({ projectId: 1, page: 1, pageSize: 25, search: "symbol250" }), 7);
    const fieldDependenciesPage = await getFieldDependenciesPage({ projectId: 1, page: 1, pageSize: 25, tableName: "orders", search: "field_250" }, 7);

    expect(dependenciesPage.items).toEqual([expect.objectContaining({ sourceSymbolName: "Symbol0", targetSymbolName: "Symbol250" })]);
    expect(fieldDependenciesPage.items).toEqual([expect.objectContaining({ tableName: "orders", fieldName: "field_250", symbolName: "Symbol250" })]);
  });

  it("returns a light snapshot summary instead of full arrays", async () => {
    const { getAnalysisSnapshot } = await import("./projectWorkflow");
    seedProject(1, { status: "completed", importWarningsJson: [{ code: "IMPORT_ENCODING_DETECTED", message: "Detected Big5 encoding.", filePath: "legacy.pas" }] });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    const sourceFingerprint = calculateSourceFingerprint(fakeDb.store.files);
    fakeDb.store.projects[0].sourceFingerprint = sourceFingerprint;
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      status: "completed",
      sourceFingerprint,
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
    const risksPage = await getRisksPage(riskListOptions({ projectId: 1, page: 1, pageSize: 25, severity: "high", search: "shared" }), 7);
    const dependenciesPage = await getDependenciesPage(dependencyListOptions({ projectId: 1, page: 1, pageSize: 25, targetKind: "external", search: "legacy" }), 7);
    const fieldDependenciesPage = await getFieldDependenciesPage({ projectId: 1, page: 1, pageSize: 25, tableName: "ERP.SIGNB", operationType: "write", search: "mark" }, 7);

    expect(symbolsPage.total).toBe(15);
    expect(symbolsPage.page).toBe(2);
    expect(symbolsPage.items).toHaveLength(5);
    expect(symbolsPage.items[0]?.name).toContain("LoadUser");
    expect(fieldsPage.items).toEqual([expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_2", writeCount: 1 })]);
    expect(risksPage.items).toEqual([expect.objectContaining({ title: "Shared risk", severity: "high", occurrenceCount: 1 })]);
    expect(dependenciesPage.items).toEqual([expect.objectContaining({ targetExternalName: "LegacyApi", targetKind: "external" })]);
    expect(dependenciesPage.summary.defaultHideStandardLibrary).toBe(true);
    expect(fieldDependenciesPage.items).toEqual([expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_2", operationType: "write" })]);
  });

  it("hides Delphi standard library dependencies by default but can show them on demand", async () => {
    const { getDependenciesPage } = await import("./projectWorkflow");
    seedProject();
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "LoadMain", type: "procedure", startLine: 1, endLine: 2 });
    fakeDb.store.dependencies.push(
      { id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetExternalName: "Windows", targetKind: "external", dependencyType: "references", lineNumber: 1 },
      { id: 2, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetExternalName: "ProjectUnit", targetKind: "external", dependencyType: "references", lineNumber: 2 }
    );

    const hiddenPage = await getDependenciesPage(dependencyListOptions({ projectId: 1, page: 1, pageSize: 25, hideStandardLibrary: true }), 7);
    const visiblePage = await getDependenciesPage(dependencyListOptions({ projectId: 1, page: 1, pageSize: 25 }), 7);

    expect(hiddenPage.items).toHaveLength(1);
    expect(hiddenPage.items[0]?.targetExternalName).toBe("ProjectUnit");
    expect(hiddenPage.summary.standardLibraryCount).toBe(1);
    expect(visiblePage.items).toHaveLength(2);
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
        ...claimedOwnership({ leaseUntil: new Date("2026-01-01T00:10:00.000Z"), heartbeatAt: new Date("2026-01-01T00:09:30.000Z") }),
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
        ...claimedOwnership({ lockedBy: "worker-b" }),
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
    analyzerResult = createAnalysisResultFixture({
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
    });

    const recovered = await recoverStaleProjectJobsOnStartup(new Date("2026-01-02T00:16:00.000Z"), 15 * 60 * 1000);
    await waitForProjectJobForTests(1);

    expect(recovered).toBe(1);
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ status: "completed", activeKey: null });
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed" });
    expect(fakeDb.store.projects[1]).toMatchObject({
      status: "failed",
      lastErrorCode: "PROJECT_JOB_STALE",
      importProgress: 50,
    });
  });

  it("fails stale running jobs that exhausted their retry budget without faking completion progress", async () => {
    const { recoverStaleProjectJobsOnStartup } = await import("./projectWorkflow");
    seedProject(1, { status: "importing", importProgress: 60 });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 60,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/stale-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership({
        attemptCount: 3,
        maxAttempts: 3,
        leaseUntil: new Date("2026-01-01T00:01:30.000Z"),
        heartbeatAt: new Date("2026-01-01T00:01:00.000Z"),
      }),
    });

    const recovered = await recoverStaleProjectJobsOnStartup(new Date("2026-01-01T00:10:00.000Z"), 15 * 60 * 1000);

    expect(recovered).toBe(0);
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      progress: 60,
      errorCode: "JOB_STALE_MAX_ATTEMPTS",
      activeKey: null,
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      importProgress: 60,
      lastErrorCode: "JOB_STALE_MAX_ATTEMPTS",
    });
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Project job exhausted stale recovery retries",
      expect.objectContaining({ action: "project.job.stale.failed", errorCode: "JOB_STALE_MAX_ATTEMPTS" })
    );
  });

  it("keeps the previous usable report and graph when startup recovery fails a stuck analyzing project", async () => {
    const { buildReportArchive, recoverStaleProjectJobsOnStartup } = await import("./projectWorkflow");
    seedProject(1, { status: "analyzing", analysisProgress: 42 });
    const currentFile = {
      id: 1,
      projectId: 1,
      filePath: "main.go",
      fileName: "main.go",
      fileType: ".go",
      content: "package main",
      lineCount: 1,
      status: "stored",
    };
    fakeDb.store.files.push(currentFile);
    const previousRun = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      status: "partial",
      projectFiles: [{ path: "main.go", content: "package main" }],
      projectContext: { projectName: "project-1", sourceType: "upload", focusLanguage: "go", importWarnings: [] },
      result: {
        status: "partial",
        symbols: [{ stableKey: "main.go::old_symbol::1", name: "old_symbol", type: "function", file: "main.go", startLine: 1, endLine: 1 }],
        dependencies: [{ from: "main.go::old_symbol::1", fromName: "old_symbol", toName: "LegacyApi", targetKind: "external", type: "references", line: 1 }],
        flowDocument: "# OLD FLOW",
        dataDependencyDocument: "# OLD DATA",
        risksDocument: "# OLD RISKS",
        rulesYaml: "rules: []",
        metrics: {
          fileCount: 1,
          eligibleFileCount: 1,
          analyzedFileCount: 1,
          skippedFileCount: 0,
          heuristicFileCount: 0,
          degradedFileCount: 0,
          symbolCount: 1,
          dependencyCount: 1,
          fieldCount: 0,
          fieldDependencyCount: 0,
          riskCount: 0,
          ruleCount: 0,
          warningCount: 0,
        },
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = previousRun.sourceFingerprint;
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "old_symbol", type: "function", startLine: 1, endLine: 1 });
    fakeDb.store.dependencies.push({
      id: 1,
      projectId: 1,
      sourceSymbolId: 1,
      targetSymbolId: null,
      targetExternalName: "LegacyApi",
      targetKind: "external",
      dependencyType: "references",
      lineNumber: 1,
    });
    fakeDb.store.analysisResults.push(previousRun.row);
    const beforeSnapshotJson = String(previousRun.row.snapshotJson);

    const recovered = await recoverStaleProjectJobsOnStartup(new Date("2026-01-02T00:16:00.000Z"), 15 * 60 * 1000);

    expect(recovered).toBe(0);
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "failed", lastErrorCode: "PROJECT_JOB_STALE", analysisProgress: 0 });
    expect(fakeDb.store.analysisResults).toHaveLength(1);
    expect(fakeDb.store.analysisResults[0]).toMatchObject({ status: "partial", flowMarkdown: "# OLD FLOW", sourceFingerprint: previousRun.sourceFingerprint });
    expect(String(fakeDb.store.analysisResults[0].snapshotJson)).toBe(beforeSnapshotJson);
    expect(fakeDb.store.symbols).toHaveLength(1);
    expect(fakeDb.store.dependencies).toHaveLength(1);
    expect(fakeDb.store.projects[0].sourceFingerprint).toBe(previousRun.sourceFingerprint);

    const archive = await buildReportArchive(1, 7);
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));
    await expect(zip.file("FLOW.md")!.async("text")).resolves.toBe("# OLD FLOW");
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
      ...claimedOwnership({ leaseUntil: new Date("2026-01-01T00:10:00.000Z"), heartbeatAt: new Date("2026-01-01T00:09:30.000Z") }),
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

  it("does not start polling when the project worker is disabled", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";

    const {
      getProjectJobWorkerSchedulerStateForTests,
      resetProjectJobWorkerSchedulerStateForTests,
      startProjectJobWorkerPolling,
    } = await import("./projectWorkflow");

    try {
      resetProjectJobWorkerSchedulerStateForTests();

      const timer = startProjectJobWorkerPolling(25);

      expect(timer).toBeNull();
      expect(getProjectJobWorkerSchedulerStateForTests()).toMatchObject({
        kickCount: 0,
        loopStartCount: 0,
        pollingActive: false,
      });
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("periodically kicks the project worker loop on worker-enabled processes", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "true";
    vi.useFakeTimers();

    const {
      getProjectJobWorkerSchedulerStateForTests,
      resetProjectJobWorkerSchedulerStateForTests,
      startProjectJobWorkerPolling,
    } = await import("./projectWorkflow");

    try {
      resetProjectJobWorkerSchedulerStateForTests();
      startProjectJobWorkerPolling(25);

      await vi.advanceTimersByTimeAsync(80);

      expect(getProjectJobWorkerSchedulerStateForTests()).toMatchObject({
        pollingActive: true,
      });
      expect(getProjectJobWorkerSchedulerStateForTests().kickCount).toBeGreaterThanOrEqual(3);
      expect(getProjectJobWorkerSchedulerStateForTests().loopStartCount).toBeGreaterThanOrEqual(3);
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("does not reenter the worker loop when polling fires during an active run", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "true";
    vi.useFakeTimers();
    vi.resetModules();

    let resolveJob!: () => void;
    const runProjectJobMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveJob = resolve;
        })
    );
    vi.doMock("./jobWorker", () => ({
      runProjectJob: runProjectJobMock,
    }));

    const {
      getProjectJobWorkerSchedulerStateForTests,
      resetProjectJobWorkerSchedulerStateForTests,
      startProjectJobWorkerPolling,
    } = await import("./projectWorkflow");

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

    try {
      resetProjectJobWorkerSchedulerStateForTests();
      startProjectJobWorkerPolling(20);

      await vi.advanceTimersByTimeAsync(25);
      expect(runProjectJobMock).toHaveBeenCalledTimes(1);
      expect(getProjectJobWorkerSchedulerStateForTests().loopStartCount).toBe(1);

      await vi.advanceTimersByTimeAsync(80);
      expect(getProjectJobWorkerSchedulerStateForTests().kickCount).toBeGreaterThanOrEqual(2);
      expect(getProjectJobWorkerSchedulerStateForTests().loopStartCount).toBe(1);
      expect(runProjectJobMock).toHaveBeenCalledTimes(1);

      resolveJob();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      resolveJob?.();
      vi.doUnmock("./jobWorker");
      vi.resetModules();
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("catches scheduler-level claim failures and retries with backoff", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "true";
    vi.useFakeTimers();

    const {
      getProjectJobWorkerSchedulerStateForTests,
      resetProjectJobWorkerSchedulerStateForTests,
      startProjectJobWorkerPolling,
    } = await import("./projectWorkflow");

    seedProject(1, { status: "ready" });
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
    analyzerResult = createPersistenceAnalysisResult();

    const originalSelect = fakeDb.select.bind(fakeDb);
    let failClaimSelect = true;
    fakeDb.select = (selection?: Row) => {
      if (failClaimSelect) {
        failClaimSelect = false;
        throw new Error("claim query failed");
      }
      return originalSelect(selection);
    };

    try {
      resetProjectJobWorkerSchedulerStateForTests();
      startProjectJobWorkerPolling(20);

      await vi.advanceTimersByTimeAsync(25);
      expect(getProjectJobWorkerSchedulerStateForTests()).toMatchObject({
        retryActive: true,
        failureCount: 1,
      });
      expect(loggerMock.error).toHaveBeenCalledWith(
        "Project job scheduler failed",
        expect.objectContaining({
          action: "project.job.scheduler.error",
          errorMessage: "claim query failed",
        })
      );

      await vi.advanceTimersByTimeAsync(500);
      expect(fakeDb.store.projectJobs[0]).toMatchObject({
        status: "completed",
        progress: 100,
      });
      expect(getProjectJobWorkerSchedulerStateForTests()).toMatchObject({
        retryActive: false,
        failureCount: 0,
      });
    } finally {
      fakeDb.select = originalSelect;
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("cancels scheduler retry timers when polling stops", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "true";
    vi.useFakeTimers();

    const {
      getProjectJobWorkerSchedulerStateForTests,
      resetProjectJobWorkerSchedulerStateForTests,
      startProjectJobWorkerPolling,
      stopProjectJobWorkerPolling,
    } = await import("./projectWorkflow");

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

    const originalSelect = fakeDb.select.bind(fakeDb);
    fakeDb.select = () => {
      throw new Error("queue lookup failed");
    };

    try {
      resetProjectJobWorkerSchedulerStateForTests();
      startProjectJobWorkerPolling(20);
      await vi.advanceTimersByTimeAsync(25);

      expect(getProjectJobWorkerSchedulerStateForTests().retryActive).toBe(true);
      stopProjectJobWorkerPolling();
      expect(getProjectJobWorkerSchedulerStateForTests()).toMatchObject({
        pollingActive: false,
        retryActive: false,
        shutdown: true,
      });

      const loopStartCount = getProjectJobWorkerSchedulerStateForTests().loopStartCount;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getProjectJobWorkerSchedulerStateForTests().loopStartCount).toBe(loopStartCount);
    } finally {
      fakeDb.select = originalSelect;
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
  });

  it("lets a worker-enabled process pick up a queued job via polling after a web-only enqueue", async () => {
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";
    vi.useFakeTimers();

    const {
      getProjectJobWorkerSchedulerStateForTests,
      queueAnalyzeProject,
      resetProjectJobWorkerSchedulerStateForTests,
      startProjectJobWorkerPolling,
    } = await import("./projectWorkflow");

    seedProject(1, { status: "ready", analysisProgress: 100 });
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
    analyzerResult = createPersistenceAnalysisResult();

    try {
      resetProjectJobWorkerSchedulerStateForTests();
      await queueAnalyzeProject(1, 7);

      expect(fakeDb.store.projectJobs[0]).toMatchObject({ status: "queued" });
      expect(getProjectJobWorkerSchedulerStateForTests().kickCount).toBe(1);
      expect(getProjectJobWorkerSchedulerStateForTests().loopStartCount).toBe(0);

      process.env.PROJECT_WORKER_ENABLED = "true";
      startProjectJobWorkerPolling(20);

      await vi.advanceTimersByTimeAsync(80);

      expect(fakeDb.store.projectJobs[0]).toMatchObject({
        status: "completed",
        progress: 100,
      });
      expect(fakeDb.store.projects[0]).toMatchObject({
        status: "completed",
        analysisProgress: 100,
      });
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
    analyzerResult = createAnalysisResultFixture({
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
    });

    const queued = await queueAnalyzeProject(1, 7);
    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await waitForProjectJobForTests(queued.jobId);
    const completedJob = await getProjectJob(queued.jobId, 7);
    expect(completedJob.status).toBe("completed");
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "completed" });

    fakeDb.store.projects[0] = { ...fakeDb.store.projects[0], status: "ready", analysisProgress: 0, errorMessage: null, lastErrorCode: null };
    analyzerResult = createAnalysisResultFixture({
      status: "failed",
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
    });

    const failed = await queueAnalyzeProject(1, 7);
    await waitForProjectJobForTests(failed.jobId);
    const failedJob = await getProjectJob(failed.jobId, 7);
    expect(failedJob.status).toBe("failed");
    expect(failedJob.errorCode).toBe("ANALYSIS_SUMMARY_FAILED");
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "failed", lastErrorCode: "ANALYSIS_SUMMARY_FAILED" });
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
      ...claimedOwnership(),
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
      importProgress: 10,
    });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("fails a claimed import job when its JSON payload shape is invalid", async () => {
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
      payloadJson: JSON.stringify({ type: "import_zip", zipContent: "abc", tempFilePath: "C:/tmp/demo.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership(),
    });

    await expect(runClaimedProjectJob(1)).rejects.toMatchObject({
      code: "PROJECT_JOB_STALE",
      message: expect.stringContaining("payload is invalid"),
    });

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      errorCode: "PROJECT_JOB_STALE",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "PROJECT_JOB_STALE",
      importProgress: 10,
    });
  });

  it("syncs import progress and emits structured lifecycle logs for a successful claimed ZIP job", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";
    seedProject(1, { status: "importing", importProgress: 0 });
    zipFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 10,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/queued-upload.zip", originalFileName: "queued-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership(),
    });

    try {
      await expect(runClaimedProjectJob(1)).resolves.toBeUndefined();
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "completed",
      progress: 100,
      activeKey: null,
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      importProgress: 100,
    });
    expect(fakeDb.store.projectJobs[1]).toMatchObject({
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "queued",
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "analyzing",
      analysisProgress: 0,
    });
    expect(projectProgressUpdates).toEqual(expect.arrayContaining([10, 60, 80, 100]));
    expect(jobProgressUpdates).toEqual(expect.arrayContaining([10, 60, 90, 100]));

    const infoActions = loggerMock.info.mock.calls.map(([, context]) => (context as { action?: string } | undefined)?.action);
    expect(infoActions).toEqual(
      expect.arrayContaining([
        "project.job.started",
        "import.zip.started",
        "import.zip.extracted",
        "import.zip.persisted",
        "project.job.completed",
      ])
    );
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
      ...claimedOwnership(),
    });

    await expect(runClaimedProjectJob(1)).rejects.toMatchObject({ code: "IMPORT_FAILED" });

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      errorCode: "IMPORT_FAILED",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "IMPORT_FAILED",
      importProgress: 10,
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
      ...claimedOwnership(),
    });

    await expect(runClaimedProjectJob(1)).rejects.toMatchObject({ code: "IMPORT_FAILED" });

    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      errorCode: "IMPORT_FAILED",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "failed",
      importProgress: 10,
    });
    expect(rmMock).toHaveBeenCalledWith("C:/tmp/queued-upload.zip", { force: true });
  }, 10_000);

  it("does not let a stale worker fail a reclaimed running job", async () => {
    const { failClaimedProjectJobBestEffort } = await import("./projectWorkflow");
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
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/reclaimed-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership({ lockedBy: "worker-b", attemptCount: 2 }),
    });

    const failed = await failClaimedProjectJobBestEffort(
      { jobId: 1, projectId: 1, type: "import_zip", lockedBy: "worker-a", attemptCount: 1 },
      new AppError("PROJECT_JOB_TIMEOUT", "old attempt timed out")
    );

    expect(failed).toBe(false);
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "running",
      lockedBy: "worker-b",
      attemptCount: 2,
      errorCode: null,
      activeKey: "active",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "importing", importProgress: 10 });
    expect(rmMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Project job failure skipped because ownership changed",
      expect.objectContaining({
        action: "project.job.failure_skipped",
        jobId: 1,
        lockedBy: "worker-a",
        attemptCount: 1,
      })
    );
  }, 10_000);

  it("does not create a duplicate analysis job when one is already queued after import completion", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";
    seedProject(1, { status: "importing", importProgress: 0 });
    zipFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
    fakeDb.store.projectJobs.push(
      {
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
        ...claimedOwnership(),
      },
      {
        id: 2,
        projectId: 1,
        userId: 7,
        type: "analyze",
        status: "queued",
        progress: 0,
        errorCode: null,
        errorMessage: null,
        payloadJson: JSON.stringify({ type: "analyze" }),
        activeKey: "active",
        createdAt: new Date("2026-01-01T00:00:30.000Z"),
        startedAt: null,
        finishedAt: null,
      }
    );

    try {
      await expect(runClaimedProjectJob(1)).resolves.toBeUndefined();
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }

    expect(fakeDb.store.projectJobs.filter((job: Row) => job.type === "analyze")).toHaveLength(1);
    expect(fakeDb.store.projectJobs[1]).toMatchObject({ id: 2, type: "analyze", status: "queued" });
  });

  it("allows the current owner to fail its own running job", async () => {
    const { failClaimedProjectJobBestEffort } = await import("./projectWorkflow");
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
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/current-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership(),
    });

    const failed = await failClaimedProjectJobBestEffort(
      { jobId: 1, projectId: 1, type: "import_zip", lockedBy: "worker-a", attemptCount: 1 },
      new AppError("IMPORT_FAILED", "current attempt failed")
    );

    expect(failed).toBe(true);
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "failed",
      lockedBy: null,
      attemptCount: 1,
      errorCode: "IMPORT_FAILED",
      errorMessage: "current attempt failed",
      activeKey: null,
    });
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "failed", lastErrorCode: "IMPORT_FAILED" });
    expect(rmMock).toHaveBeenCalledWith("C:/tmp/current-upload.zip", { force: true });
  });

  it("logs and skips safely when ownership changes before failure persistence", async () => {
    const { failClaimedProjectJobBestEffort } = await import("./projectWorkflow");
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
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/race-upload.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership(),
    });
    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            if (getTableName(table) === "projectJobs" && updates.status === "failed") {
              fakeDb.store.projectJobs[0] = {
                ...fakeDb.store.projectJobs[0],
                lockedBy: "worker-b",
                attemptCount: 2,
                heartbeatAt: new Date("2026-01-01T00:02:00.000Z"),
                leaseUntil: new Date("2099-01-01T00:05:00.000Z"),
              };
            }

            return baseUpdate.set(updates).where(condition);
          },
        }),
      };
    };

    const failed = await failClaimedProjectJobBestEffort(
      { jobId: 1, projectId: 1, type: "import_zip", lockedBy: "worker-a", attemptCount: 1 },
      new AppError("PROJECT_JOB_TIMEOUT", "attempt timed out")
    );

    expect(failed).toBe(false);
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "running",
      lockedBy: "worker-b",
      attemptCount: 2,
      errorCode: null,
      activeKey: "active",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({ status: "importing", importProgress: 10 });
    expect(rmMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Project job failure skipped because ownership changed",
      expect.objectContaining({
        action: "project.job.failure_skipped",
        jobId: 1,
        lockedBy: "worker-a",
        attemptCount: 1,
        errorCode: "PROJECT_JOB_TIMEOUT",
      })
    );
  });

  it("does not let a stale worker finalize a reclaimed job as completed or overwrite project state", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    seedProject(1, { status: "importing", importProgress: 10 });
    zipFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];

    let resolveRead!: (value: Buffer) => void;
    const readGate = new Promise((resolve) => {
      resolveRead = resolve as (value: Buffer) => void;
    }) as Promise<Buffer>;
    readFileMock.mockImplementationOnce(() => readGate as unknown as Promise<Buffer<ArrayBuffer>>);

    let projectJobUpdateCount = 0;
    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            if (getTableName(table) === "projectJobs") {
              projectJobUpdateCount += 1;
              if (projectJobUpdateCount === 3) {
                fakeDb.store.projectJobs[0] = {
                  ...fakeDb.store.projectJobs[0],
                  lockedBy: "worker-b",
                  attemptCount: 2,
                  heartbeatAt: new Date("2026-01-01T00:01:30.000Z"),
                  leaseUntil: new Date("2099-01-01T00:05:00.000Z"),
                };
                return { affectedRows: 0 };
              }
            }

            return baseUpdate.set(updates).where(condition);
          },
        }),
      };
    };

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
      ...claimedOwnership(),
    });

    const runPromise = runClaimedProjectJob(1);
    resolveRead(Buffer.from("zip-bytes"));

    await expect(runPromise).resolves.toBeUndefined();
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "running",
      lockedBy: "worker-b",
      attemptCount: 2,
      activeKey: "active",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "importing",
      importProgress: 10,
    });
  });

  it("does not let a stale worker finalize a reclaimed job as failed or overwrite project state", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    seedProject(1, { status: "importing", importProgress: 10 });

    let rejectRead!: (reason?: unknown) => void;
    const readGate = new Promise((_resolve, reject) => {
      rejectRead = reject as (reason?: unknown) => void;
    }) as Promise<Buffer>;
    readFileMock.mockImplementationOnce(() => readGate as unknown as Promise<Buffer<ArrayBuffer>>);

    let projectJobUpdateCount = 0;
    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            if (getTableName(table) === "projectJobs") {
              projectJobUpdateCount += 1;
              if (projectJobUpdateCount === 3) {
                fakeDb.store.projectJobs[0] = {
                  ...fakeDb.store.projectJobs[0],
                  lockedBy: "worker-b",
                  attemptCount: 2,
                  heartbeatAt: new Date("2026-01-01T00:01:30.000Z"),
                  leaseUntil: new Date("2099-01-01T00:05:00.000Z"),
                };
                return { affectedRows: 0 };
              }
            }

            return baseUpdate.set(updates).where(condition);
          },
        }),
      };
    };

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
      ...claimedOwnership(),
    });

    const runPromise = runClaimedProjectJob(1);
    rejectRead(new Error("disk read failed"));

    await expect(runPromise).resolves.toBeUndefined();
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "running",
      lockedBy: "worker-b",
      attemptCount: 2,
      activeKey: "active",
    });
    expect(fakeDb.store.projects[0]).toMatchObject({
      status: "importing",
      importProgress: 10,
    });
  });

  it("does not continue to finalize after heartbeat renewal fails", async () => {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    vi.useFakeTimers();
    seedProject(1, { status: "importing", importProgress: 10 });
    readFileMock.mockImplementationOnce(async () => {
      throw new Error("readFile should not run after heartbeat ownership is lost");
    });

    let projectJobUpdateCount = 0;
    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            if (getTableName(table) === "projectJobs") {
              projectJobUpdateCount += 1;
              if (projectJobUpdateCount === 2) {
                throw new Error("heartbeat write failed");
              }
            }

            return baseUpdate.set(updates).where(condition);
          },
        }),
      };
    };

    try {
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
        ...claimedOwnership(),
      });

      const runPromise = runClaimedProjectJob(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);

      await expect(runPromise).resolves.toBeUndefined();
      expect(readFileMock).not.toHaveBeenCalled();
      expect(fakeDb.store.projectJobs[0]).toMatchObject({
        status: "running",
        activeKey: "active",
        errorCode: null,
      });
      expect(fakeDb.store.projects[0]).toMatchObject({
        status: "importing",
        importProgress: 10,
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("treats a queued job as claimed even when the stored lease timestamps lose milliseconds", async () => {
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
            heartbeatAt:
              updates.heartbeatAt instanceof Date
                ? new Date(Math.floor(updates.heartbeatAt.getTime() / 1000) * 1000)
                : updates.heartbeatAt,
            leaseUntil:
              updates.leaseUntil instanceof Date
                ? new Date(Math.floor(updates.leaseUntil.getTime() / 1000) * 1000)
                : updates.leaseUntil,
          }),
      };
    };

    const claim = await claimNextQueuedProjectJobForTests();

    expect(claim).toMatchObject({ id: 1, status: "running" });
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ id: 1, status: "running" });
    expect(fakeDb.store.projectJobs[0]?.startedAt).toBeInstanceOf(Date);
    expect(fakeDb.store.projectJobs[0]?.heartbeatAt).toBeInstanceOf(Date);
    expect(fakeDb.store.projectJobs[0]?.leaseUntil).toBeInstanceOf(Date);
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

  it.each([
    ["attemptCount", (row: Row) => ({ attemptCount: Number(row.attemptCount ?? 0) + 1 })],
    ["lockedBy", () => ({ lockedBy: "worker-competing" })],
  ])("rejects a fallback claim when %s changes before reselect", async (_field, mutateClaimedRow) => {
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

    const originalUpdate = fakeDb.update.bind(fakeDb);
    fakeDb.update = (table: object) => {
      const baseUpdate = originalUpdate(table);
      return {
        set: (updates: Row) => ({
          where: async (condition: Condition) => {
            const result = await baseUpdate.set(updates).where(condition);
            if (getTableName(table) === "projectJobs" && result.affectedRows === 1) {
              fakeDb.store.projectJobs[0] = {
                ...fakeDb.store.projectJobs[0],
                ...mutateClaimedRow(fakeDb.store.projectJobs[0]),
              };
            }
            return result;
          },
        }),
      };
    };

    const claim = await claimNextQueuedProjectJobForTests();

    expect(claim).toBeNull();
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      id: 1,
      status: "running",
      lockedBy: expect.any(String),
    });
  });

  it("does not let another worker claim a running job while its lease is still valid", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "analyzing" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "running",
      progress: 60,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      lockedBy: "worker-still-active",
      heartbeatAt: new Date("2026-01-01T00:00:10.000Z"),
      leaseUntil: new Date("2099-01-01T00:00:20.000Z"),
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      finishedAt: null,
    });

    const claim = await claimNextQueuedProjectJobForTests();

    expect(claim).toBeNull();
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      id: 1,
      status: "running",
      lockedBy: "worker-still-active",
      attemptCount: 1,
    });
  });

  it("does not reclaim a running job after it has exhausted max attempts", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "analyzing" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "running",
      progress: 60,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: "active",
      lockedBy: "worker-exhausted",
      heartbeatAt: new Date("2026-01-01T00:00:10.000Z"),
      leaseUntil: new Date("2026-01-01T00:00:20.000Z"),
      attemptCount: 3,
      maxAttempts: 3,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      finishedAt: null,
    });

    const claim = await claimNextQueuedProjectJobForTests();

    expect(claim).toBeNull();
    expect(fakeDb.store.projectJobs[0]).toMatchObject({
      status: "running",
      lockedBy: "worker-exhausted",
      attemptCount: 3,
      maxAttempts: 3,
    });
  });

  it("claims queued jobs in stable createdAt/id order without scanning unrelated completed rows into execution", async () => {
    const { claimNextQueuedProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { status: "ready" });
    fakeDb.store.projectJobs.push(
      {
        id: 3,
        projectId: 1,
        userId: 7,
        type: "analyze",
        status: "completed",
        progress: 100,
        errorCode: null,
        errorMessage: null,
        payloadJson: null,
        activeKey: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:01:00.000Z"),
        finishedAt: new Date("2026-01-01T00:02:00.000Z"),
      },
      {
        id: 2,
        projectId: 1,
        userId: 7,
        type: "analyze",
        status: "queued",
        progress: 0,
        errorCode: null,
        errorMessage: null,
        payloadJson: JSON.stringify({ type: "analyze" }),
        activeKey: "active",
        createdAt: new Date("2026-01-01T00:00:05.000Z"),
        startedAt: null,
        finishedAt: null,
      },
      {
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
        createdAt: new Date("2026-01-01T00:00:05.000Z"),
        startedAt: null,
        finishedAt: null,
      }
    );

    const firstClaim = await claimNextQueuedProjectJobForTests();
    const secondClaim = await claimNextQueuedProjectJobForTests();

    expect(firstClaim).toMatchObject({ id: 1, status: "running" });
    expect(secondClaim).toMatchObject({ id: 2, status: "running" });
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
      ...claimedOwnership(),
    });
    fakeDb.store.projects[0] = { ...fakeDb.store.projects[0], status: "analyzing" };

    await expect(queueImportProjectGit(1, 7, "https://example.com/repo.git")).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await expect(queueImportProjectZip(1, 7, "encoded")).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
  });

  it("keeps queued jobs blocking new project jobs", async () => {
    const { queueAnalyzeProject } = await import("./projectWorkflow");
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

    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    expect(fakeDb.store.projectJobs).toHaveLength(1);
  });

  it("keeps running jobs with a valid lease blocking new project jobs", async () => {
    const { queueAnalyzeProject } = await import("./projectWorkflow");
    seedProject(1, { status: "ready" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 50,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", zipContent: "encoded" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership({ leaseUntil: new Date(Date.now() + 60_000), heartbeatAt: new Date() }),
    });

    await expect(queueAnalyzeProject(1, 7)).rejects.toMatchObject({ code: "PROJECT_JOB_ACTIVE" });
    expect(fakeDb.store.projectJobs).toHaveLength(1);
  });

  it("does not let a running job with an expired lease block new project jobs forever", async () => {
    const { queueAnalyzeProject } = await import("./projectWorkflow");
    const originalValue = process.env.PROJECT_WORKER_ENABLED;
    process.env.PROJECT_WORKER_ENABLED = "false";
    seedProject(1, { status: "ready" });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "running",
      progress: 50,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", zipContent: "encoded" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
      ...claimedOwnership({ leaseUntil: new Date(Date.now() - 60_000), heartbeatAt: new Date(Date.now() - 90_000) }),
    });

    try {
      await expect(queueAnalyzeProject(1, 7)).resolves.toMatchObject({ projectId: 1, status: "queued" });
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROJECT_WORKER_ENABLED;
      } else {
        process.env.PROJECT_WORKER_ENABLED = originalValue;
      }
    }
    expect(fakeDb.store.projectJobs[0]).toMatchObject({ id: 1, status: "running", activeKey: null });
    expect(fakeDb.store.projectJobs[1]).toMatchObject({ type: "analyze", status: "queued", activeKey: "active" });
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

  it("deletes a project together with completed jobs, files, graph data, and analysis results", async () => {
    const { deleteProjectCascade } = await import("./projectWorkflow");
    seedProject(1, { status: "completed" });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main" });
    fakeDb.store.symbols.push({ id: 1, projectId: 1, fileId: 1, name: "main", type: "function", startLine: 1, endLine: 1 });
    fakeDb.store.dependencies.push({ id: 1, projectId: 1, sourceSymbolId: 1, targetSymbolId: null, targetKind: "external", dependencyType: "calls" });
    fakeDb.store.fields.push({ id: 1, projectId: 1, tableName: "orders", fieldName: "amount" });
    fakeDb.store.fieldDependencies.push({ id: 1, projectId: 1, fieldId: 1, symbolId: 1, operationType: "read" });
    fakeDb.store.risks.push({ id: 1, projectId: 1, riskType: "magic_value", severity: "medium", title: "Risk" });
    fakeDb.store.rules.push({ id: 1, projectId: 1, ruleType: "validation", name: "Rule" });
    fakeDb.store.analysisResults.push({ id: 1, projectId: 1, status: "completed", warningsJson: [] });
    fakeDb.store.analysisBaselines.push({ projectId: 1, analysisResultId: 1, createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z") });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "analyze",
      status: "completed",
      progress: 100,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "analyze" }),
      activeKey: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: new Date("2026-01-01T00:00:10.000Z"),
    });

    await deleteProjectCascade(1, 7);

    expect(fakeDb.store.projects).toHaveLength(0);
    expect(fakeDb.store.projectJobs).toHaveLength(0);
    expect(fakeDb.store.files).toHaveLength(0);
    expect(fakeDb.store.symbols).toHaveLength(0);
    expect(fakeDb.store.dependencies).toHaveLength(0);
    expect(fakeDb.store.fields).toHaveLength(0);
    expect(fakeDb.store.fieldDependencies).toHaveLength(0);
    expect(fakeDb.store.risks).toHaveLength(0);
    expect(fakeDb.store.rules).toHaveLength(0);
    expect(fakeDb.store.analysisResults).toHaveLength(0);
    expect(fakeDb.store.analysisBaselines).toHaveLength(0);
  });

  it("manages baselines directly across set, replace, clear, idempotent set, and history summary state", async () => {
    const { clearAnalysisBaseline, getAnalysisRunDetail, listAnalysisRuns, setAnalysisBaseline } = await import("./analysisHistory");
    seedProject(1, { status: "completed" });
    const run1 = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "old.go", content: "package old" }],
    });
    const run2 = createValidAnalysisRunFixture({
      id: 2,
      projectId: 1,
      runNumber: 2,
      projectFiles: [{ path: "new.go", content: "package new" }],
    });
    fakeDb.store.projects[0].sourceFingerprint = run2.sourceFingerprint;
    fakeDb.store.analysisResults.push(run1.row, run2.row);

    await expect(setAnalysisBaseline(fakeDb, 1, 1)).resolves.toEqual({ success: true });
    expect(fakeDb.store.analysisBaselines).toEqual([
      expect.objectContaining({ projectId: 1, analysisResultId: 1 }),
    ]);
    await expect(setAnalysisBaseline(fakeDb, 1, 1)).resolves.toEqual({ success: true });
    expect(fakeDb.store.analysisBaselines).toHaveLength(1);
    expect(fakeDb.store.analysisBaselines[0]).toEqual(expect.objectContaining({ projectId: 1, analysisResultId: 1 }));

    await expect(setAnalysisBaseline(fakeDb, 1, 2)).resolves.toEqual({ success: true });
    expect(fakeDb.store.analysisBaselines).toEqual([
      expect.objectContaining({ projectId: 1, analysisResultId: 2 }),
    ]);

    const history = await listAnalysisRuns(fakeDb, 1, 1, 10);
    expect(history.items).toEqual([
      expect.objectContaining({ id: 2, runNumber: 2, isBaseline: true, isLatestUsable: true }),
      expect.objectContaining({ id: 1, runNumber: 1, isBaseline: false, isLatestUsable: false }),
    ]);
    const detail = await getAnalysisRunDetail(fakeDb, 1, 2);
    expect(detail).toEqual(expect.objectContaining({ id: 2, runNumber: 2, isBaseline: true }));

    await expect(clearAnalysisBaseline(fakeDb, 1)).resolves.toEqual({ success: true });
    expect(fakeDb.store.analysisBaselines).toEqual([]);
    const clearedHistory = await listAnalysisRuns(fakeDb, 1, 1, 10);
    expect(clearedHistory.items).toEqual([
      expect.objectContaining({ id: 2, isBaseline: false }),
      expect.objectContaining({ id: 1, isBaseline: false }),
    ]);
  });

  it("rejects cross-project and unusable baseline selections", async () => {
    const { setAnalysisBaseline } = await import("./analysisHistory");
    seedProject(1, { status: "completed" });
    seedProject(2, { status: "completed", userId: 7 });
    const run1 = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "main.go", content: "package main" }],
    });
    const run2 = createValidAnalysisRunFixture({
      id: 2,
      projectId: 2,
      runNumber: 1,
      projectFiles: [{ path: "other.go", content: "package other" }],
    });
    fakeDb.store.analysisResults.push(run1.row, run2.row, { ...run1.row, id: 3, runNumber: 2, status: "failed" });

    await expect(setAnalysisBaseline(fakeDb, 1, 2)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(setAnalysisBaseline(fakeDb, 1, 3)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    expect(fakeDb.store.analysisBaselines).toEqual([]);
  });

  it("derives and backfills the current source fingerprint idempotently from current files", async () => {
    const { ensureProjectSourceFingerprint } = await import("./analysisHistory");
    seedProject(1, { status: "completed", sourceFingerprint: null });
    fakeDb.store.files.push(
      { id: 1, projectId: 1, filePath: "src/B.pas", fileName: "B.pas", fileType: ".pas", lineCount: 10, status: "stored", content: "unit B;" },
      { id: 2, projectId: 1, filePath: "src/A.pas", fileName: "A.pas", fileType: ".pas", lineCount: 5, status: "stored", content: "unit A;" }
    );

    const first = await ensureProjectSourceFingerprint(fakeDb, 1);
    const second = await ensureProjectSourceFingerprint(fakeDb, 1);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(fakeDb.store.projects[0].sourceFingerprint).toBe(first);

    const original = first;
    fakeDb.store.files.reverse();
    expect(await ensureProjectSourceFingerprint(fakeDb, 1)).toBe(original);
    fakeDb.store.files[0].lineCount = 999;
    fakeDb.store.files[0].fileType = "pascal";
    expect(await ensureProjectSourceFingerprint(fakeDb, 1)).toBe(original);
    fakeDb.store.projects[0].sourceFingerprint = null;
    fakeDb.store.files[0].filePath = "src/C.pas";
    const changedPath = await ensureProjectSourceFingerprint(fakeDb, 1);
    expect(changedPath).not.toBe(original);
    fakeDb.store.projects[0].sourceFingerprint = null;
    fakeDb.store.files[0].filePath = "src/B.pas";
    fakeDb.store.files[0].content = "unit B; interface";
    const changedContent = await ensureProjectSourceFingerprint(fakeDb, 1);
    expect(changedContent).not.toBe(original);
  });

  it("retries duplicate run-number allocation once and uses the next available run number", async () => {
    const { writeSuccessfulAnalysis } = await import("./project/projectAnalysisPersistence");
    seedProject(1, { status: "completed" });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", lineCount: 1, status: "stored", content: "package main" });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      runNumber: 1,
      status: "completed",
      sourceFingerprint: "old-source",
      snapshotJson: "{}",
      warningsJson: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const originalInsert = fakeDb.insert.bind(fakeDb);
    let duplicateCount = 0;
    fakeDb.insert = (table: object) => {
      const tableName = getTableName(table);
      const base = originalInsert(table);
      if (tableName !== "analysisResults") {
        return base;
      }
      return {
        values: async (payload: Row | Row[]) => {
          const row = Array.isArray(payload) ? payload[0] : payload;
          if (Number(row.runNumber) === 2 && duplicateCount === 0) {
            duplicateCount += 1;
            fakeDb.store.analysisResults.push({
              id: 99,
              projectId: 1,
              runNumber: 2,
              status: "completed",
              sourceFingerprint: "raced-source",
              snapshotJson: "{}",
              warningsJson: [],
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            });
            const error = new Error("Duplicate entry '1-2' for key 'analysisResults_projectId_runNumber_unique'") as Error & { code?: string };
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          return base.values(payload);
        },
      };
    };

    await writeSuccessfulAnalysis(
      {
        tx: fakeDb,
        projectId: 1,
        projectFiles: [{ id: 1, filePath: "main.go" }],
        result: createPersistenceAnalysisResult(),
        persistCheckpoint: { operation: "start", table: "analysisResults" },
      },
      {
        assertProjectJobExecutionActive: async () => undefined,
        getAnalysisResultErrorMessage: () => null,
        throwAnalysisPersistError: (error) => {
          throw error;
        },
        insertInChunks: async (db, table, rows) => {
          await db.insert(table as any).values(rows as Row[]);
        },
        resolveOwningSymbol: (symbolsForProject, file, line) =>
          symbolsForProject.find((symbol) => symbol.file === file && symbol.startLine <= line && symbol.endLine >= line),
        resolveInsertedTargetSymbolId: () => undefined,
        transitionProjectState: async () => undefined,
      }
    );

    const runNumbers = fakeDb.store.analysisResults.map((row: Row) => Number(row.runNumber)).sort((left: number, right: number) => left - right);
    expect(runNumbers).toEqual([1, 2, 3]);
    expect(fakeDb.store.analysisResults.find((row: Row) => Number(row.runNumber) === 3)).toEqual(
      expect.objectContaining({ status: "completed", projectId: 1 })
    );
  });

  it("keeps retries bounded, does not retry non-duplicate failures, and leaves no partial immutable run on final failure", async () => {
    const { writeSuccessfulAnalysis } = await import("./project/projectAnalysisPersistence");
    seedProject(1, { status: "completed" });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", lineCount: 1, status: "stored", content: "package main" });
    fakeDb.store.analysisResults.push({
      id: 1,
      projectId: 1,
      runNumber: 1,
      status: "completed",
      sourceFingerprint: "stable-source",
      snapshotJson: "{}",
      warningsJson: [],
      flowMarkdown: "# OLD FLOW",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const makeDeps = () => ({
      assertProjectJobExecutionActive: async () => undefined,
      getAnalysisResultErrorMessage: () => null,
      throwAnalysisPersistError: (error: unknown) => {
        throw error;
      },
      insertInChunks: async (db: typeof fakeDb, table: object, rows: Row[]) => {
        await db.insert(table as any).values(rows);
      },
      resolveOwningSymbol: (symbolsForProject: ProjectAnalysisResult["symbols"], file: string, line: number) =>
        symbolsForProject.find((symbol) => symbol.file === file && symbol.startLine <= line && symbol.endLine >= line),
      resolveInsertedTargetSymbolId: () => undefined,
      transitionProjectState: async () => undefined,
    });

    const originalInsert = fakeDb.insert.bind(fakeDb);
    let duplicateAttempts = 0;
    fakeDb.insert = (table: object) => {
      const tableName = getTableName(table);
      const base = originalInsert(table);
      if (tableName !== "analysisResults") {
        return base;
      }
      return {
        values: async () => {
          duplicateAttempts += 1;
          const error = new Error("Duplicate entry for key 'analysisResults_projectId_runNumber_unique'") as Error & { code?: string };
          error.code = "ER_DUP_ENTRY";
          throw error;
        },
      };
    };

    await expect(
      writeSuccessfulAnalysis(
        {
          tx: fakeDb,
          projectId: 1,
          projectFiles: [{ id: 1, filePath: "main.go" }],
          result: createPersistenceAnalysisResult(),
          persistCheckpoint: { operation: "start", table: "analysisResults" },
        },
        makeDeps()
      )
    ).rejects.toThrow("Duplicate entry for key 'analysisResults_projectId_runNumber_unique'");
    expect(duplicateAttempts).toBe(3);
    expect(fakeDb.store.analysisResults).toEqual([
      expect.objectContaining({ runNumber: 1, flowMarkdown: "# OLD FLOW", sourceFingerprint: "stable-source" }),
    ]);

    let nonDuplicateAttempts = 0;
    fakeDb.insert = (table: object) => {
      const tableName = getTableName(table);
      const base = originalInsert(table);
      if (tableName !== "analysisResults") {
        return base;
      }
      return {
        values: async () => {
          nonDuplicateAttempts += 1;
          throw new Error("database connection lost");
        },
      };
    };

    await expect(
      writeSuccessfulAnalysis(
        {
          tx: fakeDb,
          projectId: 1,
          projectFiles: [{ id: 1, filePath: "main.go" }],
          result: createPersistenceAnalysisResult(),
          persistCheckpoint: { operation: "start", table: "analysisResults" },
        },
        makeDeps()
      )
    ).rejects.toThrow("database connection lost");
    expect(nonDuplicateAttempts).toBe(1);
    expect(fakeDb.store.analysisResults).toEqual([
      expect.objectContaining({ runNumber: 1, flowMarkdown: "# OLD FLOW", sourceFingerprint: "stable-source" }),
    ]);
  });

  it("enforces ownership on paged reads and job reads", async () => {
    const { getProjectJob, getSymbolsPage, queueAnalyzeProject, waitForProjectJobForTests } = await import("./projectWorkflow");
    seedProject(1, { userId: 7 });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    analyzerResult = createAnalysisResultFixture({
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
    });

    const job = await queueAnalyzeProject(1, 7);
    await waitForProjectJobForTests(job.jobId);

    await expect(getSymbolsPage({ projectId: 1, page: 1, pageSize: 25 }, 99)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(getProjectJob(job.jobId, 99)).rejects.toMatchObject({ code: "PROJECT_JOB_NOT_FOUND" });
  });

  it("builds a downloadable report archive with the expected files", async () => {
    const { buildReportArchive } = await import("./projectWorkflow");
    const finalConfidence = {
      score: 64,
      level: "medium" as const,
      breakdown: [
        { label: "Base score", impact: 100, reason: "Start from full confidence." },
        { label: "Persisted final penalty", impact: -36, reason: "Use the persisted final analysis result confidence." },
      ],
    };
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "report-project",
      language: "go",
      sourceType: "upload",
      status: "completed",
      importWarningsJson: [{ code: "IMPORT_LIMITED_ANALYSIS", message: "Imported with limited analysis.", filePath: "Form1.dfm" }],
    });
    const currentFiles = [
      { id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" },
      {
        id: 2,
        projectId: 1,
        filePath: "repo/Invoice.pas",
        fileName: "Invoice.pas",
        fileType: ".pas",
        content: "procedure UpdateOrder;\nbegin\n  Query.ParamByName('OrderId').AsInteger := 42;\nend;",
        lineCount: 4,
        status: "stored",
      },
    ];
    fakeDb.store.files.push(...currentFiles);
    const currentRun = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: currentFiles.map((file) => ({ path: file.filePath, content: String(file.content), fileType: String(file.fileType) })),
      projectContext: {
        projectName: "report-project",
        sourceType: "upload",
        focusLanguage: "go",
        importWarnings: [{ code: "IMPORT_LIMITED_ANALYSIS", message: "Imported with limited analysis.", filePath: "Form1.dfm" }],
      },
      result: {
        status: "completed",
        symbols: [
          { stableKey: "main.go::main::1", name: "main", type: "function", file: "main.go", startLine: 1, endLine: 1, signature: "func main()" },
          { stableKey: "repo/Invoice.pas::UpdateOrder::1", name: "UpdateOrder", type: "procedure", file: "repo/Invoice.pas", startLine: 1, endLine: 4, signature: "procedure UpdateOrder;" },
        ],
        dependencies: [{ from: "main.go::main::1", fromName: "main", toName: "external.Dependency", targetKind: "unresolved", type: "references", line: 1 }],
        fieldReferences: [
          {
            table: "delphi",
            field: "OrderId",
            type: "write",
            file: "repo/Invoice.pas",
            line: 3,
            symbolStableKey: "repo/Invoice.pas::UpdateOrder::1",
            symbolName: "UpdateOrder",
            context: "Query.ParamByName('OrderId').AsInteger := 42;",
          },
        ],
        risks: [{ title: "Critical risk", description: "high risk", severity: "high", category: "magic_value", sourceFile: "main.go", lineNumber: 1 }],
        rules: [{ ruleType: "validation", name: "MainRule", description: "validate", sourceFile: "main.go", lineNumber: 1 }],
        delphiEventMap: [
          {
            formName: "InvoiceForm",
            componentName: "SaveButton",
            componentClass: "TButton",
            eventName: "OnClick",
            handlerName: "SaveButtonClick",
            filePath: "repo/Invoice.dfm",
            lineNumber: 3,
            resolvedMethod: null,
            resolvedFile: null,
            status: "unresolved",
            warnings: ["Handler was not resolved."],
          },
        ],
        delphiDataBindings: [
          {
            formName: "InvoiceForm",
            componentName: "OrderIdEdit",
            componentClass: "TDBEdit",
            dataSource: "OrdersSource",
            dataSet: null,
            dataField: "OrderId",
            readOnly: false,
            enabled: true,
            visible: true,
            accessHint: "unresolved",
            confidence: "low",
            sourceFile: "repo/Invoice.dfm",
            lineNumber: 7,
            warnings: ["DataSet was not resolved."],
          },
        ],
        buildDoctor: {
          status: "ready_with_warnings",
          score: 72,
          compilerFamily: { value: "Delphi", confidence: "medium", evidence: ["Invoice.dpr"] },
          projectEntries: [{ path: "Invoice.dpr", kind: "project", lineNumber: 1, evidence: "program Invoice;" }],
          configurations: ["Debug"],
          platforms: ["Win32"],
          defines: ["DEBUG"],
          searchPaths: ["src"],
          includePaths: [],
          outputPaths: [],
          runtimePackages: ["rtl"],
          requiredPackages: ["vcl"],
          packageResolutions: [{ packageName: "vcl", resolution: "delphi_standard", evidence: ["vcl"] }],
          requiredUnits: ["Forms"],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [{ code: "DEL001", severity: "warning", title: "OLD_FINDING", description: "legacy finding", recommendation: "review", confidence: "medium", evidence: "Invoice.dpr" }],
          limitations: [],
        },
        flowTraces: [
          {
            stableKey: "trace-1",
            formName: "InvoiceForm",
            componentName: "SaveButton",
            componentClass: "TButton",
            eventName: "OnClick",
            handlerName: "SaveButtonClick",
            resolvedHandler: "UpdateOrder",
            status: "partial",
            confidence: "medium",
            steps: [{ id: "step-1", type: "handler", label: "UpdateOrder", filePath: "repo/Invoice.pas", lineNumber: 1, confidence: "medium" }],
            affectedTables: ["delphi"],
            affectedFields: [{ table: "delphi", field: "OrderId", operation: "write" }],
            warnings: ["trace warning"],
            truncated: false,
          },
        ],
        flowTraceSummary: { candidateTraceCount: 1, persistedTraceCount: 1, globalTruncated: false },
        flowDocument: "# FLOW",
        dataDependencyDocument: "# DATA_DEPENDENCY",
        risksDocument: "# RISKS",
        rulesYaml: "rules: []",
        metrics: {
          fileCount: 2,
          eligibleFileCount: 2,
          analyzedFileCount: 2,
          skippedFileCount: 0,
          heuristicFileCount: 0,
          degradedFileCount: 0,
          symbolCount: 2,
          dependencyCount: 1,
          fieldCount: 0,
          fieldDependencyCount: 1,
          riskCount: 1,
          ruleCount: 1,
          warningCount: 0,
          delphiEventMap: [],
          delphiDataBindings: [],
          confidence: finalConfidence,
        },
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = currentRun.sourceFingerprint;
    fakeDb.store.analysisResults.push(currentRun.row);

    const archive = await buildReportArchive(1, 7);
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));

    expect(archive.mimeType).toBe("application/zip");
    expect(zip.file("FLOW.md")).toBeTruthy();
    expect(zip.file("DATA_DEPENDENCY.md")).toBeTruthy();
    expect(zip.file("RISKS.md")).toBeTruthy();
    expect(zip.file("RULES.yaml")).toBeTruthy();
    expect(zip.file("IMPACT_ANALYSIS.md")).toBeTruthy();
    expect(zip.file("EXECUTIVE_SUMMARY.md")).toBeTruthy();
    expect(zip.file("PROJECT_OVERVIEW.md")).toBeTruthy();
    expect(zip.file("FILE_INVENTORY.md")).toBeTruthy();
    expect(zip.file("DELPHI_FIELD_ACCESS.md")).toBeTruthy();
    expect(zip.file("DELPHI_EVENT_MAP.md")).toBeTruthy();
    expect(zip.file("DELPHI_DATA_BINDINGS.md")).toBeTruthy();
    expect(zip.file("LIMITATIONS.md")).toBeTruthy();
    expect(zip.file("FULL_FINDINGS.json")).toBeTruthy();
    expect(zip.file("impact-analysis.json")).toBeTruthy();
    expect(zip.file("import-warnings.json")).toBeTruthy();
    expect(zip.file("metadata.json")).toBeTruthy();
    expect(zip.file("analysis-summary.json")).toBeTruthy();
    await expect(zip.file("impact-analysis.json")!.async("text")).resolves.toContain("\"topImpactedFiles\"");
    const executiveSummary = await zip.file("EXECUTIVE_SUMMARY.md")!.async("text");
    expect(executiveSummary).toContain("## Project Summary");
    expect(executiveSummary).toContain("## Analysis Confidence");
    expect(executiveSummary).toContain("- Score: 64/100");
    expect(executiveSummary).toContain("## Key Findings Top 5");
    expect(executiveSummary).toContain("FieldByName/ParamByName write access");
    expect(executiveSummary).toContain("## Delphi Audit Summary");
    expect(executiveSummary).toContain("Resolved / unresolved event handlers: 0 / 1");
    expect(executiveSummary).toContain("Resolved / unresolved data bindings: 0 / 1");
    expect(executiveSummary).toContain("## Recommended Next Actions");
    expect(executiveSummary).toContain("P0:");
    expect(executiveSummary).toContain("## Manual Review Notice");
    expect(executiveSummary).toContain("heuristic static analysis");
    await expect(zip.file("PROJECT_OVERVIEW.md")!.async("text")).resolves.toContain("Delphi-like files: 1");
    await expect(zip.file("PROJECT_OVERVIEW.md")!.async("text")).resolves.toContain("Analysis Confidence");
    await expect(zip.file("PROJECT_OVERVIEW.md")!.async("text")).resolves.toContain("- Score: 64/100");
    await expect(zip.file("PROJECT_OVERVIEW.md")!.async("text")).resolves.toContain("- Level: medium");
    await expect(zip.file("FILE_INVENTORY.md")!.async("text")).resolves.toContain("repo/Invoice.pas");
    await expect(zip.file("DELPHI_FIELD_ACCESS.md")!.async("text")).resolves.toContain("param:OrderId");
    await expect(zip.file("LIMITATIONS.md")!.async("text")).resolves.toContain("heuristic static analysis");
    const fullFindings = JSON.parse(await zip.file("FULL_FINDINGS.json")!.async("text")) as {
      fieldAccesses: Array<{ owner: string; name: string; operation: string }>;
      metadata: { sourceType: string; confidence: unknown };
      confidence: unknown;
      symbols: unknown[];
      dependencies: unknown[];
      risks: unknown[];
    };
    expect(fullFindings.metadata.sourceType).toBe("upload");
    expect(fullFindings.metadata.confidence).toEqual(finalConfidence);
    expect(fullFindings.confidence).toEqual(finalConfidence);
    expect(fullFindings.symbols).toHaveLength(2);
    expect(fullFindings.dependencies).toHaveLength(1);
    expect(fullFindings.risks).toHaveLength(1);
    expect(fullFindings.fieldAccesses).toEqual([expect.objectContaining({ owner: "Query", name: "OrderId", operation: "write" })]);

    const metadata = JSON.parse(await zip.file("metadata.json")!.async("text")) as { confidence?: unknown; runNumber?: number; projectId?: number };
    expect(metadata.confidence).toEqual(finalConfidence);
    expect(metadata.runNumber).toBe(1);
    expect(metadata.projectId).toBe(1);
    const summary = JSON.parse(await zip.file("analysis-summary.json")!.async("text")) as { confidence?: unknown };
    expect(summary.confidence).toEqual(finalConfidence);
  });

  it("exports a selected historical analysis run by id", async () => {
    const { buildReportArchive } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "historical-report",
      language: "go",
      sourceType: "upload",
      status: "completed",
      importWarningsJson: [],
    });
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "NewForm.pas", fileName: "NewForm.pas", fileType: ".pas", content: "procedure NewSave;\nbegin\nend;", lineCount: 3, status: "stored" });
    const run1 = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "OldForm.pas", content: "procedure OldSave;\nbegin\nend;", fileType: ".pas" }],
      projectContext: { projectName: "historical-report", sourceType: "upload", focusLanguage: "go", importWarnings: [] },
      result: {
        status: "completed",
        symbols: [{ stableKey: "OldForm.pas::OldSave::1", name: "OldSave", type: "procedure", file: "OldForm.pas", startLine: 1, endLine: 3 }],
        fieldReferences: [{ table: "OLD_ORDER", field: "ID", type: "read", file: "OldForm.pas", line: 2, symbolStableKey: "OldForm.pas::OldSave::1", symbolName: "OldSave", context: "FieldByName('ID')" }],
        risks: [{ title: "Old risk", description: "legacy", severity: "high", category: "magic_value", sourceFile: "OldForm.pas", lineNumber: 2 }],
        buildDoctor: {
          status: "ready_with_warnings",
          score: 60,
          compilerFamily: { value: "Delphi", confidence: "medium", evidence: ["OldForm.pas"] },
          projectEntries: [],
          configurations: [],
          platforms: [],
          defines: [],
          searchPaths: [],
          includePaths: [],
          outputPaths: [],
          runtimePackages: [],
          requiredPackages: [],
          packageResolutions: [],
          requiredUnits: [],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [{ code: "OLD_FINDING", severity: "warning", title: "OLD_FINDING", description: "old finding", recommendation: "review", confidence: "medium", evidence: "OldForm.pas:2" }],
          limitations: [],
        },
        flowTraces: [{ stableKey: "old-trace", formName: "OldForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "OldSave", resolvedHandler: "OldSave", status: "complete", confidence: "high", steps: [{ id: "old-step", type: "handler", label: "OldSave", filePath: "OldForm.pas", lineNumber: 1, confidence: "high" }], affectedTables: ["OLD_ORDER"], affectedFields: [{ table: "OLD_ORDER", field: "ID", operation: "read" }], warnings: [], truncated: false }],
        flowTraceSummary: { candidateTraceCount: 1, persistedTraceCount: 1, globalTruncated: false },
        delphiEventMap: [{ formName: "OldForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "OldSave", filePath: "OldForm.dfm", lineNumber: 1, resolvedMethod: "OldSave", resolvedFile: "OldForm.pas", status: "resolved", warnings: [] }],
        delphiDataBindings: [{ formName: "OldForm", componentName: "OrderEdit", componentClass: "TDBEdit", dataSource: "OrdersSource", dataSet: "OLD_ORDER", dataField: "ID", readOnly: false, enabled: true, visible: true, accessHint: "read-write", confidence: "high", sourceFile: "OldForm.dfm", lineNumber: 2, warnings: [] }],
        flowDocument: "# OLD FLOW",
        dataDependencyDocument: "# OLD DATA",
        risksDocument: "# OLD RISKS",
        rulesYaml: "rules: []",
      },
    });
    const run2 = createValidAnalysisRunFixture({
      id: 2,
      projectId: 1,
      runNumber: 2,
      projectFiles: [{ path: "NewForm.pas", content: "procedure NewSave;\nbegin\nend;", fileType: ".pas" }],
      projectContext: { projectName: "historical-report", sourceType: "upload", focusLanguage: "go", importWarnings: [] },
      result: {
        status: "completed",
        symbols: [{ stableKey: "NewForm.pas::NewSave::1", name: "NewSave", type: "procedure", file: "NewForm.pas", startLine: 1, endLine: 3 }],
        fieldReferences: [{ table: "NEW_ORDER", field: "ID", type: "write", file: "NewForm.pas", line: 2, symbolStableKey: "NewForm.pas::NewSave::1", symbolName: "NewSave", context: "FieldByName('ID')" }],
        risks: [{ title: "New risk", description: "modern", severity: "high", category: "magic_value", sourceFile: "NewForm.pas", lineNumber: 2 }],
        buildDoctor: {
          status: "ready_with_warnings",
          score: 80,
          compilerFamily: { value: "Delphi", confidence: "medium", evidence: ["NewForm.pas"] },
          projectEntries: [],
          configurations: [],
          platforms: [],
          defines: [],
          searchPaths: [],
          includePaths: [],
          outputPaths: [],
          runtimePackages: [],
          requiredPackages: [],
          packageResolutions: [],
          requiredUnits: [],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [{ code: "NEW_FINDING", severity: "warning", title: "NEW_FINDING", description: "new finding", recommendation: "review", confidence: "medium", evidence: "NewForm.pas:2" }],
          limitations: [],
        },
        flowTraces: [{ stableKey: "new-trace", formName: "NewForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "NewSave", resolvedHandler: "NewSave", status: "complete", confidence: "high", steps: [{ id: "new-step", type: "handler", label: "NewSave", filePath: "NewForm.pas", lineNumber: 1, confidence: "high" }], affectedTables: ["NEW_ORDER"], affectedFields: [{ table: "NEW_ORDER", field: "ID", operation: "write" }], warnings: [], truncated: false }],
        flowTraceSummary: { candidateTraceCount: 1, persistedTraceCount: 1, globalTruncated: false },
        delphiEventMap: [{ formName: "NewForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "NewSave", filePath: "NewForm.dfm", lineNumber: 1, resolvedMethod: "NewSave", resolvedFile: "NewForm.pas", status: "resolved", warnings: [] }],
        delphiDataBindings: [{ formName: "NewForm", componentName: "OrderEdit", componentClass: "TDBEdit", dataSource: "OrdersSource", dataSet: "NEW_ORDER", dataField: "ID", readOnly: false, enabled: true, visible: true, accessHint: "read-write", confidence: "high", sourceFile: "NewForm.dfm", lineNumber: 2, warnings: [] }],
        flowDocument: "# NEW FLOW",
        dataDependencyDocument: "# NEW DATA",
        risksDocument: "# NEW RISKS",
        rulesYaml: "rules: []",
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = run2.sourceFingerprint;
    fakeDb.store.analysisResults.push(run1.row, run2.row);

    const archive = await buildReportArchive(1, 7, 1);
    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));

    await expect(zip.file("FLOW.md")!.async("text")).resolves.toBe("# OLD FLOW");
    await expect(zip.file("FILE_INVENTORY.md")!.async("text")).resolves.toContain("OldForm.pas");
    await expect(zip.file("FILE_INVENTORY.md")!.async("text")).resolves.not.toContain("NewForm.pas");
    await expect(zip.file("DELPHI_FIELD_ACCESS.md")!.async("text")).resolves.toContain("OldForm.pas");
    await expect(zip.file("DELPHI_FIELD_ACCESS.md")!.async("text")).resolves.toContain("field:ID");
    await expect(zip.file("DELPHI_FIELD_ACCESS.md")!.async("text")).resolves.not.toContain("NewForm.pas");
    await expect(zip.file("DELPHI_EVENT_MAP.md")!.async("text")).resolves.toContain("OldSave");
    await expect(zip.file("DELPHI_EVENT_MAP.md")!.async("text")).resolves.not.toContain("NewSave");
    await expect(zip.file("DELPHI_DATA_BINDINGS.md")!.async("text")).resolves.toContain("OLD_ORDER");
    await expect(zip.file("DELPHI_DATA_BINDINGS.md")!.async("text")).resolves.not.toContain("NEW_ORDER");
    await expect(zip.file("DELPHI_BUILD_DOCTOR.md")!.async("text")).resolves.toContain("OLD_FINDING");
    await expect(zip.file("DELPHI_BUILD_DOCTOR.md")!.async("text")).resolves.not.toContain("NEW_FINDING");
    await expect(zip.file("UI_DATABASE_FLOW.md")!.async("text")).resolves.toContain("OldSave");
    await expect(zip.file("UI_DATABASE_FLOW.md")!.async("text")).resolves.toContain("OLD_ORDER");
    await expect(zip.file("UI_DATABASE_FLOW.md")!.async("text")).resolves.not.toContain("NewSave");
    await expect(zip.file("FULL_FINDINGS.json")!.async("text")).resolves.toContain("Old risk");
    await expect(zip.file("FULL_FINDINGS.json")!.async("text")).resolves.not.toContain("New risk");
    await expect(zip.file("impact-analysis.json")!.async("text")).resolves.toContain("OldForm.pas");
    await expect(zip.file("impact-analysis.json")!.async("text")).resolves.toContain("Old risk");
    await expect(zip.file("impact-analysis.json")!.async("text")).resolves.not.toContain("NewForm.pas");
    const metadata = JSON.parse(await zip.file("metadata.json")!.async("text")) as { runNumber?: number; analysisResultId?: number; isHistoricalExport?: boolean; analyzerVersion?: string; exporterVersion?: string };
    expect(metadata.runNumber).toBe(1);
    expect(metadata.analysisResultId).toBe(1);
    expect(metadata.isHistoricalExport).toBe(true);
    expect(metadata.analyzerVersion).toBe("1.1.0-rc2");
    expect(metadata.exporterVersion).toBeTypeOf("string");
    await expect(zip.file("analysis-summary.json")!.async("text")).resolves.toContain("\"analysisResultId\": 1");
    await expect(zip.file("analysis-summary.json")!.async("text")).resolves.toContain("\"projectName\": \"historical-report\"");
    await expect(zip.file("analysis-summary.json")!.async("text")).resolves.not.toContain("NewSave");
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
    fakeDb.store.files.push({ id: 1, projectId: 1, filePath: "main.go", fileName: "main.go", fileType: ".go", content: "package main", lineCount: 1, status: "stored" });
    const oversizedRun = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "main.go", content: "package main" }],
      projectContext: { projectName: "oversized-report", sourceType: "upload", focusLanguage: "go", importWarnings: [] },
      result: {
        status: "completed",
        flowDocument: "A".repeat(10 * 1024 * 1024),
        dataDependencyDocument: "B".repeat(10 * 1024 * 1024),
        risksDocument: "C".repeat(10 * 1024 * 1024),
        rulesYaml: "rules: []",
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
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = oversizedRun.sourceFingerprint;
    fakeDb.store.analysisResults.push(oversizedRun.row);

    await expect(buildReportArchiveBuffer(1, 7)).rejects.toMatchObject({ code: "REPORT_TOO_LARGE" });
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("exports expanded analysis diff markdown and metadata", async () => {
    const { buildAnalysisDiffArchiveBuffer } = await import("./projectWorkflow");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "diff-project",
      language: "go",
      sourceType: "upload",
      status: "completed",
      importWarningsJson: [],
    });
    const run1 = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "OldForm.pas", content: "procedure OldSave;\nbegin\nend;", fileType: ".pas" }],
      result: {
        status: "completed",
        schemaFields: [{ table: "ORDERS", field: "STATUS", fieldType: "varchar", file: "OldForm.pas", line: 1 }],
        fieldReferences: [{ table: "ORDERS", field: "STATUS", type: "read", file: "OldForm.pas", line: 2, symbolStableKey: "old", symbolName: "OldSave", context: "read" }],
        risks: [{ title: "Old risk", description: "legacy", severity: "high", category: "magic_value", sourceFile: "OldForm.pas", lineNumber: 2 }],
        buildDoctor: {
          status: "ready_with_warnings",
          score: 60,
          compilerFamily: { value: "Delphi", confidence: "medium", evidence: ["OldForm.pas"] },
          projectEntries: [],
          configurations: [],
          platforms: [],
          defines: [],
          searchPaths: [],
          includePaths: [],
          outputPaths: [],
          runtimePackages: [],
          requiredPackages: [],
          packageResolutions: [],
          requiredUnits: [],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [{ code: "OLD_FINDING", severity: "warning", title: "Old finding", description: "old", recommendation: "review", confidence: "medium", evidence: "old evidence" }],
          limitations: [],
        },
        flowTraces: [{ stableKey: "trace-1", formName: "OldForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "OldSave", resolvedHandler: "OldSave", status: "complete", confidence: "high", steps: [], affectedTables: ["OLD_ORDER"], affectedFields: [{ table: "OLD_ORDER", field: "ID", operation: "read" }], warnings: [], truncated: false }],
        delphiEventMap: [{ formName: "OldForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "OldSave", filePath: "OldForm.dfm", lineNumber: 1, resolvedMethod: "OldSave", resolvedFile: "OldForm.pas", status: "resolved", warnings: [] }],
      },
    });
    const run2 = createValidAnalysisRunFixture({
      id: 2,
      projectId: 1,
      runNumber: 2,
      projectFiles: [{ path: "NewForm.pas", content: "procedure NewSave;\nbegin\nend;", fileType: ".pas" }],
      result: {
        status: "completed",
        schemaFields: [{ table: "ORDERS", field: "STATUS", fieldType: "int", file: "NewForm.pas", line: 1 }],
        fieldReferences: [{ table: "ORDERS", field: "STATUS", type: "write", file: "NewForm.pas", line: 2, symbolStableKey: "new", symbolName: "NewSave", context: "write" }],
        risks: [{ title: "New risk", description: "modern", severity: "high", category: "magic_value", sourceFile: "NewForm.pas", lineNumber: 2 }],
        buildDoctor: {
          status: "ready_with_warnings",
          score: 80,
          compilerFamily: { value: "Delphi", confidence: "medium", evidence: ["NewForm.pas"] },
          projectEntries: [],
          configurations: [],
          platforms: [],
          defines: [],
          searchPaths: [],
          includePaths: [],
          outputPaths: [],
          runtimePackages: [],
          requiredPackages: [],
          packageResolutions: [],
          requiredUnits: [],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [{ code: "OLD_FINDING", severity: "warning", title: "Old finding", description: "new", recommendation: "review", confidence: "medium", evidence: "new evidence" }],
          limitations: [],
        },
        flowTraces: [{ stableKey: "trace-1", formName: "NewForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "NewSave", resolvedHandler: "NewSave", status: "partial", confidence: "medium", steps: [], affectedTables: ["NEW_ORDER"], affectedFields: [{ table: "NEW_ORDER", field: "ID", operation: "write" }], warnings: ["changed"], truncated: false }],
        delphiEventMap: [{ formName: "OldForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "NewSave", filePath: "OldForm.dfm", lineNumber: 1, resolvedMethod: "NewSave", resolvedFile: "NewForm.pas", status: "resolved", warnings: [] }],
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = run2.sourceFingerprint;
    fakeDb.store.analysisResults.push(run1.row, run2.row);

    const archive = await buildAnalysisDiffArchiveBuffer(1, 7, 1, 2);
    const zip = await JSZip.loadAsync(archive.buffer);
    const markdown = await zip.file("ANALYSIS_DIFF.md")!.async("text");
    const metadata = JSON.parse(await zip.file("metadata.json")!.async("text")) as { baseRunNumber?: number; compareRunNumber?: number; truncated?: boolean };

    expect(markdown).toContain("## Added Files");
    expect(markdown).toContain("## Removed Files");
    expect(markdown).toContain("## Changed Files");
    expect(markdown).toContain("## Introduced Risks");
    expect(markdown).toContain("## Resolved Risks");
    expect(markdown).toContain("## Changed Fields");
    expect(markdown).toContain("## Field Dependency Changes");
    expect(markdown).toContain("## Delphi Event Resolution Changes");
    expect(markdown).toContain("## Build Doctor Changes");
    expect(markdown).toContain("## Flow Trace Changes");
    expect(metadata.baseRunNumber).toBe(1);
    expect(metadata.compareRunNumber).toBe(2);
    expect(typeof metadata.truncated).toBe("boolean");
  });

  it("computes direct analysis diffs with deterministic ordering, evidence deltas, and truncation metadata", async () => {
    const { getAnalysisDiff } = await import("./analysisHistory");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "direct-diff-project",
      language: "delphi",
      sourceType: "upload",
      status: "completed",
      importWarningsJson: [],
      sourceFingerprint: null,
    });
    const run1 = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 7,
      projectFiles: [
        { path: "src/Alpha.pas", content: "procedure SaveAlpha;\nbegin\nend;", fileType: ".pas" },
        { path: "src/Removed.pas", content: "procedure Removed;\nbegin\nend;", fileType: ".pas" },
        { path: "src/Shared.pas", content: "procedure SharedOld;\nbegin\nend;", fileType: ".pas" },
      ],
      result: {
        status: "completed",
        symbols: [
          { stableKey: "src/Alpha.pas::SaveAlpha::1", name: "SaveAlpha", type: "procedure", file: "src/Alpha.pas", startLine: 1, endLine: 3 },
        ],
        dependencies: [
          { from: "src/Alpha.pas::SaveAlpha::1", toName: "QueryAlpha", fromName: "SaveAlpha", type: "calls", line: 2 },
        ],
        schemaFields: [
          { table: "ORDERS", field: "STATUS", fieldType: "varchar", file: "src/Shared.pas", line: 1 },
          { table: "ORDERS", field: "LEGACY_ONLY", fieldType: "int", file: "src/Removed.pas", line: 1 },
        ],
        fieldReferences: [
          { table: "ORDERS", field: "STATUS", type: "read", file: "src/Shared.pas", line: 2, symbolStableKey: "src/Alpha.pas::SaveAlpha::1", symbolName: "SaveAlpha", context: "read old status" },
          { table: "ORDERS", field: "LEGACY_ONLY", type: "read", file: "src/Removed.pas", line: 3, symbolStableKey: "src/Alpha.pas::SaveAlpha::1", symbolName: "SaveAlpha", context: "legacy only" },
        ],
        risks: [
          { title: "Legacy risk", description: "resolved later", severity: "high", category: "magic_value", sourceFile: "src/Removed.pas", lineNumber: 5 },
          { title: "Shared risk", description: "changed evidence", severity: "medium", category: "missing_condition", sourceFile: "src/Shared.pas", lineNumber: 8 },
        ],
        rules: [
          { ruleType: "validation", name: "require_status", description: "old rule", condition: "status required", sourceFile: "src/Shared.pas", lineNumber: 7 },
          { ruleType: "format", name: "legacy_rule", description: "resolved rule", sourceFile: "src/Removed.pas", lineNumber: 2 },
        ],
        delphiEventMap: [
          { formName: "OrderForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "SaveAlpha", filePath: "forms/OrderForm.dfm", lineNumber: 10, resolvedMethod: "SaveAlpha", resolvedFile: "src/Alpha.pas", status: "resolved", warnings: [] },
        ],
        delphiDataBindings: [
          { formName: "OrderForm", componentName: "StatusEdit", componentClass: "TDBEdit", dataSource: "OrderSource", dataSet: "ORDERS", dataField: "STATUS", readOnly: false, enabled: true, visible: true, accessHint: "read-write", confidence: "high", sourceFile: "forms/OrderForm.dfm", lineNumber: 20, warnings: [] },
        ],
        buildDoctor: {
          status: "ready_with_warnings",
          score: 58,
          compilerFamily: { value: "Delphi", confidence: "high", evidence: ["dcc32"] },
          projectEntries: [],
          configurations: [],
          platforms: [],
          defines: [],
          searchPaths: [],
          includePaths: [],
          outputPaths: [],
          runtimePackages: [],
          requiredPackages: [],
          packageResolutions: [],
          requiredUnits: [],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [
            { code: "SHARED_FINDING", severity: "warning", title: "Shared finding", description: "old", recommendation: "review", confidence: "medium", evidence: "Old evidence" },
            { code: "REMOVED_FINDING", severity: "error", title: "Removed finding", description: "removed", recommendation: "fix", confidence: "high", evidence: "Removed evidence" },
          ],
          limitations: [],
        },
        flowTraces: [
          { stableKey: "shared-trace", formName: "OrderForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "SaveAlpha", resolvedHandler: "SaveAlpha", status: "partial", confidence: "medium", steps: [{ id: "old-step", type: "handler", label: "SaveAlpha", filePath: "src/Alpha.pas", lineNumber: 1, confidence: "medium" }], affectedTables: ["ORDERS"], affectedFields: [{ table: "ORDERS", field: "STATUS", operation: "read" }], warnings: ["old-warning"], truncated: false },
        ],
        flowTraceSummary: { candidateTraceCount: 3, persistedTraceCount: 1, globalTruncated: true },
        metrics: {
          fileCount: 3,
          eligibleFileCount: 3,
          analyzedFileCount: 2,
          skippedFileCount: 1,
          heuristicFileCount: 1,
          degradedFileCount: 1,
          symbolCount: 1,
          dependencyCount: 1,
          fieldCount: 2,
          fieldDependencyCount: 2,
          riskCount: 2,
          ruleCount: 2,
          warningCount: 1,
        },
      },
    });
    const run2 = createValidAnalysisRunFixture({
      id: 2,
      projectId: 1,
      runNumber: 8,
      projectFiles: [
        { path: "src/Added.pas", content: "procedure Added;\nbegin\nend;", fileType: ".pas" },
        { path: "src/Alpha.pas", content: "procedure SaveAlpha;\nbegin\nDoWork;\nend;", fileType: ".pas" },
        { path: "src/Shared.pas", content: "procedure SharedNew;\nbegin\nend;", fileType: ".pas" },
      ],
      result: {
        status: "completed_with_warnings",
        symbols: [
          { stableKey: "src/Alpha.pas::SaveAlpha::1", name: "SaveAlpha", type: "procedure", file: "src/Alpha.pas", startLine: 1, endLine: 4 },
        ],
        dependencies: [
          { from: "src/Alpha.pas::SaveAlpha::1", toName: "QueryAlpha", fromName: "SaveAlpha", type: "calls", line: 3 },
        ],
        schemaFields: [
          { table: "ORDERS", field: "ADDED_ONLY", fieldType: "date", file: "src/Added.pas", line: 1 },
          { table: "ORDERS", field: "STATUS", fieldType: "nvarchar", file: "src/Shared.pas", line: 1 },
        ],
        fieldReferences: [
          { table: "ORDERS", field: "ADDED_ONLY", type: "write", file: "src/Added.pas", line: 2, symbolStableKey: "src/Alpha.pas::SaveAlpha::1", symbolName: "SaveAlpha", context: "added dependency" },
          { table: "ORDERS", field: "STATUS", type: "write", file: "src/Shared.pas", line: 3, symbolStableKey: "src/Alpha.pas::SaveAlpha::1", symbolName: "SaveAlpha", context: "changed dependency" },
        ],
        risks: [
          { title: "Shared risk", description: "changed evidence", severity: "high", category: "missing_condition", sourceFile: "src/Shared.pas", lineNumber: 10 },
          { title: "New risk", description: "introduced", severity: "critical", category: "multiple_writes", sourceFile: "src/Added.pas", lineNumber: 4 },
        ],
        rules: [
          { ruleType: "validation", name: "require_status", description: "new rule text", condition: "status normalized", sourceFile: "src/Shared.pas", lineNumber: 9 },
          { ruleType: "calculation", name: "new_rule", description: "introduced rule", sourceFile: "src/Added.pas", lineNumber: 6 },
        ],
        delphiEventMap: [
          { formName: "OrderForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "SaveAlpha", filePath: "forms/OrderForm.dfm", lineNumber: 10, resolvedMethod: "SaveAlphaV2", resolvedFile: "src/Alpha.pas", status: "resolved", warnings: [] },
        ],
        delphiDataBindings: [
          { formName: "OrderForm", componentName: "StatusEdit", componentClass: "TDBEdit", dataSource: "OrderSource", dataSet: "ORDERS", dataField: "STATUS", readOnly: true, enabled: true, visible: true, accessHint: "read-only", confidence: "medium", sourceFile: "forms/OrderForm.dfm", lineNumber: 20, warnings: ["changed"] },
          { formName: "OrderForm", componentName: "AddedEdit", componentClass: "TDBEdit", dataSource: "OrderSource", dataSet: "ORDERS", dataField: "ADDED_ONLY", readOnly: false, enabled: true, visible: true, accessHint: "read-write", confidence: "high", sourceFile: "forms/OrderForm.dfm", lineNumber: 21, warnings: [] },
        ],
        buildDoctor: {
          status: "blocked",
          score: 91,
          compilerFamily: { value: "Delphi", confidence: "high", evidence: ["dcc64"] },
          projectEntries: [],
          configurations: [],
          platforms: [],
          defines: [],
          searchPaths: [],
          includePaths: [],
          outputPaths: [],
          runtimePackages: [],
          requiredPackages: [],
          packageResolutions: [],
          requiredUnits: [],
          missingUnits: [],
          unresolvedUnits: [],
          missingPackages: [],
          externalDependencies: [],
          findings: [
            { code: "ADDED_FINDING", severity: "warning", title: "Added finding", description: "added", recommendation: "review", confidence: "medium", evidence: "Added evidence" },
            { code: "SHARED_FINDING", severity: "warning", title: "Shared finding", description: "new", recommendation: "review", confidence: "medium", evidence: "New evidence" },
          ],
          limitations: [],
        },
        flowTraces: [
          { stableKey: "shared-trace", formName: "OrderForm", componentName: "SaveButton", componentClass: "TButton", eventName: "OnClick", handlerName: "SaveAlpha", resolvedHandler: "SaveAlphaV2", status: "complete", confidence: "high", steps: [{ id: "new-step", type: "handler", label: "SaveAlphaV2", filePath: "src/Alpha.pas", lineNumber: 1, confidence: "high" }], affectedTables: ["ORDERS", "ORDERS_AUDIT"], affectedFields: [{ table: "ORDERS", field: "STATUS", operation: "write" }], warnings: ["new-warning"], truncated: false },
        ],
        flowTraceSummary: { candidateTraceCount: 1, persistedTraceCount: 1, globalTruncated: false },
        metrics: {
          fileCount: 3,
          eligibleFileCount: 2,
          analyzedFileCount: 2,
          skippedFileCount: 0,
          heuristicFileCount: 0,
          degradedFileCount: 0,
          symbolCount: 1,
          dependencyCount: 1,
          fieldCount: 2,
          fieldDependencyCount: 2,
          riskCount: 2,
          ruleCount: 2,
          warningCount: 2,
        },
      },
    });
    fakeDb.store.projects[0].sourceFingerprint = run2.sourceFingerprint;
    fakeDb.store.analysisResults.push(run1.row, run2.row);

    const diff = await getAnalysisDiff(fakeDb, 1, 1, 2);
    const repeated = await getAnalysisDiff(fakeDb, 1, 1, 2);

    expect(diff).toEqual(repeated);
    expect(diff.files.added.items.map((item) => item.path)).toEqual(["src/Added.pas"]);
    expect(diff.files.removed.items.map((item) => item.path)).toEqual(["src/Removed.pas"]);
    expect(diff.files.changed.items.map((item) => item.before.path)).toEqual(["src/Alpha.pas", "src/Shared.pas"]);
    expect(diff.metricsDelta).toEqual({
      fileCount: 0,
      eligibleFileCount: -1,
      analyzedFileCount: 0,
      skippedFileCount: -1,
      heuristicFileCount: -1,
      degradedFileCount: -1,
      symbolCount: 0,
      dependencyCount: 0,
      fieldCount: 0,
      fieldDependencyCount: 0,
      riskCount: 0,
      ruleCount: 0,
      warningCount: 1,
    });
    expect(diff.fields.added.items).toEqual([expect.objectContaining({ table: "ORDERS", field: "ADDED_ONLY" })]);
    expect(diff.fields.removed.items).toEqual([expect.objectContaining({ table: "ORDERS", field: "LEGACY_ONLY" })]);
    expect(diff.fields.changed.items).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ table: "ORDERS", field: "STATUS", fieldType: "varchar" }),
        after: expect.objectContaining({ table: "ORDERS", field: "STATUS", fieldType: "nvarchar" }),
      }),
    ]);
    expect(diff.fieldDependencies.introduced.items).toEqual([
      expect.objectContaining({ table: "ORDERS", field: "ADDED_ONLY", type: "write" }),
      expect.objectContaining({ table: "ORDERS", field: "STATUS", type: "write" }),
    ]);
    expect(diff.fieldDependencies.removed.items).toEqual([
      expect.objectContaining({ table: "ORDERS", field: "LEGACY_ONLY", type: "read" }),
      expect.objectContaining({ table: "ORDERS", field: "STATUS", type: "read" }),
    ]);
    expect(diff.fieldDependencies.changed.items).toEqual([]);
    expect(diff.risks.introduced.items).toEqual([expect.objectContaining({ title: "New risk" })]);
    expect(diff.risks.resolved.items).toEqual([expect.objectContaining({ title: "Legacy risk" })]);
    expect(diff.risks.changed.items).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ title: "Shared risk", severity: "medium" }),
        after: expect.objectContaining({ title: "Shared risk", severity: "high" }),
      }),
    ]);
    expect(diff.rules.introduced.items).toEqual([expect.objectContaining({ name: "new_rule" })]);
    expect(diff.rules.resolved.items).toEqual([expect.objectContaining({ name: "legacy_rule" })]);
    expect(diff.rules.changed.items).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ name: "require_status", condition: "status required" }),
        after: expect.objectContaining({ name: "require_status", condition: "status normalized" }),
      }),
    ]);
    expect(diff.delphiEvents.resolutionChanged.items).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ resolvedMethod: "SaveAlpha" }),
        after: expect.objectContaining({ resolvedMethod: "SaveAlphaV2" }),
      }),
    ]);
    expect(diff.dataBindings.introduced.items).toEqual([expect.objectContaining({ componentName: "AddedEdit" })]);
    expect(diff.dataBindings.changed.items).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ componentName: "StatusEdit", readOnly: false, accessHint: "read-write" }),
        after: expect.objectContaining({ componentName: "StatusEdit", readOnly: true, accessHint: "read-only" }),
      }),
    ]);
    expect(diff.buildDoctor.scoreDelta).toBe(33);
    expect(diff.buildDoctor.introduced.items).toEqual([
      expect.objectContaining({ code: "ADDED_FINDING" }),
      expect.objectContaining({ code: "SHARED_FINDING", evidence: "New evidence" }),
    ]);
    expect(diff.buildDoctor.resolved.items).toEqual([
      expect.objectContaining({ code: "REMOVED_FINDING" }),
      expect.objectContaining({ code: "SHARED_FINDING", evidence: "Old evidence" }),
    ]);
    expect(diff.buildDoctor.changed.items).toEqual([]);
    expect(diff.flowTraces.changed.items).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ stableKey: "shared-trace", status: "partial" }),
        after: expect.objectContaining({ stableKey: "shared-trace", status: "complete" }),
      }),
    ]);
    expect(diff.truncated).toBe(true);
  });

  it("rejects invalid direct analysis diff comparisons", async () => {
    const { getAnalysisDiff } = await import("./analysisHistory");
    fakeDb.store.projects.push(
      { id: 1, userId: 7, name: "a", language: "go", sourceType: "upload", status: "completed", importWarningsJson: [], sourceFingerprint: null },
      { id: 2, userId: 7, name: "b", language: "go", sourceType: "upload", status: "completed", importWarningsJson: [], sourceFingerprint: null }
    );
    const usable = createValidAnalysisRunFixture({
      id: 1,
      projectId: 1,
      runNumber: 1,
      projectFiles: [{ path: "main.go", content: "package main" }],
    });
    const otherProject = createValidAnalysisRunFixture({
      id: 2,
      projectId: 2,
      runNumber: 1,
      projectFiles: [{ path: "other.go", content: "package other" }],
    });
    const missingSnapshot = createValidAnalysisRunFixture({
      id: 3,
      projectId: 1,
      runNumber: 2,
      projectFiles: [{ path: "missing.go", content: "package missing" }],
    });
    const invalidSnapshot = createValidAnalysisRunFixture({
      id: 4,
      projectId: 1,
      runNumber: 3,
      projectFiles: [{ path: "invalid.go", content: "package invalid" }],
    });
    const futureSnapshot = createValidAnalysisRunFixture({
      id: 5,
      projectId: 1,
      runNumber: 4,
      projectFiles: [{ path: "future.go", content: "package future" }],
    });
    fakeDb.store.analysisResults.push(
      usable.row,
      otherProject.row,
      { ...missingSnapshot.row, snapshotJson: null },
      { ...invalidSnapshot.row, snapshotJson: "{not-json}" },
      { ...futureSnapshot.row, snapshotJson: JSON.stringify({ schemaVersion: 99 }) },
      { ...createValidAnalysisRunFixture({ id: 6, projectId: 1, runNumber: 5, projectFiles: [{ path: "pending.go", content: "package pending" }] }).row, status: "processing" }
    );

    await expect(getAnalysisDiff(fakeDb, 1, 1, 1)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    await expect(getAnalysisDiff(fakeDb, 1, 1, 2)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(getAnalysisDiff(fakeDb, 1, 1, 6)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    await expect(getAnalysisDiff(fakeDb, 1, 1, 3)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    await expect(getAnalysisDiff(fakeDb, 1, 1, 4)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    await expect(getAnalysisDiff(fakeDb, 1, 1, 5)).rejects.toMatchObject({ code: "UNSUPPORTED_SNAPSHOT_VERSION" });
  });
});
