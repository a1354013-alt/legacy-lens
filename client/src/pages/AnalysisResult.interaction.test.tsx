/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/locales";
import AnalysisResult from "./AnalysisResult";

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
    activeTab: "history",
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
    runPage: 1,
    setRunPage: vi.fn(),
    selectedRunId: null,
    setSelectedRunId: vi.fn(),
    inspectedRunId: 55,
    inspectRun: vi.fn(),
    returnToCurrentSource: vi.fn(),
    isInspectingHistoricalRun: true,
    compareBaseRunId: 55,
    setCompareBaseRunId: vi.fn(),
    compareRunId: 55,
    setCompareRunId: vi.fn(),
    flowTraceSearch: "",
    setFlowTraceSearch: vi.fn(),
    flowTraceForm: "",
    setFlowTraceForm: vi.fn(),
    flowTraceComponent: "",
    setFlowTraceComponent: vi.fn(),
    flowTraceEvent: "",
    setFlowTraceEvent: vi.fn(),
    flowTraceStatus: "all",
    setFlowTraceStatus: vi.fn(),
    flowTraceTable: "",
    setFlowTraceTable: vi.fn(),
    flowTraceOperation: "all",
    setFlowTraceOperation: vi.fn(),
    flowTraceConfidence: "all",
    setFlowTraceConfidence: vi.fn(),
    flowTracePage: 1,
    setFlowTracePage: vi.fn(),
    resetFlowTraceFilters: vi.fn(),
    isReportDownloading: false,
    downloadingRunId: null,
    isDiffDownloading: false,
    projectQuery: { error: null, isFetching: false, isLoading: false, refetch: vi.fn() },
    snapshotQuery: { error: null, data: { report: { id: 101, runNumber: 9 }, topSymbols: [], topRiskGroups: [], topRuleGroups: [], topAffectedFiles: [], dependencySummary: { internalCount: 0, externalCount: 0, unresolvedCount: 0, standardLibraryCount: 0 }, fieldTables: [], warningSummary: [], partialReasons: [], importWarnings: [], totals: { files: 0, symbols: 0, dependencies: 0, fields: 0, fieldDependencies: 0, risks: 0, rules: 0, importWarnings: 0 } }, isFetching: false, isLoading: false, refetch: vi.fn() },
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
        summary: { internalCount: 0, externalCount: 0, unresolvedCount: 0, standardLibraryCount: 0, hiddenByDefaultCount: 0, defaultHideStandardLibrary: true },
      },
      isLoading: false,
    },
    fieldDependenciesQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, isLoading: false },
    analysisRunsQuery: {
      data: {
        items: [
          { id: 101, runNumber: 9, status: "completed", fingerprint: "current", createdAt: new Date("2026-07-26T00:00:00.000Z"), metricsSummary: { files: 10, symbols: 5 }, riskCount: 0, confidence: { score: 88, level: "high" }, isLatestUsable: true, isBaseline: false, analyzerVersion: "1.1.0", exporterVersion: "1.1.0", jobStatus: "completed", warningCount: 0, snapshotAvailable: true },
          { id: 55, runNumber: 8, status: "completed", fingerprint: "older", createdAt: new Date("2026-07-25T00:00:00.000Z"), metricsSummary: { files: 9, symbols: 4 }, riskCount: 1, confidence: { score: 70, level: "medium" }, isLatestUsable: false, isBaseline: true, analyzerVersion: "1.1.0", exporterVersion: "1.1.0", jobStatus: "completed", warningCount: 1, snapshotAvailable: true },
        ],
        total: 2,
        page: 1,
        pageCount: 1,
      },
      error: null,
      isLoading: false,
    },
    selectedRunQuery: { data: null, error: null, isLoading: false },
    diffQuery: { data: null, error: null, isLoading: false },
    buildDoctorRunQuery: {
      data: null,
      error: null,
      isLoading: false,
    },
    flowTraceSummaryQuery: { data: null, error: null, isLoading: false },
    flowTracesQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, error: null, isLoading: false },
    setBaselineMutation: { isPending: false, mutate: vi.fn() },
    clearBaselineMutation: { isPending: false, mutate: vi.fn() },
    triggerAnalysisMutation: { isPending: false },
    isLoading: false,
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
      errorMessage: null,
      lastErrorCode: null,
      analysisStatus: "completed",
      importWarningsJson: [],
      latestJob: { id: 1, type: "analyze", status: "completed", progress: 100, errorMessage: null },
      lastAnalyzedAt: null,
      createdAt: new Date("2026-07-25T00:00:00.000Z"),
      updatedAt: new Date("2026-07-26T00:00:00.000Z"),
    },
    snapshot: {
      report: { id: 101, projectId: 1, runNumber: 9, status: "completed", flowMarkdown: "# FLOW", dataDependencyMarkdown: "# DATA", risksMarkdown: "# RISKS", rulesYaml: "rules: []", summaryJson: { confidence: { score: 80, level: "medium", breakdown: [] } }, warningsJson: [], errorMessage: null, createdAt: new Date("2026-07-26T00:00:00.000Z"), updatedAt: new Date("2026-07-26T00:00:00.000Z") },
      importWarnings: [],
      warningSummary: [],
      partialReasons: [],
      totals: { files: 0, symbols: 0, dependencies: 0, fields: 0, fieldDependencies: 0, risks: 0, rules: 0, importWarnings: 0 },
      topSymbols: [],
      topRisks: [],
      topRules: [],
      topRiskGroups: [],
      topRuleGroups: [],
      topAffectedFiles: [],
      dependencySummary: { internalCount: 0, externalCount: 0, unresolvedCount: 0, standardLibraryCount: 0, hiddenByDefaultCount: 0, defaultHideStandardLibrary: true },
      fieldTables: [],
    },
    report: { id: 101, runNumber: 9 },
    metrics: { confidence: { score: 80, level: "medium", breakdown: [] } },
    analysisStatus: "completed",
    viewState: "completed",
    showPreviousAnalysisFailureBanner: false,
    importWarnings: [],
    canRunAnalysis: true,
    canDownloadReport: true,
    handleRunAnalysis: vi.fn(),
    handleDownloadReport: vi.fn(),
    handleDownloadHistoricalReport: vi.fn(),
    handleDownloadComparison: vi.fn(),
    selectCompareBaseRun: vi.fn(),
    selectCompareRun: vi.fn(),
    canDownloadComparison: false,
    ...overrides,
  };
}

