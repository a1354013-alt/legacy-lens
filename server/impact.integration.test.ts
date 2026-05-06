import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";

type Row = Record<string, unknown>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "and"; conditions: Condition[] }
  | undefined;

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

const rowsByTable: Record<string, Row[]> = {
  symbols: [{ id: 1, projectId: 1, fileId: 10, name: "EB_SPECI", type: "table", startLine: 1, endLine: 1 }],
  files: [{ id: 10, projectId: 1, fileName: "schema.sql", filePath: "sql/schema.sql" }],
  fields: [],
  dependencies: [],
  fieldDependencies: [],
  risks: [],
  rules: [],
  projects: [{ id: 1, userId: 1 }],
  analysisResults: [],
};

const fakeDb = {
  select: () => ({
    from: (table: object) => {
      const tableName = getTableName(table);
      const rows = rowsByTable[tableName] ?? [];

      return {
        where: (condition: Condition) => ({
          limit: async (count: number) => rows.filter((row) => matches(condition, row)).slice(0, count),
          then: <TResult1 = Row[], TResult2 = never>(
            onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
          ) => Promise.resolve(rows.filter((row) => matches(condition, row))).then(onfulfilled, onrejected),
        }),
      };
    },
  }),
};

vi.mock("./db", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ type: "eq", column: column.name, value }),
    and: (...conditions: Condition[]) => ({ type: "and", conditions: conditions.filter(Boolean) as Condition[] }),
  };
});

describe("Impact Analysis Integration", () => {
  it("returns project-scoped impact results through TRPC", async () => {
    const caller = appRouter.createCaller({
      user: { id: 1, role: "user", openId: "test", name: "Test", email: "test@example.com", loginMethod: "test", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: {} as any,
      res: {} as any,
    });

    const result = await caller.analysis.getImpact({
      projectId: 1,
      target: "EB_SPECI",
      type: "auto",
    });

    expect(result.target).toBe("EB_SPECI");
    expect(result.targetType).toBe("symbol");
    expect(result.summary).toContain("project 1");
  });
});
