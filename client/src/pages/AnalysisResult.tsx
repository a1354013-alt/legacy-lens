import type { ReactNode } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, FileText, Loader2, ShieldAlert } from "lucide-react";
import {
  dependencyKinds,
  dependencyTargetKinds,
  fieldDependencyOperationTypes,
  riskSeverities,
  ruleTypes,
  symbolKinds,
} from "@shared/contracts";
import { ImpactAnalysisPanel } from "@/components/ImpactAnalysisPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/locales";
import { analysisStatusLabel, projectJobStatusLabel, projectJobTypeLabel, projectStatusLabel } from "@/locales/uiLabels";
import { FileTable, PaginationControls, ProjectSummaryCard, ReportActions, RiskPanel } from "./analysisResult/components";
import { useAnalysisResultModel } from "./analysisResult/useAnalysisResultModel";

export function renderDocumentPreview(content: string | null | undefined) {
  if (!content) {
    return t("analysis.empty.noDocument");
  }

  return content.split("\n").slice(0, 12).join("\n");
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
    riskPage,
    setRiskPage,
    ruleSearch,
    setRuleSearch,
    ruleType,
    setRuleType,
    rulePage,
    setRulePage,
    dependencySearch,
    setDependencySearch,
    dependencyType,
    setDependencyType,
    dependencyTargetKind,
    setDependencyTargetKind,
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
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>{t("analysis.invalidProjectTitle")}</AlertTitle>
          <AlertDescription>{t("analysis.invalidProjectDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="size-10 animate-spin text-slate-600" aria-label="analysis-loading" />
      </div>
    );
  }

  if (projectQuery.error || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>{t("analysis.loadFailedTitle")}</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? t("analysis.loadFailedDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
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
          <Badge variant={viewState === "failed" ? "destructive" : report?.status === "completed" || report?.status === "partial" ? "default" : "secondary"}>
            {t("analysis.analysisStatus")}：{analysisStatusLabel(analysisStatus)}
          </Badge>
          <Badge variant="outline">{t("analysis.language")}：{project.language.toUpperCase()}</Badge>
          <Badge variant="outline">{t("analysis.source")}：{project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
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

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>{t("analysis.projectErrorTitle")}</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {project.latestJob?.status === "failed" && project.latestJob.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>{t("analysis.latestJobErrorTitle")}</AlertTitle>
            <AlertDescription>{project.latestJob.errorMessage}</AlertDescription>
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

            {importWarnings.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>{t("analysis.summary.importWarningsTitle")}</CardTitle>
                  <CardDescription>{t("analysis.summary.importWarningsDescription")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-700">
                  {importWarnings.map((warning, index) => (
                    <div key={`${warning.code}-${warning.filePath ?? index}`} className="rounded-lg border px-3 py-2">
                      <p className="font-medium text-slate-950">{warning.code}</p>
                      <p>{warning.message}</p>
                      {warning.filePath ? <p className="text-slate-500">{warning.filePath}</p> : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-3">
              <SimpleListCard
                title={t("analysis.summary.topSymbols")}
                items={(snapshot?.topSymbols ?? []).map((item) => `${item.name} (${item.type})${item.filePath ? ` - ${item.filePath}` : ""}`)}
                emptyText={t("analysis.summary.noSymbols")}
              />
              <SimpleListCard
                title={t("analysis.summary.topRisks")}
                items={(snapshot?.topRisks ?? []).map((item) => `[${item.severity}] ${item.title}`)}
                emptyText={t("analysis.summary.noRisks")}
              />
              <SimpleListCard
                title={t("analysis.summary.topRules")}
                items={(snapshot?.topRules ?? []).map((item) => `${item.name} (${item.ruleType})`)}
                emptyText={t("analysis.summary.noRules")}
              />
            </div>

            <FileTable rows={snapshot?.fieldTables ?? []} />
          </TabsContent>

          <TabsContent value="impact">
            <ImpactAnalysisPanel projectId={projectId} />
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <FilterCard title="符號" description="依名稱或類型篩選已持久化的符號結果。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={symbolSearch} onChange={(event) => { setSymbolSearch(event.target.value); setSymbolPage(1); }} placeholder="搜尋符號名稱" />
                <Select value={symbolKind} onValueChange={(value) => { setSymbolKind(value); setSymbolPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="類型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部類型</SelectItem>
                    {symbolKinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
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
                    <Badge variant="outline">{symbol.type}</Badge>
                  </div>
                  <p className="text-slate-600">{symbol.filePath ?? "未知檔案"}</p>
                  <p className="text-slate-500">line {symbol.startLine} - {symbol.endLine}</p>
                </div>
              ))}
              emptyText="目前篩選條件下沒有符號結果。"
            />
          </TabsContent>

          <TabsContent value="fields" className="space-y-4">
            <FilterCard title="欄位" description="依資料表或欄位名稱篩選欄位證據。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={fieldSearch} onChange={(event) => { setFieldSearch(event.target.value); setFieldPage(1); }} placeholder="搜尋資料表或欄位" />
                <Select value={fieldTable} onValueChange={(value) => { setFieldTable(value); setFieldPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="資料表" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部資料表</SelectItem>
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
                    <Badge variant="outline">{field.fieldType ?? "unknown"}</Badge>
                  </div>
                  <p className="text-slate-500">references {field.referenceCount} / reads {field.readCount} / writes {field.writeCount}</p>
                </div>
              ))}
              emptyText="目前篩選條件下沒有欄位結果。"
            />
          </TabsContent>

          <TabsContent value="dependencies" className="space-y-4">
            <FilterCard title="相依關係" description="檢視符號到符號、或符號到外部目標的相依關係。">
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={dependencySearch} onChange={(event) => { setDependencySearch(event.target.value); setDependencyPage(1); }} placeholder="搜尋來源、目標或外部名稱" />
                <Select value={dependencyType} onValueChange={(value) => { setDependencyType(value); setDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="相依類型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部相依類型</SelectItem>
                    {dependencyKinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={dependencyTargetKind} onValueChange={(value) => { setDependencyTargetKind(value); setDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="目標類型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部目標類型</SelectItem>
                    {dependencyTargetKinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={dependenciesQuery.data?.total ?? 0} page={dependenciesQuery.data?.page ?? dependencyPage} pageCount={dependenciesQuery.data?.pageCount ?? 0} onPrev={() => setDependencyPage((value) => Math.max(1, value - 1))} onNext={() => setDependencyPage((value) => value + 1)} />
            <ListCard
              loading={dependenciesQuery.isLoading}
              items={(dependenciesQuery.data?.items ?? []).map((dependency) => (
                <div key={dependency.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{dependency.sourceSymbolName}</span>
                    <Badge variant="outline">{dependency.dependencyType}</Badge>
                  </div>
                  <p className="text-slate-600">target: {dependency.targetSymbolName ?? dependency.targetExternalName ?? "unknown"}</p>
                  <p className="text-slate-500">{dependency.targetKind}{dependency.lineNumber ? ` / line ${dependency.lineNumber}` : ""}</p>
                </div>
              ))}
              emptyText="目前篩選條件下沒有相依關係結果。"
            />
          </TabsContent>

          <TabsContent value="fieldDependencies" className="space-y-4">
            <FilterCard title="欄位相依" description="檢視欄位層級的讀取、寫入與計算證據。">
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={fieldDependencySearch} onChange={(event) => { setFieldDependencySearch(event.target.value); setFieldDependencyPage(1); }} placeholder="搜尋資料表、欄位、符號或上下文" />
                <Select value={fieldDependencyTable} onValueChange={(value) => { setFieldDependencyTable(value); setFieldDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="資料表" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部資料表</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => <SelectItem key={table.tableName} value={table.tableName}>{table.tableName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={fieldDependencyOperationType} onValueChange={(value) => { setFieldDependencyOperationType(value); setFieldDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="操作類型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部操作類型</SelectItem>
                    {fieldDependencyOperationTypes.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
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
                    <Badge variant="outline">{item.operationType}</Badge>
                  </div>
                  <p className="text-slate-600">{item.symbolName}</p>
                  <p className="text-slate-500">{item.context ?? "無上下文"}{item.lineNumber ? ` / line ${item.lineNumber}` : ""}</p>
                </div>
              ))}
              emptyText="目前篩選條件下沒有欄位相依結果。"
            />
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            <FilterCard title="風險" description="檢視 heuristic 風險，並依嚴重度或關鍵字篩選。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={riskSearch} onChange={(event) => { setRiskSearch(event.target.value); setRiskPage(1); }} placeholder="搜尋標題、描述或檔案" />
                <Select value={riskSeverity} onValueChange={(value) => { setRiskSeverity(value); setRiskPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="嚴重度" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部嚴重度</SelectItem>
                    {riskSeverities.map((severity) => <SelectItem key={severity} value={severity}>{severity}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={risksQuery.data?.total ?? 0} page={risksQuery.data?.page ?? riskPage} pageCount={risksQuery.data?.pageCount ?? 0} onPrev={() => setRiskPage((value) => Math.max(1, value - 1))} onNext={() => setRiskPage((value) => value + 1)} />
            <RiskPanel loading={risksQuery.isLoading} items={risksQuery.data?.items ?? []} />
          </TabsContent>

          <TabsContent value="rules" className="space-y-4">
            <FilterCard title="規則" description="檢視推導出的商業規則候選與相關中繼資料。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={ruleSearch} onChange={(event) => { setRuleSearch(event.target.value); setRulePage(1); }} placeholder="搜尋規則名稱或描述" />
                <Select value={ruleType} onValueChange={(value) => { setRuleType(value); setRulePage(1); }}>
                  <SelectTrigger><SelectValue placeholder="規則類型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部規則類型</SelectItem>
                    {ruleTypes.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={rulesQuery.data?.total ?? 0} page={rulesQuery.data?.page ?? rulePage} pageCount={rulesQuery.data?.pageCount ?? 0} onPrev={() => setRulePage((value) => Math.max(1, value - 1))} onNext={() => setRulePage((value) => value + 1)} />
            <ListCard
              loading={rulesQuery.isLoading}
              items={(rulesQuery.data?.items ?? []).map((rule) => (
                <div key={rule.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{rule.name}</span>
                    <Badge variant="outline">{rule.ruleType}</Badge>
                  </div>
                  <p className="text-slate-600">{rule.description ?? "這筆規則沒有產生額外描述。"}</p>
                  <p className="text-slate-500">{rule.sourceFile ?? "未知檔案"}{rule.lineNumber ? `:${rule.lineNumber}` : ""}</p>
                </div>
              ))}
              emptyText="目前篩選條件下沒有規則結果。"
            />
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description="流程摘要" content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description="欄位相依摘要" content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
            <DocumentCard title="RISKS.md" description="風險列表" content={renderDocumentPreview(report?.risksMarkdown)} />
            <DocumentCard title="RULES.yaml" description="推導規則" content={renderDocumentPreview(report?.rulesYaml)} />
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
