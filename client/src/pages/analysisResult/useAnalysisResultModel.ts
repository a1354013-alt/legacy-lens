import { useState } from "react";
import {
  dependencyKinds,
  dependencyTargetKinds,
  fieldDependencyOperationTypes,
  riskSeverities,
  riskTypes,
  ruleTypes,
  symbolKinds,
} from "@shared/contracts";
import { getReportDownloadErrorMessage, readHttpApiError } from "@/lib/httpApiErrors";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  RESULT_LIST_PAGE_SIZE,
  canDownloadAnalysisReport,
  getAnalysisViewState,
  resolveAnalysisStatus,
  shouldShowPreviousAnalysisFailureBanner,
  shouldPollProjectStatus,
  shouldPollSnapshot,
} from "../analysisResultModel";
import { analysisResultCopy } from "./copy";

async function downloadBlobFromResponse(response: Response, fallbackFileName: string) {
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? fallbackFileName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function downloadReportZip(projectId: number, runId?: number) {
  const query = typeof runId === "number" ? `?runId=${runId}` : "";
  const response = await fetch(`/api/projects/${projectId}/report.zip${query}`, {
    credentials: "include",
  });

  if (!response.ok) {
    const payload = await readHttpApiError(response);
    throw new Error(getReportDownloadErrorMessage(response.status, payload));
  }

  await downloadBlobFromResponse(response, `legacy-lens-report-${projectId}${typeof runId === "number" ? `-run-${runId}` : ""}.zip`);
}

async function downloadAnalysisDiffZip(projectId: number, baseRunId: number, compareRunId: number) {
  const response = await fetch(`/api/projects/${projectId}/analysis-diff.zip?baseRunId=${baseRunId}&compareRunId=${compareRunId}`, {
    credentials: "include",
  });

  if (!response.ok) {
    const payload = await readHttpApiError(response);
    throw new Error(getReportDownloadErrorMessage(response.status, payload));
  }

  await downloadBlobFromResponse(response, `legacy-lens-analysis-diff-${projectId}-${baseRunId}-vs-${compareRunId}.zip`);
}

export function useAnalysisResultModel(projectId: number) {
  const [activeTab, setActiveTab] = useState("overview");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [symbolKind, setSymbolKind] = useState<string>("all");
  const [symbolPage, setSymbolPage] = useState(1);
  const [fieldSearch, setFieldSearch] = useState("");
  const [fieldTable, setFieldTable] = useState<string>("all");
  const [fieldPage, setFieldPage] = useState(1);
  const [riskSearch, setRiskSearch] = useState("");
  const [riskSeverity, setRiskSeverity] = useState<string>("all");
  const [riskType, setRiskType] = useState<string>("all");
  const [riskFile, setRiskFile] = useState("");
  const [riskCriticalOnly, setRiskCriticalOnly] = useState(false);
  const [hideDuplicateRisks, setHideDuplicateRisks] = useState(true);
  const [riskPage, setRiskPage] = useState(1);
  const [ruleSearch, setRuleSearch] = useState("");
  const [ruleType, setRuleType] = useState<string>("all");
  const [ruleFile, setRuleFile] = useState("");
  const [hideDuplicateRules, setHideDuplicateRules] = useState(true);
  const [rulePage, setRulePage] = useState(1);
  const [dependencySearch, setDependencySearch] = useState("");
  const [dependencyType, setDependencyType] = useState<string>("all");
  const [dependencyTargetKind, setDependencyTargetKind] = useState<string>("all");
  const [hideStandardLibraryDependencies, setHideStandardLibraryDependencies] = useState(true);
  const [dependencyPage, setDependencyPage] = useState(1);
  const [fieldDependencySearch, setFieldDependencySearch] = useState("");
  const [fieldDependencyTable, setFieldDependencyTable] = useState<string>("all");
  const [fieldDependencyOperationType, setFieldDependencyOperationType] = useState<string>("all");
  const [fieldDependencyPage, setFieldDependencyPage] = useState(1);
  const [runPage, setRunPage] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [inspectedRunId, setInspectedRunId] = useState<number | null>(null);
  const [compareBaseRunId, setCompareBaseRunId] = useState<number | null>(null);
  const [compareRunId, setCompareRunId] = useState<number | null>(null);
  const [flowTraceSearch, setFlowTraceSearch] = useState("");
  const [flowTraceForm, setFlowTraceForm] = useState("");
  const [flowTraceComponent, setFlowTraceComponent] = useState("");
  const [flowTraceEvent, setFlowTraceEvent] = useState("");
  const [flowTraceStatus, setFlowTraceStatus] = useState<string>("all");
  const [flowTraceTable, setFlowTraceTable] = useState("");
  const [flowTraceOperation, setFlowTraceOperation] = useState<string>("all");
  const [flowTraceConfidence, setFlowTraceConfidence] = useState<string>("all");
  const [flowTracePage, setFlowTracePage] = useState(1);
  const [isReportDownloading, setIsReportDownloading] = useState(false);
  const [downloadingRunId, setDownloadingRunId] = useState<number | null>(null);
  const [isDiffDownloading, setIsDiffDownloading] = useState(false);

  const utils = trpc.useUtils();

  const projectQuery = trpc.projects.getById.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return shouldPollProjectStatus(data?.status, data?.analysisStatus, data?.latestJob) ? 2000 : false;
    },
    refetchOnWindowFocus: false,
  });

  const snapshotQuery = trpc.analysis.getSnapshot.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchInterval: (query) =>
      shouldPollSnapshot(projectQuery.data?.status, query.state.data?.report?.status ?? projectQuery.data?.analysisStatus, projectQuery.data?.latestJob)
        ? 2000
        : false,
    refetchOnWindowFocus: false,
  });

  const symbolsQuery = trpc.analysis.getSymbolsPage.useQuery(
    {
      projectId,
      page: symbolPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: symbolSearch || undefined,
      kind: symbolKind === "all" ? undefined : (symbolKind as (typeof symbolKinds)[number]),
    },
    { enabled: Number.isFinite(projectId) && activeTab === "symbols" }
  );

  const fieldsQuery = trpc.analysis.getFieldsPage.useQuery(
    {
      projectId,
      page: fieldPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: fieldSearch || undefined,
      tableName: fieldTable === "all" ? undefined : fieldTable,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "fields" }
  );

  const risksQuery = trpc.analysis.getRisksPage.useQuery(
    {
      projectId,
      page: riskPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: riskSearch || undefined,
      severity: riskSeverity === "all" ? undefined : (riskSeverity as (typeof riskSeverities)[number]),
      riskType: riskType === "all" ? undefined : (riskType as (typeof riskTypes)[number]),
      filePath: riskFile || undefined,
      criticalOnly: riskCriticalOnly,
      hideDuplicates: hideDuplicateRisks,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "risks" }
  );

  const rulesQuery = trpc.analysis.getRulesPage.useQuery(
    {
      projectId,
      page: rulePage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: ruleSearch || undefined,
      ruleType: ruleType === "all" ? undefined : (ruleType as (typeof ruleTypes)[number]),
      filePath: ruleFile || undefined,
      hideDuplicates: hideDuplicateRules,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "rules" }
  );

  const dependenciesQuery = trpc.analysis.getDependenciesPage.useQuery(
    {
      projectId,
      page: dependencyPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: dependencySearch || undefined,
      dependencyType: dependencyType === "all" ? undefined : (dependencyType as (typeof dependencyKinds)[number]),
      targetKind: dependencyTargetKind === "all" ? undefined : (dependencyTargetKind as (typeof dependencyTargetKinds)[number]),
      hideStandardLibrary: hideStandardLibraryDependencies,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "dependencies" }
  );

  const fieldDependenciesQuery = trpc.analysis.getFieldDependenciesPage.useQuery(
    {
      projectId,
      page: fieldDependencyPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: fieldDependencySearch || undefined,
      tableName: fieldDependencyTable === "all" ? undefined : fieldDependencyTable,
      operationType:
        fieldDependencyOperationType === "all"
          ? undefined
          : (fieldDependencyOperationType as (typeof fieldDependencyOperationTypes)[number]),
    },
    { enabled: Number.isFinite(projectId) && activeTab === "fieldDependencies" }
  );

  const analysisRunsQuery = trpc.analysis.listRuns.useQuery(
    {
      projectId,
      page: runPage,
      pageSize: 10,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "history" }
  );

  const selectedRunQuery = trpc.analysis.getRun.useQuery(
    {
      projectId,
      runId: selectedRunId ?? 0,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "history" && Boolean(selectedRunId) }
  );

  const diffQuery = trpc.analysis.getDiff.useQuery(
    {
      projectId,
      baseRunId: compareBaseRunId ?? 0,
      compareRunId: compareRunId ?? 0,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "history" && Boolean(compareBaseRunId && compareRunId && compareBaseRunId !== compareRunId) }
  );

  const currentReportId = snapshotQuery.data?.report?.id;
  const inspectedHistoricalRunId = inspectedRunId && inspectedRunId !== currentReportId ? inspectedRunId : undefined;
  const isInspectingHistoricalRun = Boolean(inspectedHistoricalRunId);
  const inspectRun = (runId: number) => {
    setInspectedRunId(runId === currentReportId ? null : runId);
  };
  const returnToCurrentSource = () => {
    setInspectedRunId(null);
    setFlowTracePage(1);
  };
  const buildDoctorRunQuery = trpc.analysis.getRun.useQuery(
    {
      projectId,
      runId: inspectedHistoricalRunId ?? currentReportId ?? 0,
    },
    { enabled: Number.isFinite(projectId) && activeTab === "buildDoctor" && Boolean(inspectedHistoricalRunId ?? currentReportId) }
  );

  const flowTraceSummaryQuery = trpc.analysis.getFlowTraceSummary.useQuery(
    { projectId, runId: inspectedHistoricalRunId },
    { enabled: Number.isFinite(projectId) && activeTab === "flow" }
  );

  const flowTracesQuery = trpc.analysis.getFlowTracesPage.useQuery(
    {
      projectId,
      runId: inspectedHistoricalRunId,
      page: flowTracePage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: flowTraceSearch || undefined,
      form: flowTraceForm || undefined,
      component: flowTraceComponent || undefined,
      event: flowTraceEvent || undefined,
      status: flowTraceStatus === "all" ? undefined : (flowTraceStatus as "complete" | "partial" | "unresolved"),
      table: flowTraceTable || undefined,
      operation: flowTraceOperation === "all" ? undefined : (flowTraceOperation as "read" | "write" | "calculate" | "unknown"),
      confidence: flowTraceConfidence === "all" ? undefined : (flowTraceConfidence as "high" | "medium" | "low"),
    },
    { enabled: Number.isFinite(projectId) && activeTab === "flow" }
  );

  const setBaselineMutation = trpc.analysis.setBaseline.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.analysis.listRuns.invalidate({ projectId }),
        selectedRunId ? utils.analysis.getRun.invalidate({ projectId, runId: selectedRunId }) : Promise.resolve(),
      ]);
    toast.success("Baseline updated.");
    },
    onError: (error) => {
      toast.error(error.message || "Set baseline failed.");
    },
  });

  const clearBaselineMutation = trpc.analysis.clearBaseline.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.analysis.listRuns.invalidate({ projectId }),
        selectedRunId ? utils.analysis.getRun.invalidate({ projectId, runId: selectedRunId }) : Promise.resolve(),
        compareBaseRunId && compareRunId && compareBaseRunId !== compareRunId
          ? utils.analysis.getDiff.invalidate({ projectId, baseRunId: compareBaseRunId, compareRunId })
          : Promise.resolve(),
      ]);
    toast.success("Baseline cleared.");
    },
    onError: (error) => {
      toast.error(error.message || "Clear baseline failed.");
    },
  });

  const triggerAnalysisMutation = trpc.analysis.trigger.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.projects.getById.invalidate(projectId), utils.analysis.getSnapshot.invalidate(projectId)]);
      toast.success(analysisResultCopy.toasts.analysisQueued);
    },
  });

  const isLoading = projectQuery.isLoading || snapshotQuery.isLoading;
  const project = projectQuery.data;
  const snapshot = snapshotQuery.data;
  const report = snapshot?.report;
  const metrics = report?.summaryJson;
  const analysisStatus = resolveAnalysisStatus(report?.status, project?.analysisStatus);
  const viewState = getAnalysisViewState(project?.status, analysisStatus, project?.latestJob, Boolean(report));
  const showPreviousAnalysisFailureBanner = shouldShowPreviousAnalysisFailureBanner(
    project?.status,
    report?.status,
    project?.latestJob,
    Boolean(report)
  );
  const importWarnings = snapshot?.importWarnings ?? project?.importWarningsJson ?? [];
  const canRunAnalysis = project ? ["ready", "failed", "completed"].includes(project.status) : false;
  const canDownloadReport = canDownloadAnalysisReport(snapshot);

  const handleRunAnalysis = async () => {
    if (!project) {
      return;
    }

    try {
      await triggerAnalysisMutation.mutateAsync(project.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : analysisResultCopy.toasts.analysisQueueFailed);
    }
  };

  const handleDownloadReport = async () => {
    setIsReportDownloading(true);
    try {
      await downloadReportZip(projectId);
      toast.success(analysisResultCopy.toasts.reportDownloadSucceeded);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : analysisResultCopy.toasts.reportDownloadFailed);
    } finally {
      setIsReportDownloading(false);
    }
  };

  const handleDownloadHistoricalReport = async (runId: number) => {
    setDownloadingRunId(runId);
    try {
      await downloadReportZip(projectId, runId);
    toast.success("Historical report downloaded.");
    } catch (error) {
    toast.error(error instanceof Error ? error.message : "Historical report download failed.");
    } finally {
      setDownloadingRunId(null);
    }
  };

  const handleDownloadComparison = async () => {
    if (!compareBaseRunId || !compareRunId || compareBaseRunId === compareRunId) {
      return;
    }
    setIsDiffDownloading(true);
    try {
      await downloadAnalysisDiffZip(projectId, compareBaseRunId, compareRunId);
    toast.success("Comparison downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Comparison download failed.");
    } finally {
      setIsDiffDownloading(false);
    }
  };

  const selectCompareBaseRun = (runId: number) => {
    setCompareBaseRunId(runId);
    if (compareRunId === runId) {
      setCompareRunId(null);
    }
  };

  const selectCompareRun = (runId: number) => {
    setCompareRunId(runId);
    if (compareBaseRunId === runId) {
      setCompareBaseRunId(null);
    }
  };

  const canDownloadComparison = Boolean(compareBaseRunId && compareRunId && compareBaseRunId !== compareRunId && !diffQuery.isLoading && !diffQuery.error);

  const resetFlowTraceFilters = () => {
    setFlowTraceSearch("");
    setFlowTraceForm("");
    setFlowTraceComponent("");
    setFlowTraceEvent("");
    setFlowTraceStatus("all");
    setFlowTraceTable("");
    setFlowTraceOperation("all");
    setFlowTraceConfidence("all");
    setFlowTracePage(1);
  };

  return {
    activeTab,
    setActiveTab,
    symbolSearch,
    setSymbolSearch,
    symbolKind,
    setSymbolKind,
    symbolPage,
    setSymbolPage,
    fieldSearch,
    setFieldSearch,
    fieldTable,
    setFieldTable,
    fieldPage,
    setFieldPage,
    riskSearch,
    setRiskSearch,
    riskSeverity,
    setRiskSeverity,
    riskType,
    setRiskType,
    riskFile,
    setRiskFile,
    riskCriticalOnly,
    setRiskCriticalOnly,
    hideDuplicateRisks,
    setHideDuplicateRisks,
    riskPage,
    setRiskPage,
    ruleSearch,
    setRuleSearch,
    ruleType,
    setRuleType,
    ruleFile,
    setRuleFile,
    hideDuplicateRules,
    setHideDuplicateRules,
    rulePage,
    setRulePage,
    dependencySearch,
    setDependencySearch,
    dependencyType,
    setDependencyType,
    dependencyTargetKind,
    setDependencyTargetKind,
    hideStandardLibraryDependencies,
    setHideStandardLibraryDependencies,
    dependencyPage,
    setDependencyPage,
    fieldDependencySearch,
    setFieldDependencySearch,
    fieldDependencyTable,
    setFieldDependencyTable,
    fieldDependencyOperationType,
    setFieldDependencyOperationType,
    fieldDependencyPage,
    setFieldDependencyPage,
    runPage,
    setRunPage,
    selectedRunId,
    setSelectedRunId,
    inspectedRunId,
    inspectRun,
    returnToCurrentSource,
    isInspectingHistoricalRun,
    compareBaseRunId,
    setCompareBaseRunId,
    compareRunId,
    setCompareRunId,
    flowTraceSearch,
    setFlowTraceSearch,
    flowTraceForm,
    setFlowTraceForm,
    flowTraceComponent,
    setFlowTraceComponent,
    flowTraceEvent,
    setFlowTraceEvent,
    flowTraceStatus,
    setFlowTraceStatus,
    flowTraceTable,
    setFlowTraceTable,
    flowTraceOperation,
    setFlowTraceOperation,
    flowTraceConfidence,
    setFlowTraceConfidence,
    flowTracePage,
    setFlowTracePage,
    resetFlowTraceFilters,
    isReportDownloading,
    downloadingRunId,
    isDiffDownloading,
    projectQuery,
    snapshotQuery,
    symbolsQuery,
    fieldsQuery,
    risksQuery,
    rulesQuery,
    dependenciesQuery,
    fieldDependenciesQuery,
    analysisRunsQuery,
    selectedRunQuery,
    diffQuery,
    buildDoctorRunQuery,
    flowTraceSummaryQuery,
    flowTracesQuery,
    setBaselineMutation,
    clearBaselineMutation,
    triggerAnalysisMutation,
    isLoading,
    project,
    snapshot,
    report,
    metrics,
    analysisStatus,
    viewState,
    showPreviousAnalysisFailureBanner,
    importWarnings,
    canRunAnalysis,
    canDownloadReport,
    handleRunAnalysis,
    handleDownloadReport,
    handleDownloadHistoricalReport,
    handleDownloadComparison,
    selectCompareBaseRun,
    selectCompareRun,
    canDownloadComparison,
  };
}
