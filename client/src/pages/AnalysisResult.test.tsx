import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AnalysisResult, { renderDocumentPreview } from "./AnalysisResult";

const setLocation = vi.fn();
const useAnalysisResultModelMock = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/projects/1/analysis", setLocation],
  useRoute: () => [true, { id: "1" }],
}));

vi.mock("./analysisResult/useAnalysisResultModel", () => ({
  useAnalysisResultModel: (...args: unknown[]) => useAnalysisResultModelMock(...args),
}));

function createModel(overrides: Record<string, unknown> = {}) {
  return {
    activeTab: "overview",
    setActiveTab: vi.fn(),
    symbolSearch: "",
    setSymbolSearch: vi.fn(),
    symbolKind: "all",
    setSymbolKind: vi.fn(),
    symbolPage: 1,
    setSymbolPage: vi.fn(),
    fieldSearch: "",
    setFieldSearch: vi.fn(),
    fieldTable: "all",
    setFieldTable: vi.fn(),
    fieldPage: 1,
    setFieldPage: vi.fn(),
    riskSearch: "",
    setRiskSearch: vi.fn(),
    riskSeverity: "all",
    setRiskSeverity: vi.fn(),
    riskType: "all",
    setRiskType: vi.fn(),
    riskFile: "",
    setRiskFile: vi.fn(),
    riskCriticalOnly: false,
    setRiskCriticalOnly: vi.fn(),
    hideDuplicateRisks: true,
    setHideDuplicateRisks: vi.fn(),
    riskPage: 1,
    setRiskPage: vi.fn(),
    ruleSearch: "",
    setRuleSearch: vi.fn(),
    ruleType: "all",
    setRuleType: vi.fn(),
    ruleFile: "",
    setRuleFile: vi.fn(),
    hideDuplicateRules: true,
    setHideDuplicateRules: vi.fn(),
    rulePage: 1,
    setRulePage: vi.fn(),
    dependencySearch: "",
    setDependencySearch: vi.fn(),
    dependencyType: "all",
    setDependencyType: vi.fn(),
    dependencyTargetKind: "all",
    setDependencyTargetKind: vi.fn(),
    hideStandardLibraryDependencies: true,
    setHideStandardLibraryDependencies: vi.fn(),
    dependencyPage: 1,
    setDependencyPage: vi.fn(),
    fieldDependencySearch: "",
    setFieldDependencySearch: vi.fn(),
    fieldDependencyTable: "all",
    setFieldDependencyTable: vi.fn(),
    fieldDependencyOperationType: "all",
    setFieldDependencyOperationType: vi.fn(),
    fieldDependencyPage: 1,
    setFieldDependencyPage: vi.fn(),
    isReportDownloading: false,
    projectQuery: { error: null, isFetching: false, isLoading: false, refetch: vi.fn() },
    snapshotQuery: { isFetching: false, isLoading: false, refetch: vi.fn() },
    symbolsQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
    fieldsQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
    risksQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
    rulesQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
    dependenciesQuery: {
      data: {
        items: [],
        total: 0,
        page: 1,
        pageCount: 0,
        summary: {
          internalCount: 0,
          externalCount: 0,
          standardLibraryCount: 0,
          hiddenByDefaultCount: 0,
          defaultHideStandardLibrary: true,
        },
      },
      isLoading: false,
    },
    fieldDependenciesQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
    triggerAnalysisMutation: { isPending: false },
    isLoading: false,
    project: {
      id: 1,
      name: "Legacy Demo",
      description: null,
      language: "go",
      sourceType: "upload",
      sourceUrl: null,
      status: "completed",
      importProgress: 100,
      analysisProgress: 100,
      errorMessage: null,
      lastErrorCode: null,
      analysisStatus: "completed",
      importWarningsJson: [],
      latestJob: { id: 1, type: "analyze", status: "completed", progress: 100, errorMessage: null },
      lastAnalyzedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    snapshot: {
      report: null,
      importWarnings: [],
      warningSummary: [],
      partialReasons: [],
      totals: { files: 0, symbols: 0, fields: 0, dependencies: 0, fieldDependencies: 0, risks: 0, rules: 0, importWarnings: 0 },
      topSymbols: [],
      topRisks: [],
      topRules: [],
      topRiskGroups: [],
      topRuleGroups: [],
      topAffectedFiles: [],
      dependencySummary: {
        internalCount: 0,
        externalCount: 0,
        standardLibraryCount: 0,
        hiddenByDefaultCount: 0,
        defaultHideStandardLibrary: true,
      },
      fieldTables: [],
    },
    report: null,
    metrics: null,
    analysisStatus: "completed",
    viewState: "completed",
    showPreviousAnalysisFailureBanner: false,
    importWarnings: [],
    canRunAnalysis: true,
    canDownloadReport: false,
    handleRunAnalysis: vi.fn(),
    handleDownloadReport: vi.fn(),
    ...overrides,
  };
}

describe("AnalysisResult", () => {
  beforeEach(() => {
    setLocation.mockReset();
    useAnalysisResultModelMock.mockReset();
  });

  it("shows a warning banner instead of a project error when analysis completed with warnings", () => {
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        project: {
          id: 1,
          name: "Legacy Demo",
          description: null,
          language: "delphi",
          sourceType: "upload",
          sourceUrl: null,
          status: "completed",
          importProgress: 100,
          analysisProgress: 100,
          errorMessage: "Analysis completed with warnings.",
          lastErrorCode: null,
          analysisStatus: "completed_with_warnings",
          importWarningsJson: [],
          latestJob: { id: 1, type: "analyze", status: "completed", progress: 100, errorMessage: null },
          lastAnalyzedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        snapshot: {
          report: {
            id: 1,
            projectId: 1,
            status: "completed_with_warnings",
            flowMarkdown: "# FLOW",
            dataDependencyMarkdown: "# DATA",
            risksMarkdown: "# RISKS",
            rulesYaml: "rules: []",
            summaryJson: null,
            warningsJson: [],
            errorMessage: "Analysis completed with warnings.",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          importWarnings: [],
          warningSummary: [{ code: "IMPORT_LIMITED_ANALYSIS", label: "DFM 有限分析", description: "部分 DFM 只能做有限分析。", count: 2, sampleMessages: [], sampleFiles: [], partialReason: "DFM 僅有限分析" }],
          partialReasons: ["DFM 僅有限分析", "偵測到 legacy encoding"],
          totals: { files: 10, symbols: 20, fields: 0, dependencies: 5, fieldDependencies: 0, risks: 3, rules: 2, importWarnings: 2 },
          topSymbols: [],
          topRisks: [],
          topRules: [],
          topRiskGroups: [],
          topRuleGroups: [],
          topAffectedFiles: [],
          dependencySummary: { internalCount: 1, externalCount: 1, standardLibraryCount: 1, hiddenByDefaultCount: 1, defaultHideStandardLibrary: true },
          fieldTables: [],
        },
        report: {
          id: 1,
          projectId: 1,
          status: "completed_with_warnings",
          flowMarkdown: "# FLOW",
          dataDependencyMarkdown: "# DATA",
          risksMarkdown: "# RISKS",
          rulesYaml: "rules: []",
          summaryJson: null,
          warningsJson: [],
          errorMessage: "Analysis completed with warnings.",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        analysisStatus: "completed_with_warnings",
      })
    );

    const html = renderToString(<AnalysisResult />);

    expect(html).toContain("分析完成但有警告");
    expect(html).not.toContain("專案錯誤");
    expect(html).not.toContain("completed_with_warnings");
    expect(html).toContain("原因摘要");
  });

  it("shows import warnings from the analysis snapshot", () => {
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        importWarnings: [
          {
            code: "IMPORT_LIMITED_ANALYSIS",
            message: "Imported with limited analysis.",
            filePath: "forms/MainForm.dfm",
          },
        ],
      })
    );

    const html = renderToString(<AnalysisResult />);

    expect(html).toContain("IMPORT_LIMITED_ANALYSIS");
    expect(html).toContain("Imported with limited analysis.");
    expect(html).toContain("forms/MainForm.dfm");
  });

  it("shows analysis confidence score, level, breakdown, and manual review prompt", () => {
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        metrics: {
          fileCount: 3,
          eligibleFileCount: 3,
          analyzedFileCount: 2,
          skippedFileCount: 1,
          heuristicFileCount: 1,
          degradedFileCount: 1,
          symbolCount: 4,
          dependencyCount: 1,
          fieldCount: 2,
          fieldDependencyCount: 2,
          riskCount: 1,
          ruleCount: 0,
          warningCount: 3,
          confidence: {
            score: 55,
            level: "low",
            breakdown: [
              { label: "Base score", impact: 100, reason: "Start from full confidence." },
              { label: "Unresolved DFM event handlers", impact: -8, reason: "2/3 DFM event handlers were unresolved." },
              { label: "Dynamic SQL", impact: -6, reason: "2 dynamic SQL fragments or risk findings were detected." },
            ],
          },
        },
      })
    );

    const html = renderToString(<AnalysisResult />);

    expect(html).toContain("Analysis Confidence Score");
    expect(html).toContain("55");
    expect(html).toContain("/100");
    expect(html).toContain("low");
    expect(html).toContain("Unresolved DFM event handlers");
    expect(html).toContain("Dynamic SQL");
    expect(html).toContain("需要人工複核");
  });

  it("shows confidence unavailable when the backend result has no final confidence", () => {
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
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
      })
    );

    const html = renderToString(<AnalysisResult />);

    expect(html).toContain("Analysis Confidence Score");
    expect(html).toContain("Confidence unavailable for this analysis result.");
  });

  it("returns stable fallback text when no document content exists", () => {
    expect(renderDocumentPreview(null)).toBe("目前沒有可預覽的文件內容。");
  });
});