describe("AnalysisResult interactions", () => {
  beforeEach(() => {
    setLocation.mockReset();
    useAnalysisResultModelMock.mockReset();
  });

  afterEach(() => cleanup());

  it("shows historical run context using run numbers and blocks same-run comparison before diff data exists", () => {
    useAnalysisResultModelMock.mockReturnValue(createModel());

    render(<AnalysisResult />);

    expect(screen.getAllByText(t("analysisV11.runSource.historical")).length).toBeGreaterThan(0);
    expect(screen.getByText(t("analysisV11.runSource.historicalRunNumber", { runNumber: 8 }))).toBeTruthy();
    expect(screen.getByText(t("analysisV11.runSource.baseline"))).toBeTruthy();
    expect(screen.getByText(t("analysisV11.diff.sameRunTitle"))).toBeTruthy();
    expect(screen.getByText(t("analysisV11.diff.sameRunDescription"))).toBeTruthy();
  });

  it("renders Build Doctor package references from structured provenance", () => {
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        activeTab: "buildDoctor",
        buildDoctorRunQuery: {
          data: {
            snapshot: {
              buildDoctor: {
                status: "ready_with_warnings",
                score: 82,
                compilerFamily: { value: "MSBuild", confidence: "high", evidence: ["Personality=Delphi.Personality"] },
                projectEntries: [],
                configurations: ["Debug"],
                platforms: ["Win64"],
                defines: ["DEBUG"],
                searchPaths: [],
                includePaths: [],
                outputPaths: [],
                runtimePackages: [],
                requiredPackages: ["Vendor.Reporting"],
                packageResolutions: [
                  {
                    packageName: "Vendor.Reporting",
                    resolution: "external_unverified",
                    evidence: ["sourceFile=Build/App.dproj"],
                    references: [
                      {
                        sourceFile: "Build/App.dproj",
                        lineNumber: 12,
                        condition: "'$(Config)'=='Debug'",
                        rawValue: "Vendor.Reporting",
                        resolvedPath: "Packages/Vendor.Reporting.dpk",
                      },
                    ],
                  },
                ],
                requiredUnits: [],
                missingUnits: [],
                unresolvedUnits: [],
                missingPackages: [],
                externalDependencies: ["Vendor.Reporting"],
                findings: [],
                limitations: [],
              },
            },
          },
          error: null,
          isLoading: false,
        },
      })
    );

    render(<AnalysisResult />);

    expect(screen.getByText(t("analysisV11.buildDoctor.references"))).toBeTruthy();
    expect(screen.getByText(/Build\/App\.dproj:12 \| Vendor\.Reporting \| '\$\(Config\)'=='Debug' \| Packages\/Vendor\.Reporting\.dpk/)).toBeTruthy();
  });
});
