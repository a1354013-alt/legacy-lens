import { describe, expect, it } from "vitest";
import type { AnalysisSnapshot } from "@shared/contracts";
import {
  canDownloadAnalysisReport,
  filterFields,
  filterRisks,
  filterRules,
  filterSymbols,
  getAnalysisViewState,
  limitResults,
  RESULT_LIST_PAGE_SIZE,
  resolveAnalysisStatus,
  shouldPollProjectStatus,
  shouldPollSnapshot,
} from "./analysisResultModel";

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
    importWarnings: [],
    symbols: Array.from({ length: 100 }, (_, index) => ({
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
    fields: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      tableName: index < 50 ? "dbo.Users" : "ERP.SIGNB",
      fieldName: index < 50 ? `Name_${index}` : `MARK_${index}`,
      fieldType: null,
      description: null,
      readCount: index,
      writeCount: index % 3,
      referenceCount: index + 1,
    })),
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
  it("filters large symbol collections by search and kind", () => {
    const snapshot = createSnapshot();

    expect(filterSymbols(snapshot, { search: "", kind: "all" })).toHaveLength(100);
    expect(filterSymbols(snapshot, { search: "loaduser", kind: "all" })).toHaveLength(50);
    expect(filterSymbols(snapshot, { search: "", kind: "method" })).toHaveLength(50);
  });

  it("limits large result lists before rendering them into the DOM", () => {
    const items = Array.from({ length: RESULT_LIST_PAGE_SIZE + 25 }, (_, index) => index);
    const page = limitResults(items);

    expect(page.visibleItems).toHaveLength(RESULT_LIST_PAGE_SIZE);
    expect(page.totalCount).toBe(RESULT_LIST_PAGE_SIZE + 25);
    expect(page.hasMore).toBe(true);
    expect(limitResults(items, RESULT_LIST_PAGE_SIZE + 25).hasMore).toBe(false);
  });

  it("filters fields by table and field search while keeping reference counts available", () => {
    const snapshot = createSnapshot();

    expect(filterFields(snapshot, { search: "mark_7", table: "all" })).toEqual([
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_70" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_71" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_72" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_73" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_74" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_75" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_76" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_77" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_78" }),
      expect.objectContaining({ tableName: "ERP.SIGNB", fieldName: "MARK_79" }),
    ]);
    expect(filterFields(snapshot, { search: "", table: "dbo.Users" })).toHaveLength(50);
    expect(filterFields(snapshot, { search: "", table: "all" })).toHaveLength(100);
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

  it("polls only while analysis is actively running", () => {
    expect(shouldPollProjectStatus("ready", "pending")).toBe(false);
    expect(shouldPollSnapshot("ready", "pending")).toBe(false);
    expect(shouldPollProjectStatus("analyzing", "pending")).toBe(true);
    expect(shouldPollSnapshot("ready", "processing")).toBe(true);
    expect(shouldPollProjectStatus("completed", "completed")).toBe(false);
    expect(shouldPollSnapshot("failed", "failed")).toBe(false);
  });

  it("restores all results after clearing search filters", () => {
    const snapshot = createSnapshot();

    expect(filterSymbols(snapshot, { search: "loaduser0", kind: "all" })).toHaveLength(1);
    expect(filterSymbols(snapshot, { search: "", kind: "all" })).toHaveLength(100);
    expect(filterFields(snapshot, { search: "mark_9", table: "ERP.SIGNB" })).toHaveLength(10);
    expect(filterFields(snapshot, { search: "", table: "all" })).toHaveLength(100);
  });

  it("derives view state for completed and failed UI branches", () => {
    expect(getAnalysisViewState("ready", "pending", false)).toBe("idle");
    expect(getAnalysisViewState("analyzing", "pending", false)).toBe("analyzing");
    expect(getAnalysisViewState("completed", "completed", true)).toBe("completed");
    expect(getAnalysisViewState("failed", "failed", false)).toBe("failed");
  });

  it("prefers the persisted report status and falls back to project analysis status", () => {
    expect(resolveAnalysisStatus(undefined, undefined)).toBe("pending");
    expect(resolveAnalysisStatus(undefined, "processing")).toBe("processing");
    expect(resolveAnalysisStatus(undefined, "completed")).toBe("completed");
    expect(resolveAnalysisStatus(undefined, "failed")).toBe("failed");
    expect(resolveAnalysisStatus("partial", "processing")).toBe("partial");
  });

  it("enables report download only for completed or partial reports with all snapshot artifacts", () => {
    const completedSnapshot = createSnapshot();
    const partialSnapshot = {
      ...createSnapshot(),
      report: {
        ...createSnapshot().report!,
        status: "partial" as const,
      },
    };
    const failedSnapshot = {
      ...createSnapshot(),
      report: {
        ...createSnapshot().report!,
        status: "failed" as const,
      },
    };
    const pendingSnapshot = {
      ...createSnapshot(),
      report: {
        ...createSnapshot().report!,
        status: "processing" as const,
      },
    };
    const missingYamlSnapshot = {
      ...createSnapshot(),
      report: {
        ...createSnapshot().report!,
        rulesYaml: null,
      },
    };

    expect(canDownloadAnalysisReport(completedSnapshot)).toBe(true);
    expect(canDownloadAnalysisReport(partialSnapshot)).toBe(true);
    expect(canDownloadAnalysisReport(failedSnapshot)).toBe(false);
    expect(canDownloadAnalysisReport(pendingSnapshot)).toBe(false);
    expect(canDownloadAnalysisReport(missingYamlSnapshot)).toBe(false);
    expect(canDownloadAnalysisReport(undefined)).toBe(false);
  });
});
