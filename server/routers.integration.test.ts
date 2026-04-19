import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import JSZip from "jszip";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "and"; conditions: Condition[] }
  | undefined;
type SortOrder = { type: "desc"; column: string } | undefined;

let fakeDb: ReturnType<typeof createFakeDb>;
let zipFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
let analyzerResult: Record<string, unknown> | null = null;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ type: "eq", column: column.name, value }),
    and: (...conditions: Condition[]) => ({ type: "and", conditions: conditions.filter(Boolean) as Condition[] }),
    desc: (column: { name: string }) => ({ type: "desc", column: column.name }),
  };
});

vi.mock("./db", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

vi.mock("./utils/zipHandler", () => ({
  SUPPORTED_SOURCE_EXTENSIONS: [".go", ".sql", ".pas"],
  validateZipFile: vi.fn(async () => true),
  extractFilesFromZip: vi.fn(async () => ({ files: zipFiles, warnings: [] })),
}));

vi.mock("./utils/gitHandler", () => ({
  isValidGitUrl: vi.fn(() => true),
  cloneAndExtractFiles: vi.fn(async () => ({ files: zipFiles, warnings: [] })),
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
  analyzerResult = {
    projectId: 1,
    status: "partial",
    language: "go",
    symbols: [{ stableKey: "main.go::main::1", name: "main", type: "function", file: "main.go", startLine: 1, endLine: 3, signature: "func main()" }],
    dependencies: [],
    fieldReferences: [],
    risks: [],
    rules: [],
    warnings: [{ code: "HEURISTIC_ANALYSIS", message: "best-effort", heuristic: true }],
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
      fieldCount: 0,
      fieldDependencyCount: 0,
      riskCount: 0,
      ruleCount: 0,
      warningCount: 1,
    },
  };
});

describe("appRouter integration", () => {
  it("supports create, upload, analyze, snapshot, and download flows", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller(createContext());

    const created = await caller.projects.create({
      name: "integration-project",
      focusLanguage: "go",
      sourceType: "upload",
    });
    expect(created.projectId).toBe(1);

    const uploaded = await caller.projects.uploadFiles({
      projectId: created.projectId,
      zipContent: "encoded",
    });
    expect(uploaded.fileCount).toBe(1);

    const analyzed = await caller.analysis.trigger(created.projectId);
    expect(analyzed.status).toBe("partial");

    const snapshot = await caller.analysis.getSnapshot(created.projectId);
    expect(snapshot.report?.status).toBe("partial");

    const archive = await caller.analysis.downloadReport({
      projectId: created.projectId,
      format: "zip",
    });
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
    expect(metadataJson.warningCount).toBe(1);
  });
});
