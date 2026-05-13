import { describe, expect, it } from "vitest";
import type { AnalysisSnapshot } from "@shared/contracts";
import { filterFields, filterRisks, filterRules, filterSymbols, shouldPollProjectStatus, shouldPollSnapshot } from "./analysisResultModel";

function createSnapshot(): AnalysisSnapshot {
  return {
    report: {
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# FLOW",
      dataDependencyMarkdown: "# DATA_DEPENDENCY",
      risksMarkdown: "# RISKS",
      rulesYaml: "rules: []",
      summaryJson: null,
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    symbols: Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      name: index % 2 === 0 ? `LoadUser${index}` : `SaveOrder${index}`,
      type: index % 2 === 0 ? "procedure" : "method",
      fileId: 1,
      filePath: index % 2 === 0 ? "src/users.pas" : "src/orders.pas",
      startLine: index + 1,
      endLine: index + 2,
      signature: null,
      description: null,
    })),
    dependencies: [],
    fields: [
      { id: 1, tableName: "dbo.Users", fieldName: "Name", fieldType: null, description: null, readCount: 3, writeCount: 1, referenceCount: 4 },
      { id: 2, tableName: "ERP.SIGNB", fieldName: "MARK_2", fieldType: null, description: null, readCount: 0, writeCount: 2, referenceCount: 2 },
    ],
    fieldDependencies: [],
    risks: [
      { id: 1, riskType: "magic_value", severity: "high", title: "Shared risk", description: "message one", sourceFile: "src/users.pas", lineNumber: 10, recommendation: null },
      { id: 2, riskType: "other", severity: "low", title: "Minor issue", description: "message two", sourceFile: "src/orders.pas", lineNumber: 20, recommendation: null },
    ],
    rules: [
      { id: 1, ruleType: "validation", name: "ValidateUser", description: "Ensure dbo.Users.Name is normalized", condition: null, sourceFile: "src/users.pas", lineNumber: 10 },
      { id: 2, ruleType: "calculation", name: "CalcMark2", description: "ERP.SIGNB.MARK_2 recalculation", condition: null, sourceFile: "src/orders.pas", lineNumber: 20 },
    ],
  };
}

describe("analysisResultModel", () => {
  it("does not truncate large symbol collections and can filter by search and kind", () => {
    const snapshot = createSnapshot();

    expect(filterSymbols(snapshot, { search: "", kind: "all" })).toHaveLength(30);
    expect(filterSymbols(snapshot, { search: "LoadUser", kind: "all" })).toHaveLength(15);
    expect(filterSymbols(snapshot, { search: "", kind: "method" })).toHaveLength(15);
  });

  it("filters fields by table and field search while keeping reference counts available", () => {
    const snapshot = createSnapshot();

    expect(filterFields(snapshot, { search: "mark", table: "all" })).toEqual([
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_2", writeCount: 2 }),
    ]);
    expect(filterFields(snapshot, { search: "", table: "dbo.Users" })).toEqual([
      expect.objectContaining({ tableName: "dbo.Users", referenceCount: 4 }),
    ]);
  });

  it("filters risks by severity and search text", () => {
    const snapshot = createSnapshot();

    expect(filterRisks(snapshot, { search: "", severity: "high" })).toEqual([
      expect.objectContaining({ title: "Shared risk" }),
    ]);
    expect(filterRisks(snapshot, { search: "orders", severity: "all" })).toEqual([
      expect.objectContaining({ title: "Minor issue" }),
    ]);
  });

  it("filters rules by name and description", () => {
    const snapshot = createSnapshot();

    expect(filterRules(snapshot, { search: "ValidateUser" })).toEqual([
      expect.objectContaining({ name: "ValidateUser" }),
    ]);
    expect(filterRules(snapshot, { search: "mark_2" })).toEqual([
      expect.objectContaining({ name: "CalcMark2" }),
    ]);
  });

  it("stops polling when analysis reaches a terminal state", () => {
    expect(shouldPollProjectStatus("analyzing", "processing")).toBe(true);
    expect(shouldPollSnapshot("analyzing", "processing")).toBe(true);
    expect(shouldPollProjectStatus("completed", "completed")).toBe(false);
    expect(shouldPollSnapshot("failed", "failed")).toBe(false);
  });
});
