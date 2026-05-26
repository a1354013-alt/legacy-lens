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

describe("AnalysisResult", () => {
  beforeEach(() => {
    setLocation.mockReset();
    useAnalysisResultModelMock.mockReset();
  });

  it("renders queued state without crashing", () => {
    useAnalysisResultModelMock.mockReturnValue({
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
      riskPage: 1,
      setRiskPage: vi.fn(),
      ruleSearch: "",
      setRuleSearch: vi.fn(),
      ruleType: "all",
      setRuleType: vi.fn(),
      rulePage: 1,
      setRulePage: vi.fn(),
      dependencySearch: "",
      setDependencySearch: vi.fn(),
      dependencyType: "all",
      setDependencyType: vi.fn(),
      dependencyTargetKind: "all",
      setDependencyTargetKind: vi.fn(),
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
      dependenciesQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
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
        status: "ready",
        importProgress: 100,
        analysisProgress: 0,
        errorMessage: null,
        lastErrorCode: null,
        analysisStatus: "pending",
        importWarningsJson: [],
        latestJob: { id: 1, type: "analyze", status: "queued", progress: 0, errorMessage: null },
        lastAnalyzedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      snapshot: {
        projectId: 1,
        status: "pending",
        report: null,
        importWarnings: [],
        totals: { files: 0, symbols: 0, fields: 0, dependencies: 0, fieldDependencies: 0, risks: 0, rules: 0 },
        topSymbols: [],
        topRisks: [],
        topRules: [],
        fieldTables: [],
      },
      report: null,
      metrics: null,
      analysisStatus: "pending",
      viewState: "queued",
      importWarnings: [],
      canRunAnalysis: true,
      canDownloadReport: false,
      handleRunAnalysis: vi.fn(),
      handleDownloadReport: vi.fn(),
    });

    const html = renderToString(<AnalysisResult />);

    expect(html).toContain("Legacy Demo");
  });

  it("returns stable fallback text when no document content exists", () => {
    expect(renderDocumentPreview(null)).toBe("目前沒有可預覽的文件內容。");
  });
});
