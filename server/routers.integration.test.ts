import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import JSZip from "jszip";
import { MAX_LEGACY_BASE64_ZIP_BYTES } from "../shared/const";
import {
  analysisSnapshotOutputSchema,
  fieldsPageOutputSchema,
  jobByIdOutputSchema,
  projectByIdOutputSchema,
  projectsListOutputSchema,
  reportArchivePayloadSchema,
  risksPageOutputSchema,
  symbolsPageOutputSchema,
} from "../shared/contracts";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "inArray"; column: string; values: unknown[] }
  | { type: "and"; conditions: Condition[] }
  | undefined;
type SortOrder = { type: "desc"; column: string } | undefined;

let fakeDb: ReturnType<typeof createFakeDb>;
let zipFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let analyzerResult: Record<string, unknown> | null = null;
let importWarnings: Array<{ code: string; message: string; filePath?: string }> = [];

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

vi.mock("./db", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

vi.mock("./utils/zipHandler", () => ({
  SUPPORTED_SOURCE_EXTENSIONS: [".go", ".sql", ".pas"],
  extractFilesFromZip: vi.fn(async () => ({ files: zipFiles, warnings: importWarnings })),
  extractFilesFromZipBuffer: vi.fn(async () => ({ files: zipFiles, warnings: importWarnings })),
}));

vi.mock("./utils/gitHandler", () => ({
  validateSafeGitUrl: vi.fn(async () => ({
    gitUrl: "https://example.com/org/repo.git",
    host: "example.com",
    resolvedAddresses: [{ address: "93.184.216.34", family: 4 }],
    allowlist: null,
    production: false,
  })),
  cloneAndExtractFiles: vi.fn(async () => ({ files: zipFiles, warnings: importWarnings })),
  cleanupTempDir: vi.fn(async () => undefined),
}));

vi.mock("./analyzer/analyzer", () => ({
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

function createContext(): TrpcContext {
  return {
    user: {
      id: 7,
      openId: "user-7",
      email: "user@example.com",
      name: "User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { headers: {}, protocol: "http" } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

beforeEach(() => {
  fakeDb = createFakeDb();
  zipFiles = [{ path: "main.go", fileName: "main.go", content: "package main", language: "go", size: 12 }];
  importWarnings = [{ code: "IMPORT_ENCODING_DETECTED", message: "Detected Big5 encoding.", filePath: "legacy.pas" }];
  analyzerResult = {
    projectId: 1,
    status: "partial",
    language: "go",
    symbols: [{ stableKey: "main.go::main::1", name: "main", type: "function", file: "main.go", startLine: 1, endLine: 3, signature: "func main()" }],
    dependencies: [],
    fieldReferences: [{ table: "dbo.Users", field: "Name", type: "read", file: "main.go", line: 2, symbolStableKey: "main.go::main::1", symbolName: "main" }],
    schemaFields: [],
    risks: [{ title: "Dynamic SQL review", description: "Manual review is required.", severity: "medium", category: "other", sourceFile: "main.go", lineNumber: 2 }],
    rules: [{ ruleType: "validation", name: "review_user_name_reads", description: "Review dbo.Users.Name usage.", sourceFile: "main.go", lineNumber: 2 }],
    warnings: [{ code: "HEURISTIC_ANALYSIS", message: "best-effort", level: "note", heuristic: true }],
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
      heuristicFileCount: 1,
      degradedFileCount: 1,
      symbolCount: 1,
      dependencyCount: 0,
      fieldCount: 1,
      fieldDependencyCount: 1,
      riskCount: 1,
      ruleCount: 1,
      warningCount: 1,
    },
  };
});

describe("appRouter integration", () => {
  it("supports create, queued import, queued analysis, snapshot, paged reads, and download flows", async () => {
    const { appRouter } = await import("./routers");
    const { waitForProjectJobForTests } = await import("./services/projectWorkflow");
    const caller = appRouter.createCaller(createContext());

    const created = await caller.projects.create({
      name: "integration-project",
      focusLanguage: "go",
      sourceType: "upload",
    });
    expect(created.projectId).toBe(1);

    const importJob = await caller.projects.uploadFiles({
      projectId: created.projectId,
      zipContent: "encoded",
    });
    expect(importJob.status).toBe("queued");
    await waitForProjectJobForTests(importJob.jobId);

    const projectAfterImport = await caller.projects.getById(created.projectId);
    expect(projectByIdOutputSchema.parse(projectAfterImport)).toEqual(projectAfterImport);
    expect(projectAfterImport?.importWarningsJson).toEqual(importWarnings);
    expect(projectAfterImport?.latestJob?.type).toBe("import_zip");
    expect(projectAfterImport?.latestJob?.status).toBe("completed");

    const analyzeJob = await caller.analysis.trigger(created.projectId);
    expect(analyzeJob.status).toBe("queued");
    await waitForProjectJobForTests(analyzeJob.jobId);
    const analyzeJobStatus = await caller.jobs.getById(analyzeJob.jobId);
    expect(jobByIdOutputSchema.parse(analyzeJobStatus)).toEqual(analyzeJobStatus);
    expect(analyzeJobStatus).toMatchObject({
      id: analyzeJob.jobId,
      projectId: created.projectId,
      type: "analyze",
      status: "completed",
    });

    const snapshot = await caller.analysis.getSnapshot(created.projectId);
    expect(analysisSnapshotOutputSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.report?.status).toBe("partial");
    expect(snapshot.importWarnings).toEqual(importWarnings);
    expect(snapshot.totals.symbols).toBe(1);

    const symbolsPage = await caller.analysis.getSymbolsPage({
      projectId: created.projectId,
      page: 1,
      pageSize: 25,
    });
    expect(symbolsPageOutputSchema.parse(symbolsPage)).toEqual(symbolsPage);
    expect(symbolsPage.items).toHaveLength(1);
    expect(symbolsPage.total).toBe(1);

    const fieldsPage = await caller.analysis.getFieldsPage({
      projectId: created.projectId,
      page: 1,
      pageSize: 25,
    });
    expect(fieldsPageOutputSchema.parse(fieldsPage)).toEqual(fieldsPage);
    expect(fieldsPage.items).toEqual([expect.objectContaining({ tableName: "dbo.Users", fieldName: "Name" })]);

    const risksPage = await caller.analysis.getRisksPage({
      projectId: created.projectId,
      page: 1,
      pageSize: 25,
    });
    expect(risksPageOutputSchema.parse(risksPage)).toEqual(risksPage);
    expect(risksPage.items).toEqual([expect.objectContaining({ title: "Dynamic SQL review", severity: "medium" })]);

    const archive = await caller.analysis.downloadReport({
      projectId: created.projectId,
      format: "zip",
    });
    expect(reportArchivePayloadSchema.parse(archive)).toEqual(archive);
    expect(archive.mimeType).toBe("application/zip");

    const zip = await JSZip.loadAsync(Buffer.from(archive.base64, "base64"));
    const metadata = zip.file("metadata.json");
    expect(metadata).toBeTruthy();
    const metadataJson = JSON.parse(await metadata!.async("text")) as Record<string, unknown>;
    expect(metadataJson.projectName).toBe("integration-project");
    expect(metadataJson.focusLanguage).toBe("go");
    expect(typeof metadataJson.analysisVersion).toBe("string");
    expect(metadataJson.fileCount).toBe(1);
    expect(metadataJson.symbolCount).toBe(1);
    expect(metadataJson.dependencyCount).toBe(0);
    expect(metadataJson.warningCount).toBe(3);

    for (const expectedPath of [
      "FLOW.md",
      "DATA_DEPENDENCY.md",
      "RISKS.md",
      "RULES.yaml",
      "IMPACT_ANALYSIS.md",
      "metadata.json",
      "PROJECT_OVERVIEW.md",
      "FILE_INVENTORY.md",
      "DELPHI_FIELD_ACCESS.md",
      "LIMITATIONS.md",
      "FULL_FINDINGS.json",
    ]) {
      expect(zip.file(expectedPath), expectedPath).toBeTruthy();
    }
    await expect(zip.file("PROJECT_OVERVIEW.md")!.async("text")).resolves.toContain("Project name: integration-project");
    await expect(zip.file("FILE_INVENTORY.md")!.async("text")).resolves.toContain("main.go");
    await expect(zip.file("LIMITATIONS.md")!.async("text")).resolves.toContain("dynamic SQL");
    const fullFindings = JSON.parse(await zip.file("FULL_FINDINGS.json")!.async("text")) as {
      metadata: { projectName: string };
      symbols: unknown[];
      fieldAccesses: unknown[];
      importWarnings: unknown[];
      analyzerWarnings: unknown[];
    };
    expect(fullFindings.metadata.projectName).toBe("integration-project");
    expect(fullFindings.symbols).toHaveLength(1);
    expect(fullFindings.fieldAccesses).toEqual([]);
    expect(fullFindings.importWarnings).toEqual(importWarnings);
    expect(fullFindings.analyzerWarnings).toHaveLength(3);

    const summary = zip.file("analysis-summary.json");
    expect(summary).toBeTruthy();
    const summaryJson = JSON.parse(await summary!.async("text")) as Record<string, unknown>;
    expect(String(summaryJson.limitationSummary)).toContain("legacy impact review assistant");
  });

  it("lists only the current user's projects and jobs", async () => {
    const { appRouter } = await import("./routers");
    fakeDb.store.projects.push(
      { id: 1, userId: 7, name: "owned-a", language: "go", sourceType: "upload", status: "completed" },
      { id: 2, userId: 7, name: "owned-b", language: "sql", sourceType: "git", status: "ready" },
      { id: 3, userId: 99, name: "other-user", language: "go", sourceType: "upload", status: "completed" }
    );
    fakeDb.store.analysisResults.push(
      { id: 1, projectId: 1, status: "partial" },
      { id: 2, projectId: 3, status: "completed" }
    );
    fakeDb.store.projectJobs.push(
      { id: 1, projectId: 1, userId: 7, type: "analyze", status: "completed", progress: 100 },
      { id: 2, projectId: 3, userId: 99, type: "analyze", status: "failed", progress: 100 }
    );

    const caller = appRouter.createCaller(createContext());
    const projects = await caller.projects.list();
    expect(projectsListOutputSchema.parse(projects)).toEqual(projects);

    expect(projects).toEqual([
      expect.objectContaining({ id: 2, analysisStatus: "pending", latestJob: null }),
      expect.objectContaining({ id: 1, analysisStatus: "partial", latestJob: expect.objectContaining({ id: 1 }) }),
    ]);
    expect(projects.some((project) => project.id === 3)).toBe(false);
  });

  it("rejects oversized page sizes through the shared zod contract", async () => {
    const { appRouter } = await import("./routers");
    fakeDb.store.projects.push({ id: 1, userId: 7, name: "owned-a", language: "go", sourceType: "upload", status: "completed" });
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.analysis.getSymbolsPage({
        projectId: 1,
        page: 1,
        pageSize: 101,
      })
    ).rejects.toThrow(/100/);
  });

  it("blocks project deletion while an active job still exists", async () => {
    const { appRouter } = await import("./routers");
    fakeDb.store.projects.push({
      id: 1,
      userId: 7,
      name: "busy-project",
      language: "go",
      sourceType: "upload",
      status: "importing",
      importWarningsJson: [],
    });
    fakeDb.store.projectJobs.push({
      id: 1,
      projectId: 1,
      userId: 7,
      type: "import_zip",
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      payloadJson: JSON.stringify({ type: "import_zip", tempFilePath: "C:/tmp/busy.zip" }),
      activeKey: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    });

    const caller = appRouter.createCaller(createContext());

    await expect(caller.projects.delete(1)).rejects.toMatchObject({
      message: expect.stringContaining("queued or running"),
    });
    expect(fakeDb.store.projects).toHaveLength(1);
    expect(fakeDb.store.projectJobs).toHaveLength(1);
  });

  it("limits the legacy base64 ZIP endpoint to small compatibility payloads", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller(createContext());

    await caller.projects.create({
      name: "legacy-upload-project",
      focusLanguage: "go",
      sourceType: "upload",
    });

    const oversizedBase64 = Buffer.alloc(MAX_LEGACY_BASE64_ZIP_BYTES + 1, 1).toString("base64");

    await expect(
      caller.projects.uploadFiles({
        projectId: 1,
        zipContent: oversizedBase64,
      })
    ).rejects.toThrow(/Legacy ZIP upload is limited to 2MB/);
  });
});
