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
    isReportDownloading,
    projectQuery,
    snapshotQuery,
    symbolsQuery,
    fieldsQuery,
    risksQuery,
    rulesQuery,
    dependenciesQuery,
    fieldDependenciesQuery,
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
                        `Delphi 標準函式庫：${snapshot.dependencySummary.standardLibraryCount}`,
                      ]
                    : []
                }
                emptyText="目前沒有相依摘要。"
              />
            </div>

            <FileTable rows={snapshot?.fieldTables ?? []} />
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
