import type { ReactNode } from "react";
import { useLocation, useRoute } from "wouter";
import { AlertTriangle, ArrowLeft, FileText, Loader2, ShieldAlert } from "lucide-react";
import {
  dependencyKinds,
  dependencyTargetKinds,
  fieldDependencyOperationTypes,
  riskSeverities,
  riskTypes,
  ruleTypes,
  symbolKinds,
} from "@shared/contracts";
import { ImpactAnalysisPanel } from "@/components/ImpactAnalysisPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/locales";
import {
  analysisStatusLabel,
  dependencyKindLabel,
  dependencyTargetKindLabel,
  localizeProjectJobErrorMessage,
  fieldOperationLabel,
  projectJobStatusLabel,
  projectJobTypeLabel,
  projectStatusLabel,
  riskSeverityLabel,
  ruleTypeLabel,
  sourceTypeLabel,
  symbolKindLabel,
} from "@/locales/uiLabels";
import {
  DependencySummary,
  FileTable,
  PaginationControls,
  ProjectSummaryCard,
  ReportActions,
  RiskPanel,
  RulePanel,
  WarningSummaryCard,
} from "./analysisResult/components";
import { useAnalysisResultModel } from "./analysisResult/useAnalysisResultModel";

export function renderDocumentPreview(content: string | null | undefined) {
  if (!content) {
    return t("analysis.empty.noDocument");
  }

  return content.split("\n").slice(0, 12).join("\n");
}

