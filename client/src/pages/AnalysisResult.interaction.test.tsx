/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    HTMLElement.prototype.hasPointerCapture ??= vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture ??= vi.fn();
    HTMLElement.prototype.releasePointerCapture ??= vi.fn();
    HTMLElement.prototype.scrollIntoView ??= vi.fn();
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
    const packageResolutions = [
      ["LocalShared", "project_local"],
      ["rtl", "delphi_standard"],
      ["Vendor.Reporting", "external_unverified"],
      ["MissingPkg", "missing"],
      ["AmbiguousPkg", "ambiguous"],
    ] as const;
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
                packageResolutions: packageResolutions.map(([packageName, resolution]) => ({
                    packageName,
                    resolution,
                    evidence: ["sourceFile=Build/App.dproj"],
                    references: [
                      {
                        sourceFile: "Build/App.dproj",
                        lineNumber: 12,
                        condition: "'$(Config)'=='Debug'",
                        rawValue: packageName,
                        resolvedPath: `Packages/${packageName}.dpk`,
                      },
                    ],
                  })),
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

    expect(screen.getAllByText(t("analysisV11.buildDoctor.references")).length).toBe(packageResolutions.length);
    expect(screen.getByText(/Build\/App\.dproj:12 \| Vendor\.Reporting \| '\$\(Config\)'=='Debug' \| Packages\/Vendor\.Reporting\.dpk/)).toBeTruthy();
    for (const [, resolution] of packageResolutions) {
      expect(screen.getByText(t(`labels.packageResolution.${resolution}`))).toBeTruthy();
      expect(screen.queryByText(resolution)).toBeNull();
    }
  });

  it("renders history loading, empty, and error states", () => {
    useAnalysisResultModelMock.mockReturnValue(createModel({ analysisRunsQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, error: null, isLoading: true } }));
    const { rerender } = render(<AnalysisResult />);
    expect(screen.queryByText(t("analysisV11.history.empty"))).toBeNull();

    useAnalysisResultModelMock.mockReturnValue(createModel({ analysisRunsQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, error: null, isLoading: false } }));
    rerender(<AnalysisResult />);
    expect(screen.getByText(t("analysisV11.history.empty"))).toBeTruthy();

    useAnalysisResultModelMock.mockReturnValue(createModel({ analysisRunsQuery: { data: { items: [], total: 0, page: 1, pageCount: 0 }, error: new Error("history unavailable"), isLoading: false } }));
    rerender(<AnalysisResult />);
    expect(screen.getByText(t("analysisV11.history.loadFailedTitle"))).toBeTruthy();
    expect(screen.getByText("history unavailable")).toBeTruthy();
  });

  it("clicks history run actions for current, historical, baseline, and downloads independently", async () => {
    const user = userEvent.setup();
    const setSelectedRunId = vi.fn();
    const inspectRun = vi.fn();
    const returnToCurrentSource = vi.fn();
    const setBaselineMutation = { isPending: false, mutate: vi.fn() };
    const clearBaselineMutation = { isPending: false, mutate: vi.fn() };
    const selectCompareBaseRun = vi.fn();
    const selectCompareRun = vi.fn();
    const handleDownloadHistoricalReport = vi.fn();

    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        setSelectedRunId,
        inspectRun,
        returnToCurrentSource,
        setBaselineMutation,
        clearBaselineMutation,
        selectCompareBaseRun,
        selectCompareRun,
        handleDownloadHistoricalReport,
        downloadingRunId: 55,
      })
    );

    render(<AnalysisResult />);

    expect(screen.getByText(t("analysisV11.runSource.current"))).toBeTruthy();
    expect(screen.getAllByText(t("analysisV11.runSource.historical")).length).toBeGreaterThan(0);
    expect(screen.getByText(t("analysisV11.runSource.latestUsable"))).toBeTruthy();
    expect(screen.getByText(t("analysisV11.runSource.baseline"))).toBeTruthy();

    const historicalCard = screen.getByText(t("analysisV11.history.runTitle", { runNumber: 8 })).closest("[data-slot='card']") ?? screen.getByText(t("analysisV11.history.runTitle", { runNumber: 8 })).closest("div")!;
    await user.click(within(historicalCard as HTMLElement).getByRole("button", { name: t("analysisV11.history.details") }));
    await user.click(within(historicalCard as HTMLElement).getByRole("button", { name: t("analysisV11.history.setBaseline") }));
    await user.click(within(historicalCard as HTMLElement).getByRole("button", { name: t("analysisV11.history.clearBaseline") }));
    await user.click(within(historicalCard as HTMLElement).getByRole("button", { name: t("analysisV11.history.useAsBase") }));
    await user.click(within(historicalCard as HTMLElement).getByRole("button", { name: t("analysisV11.history.compareTo") }));

    const downloadButtons = screen.getAllByRole("button", { name: t("analysisV11.history.downloadReport") });
    expect(downloadButtons[1]).toHaveProperty("disabled", true);
    await user.click(downloadButtons[0]);

    await user.click(screen.getByRole("button", { name: t("analysisV11.runSource.returnToCurrent") }));

    expect(setSelectedRunId).toHaveBeenCalledWith(55);
    expect(inspectRun).toHaveBeenCalledWith(55);
    expect(setBaselineMutation.mutate).toHaveBeenCalledWith({ projectId: 1, runId: 55 });
    expect(clearBaselineMutation.mutate).toHaveBeenCalledWith(1);
    expect(selectCompareBaseRun).toHaveBeenCalledWith(55);
    expect(selectCompareRun).toHaveBeenCalledWith(55);
    expect(handleDownloadHistoricalReport).toHaveBeenCalledWith(101);
    expect(returnToCurrentSource).toHaveBeenCalledTimes(1);
  });

  it("renders comparison failures and invokes Diff ZIP download", async () => {
    const user = userEvent.setup();
    const handleDownloadComparison = vi.fn();
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        compareBaseRunId: 55,
        compareRunId: 101,
        canDownloadComparison: true,
        handleDownloadComparison,
        diffQuery: { data: null, error: new Error("diff query failed"), isLoading: false },
      })
    );

    render(<AnalysisResult />);

    expect(screen.getByText("diff query failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t("analysisV11.diff.download") }));
    expect(handleDownloadComparison).toHaveBeenCalledTimes(1);
  });

  it("renders complete Diff categories, changed before/after values, counts, and truncation", async () => {
    const user = userEvent.setup();
    const bucket = (items: unknown[], truncated = false) => ({ items, total: items.length + (truncated ? 2 : 0), displayed: items.length, truncated });
    const changed = bucket([{ before: { label: "before-name" }, after: { label: "after-name" } }], true);
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        compareBaseRunId: 55,
        compareRunId: 101,
        diffQuery: {
          data: {
            baseRun: { id: 55, runNumber: 8 },
            compareRun: { id: 101, runNumber: 9 },
            metricsDelta: { files: 2, risks: -1 },
            truncated: true,
            files: { added: bucket(["src/NewForm.pas"]), removed: bucket(["src/OldForm.pas"]), changed },
            fields: { added: bucket(["Customer.Name"]), removed: bucket(["Customer.Legacy"]), changed },
            fieldDependencies: { introduced: bucket(["Customer.Name read"]), removed: bucket(["Customer.Legacy write"]), changed },
            risks: { introduced: bucket(["Dynamic SQL"]), resolved: bucket(["Missing validation"]), changed },
            rules: { introduced: bucket(["Validate age"]), resolved: bucket(["Old rule"]), changed },
            delphiEvents: { introduced: bucket(["Button1.OnClick"]), removed: bucket(["Button2.OnClick"]), resolutionChanged: changed },
            dataBindings: { introduced: bucket(["DataSource1"]), removed: bucket(["DataSource2"]), changed },
            buildDoctor: { scoreDelta: 7, introduced: bucket(["Package added"]), resolved: bucket(["Unit resolved"]), changed },
            flowTraces: { introduced: bucket(["Trace added"]), removed: bucket(["Trace removed"]), changed },
          },
          error: null,
          isLoading: false,
        },
      })
    );

    render(<AnalysisResult />);

    for (const key of ["files", "fields", "fieldDependencies", "risks", "rules", "delphiEvents", "dataBindings", "buildDoctor", "flowTraces"] as const) {
      expect(screen.getAllByText(t(`analysisV11.diff.${key}`)).length).toBeGreaterThan(0);
    }
    await user.click(screen.getByRole("button", { name: t("analysisV11.diff.files") }));
    expect(screen.getAllByText(t("analysisV11.diff.before")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("analysisV11.diff.after")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("analysisV11.diff.truncated")).length).toBeGreaterThan(0);
    expect(screen.getByText("src/NewForm.pas")).toBeTruthy();
    expect(screen.getByText(t("analysisV11.diff.baseRun", { runNumber: 8 }))).toBeTruthy();
    expect(screen.getByText(t("analysisV11.diff.compareRun", { runNumber: 9 }))).toBeTruthy();
    expect(screen.queryByText("101")).toBeNull();
  });

  it.each(["not_applicable", "ready", "ready_with_warnings", "blocked"] as const)("renders Build Doctor state %s", (status) => {
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        activeTab: "buildDoctor",
        buildDoctorRunQuery: {
          data: {
            snapshot: {
              buildDoctor: {
                status,
                score: 64,
                compilerFamily: { value: "MSBuild", confidence: "high", evidence: ["ProjectVersion=19.0"] },
                projectEntries: [{ path: "App.dproj", kind: "dproj", lineNumber: 4, evidence: "Project root" }],
                configurations: ["Debug"],
                platforms: ["Win32"],
                defines: ["DEBUG"],
                searchPaths: ["src"],
                includePaths: ["include"],
                outputPaths: ["bin"],
                requiredPackages: ["rtl"],
                runtimePackages: ["vcl"],
                packageResolutions: [],
                requiredUnits: ["System.SysUtils"],
                missingUnits: ["Missing.Unit"],
                unresolvedUnits: ["Unknown.Unit"],
                missingPackages: ["MissingPkg"],
                externalDependencies: ["Vendor.Lib"],
                findings: [{ severity: "warning", code: "BD001", title: "Path warning", description: "Search path is broad.", recommendation: "Narrow it.", confidence: "medium", evidence: "src/**", sourceFile: "App.dproj", lineNumber: 9 }],
                limitations: ["No compiler installed."],
              },
            },
          },
          error: null,
          isLoading: false,
        },
      })
    );

    render(<AnalysisResult />);

    expect(screen.getByText(/64/)).toBeTruthy();
    for (const text of ["MSBuild", "ProjectVersion=19.0", "App.dproj", "Debug", "Win32", "DEBUG", "src", "include", "bin", "rtl", "vcl", "System.SysUtils", "Missing.Unit", "Unknown.Unit", "MissingPkg", "Vendor.Lib", "Path warning", "No compiler installed."]) {
      expect(screen.getAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBeGreaterThan(0);
    }
  });

  it("keeps Build Doctor query failure visible as an API error", () => {
    useAnalysisResultModelMock.mockReturnValue(createModel({ activeTab: "buildDoctor", buildDoctorRunQuery: { data: null, error: new Error("Build Doctor API failed"), isLoading: false } }));
    render(<AnalysisResult />);
    expect(screen.getByText(t("analysisV11.buildDoctor.loadFailedTitle"))).toBeTruthy();
    expect(screen.queryByText(t("analysisV11.buildDoctor.notApplicableTitle"))).toBeNull();
  });

  it("renders Flow summary, filters, traces, expansion, and query failures", async () => {
    const user = userEvent.setup();
    const setters = {
      setFlowTraceSearch: vi.fn(),
      setFlowTraceForm: vi.fn(),
      setFlowTraceComponent: vi.fn(),
      setFlowTraceEvent: vi.fn(),
      setFlowTraceTable: vi.fn(),
      setFlowTracePage: vi.fn(),
      resetFlowTraceFilters: vi.fn(),
    };
    const steps = Array.from({ length: 6 }, (_, index) => ({ id: `step-${index}`, type: index === 0 ? "event" : "sql", label: `Step ${index}`, operation: index === 1 ? "read" : null, filePath: index === 0 ? "MainForm.pas" : null, lineNumber: index === 0 ? 42 : null, evidence: index === 1 ? "SELECT * FROM Customer" : null }));
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        activeTab: "flow",
        isInspectingHistoricalRun: false,
        inspectedRunId: null,
        ...setters,
        flowTraceSummaryQuery: { data: { total: 9, complete: 3, partial: 2, unresolved: 4, readPaths: 5, writePaths: 6, affectedTables: 7, candidateTraceCount: 8, persistedTraceCount: 9, globalTruncated: true }, error: new Error("summary failed"), isLoading: false },
        flowTracesQuery: {
          data: { items: [{ stableKey: "trace-1", formName: "MainForm", componentClass: "TButton", componentName: "SaveButton", eventName: "OnClick", resolvedHandler: "SaveButtonClick", handlerName: null, status: "partial", confidence: "high", affectedTables: ["Customer"], affectedFields: [{ table: "Customer", field: "Name", operation: "read" }], warnings: ["Path truncated"], truncated: true, steps }], total: 1, page: 3, pageCount: 3 },
          error: new Error("traces failed"),
          isLoading: false,
        },
      })
    );

    render(<AnalysisResult />);

    for (const value of ["9", "3", "2", "4", "5", "6", "7", "8"]) expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    expect(screen.getByText(t("analysisV11.flow.globalTruncatedTitle"))).toBeTruthy();
    expect(screen.getByText("summary failed")).toBeTruthy();
    expect(screen.getByText("traces failed")).toBeTruthy();
    expect(screen.getByText("Customer.Name " + t("labels.fieldOperation.read"))).toBeTruthy();
    expect(screen.getByText("MainForm.pas:42")).toBeTruthy();
    expect(screen.getByText(t("analysisV11.flow.traceTruncatedTitle"))).toBeTruthy();

    await user.type(screen.getByPlaceholderText(t("analysisV11.flow.searchPlaceholder")), "save");
    await user.type(screen.getByPlaceholderText(t("analysisV11.flow.formPlaceholder")), "Main");
    await user.type(screen.getByPlaceholderText(t("analysisV11.flow.componentPlaceholder")), "Button");
    await user.type(screen.getByPlaceholderText(t("analysisV11.flow.eventPlaceholder")), "Click");
    await user.type(screen.getByPlaceholderText(t("analysisV11.flow.tablePlaceholder")), "Customer");
    await user.click(screen.getByRole("button", { name: t("analysisV11.flow.resetFilters") }));
    await user.click(screen.getByRole("button", { name: t("analysisV11.flow.showAllSteps", { count: 6 }) }));
    expect(screen.getByText("Step 5")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t("analysisV11.flow.collapse") }));

    expect(setters.setFlowTraceSearch).toHaveBeenCalled();
    expect(setters.setFlowTraceForm).toHaveBeenCalled();
    expect(setters.setFlowTraceComponent).toHaveBeenCalled();
    expect(setters.setFlowTraceEvent).toHaveBeenCalled();
    expect(setters.setFlowTraceTable).toHaveBeenCalled();
    expect(setters.setFlowTracePage).toHaveBeenCalledWith(1);
    expect(setters.resetFlowTraceFilters).toHaveBeenCalledTimes(1);
  });

  it("applies Flow status, operation, and confidence filters while resetting pagination", async () => {
    const user = userEvent.setup();
    const setters = {
      setFlowTraceStatus: vi.fn(),
      setFlowTraceOperation: vi.fn(),
      setFlowTraceConfidence: vi.fn(),
      setFlowTracePage: vi.fn(),
    };
    useAnalysisResultModelMock.mockReturnValue(
      createModel({
        activeTab: "flow",
        flowTracePage: 3,
        flowTraceSummaryQuery: { data: null, error: null, isLoading: false },
        flowTracesQuery: { data: { items: [], total: 0, page: 3, pageCount: 3 }, error: null, isLoading: false },
        ...setters,
      })
    );

    render(<AnalysisResult />);

    const [statusFilter, operationFilter, confidenceFilter] = screen.getAllByRole("combobox");
    await user.click(statusFilter);
    await user.click(await screen.findByRole("option", { name: t("analysisV11.flow.partial") }));
    await user.click(operationFilter);
    await user.click(await screen.findByRole("option", { name: t("labels.fieldOperation.write") }));
    await user.click(confidenceFilter);
    await user.click(await screen.findByRole("option", { name: t("labels.confidenceLevel.low") }));

    expect(setters.setFlowTraceStatus).toHaveBeenCalledWith("partial");
    expect(setters.setFlowTraceOperation).toHaveBeenCalledWith("write");
    expect(setters.setFlowTraceConfidence).toHaveBeenCalledWith("low");
    expect(setters.setFlowTracePage).toHaveBeenCalledWith(1);
    expect(setters.setFlowTracePage).toHaveBeenCalledTimes(3);
  });
});
