import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImpactAnalyzer } from "./impactAnalyzer";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Condition =
  | { type: "eq"; column: string; value: unknown }
  | { type: "and"; conditions: Condition[] }
  | undefined;

let fakeDb: ReturnType<typeof createFakeDb>;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ type: "eq", column: column.name, value }),
    and: (...conditions: Condition[]) => ({ type: "and", conditions: conditions.filter(Boolean) as Condition[] }),
  };
});

vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
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

function createFakeDb(initialStore?: Partial<Store>) {
  const store: Store = {
    files: [],
    symbols: [],
    dependencies: [],
    fields: [],
    fieldDependencies: [],
    risks: [],
    rules: [],
    ...initialStore,
  };

  class SelectQuery {
    private condition: Condition;

    constructor(private readonly table?: object) {}

    from(table: object) {
      return new SelectQuery(table);
    }

    where(condition: Condition) {
      this.condition = condition;
      return this;
    }

    limit(count: number) {
      return {
        then: <TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) => {
          const value = this.getRows().slice(0, count);
          return Promise.resolve(value).then(onfulfilled, onrejected);
        },
      };
    }

    then<TResult1 = Row[], TResult2 = never>(
      onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      return Promise.resolve(this.getRows()).then(onfulfilled, onrejected);
    }

    private getRows() {
      return store[getTableName(this.table as object)].filter((row) => matches(this.condition, row));
    }
  }

  return {
    select() {
      return new SelectQuery();
    },
  };
}

beforeEach(() => {
  fakeDb = createFakeDb({
    files: [
      { id: 1, projectId: 1, fileName: "Shared.pas", filePath: "src/Shared.pas" },
      { id: 2, projectId: 1, fileName: "Orders.sql", filePath: "sql/Orders.sql" },
      { id: 3, projectId: 2, fileName: "Shared.pas", filePath: "other/Shared.pas" },
    ],
    symbols: [
      { id: 11, projectId: 1, fileId: 1, name: "Shared", type: "class", startLine: 1, endLine: 100 },
      { id: 12, projectId: 1, fileId: 1, name: "UpdateContract", type: "method", startLine: 10, endLine: 20 },
      { id: 13, projectId: 1, fileId: 1, name: "Caller", type: "method", startLine: 30, endLine: 40 },
      { id: 21, projectId: 2, fileId: 3, name: "UpdateContract", type: "method", startLine: 5, endLine: 15 },
    ],
    dependencies: [
      { id: 101, projectId: 1, sourceSymbolId: 13, targetSymbolId: 12, targetExternalName: null, targetKind: "internal", dependencyType: "calls", lineNumber: 32 },
      { id: 102, projectId: 2, sourceSymbolId: 21, targetSymbolId: 21, targetExternalName: null, targetKind: "internal", dependencyType: "calls", lineNumber: 7 },
    ],
    fields: [
      { id: 201, projectId: 1, tableName: "orders", fieldName: "amount" },
      { id: 202, projectId: 2, tableName: "orders", fieldName: "amount" },
    ],
    fieldDependencies: [
      { id: 301, projectId: 1, fieldId: 201, symbolId: 12, operationType: "read", lineNumber: 15, context: "orders.amount" },
      { id: 302, projectId: 2, fieldId: 202, symbolId: 21, operationType: "read", lineNumber: 8, context: "orders.amount" },
    ],
    risks: [
      { id: 401, projectId: 1, title: "Shared risk", sourceFile: "src/Shared.pas", lineNumber: 12, severity: "high" },
      { id: 402, projectId: 2, title: "Shared risk", sourceFile: "other/Shared.pas", lineNumber: 9, severity: "high" },
    ],
    rules: [
      { id: 501, projectId: 1, name: "SharedRule", sourceFile: "src/Shared.pas", lineNumber: 15, ruleType: "validation", description: "uses orders.amount", condition: "orders.amount" },
      { id: 502, projectId: 2, name: "SharedRule", sourceFile: "other/Shared.pas", lineNumber: 9, ruleType: "validation", description: "uses orders.amount", condition: "orders.amount" },
    ],
  });
});

describe("ImpactAnalyzer", () => {
  it("keeps symbol lookups isolated to the requested project", async () => {
    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyze(1, "UpdateContract", "symbol");

    expect(result.targetType).toBe("symbol");
    expect(result.affectedFiles).toEqual(["src/Shared.pas"]);
    expect(result.affectedSymbols.map((symbol) => symbol.name)).toEqual(["Caller", "UpdateContract"]);
    expect(result.affectedSymbols.some((symbol) => symbol.file === "other/Shared.pas")).toBe(false);
  });

  it("finds impact for a file target without mixing projects", async () => {
    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyze(1, "Shared.pas", "file");

    expect(result.targetType).toBe("file");
    expect(result.affectedCount).toBe(6);
    expect(result.affectedFiles).toEqual(["src/Shared.pas"]);
    expect(result.affectedRules).toEqual(["SharedRule"]);
    expect(result.affectedRisks).toEqual(["Shared risk"]);
  });

  it("finds impact for a rule target", async () => {
    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyze(1, "SharedRule", "rule");

    expect(result.targetType).toBe("rule");
    expect(result.affectedFiles).toEqual(["src/Shared.pas"]);
    expect(result.affectedRules).toEqual(["SharedRule"]);
    expect(result.affectedSymbols.map((symbol) => symbol.name)).toContain("UpdateContract");
  });

  it("finds impact for a scoped sql_field target", async () => {
    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyze(1, "orders.amount", "sql_field");

    expect(result.targetType).toBe("sql_field");
    expect(result.affectedFields).toEqual([{ table: "orders", field: "amount" }]);
    expect(result.affectedSymbols.map((symbol) => symbol.name)).toEqual(["UpdateContract"]);
    expect(result.affectedRules).toEqual(["SharedRule"]);
  });

  it("auto-detects sql_field before file and symbol matches", async () => {
    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyze(1, "orders.amount", "auto");

    expect(result.targetType).toBe("sql_field");
    expect(result.affectedFiles).toEqual(["src/Shared.pas"]);
  });
});