function ImportWarningsCard({
  items,
}: {
  items: Array<{ code: string; message: string; filePath?: string }>;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("analysis.summary.importWarningsTitle")}</CardTitle>
        <CardDescription>{t("analysis.summary.importWarningsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {items.map((warning, index) => (
          <div key={`${warning.code}:${warning.filePath ?? index}`} className="rounded-lg border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{warning.code}</Badge>
              {warning.filePath ? <span className="font-medium text-slate-950">{warning.filePath}</span> : null}
            </div>
            <p className="mt-2 text-slate-700">{warning.message}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AnalysisConfidenceCard({
  confidence,
}: {
  confidence?: {
    score: number;
    level: "high" | "medium" | "low";
    breakdown: Array<{ label: string; impact: number; reason: string }>;
  };
}) {
  if (!confidence) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Analysis Confidence Score</CardTitle>
          <CardDescription>Heuristic analysis confidence for this report.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-slate-600">Confidence unavailable for this analysis result.</CardContent>
      </Card>
    );
  }

  const penalties = confidence.breakdown.filter((item) => item.impact < 0).slice(0, 6);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Analysis Confidence Score</CardTitle>
            <CardDescription>Heuristic analysis confidence for this report.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold text-slate-950">{confidence.score}/100</span>
            <Badge variant={confidence.level === "low" ? "destructive" : confidence.level === "medium" ? "secondary" : "default"}>
              {confidence.level}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {confidence.score < 60 ? (
          <Alert variant="warning">
            <AlertTriangle className="size-4" />
            <AlertTitle>需要人工複核</AlertTitle>
            <AlertDescription>Confidence is below 60, so review the highlighted limitations before relying on this report.</AlertDescription>
          </Alert>
        ) : null}
        {penalties.length === 0 ? (
          <p className="text-slate-600">No major confidence penalties were detected.</p>
        ) : (
          <div className="space-y-2">
            {penalties.map((item) => (
              <div key={`${item.label}:${item.reason}`} className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-slate-950">{item.label}</span>
                  <Badge variant="outline">{item.impact}</Badge>
                </div>
                <p className="mt-1 text-slate-600">{item.reason}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? Number(params.id) : Number.NaN;
  const {
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
    setSelectedRunId,
    compareBaseRunId,
    compareRunId,
    flowTraceSearch,
    setFlowTraceSearch,
    flowTraceStatus,
    setFlowTraceStatus,
    flowTracePage,
    setFlowTracePage,
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
  } = useAnalysisResultModel(projectId);

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>{t("analysis.invalidProjectTitle")}</AlertTitle>
          <AlertDescription>{t("analysis.invalidProjectDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50">
        <Loader2 className="size-10 animate-spin text-slate-600" aria-label="analysis-loading" />
      </div>
    );
  }

  if (projectQuery.error || !project) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>{t("analysis.loadFailedTitle")}</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? t("analysis.loadFailedDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const isPartialWarning =
    report?.status === "completed_with_warnings" ||
    report?.status === "partial" ||
    project.errorMessage === "Analysis completed with warnings." ||
    report?.errorMessage === "Analysis completed with warnings.";
  const partialReasonText =
    snapshot?.partialReasons.length && snapshot.partialReasons.length > 0
      ? snapshot.partialReasons.join("、")
      : "分析已完成，但部分報告因資料量過大或檔案格式限制被截斷。你仍可查看已產生的符號、相依、風險與規則。";

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={() => setLocation("/")}>
              <ArrowLeft className="mr-2 size-4" />
              {t("analysis.backHome")}
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-slate-950">{project.name}</h1>
              <p className="text-sm text-slate-600">{t("analysis.pageDescription")}</p>
            </div>
          </div>
          <ReportActions
            isRefreshing={projectQuery.isFetching || snapshotQuery.isFetching}
            isDownloading={isReportDownloading}
            canDownload={canDownloadReport}
            isRunning={viewState === "running"}
            onRefresh={() => void Promise.all([projectQuery.refetch(), snapshotQuery.refetch()])}
            onDownload={() => void handleDownloadReport()}
          />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>
            {t("analysis.projectStatus")}：{projectStatusLabel(project.status)}
          </Badge>
          <Badge
            variant={
              viewState === "failed"
                ? "destructive"
                : report?.status === "completed" || report?.status === "completed_with_warnings" || report?.status === "partial"
                  ? "default"
                  : "secondary"
            }
          >
            {t("analysis.analysisStatus")}：{analysisStatusLabel(analysisStatus)}
          </Badge>
          <Badge variant="outline">{t("analysis.language")}：{project.language.toUpperCase()}</Badge>
          <Badge variant="outline">{t("analysis.source")}：{sourceTypeLabel(project.sourceType)}</Badge>
          {project.latestJob ? (
            <Badge variant="outline">
              {t("analysis.currentJob")}：{projectJobTypeLabel(project.latestJob.type)} / {projectJobStatusLabel(project.latestJob.status)} / {project.latestJob.progress}%
            </Badge>
          ) : null}
        </div>

        <Alert>
          <AlertTitle>{t("analysis.heuristicTitle")}</AlertTitle>
          <AlertDescription>{t("analysis.heuristicDescription")}</AlertDescription>
        </Alert>

        {showPreviousAnalysisFailureBanner ? (
          <Alert>
            <ShieldAlert className="size-4" />
            <AlertTitle>{t("analysis.previousFailureTitle")}</AlertTitle>
            <AlertDescription>{t("analysis.previousFailureDescription")}</AlertDescription>
          </Alert>
        ) : null}

        {isPartialWarning ? (
          <Alert variant="warning">
            <AlertTriangle className="size-4" />
            <AlertTitle>分析完成但有警告</AlertTitle>
            <AlertDescription>
              分析已完成，但部分報告因資料量過大或檔案格式限制被截斷。你仍可查看已產生的符號、相依、風險與規則。
              <span className="mt-2 block text-slate-700">原因摘要：{partialReasonText}</span>
            </AlertDescription>
          </Alert>
        ) : project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>{t("analysis.projectErrorTitle")}</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {project.latestJob?.status === "failed" && project.latestJob.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>{t("analysis.latestJobErrorTitle")}</AlertTitle>
            <AlertDescription>{localizeProjectJobErrorMessage(project.latestJob.type, project.latestJob.errorMessage)}</AlertDescription>
          </Alert>
        ) : null}

        {(viewState === "queued" || viewState === "running") && project.latestJob ? (
          <Card data-testid="analysis-running">
            <CardHeader>
              <CardTitle>{viewState === "queued" ? t("analysis.queuedTitle") : t("analysis.runningTitle")}</CardTitle>
              <CardDescription>{t("analysis.runningDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-700">
              <p>{t("analysis.jobType")}：{projectJobTypeLabel(project.latestJob.type)}</p>
              <p>{t("analysis.jobStatus")}：{projectJobStatusLabel(project.latestJob.status)}</p>
              <p>{t("analysis.progress")}：{project.latestJob.progress}%</p>
            </CardContent>
          </Card>
        ) : null}

        {!report && viewState === "idle" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("analysis.noReportTitle")}</CardTitle>
              <CardDescription>{t("analysis.noReportDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={() => void handleRunAnalysis()} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                  {t("analysis.startAnalysis")}
                </Button>
              ) : (
                <p className="text-sm text-slate-600">{t("analysis.waitImport")}</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title={t("analysis.metrics.files")} value={metrics?.fileCount ?? snapshot?.totals.files ?? 0} />
          <MetricCard title={t("analysis.metrics.symbols")} value={metrics?.symbolCount ?? snapshot?.totals.symbols ?? 0} />
          <MetricCard title={t("analysis.metrics.risks")} value={metrics?.riskCount ?? snapshot?.totals.risks ?? 0} emphasis={(metrics?.riskCount ?? snapshot?.totals.risks ?? 0) > 0 ? "danger" : "default"} />
          <MetricCard title={t("analysis.metrics.rules")} value={metrics?.ruleCount ?? snapshot?.totals.rules ?? 0} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">{t("analysis.tabs.overview")}</TabsTrigger>
            <TabsTrigger value="history">Analysis History</TabsTrigger>
            <TabsTrigger value="buildDoctor">Build Doctor</TabsTrigger>
            <TabsTrigger value="flow">UI to DB Flow</TabsTrigger>
            <TabsTrigger value="impact">{t("analysis.tabs.impact")}</TabsTrigger>
            <TabsTrigger value="symbols">{t("analysis.tabs.symbols")}</TabsTrigger>
            <TabsTrigger value="fields">{t("analysis.tabs.fields")}</TabsTrigger>
            <TabsTrigger value="dependencies">{t("analysis.tabs.dependencies")}</TabsTrigger>
            <TabsTrigger value="fieldDependencies">{t("analysis.tabs.fieldDependencies")}</TabsTrigger>
            <TabsTrigger value="risks">{t("analysis.tabs.risks")}</TabsTrigger>
            <TabsTrigger value="rules">{t("analysis.tabs.rules")}</TabsTrigger>
            <TabsTrigger value="documents">{t("analysis.tabs.documents")}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <ProjectSummaryCard
              rows={[
                { label: t("analysis.projectStatus"), value: projectStatusLabel(project.status) },
                { label: t("analysis.analysisStatus"), value: analysisStatusLabel(analysisStatus) },
                { label: t("analysis.summary.eligibleFiles"), value: String(metrics?.eligibleFileCount ?? 0) },
                { label: t("analysis.summary.analyzedFiles"), value: String(metrics?.analyzedFileCount ?? 0) },
                { label: t("analysis.summary.skippedFiles"), value: String(metrics?.skippedFileCount ?? 0) },
                { label: t("analysis.summary.fieldDependencies"), value: String(metrics?.fieldDependencyCount ?? snapshot?.totals.fieldDependencies ?? 0) },
              ]}
            />

            <WarningSummaryCard items={snapshot?.warningSummary ?? []} />
            <ImportWarningsCard items={importWarnings} />
            <AnalysisConfidenceCard confidence={metrics?.confidence} />

            <div className="grid gap-4 lg:grid-cols-3">
              <SimpleListCard
                title={t("analysis.summary.topSymbols")}
                items={(snapshot?.topSymbols ?? []).map((item) => `${item.name} (${symbolKindLabel(item.type)})${item.filePath ? ` - ${item.filePath}` : ""}`)}
                emptyText={t("analysis.summary.noSymbols")}
              />
              <SimpleListCard
                title="Top 風險類型"
                items={(snapshot?.topRiskGroups ?? []).slice(0, 10).map((item) => `[${riskSeverityLabel(item.severity)}] ${item.title} (${item.occurrenceCount})`)}
                emptyText={t("analysis.summary.noRisks")}
              />
              <SimpleListCard
                title="Top 規則類型"
                items={(snapshot?.topRuleGroups ?? []).slice(0, 10).map((item) => `${item.title} (${item.occurrenceCount})`)}
                emptyText={t("analysis.summary.noRules")}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <SimpleListCard
                title="最常被影響的檔案"
                items={(snapshot?.topAffectedFiles ?? []).map((item) => `${item.filePath} (${item.totalCount})`)}
                emptyText="目前沒有可顯示的檔案影響排行。"
              />
              <SimpleListCard
                title="相依摘要"
                items={
                  snapshot
                    ? [
                        `內部相依：${snapshot.dependencySummary.internalCount}`,
                        `外部相依：${snapshot.dependencySummary.externalCount}`,
                        `未解析相依：${snapshot.dependencySummary.unresolvedCount}`,
                        `Delphi 標準函式庫：${snapshot.dependencySummary.standardLibraryCount}`,
                      ]
                    : []
                }
                emptyText="目前沒有相依摘要。"
              />
            </div>

            <FileTable rows={snapshot?.fieldTables ?? []} />
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            <PaginationControls
              total={analysisRunsQuery?.data?.total ?? 0}
              page={analysisRunsQuery?.data?.page ?? runPage}
              pageCount={analysisRunsQuery?.data?.pageCount ?? 0}
              onPrev={() => setRunPage((value) => Math.max(1, value - 1))}
              onNext={() => setRunPage((value) => value + 1)}
            />
            <div className="space-y-3">
              {(analysisRunsQuery?.data?.items ?? []).map((run) => (
                <Card key={run.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle>Run {run.runNumber}</CardTitle>
                        <CardDescription>
                          {run.createdAt.toLocaleString()} / {run.sourceFingerprint?.slice(0, 12) ?? "no fingerprint"}
                        </CardDescription>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={run.status === "partial" ? "secondary" : "outline"}>{analysisStatusLabel(run.status)}</Badge>
                        {run.isLatestUsable ? <Badge>latest</Badge> : null}
                        {run.isBaseline ? <Badge variant="secondary">baseline</Badge> : null}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="grid gap-2 md:grid-cols-4">
                      <span>Files: {run.metricsSummary.files}</span>
                      <span>Symbols: {run.metricsSummary.symbols}</span>
                      <span>Risks: {run.riskCount}</span>
                      <span>Confidence: {run.confidence ? `${run.confidence.score}/100 ${run.confidence.level}` : "unknown"}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setSelectedRunId(run.id)}>View run</Button>
                      <Button size="sm" variant="outline" onClick={() => setBaselineMutation?.mutate({ projectId, runId: run.id })}>Set baseline</Button>
                      {run.isBaseline ? (
                        <Button size="sm" variant="outline" onClick={() => clearBaselineMutation?.mutate(projectId)} disabled={clearBaselineMutation?.isPending}>Clear baseline</Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => selectCompareBaseRun(run.id)}>Use as base</Button>
                      <Button size="sm" variant="outline" onClick={() => selectCompareRun(run.id)}>Compare to</Button>
                      <Button size="sm" variant="outline" onClick={() => void handleDownloadHistoricalReport(run.id)} disabled={downloadingRunId === run.id}>
                        {downloadingRunId === run.id ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                        Download report
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {!analysisRunsQuery?.isLoading && (analysisRunsQuery?.data?.items.length ?? 0) === 0 ? (
                <Card><CardContent className="py-8 text-center text-sm text-slate-600">No analysis history is available yet.</CardContent></Card>
              ) : null}
            </div>
            {selectedRunQuery?.data ? (
              <Card>
                <CardHeader>
                  <CardTitle>Run {selectedRunQuery.data.runNumber} Details</CardTitle>
                  <CardDescription>{selectedRunQuery.data.snapshotWarning ?? "Snapshot is available for historical report, Build Doctor, and flow tracing."}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm md:grid-cols-3">
                  <span>Analyzer: {selectedRunQuery.data.analyzerVersion}</span>
                  <span>Warnings: {selectedRunQuery.data.warningCount}</span>
                  <span>Job: {selectedRunQuery.data.jobId ?? "none"}</span>
                </CardContent>
              </Card>
            ) : null}
            {compareBaseRunId && compareRunId ? (
              <Card>
                <CardHeader>
                  <CardTitle>Comparison</CardTitle>
                  <CardDescription>
                    Base run ID {compareBaseRunId} compared with run ID {compareRunId}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {diffQuery?.isLoading ? <p className="text-slate-600">Calculating diff...</p> : null}
                  {diffQuery?.error ? <p className="text-red-600">{diffQuery.error.message}</p> : null}
                  {diffQuery?.data ? (
                    <>
                      <div className="grid gap-2 md:grid-cols-4">
                        <span>Files +{diffQuery.data.files.added.total} / -{diffQuery.data.files.removed.total} / changed {diffQuery.data.files.changed.total}</span>
                        <span>Risks introduced {diffQuery.data.risks.introduced.total}</span>
                        <span>Risks resolved {diffQuery.data.risks.resolved.total}</span>
                        <span>Build score delta {diffQuery.data.buildDoctor.scoreDelta}</span>
                      </div>
                      {diffQuery.data.truncated ? <Alert variant="warning"><AlertTriangle className="size-4" /><AlertTitle>Diff truncated</AlertTitle><AlertDescription>Large diff groups were capped. Totals are still shown.</AlertDescription></Alert> : null}
                    </>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void handleDownloadComparison()} disabled={!canDownloadComparison || isDiffDownloading}>
                      {isDiffDownloading ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Download comparison
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="buildDoctor" className="space-y-4">
            {buildDoctorRunQuery?.isLoading ? <div className="flex justify-center py-10"><Loader2 className="size-6 animate-spin text-slate-600" /></div> : null}
            {buildDoctorRunQuery?.data?.snapshot?.buildDoctor ? (
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle>Delphi Build Doctor</CardTitle>
                      <CardDescription>Static build-readiness audit. No compiler or project command is executed.</CardDescription>
                    </div>
                    <Badge variant={buildDoctorRunQuery.data.snapshot.buildDoctor.status === "blocked" ? "destructive" : "secondary"}>
                      {buildDoctorRunQuery.data.snapshot.buildDoctor.status} / {buildDoctorRunQuery.data.snapshot.buildDoctor.score}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="grid gap-2 md:grid-cols-2">
                    <span>Compiler family: {buildDoctorRunQuery.data.snapshot.buildDoctor.compilerFamily.value ?? "unknown"}</span>
                    <span>Confidence: {buildDoctorRunQuery.data.snapshot.buildDoctor.compilerFamily.confidence}</span>
                    <span>Defines: {buildDoctorRunQuery.data.snapshot.buildDoctor.defines.join(", ") || "none"}</span>
                    <span>Platforms: {buildDoctorRunQuery.data.snapshot.buildDoctor.platforms.join(", ") || "none"}</span>
                  </div>
                  <div className="space-y-2">
                    {buildDoctorRunQuery.data.snapshot.buildDoctor.findings.slice(0, 50).map((finding) => (
                      <div key={`${finding.code}:${finding.title}:${finding.evidence ?? ""}`} className="rounded-lg border px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={finding.severity === "blocker" ? "destructive" : "outline"}>{finding.severity}</Badge>
                          <span className="font-medium text-slate-950">{finding.title}</span>
                          <span className="text-slate-500">{finding.confidence}</span>
                        </div>
                        <p className="mt-1 text-slate-700">{finding.description}</p>
                        <p className="mt-1 text-slate-600">{finding.recommendation}</p>
                        {finding.evidence ? <p className="mt-1 text-slate-500">Evidence: {finding.evidence}</p> : null}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card><CardContent className="py-8 text-center text-sm text-slate-600">Build Doctor data is not available for this run.</CardContent></Card>
            )}
          </TabsContent>

          <TabsContent value="flow" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
              <MetricCard title="Traces" value={flowTraceSummaryQuery?.data?.total ?? 0} />
              <MetricCard title="Complete" value={flowTraceSummaryQuery?.data?.complete ?? 0} />
              <MetricCard title="Partial" value={flowTraceSummaryQuery?.data?.partial ?? 0} />
              <MetricCard title="Tables" value={flowTraceSummaryQuery?.data?.affectedTables ?? 0} />
            </div>
            <FilterCard title="Flow trace filters" description="Filter static UI event and data-binding paths.">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={flowTraceSearch} onChange={(event) => { setFlowTraceSearch(event.target.value); setFlowTracePage(1); }} placeholder="Search form, component, SQL, table, or field" />
                <Select value={flowTraceStatus} onValueChange={(value) => { setFlowTraceStatus(value); setFlowTracePage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="complete">Complete</SelectItem>
                    <SelectItem value="partial">Partial</SelectItem>
                    <SelectItem value="unresolved">Unresolved</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={flowTracesQuery?.data?.total ?? 0} page={flowTracesQuery?.data?.page ?? flowTracePage} pageCount={flowTracesQuery?.data?.pageCount ?? 0} onPrev={() => setFlowTracePage((value) => Math.max(1, value - 1))} onNext={() => setFlowTracePage((value) => value + 1)} />
            <div className="space-y-3">
              {(flowTracesQuery?.data?.items ?? []).map((trace) => (
                <Card key={trace.stableKey}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <CardTitle>{trace.componentClass}.{trace.componentName}</CardTitle>
                        <CardDescription>{trace.formName}{trace.eventName ? ` / ${trace.eventName}` : ""} / {trace.resolvedHandler ?? trace.handlerName ?? "data binding"}</CardDescription>
                      </div>
                      <div className="flex gap-2">
                        <Badge variant={trace.status === "unresolved" ? "destructive" : "outline"}>{trace.status}</Badge>
                        <Badge variant="secondary">{trace.confidence}</Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {trace.warnings.length > 0 ? <Alert variant="warning"><AlertTriangle className="size-4" /><AlertTitle>Trace warnings</AlertTitle><AlertDescription>{trace.warnings.join(" ")}</AlertDescription></Alert> : null}
                    <div className="space-y-2">
                      {trace.steps.slice(0, 30).map((step) => (
                        <div key={step.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                          <Badge variant="outline">{step.type}</Badge>
                          <span className="font-medium text-slate-950">{step.label}</span>
                          {step.operation ? <Badge variant="secondary">{step.operation}</Badge> : null}
                          {step.filePath ? <span className="text-slate-500">{step.filePath}{step.lineNumber ? `:${step.lineNumber}` : ""}</span> : null}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {!flowTracesQuery?.isLoading && (flowTracesQuery?.data?.items.length ?? 0) === 0 ? (
                <Card><CardContent className="py-8 text-center text-sm text-slate-600">No flow traces match the current filters.</CardContent></Card>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="impact">
            <ImpactAnalysisPanel projectId={projectId} />
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <FilterCard title={t("analysis.filters.symbolsTitle")} description={t("analysis.filters.symbolsDescription")}>
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={symbolSearch} onChange={(event) => { setSymbolSearch(event.target.value); setSymbolPage(1); }} placeholder={t("analysis.filters.symbolSearch")} />
                <Select value={symbolKind} onValueChange={(value) => { setSymbolKind(value); setSymbolPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.kindPlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allKinds")}</SelectItem>
                    {symbolKinds.map((value) => <SelectItem key={value} value={value}>{symbolKindLabel(value)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={symbolsQuery.data?.total ?? 0} page={symbolsQuery.data?.page ?? symbolPage} pageCount={symbolsQuery.data?.pageCount ?? 0} onPrev={() => setSymbolPage((value) => Math.max(1, value - 1))} onNext={() => setSymbolPage((value) => value + 1)} />
            <ListCard
              loading={symbolsQuery.isLoading}
              items={(symbolsQuery.data?.items ?? []).map((symbol) => (
                <div key={symbol.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{symbol.name}</span>
                    <Badge variant="outline">{symbolKindLabel(symbol.type)}</Badge>
                  </div>
                  <p className="text-slate-600">{symbol.filePath ?? t("analysis.empty.unknownFile")}</p>
                  <p className="text-slate-500">{t("analysis.list.lineRange", { start: symbol.startLine, end: symbol.endLine })}</p>
                </div>
              ))}
              emptyText={t("analysis.empty.noSymbols")}
            />
          </TabsContent>

          <TabsContent value="fields" className="space-y-4">
            <FilterCard title={t("analysis.filters.fieldsTitle")} description={t("analysis.filters.fieldsDescription")}>
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={fieldSearch} onChange={(event) => { setFieldSearch(event.target.value); setFieldPage(1); }} placeholder={t("analysis.filters.fieldSearch")} />
                <Select value={fieldTable} onValueChange={(value) => { setFieldTable(value); setFieldPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.tablePlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allTables")}</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => <SelectItem key={table.tableName} value={table.tableName}>{table.tableName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={fieldsQuery.data?.total ?? 0} page={fieldsQuery.data?.page ?? fieldPage} pageCount={fieldsQuery.data?.pageCount ?? 0} onPrev={() => setFieldPage((value) => Math.max(1, value - 1))} onNext={() => setFieldPage((value) => value + 1)} />
            <ListCard
              loading={fieldsQuery.isLoading}
              items={(fieldsQuery.data?.items ?? []).map((field) => (
                <div key={field.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{field.tableName}.{field.fieldName}</span>
                    <Badge variant="outline">{field.fieldType ?? t("common.unknown")}</Badge>
                  </div>
                  <p className="text-slate-500">
                    {t("analysis.list.fieldStats", { references: field.referenceCount, reads: field.readCount, writes: field.writeCount })}
                  </p>
                </div>
              ))}
              emptyText={t("analysis.empty.noFields")}
            />
          </TabsContent>

          <TabsContent value="dependencies" className="space-y-4">
            <FilterCard title={t("analysis.filters.dependenciesTitle")} description={t("analysis.filters.dependenciesDescription")}>
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={dependencySearch} onChange={(event) => { setDependencySearch(event.target.value); setDependencyPage(1); }} placeholder={t("analysis.filters.dependencySearch")} />
                <Select value={dependencyType} onValueChange={(value) => { setDependencyType(value); setDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.dependencyTypePlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allDependencyTypes")}</SelectItem>
                    {dependencyKinds.map((value) => <SelectItem key={value} value={value}>{dependencyKindLabel(value)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={dependencyTargetKind} onValueChange={(value) => { setDependencyTargetKind(value); setDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.targetKindPlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allTargetKinds")}</SelectItem>
                    {dependencyTargetKinds.map((value) => <SelectItem key={value} value={value}>{dependencyTargetKindLabel(value)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Checkbox
                  id="hide-standard-library"
                  checked={hideStandardLibraryDependencies}
                  onCheckedChange={(checked) => {
                    setHideStandardLibraryDependencies(Boolean(checked));
                    setDependencyPage(1);
                  }}
                />
                <Label htmlFor="hide-standard-library">隱藏標準函式庫</Label>
              </div>
            </FilterCard>
            <DependencySummary
              hiddenCount={dependenciesQuery.data?.summary.hiddenByDefaultCount ?? snapshot?.dependencySummary.hiddenByDefaultCount ?? 0}
              internalCount={dependenciesQuery.data?.summary.internalCount ?? snapshot?.dependencySummary.internalCount ?? 0}
              standardLibraryCount={dependenciesQuery.data?.summary.standardLibraryCount ?? snapshot?.dependencySummary.standardLibraryCount ?? 0}
            />
            <PaginationControls total={dependenciesQuery.data?.total ?? 0} page={dependenciesQuery.data?.page ?? dependencyPage} pageCount={dependenciesQuery.data?.pageCount ?? 0} onPrev={() => setDependencyPage((value) => Math.max(1, value - 1))} onNext={() => setDependencyPage((value) => value + 1)} />
            <ListCard
              loading={dependenciesQuery.isLoading}
              items={(dependenciesQuery.data?.items ?? []).map((dependency) => (
                <div key={dependency.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{dependency.sourceSymbolName}</span>
                    <Badge variant="outline">{dependencyKindLabel(dependency.dependencyType)}</Badge>
                  </div>
                  <p className="text-slate-600">
                    {t("analysis.list.target", { target: dependency.targetSymbolName ?? dependency.targetExternalName ?? t("common.unknown") })}
                  </p>
                  <p className="text-slate-500">
                    {dependencyTargetKindLabel(dependency.targetKind)}
                    {dependency.lineNumber ? ` / ${t("analysis.list.lineNumber", { line: dependency.lineNumber })}` : ""}
                  </p>
                </div>
              ))}
              emptyText={t("analysis.empty.noDependencies")}
            />
          </TabsContent>

          <TabsContent value="fieldDependencies" className="space-y-4">
            <FilterCard title={t("analysis.filters.fieldDependenciesTitle")} description={t("analysis.filters.fieldDependenciesDescription")}>
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={fieldDependencySearch} onChange={(event) => { setFieldDependencySearch(event.target.value); setFieldDependencyPage(1); }} placeholder={t("analysis.filters.fieldDependencySearch")} />
                <Select value={fieldDependencyTable} onValueChange={(value) => { setFieldDependencyTable(value); setFieldDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.tablePlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allTables")}</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => <SelectItem key={table.tableName} value={table.tableName}>{table.tableName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={fieldDependencyOperationType} onValueChange={(value) => { setFieldDependencyOperationType(value); setFieldDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.operationTypePlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allOperations")}</SelectItem>
                    {fieldDependencyOperationTypes.map((value) => <SelectItem key={value} value={value}>{fieldOperationLabel(value)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={fieldDependenciesQuery.data?.total ?? 0} page={fieldDependenciesQuery.data?.page ?? fieldDependencyPage} pageCount={fieldDependenciesQuery.data?.pageCount ?? 0} onPrev={() => setFieldDependencyPage((value) => Math.max(1, value - 1))} onNext={() => setFieldDependencyPage((value) => value + 1)} />
            <ListCard
              loading={fieldDependenciesQuery.isLoading}
              items={(fieldDependenciesQuery.data?.items ?? []).map((item) => (
                <div key={item.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{item.tableName}.{item.fieldName}</span>
                    <Badge variant="outline">{fieldOperationLabel(item.operationType)}</Badge>
                  </div>
                  <p className="text-slate-600">{item.symbolName}</p>
                  <p className="text-slate-500">
                    {item.context ?? t("analysis.empty.noContext")}
                    {item.lineNumber ? ` / ${t("analysis.list.lineNumber", { line: item.lineNumber })}` : ""}
                  </p>
                </div>
              ))}
              emptyText={t("analysis.empty.noFieldDependencies")}
            />
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            <FilterCard title={t("analysis.filters.risksTitle")} description={t("analysis.filters.risksDescription")}>
              <div className="grid gap-3 md:grid-cols-2">
                <Input value={riskSearch} onChange={(event) => { setRiskSearch(event.target.value); setRiskPage(1); }} placeholder={t("analysis.filters.riskSearch")} />
                <Select value={riskSeverity} onValueChange={(value) => { setRiskSeverity(value); setRiskPage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.severityPlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allSeverities")}</SelectItem>
                    {riskSeverities.map((severity) => <SelectItem key={severity} value={severity}>{riskSeverityLabel(severity)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <Select value={riskType} onValueChange={(value) => { setRiskType(value); setRiskPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="風險類型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部風險類型</SelectItem>
                    {riskTypes.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input value={riskFile} onChange={(event) => { setRiskFile(event.target.value); setRiskPage(1); }} placeholder="依檔案篩選" />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="risk-critical-only"
                    checked={riskCriticalOnly}
                    onCheckedChange={(checked) => {
                      setRiskCriticalOnly(Boolean(checked));
                      setRiskPage(1);
                    }}
                  />
                  <Label htmlFor="risk-critical-only">只看 critical</Label>
                </div>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="hide-duplicate-risks"
                    checked={hideDuplicateRisks}
                    onCheckedChange={(checked) => {
                      setHideDuplicateRisks(Boolean(checked));
                      setRiskPage(1);
                    }}
                  />
                  <Label htmlFor="hide-duplicate-risks">隱藏重複項</Label>
                </div>
              </div>
            </FilterCard>
            <PaginationControls total={risksQuery.data?.total ?? 0} page={risksQuery.data?.page ?? riskPage} pageCount={risksQuery.data?.pageCount ?? 0} onPrev={() => setRiskPage((value) => Math.max(1, value - 1))} onNext={() => setRiskPage((value) => value + 1)} />
            <RiskPanel loading={risksQuery.isLoading} items={risksQuery.data?.items ?? []} />
          </TabsContent>

          <TabsContent value="rules" className="space-y-4">
            <FilterCard title={t("analysis.filters.rulesTitle")} description={t("analysis.filters.rulesDescription")}>
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={ruleSearch} onChange={(event) => { setRuleSearch(event.target.value); setRulePage(1); }} placeholder={t("analysis.filters.ruleSearch")} />
                <Select value={ruleType} onValueChange={(value) => { setRuleType(value); setRulePage(1); }}>
                  <SelectTrigger><SelectValue placeholder={t("analysis.filters.ruleTypePlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("analysis.filters.allRuleTypes")}</SelectItem>
                    {ruleTypes.map((value) => <SelectItem key={value} value={value}>{ruleTypeLabel(value)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={ruleFile} onChange={(event) => { setRuleFile(event.target.value); setRulePage(1); }} placeholder="依檔案篩選" />
                <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
                  <Checkbox
                    id="hide-duplicate-rules"
                    checked={hideDuplicateRules}
                    onCheckedChange={(checked) => {
                      setHideDuplicateRules(Boolean(checked));
                      setRulePage(1);
                    }}
                  />
                  <Label htmlFor="hide-duplicate-rules">隱藏重複項</Label>
                </div>
              </div>
            </FilterCard>
            <PaginationControls total={rulesQuery.data?.total ?? 0} page={rulesQuery.data?.page ?? rulePage} pageCount={rulesQuery.data?.pageCount ?? 0} onPrev={() => setRulePage((value) => Math.max(1, value - 1))} onNext={() => setRulePage((value) => value + 1)} />
            <RulePanel loading={rulesQuery.isLoading} items={rulesQuery.data?.items ?? []} />
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description={t("analysis.documents.flow")} content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description={t("analysis.documents.dataDependency")} content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
            <DocumentCard title="RISKS.md" description={t("analysis.documents.risks")} content={renderDocumentPreview(report?.risksMarkdown)} />
            <DocumentCard title="RULES.yaml" description={t("analysis.documents.rules")} content={renderDocumentPreview(report?.rulesYaml)} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function MetricCard({
  title,
  value,
  emphasis = "default",
}: {
  title: string;
  value: number;
  emphasis?: "default" | "danger";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-semibold ${emphasis === "danger" ? "text-red-600" : "text-slate-950"}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function FilterCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ListCard({ loading, items, emptyText }: { loading: boolean; items: ReactNode[]; emptyText: string }) {
  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-6 animate-spin text-slate-600" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-slate-600">{emptyText}</CardContent>
      </Card>
    );
  }

  return <div className="space-y-3">{items}</div>;
}

function SimpleListCard({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {items.length ? items.map((item) => <div key={item} className="rounded-lg border px-3 py-2">{item}</div>) : <p className="text-slate-500">{emptyText}</p>}
      </CardContent>
    </Card>
  );
}

function DocumentCard({ title, description, content }: { title: string; description: string; content: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="size-4" />
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100">{content}</pre>
      </CardContent>
    </Card>
  );
}
