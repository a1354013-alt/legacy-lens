import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Download, FileText, Loader2, RefreshCcw, ShieldAlert } from "lucide-react";
import {
  analysisStatusLabels,
  dependencyKinds,
  dependencyTargetKinds,
  fieldDependencyOperationTypes,
  projectJobStatusLabels,
  projectJobTypeLabels,
  projectStatusLabels,
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
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  RESULT_LIST_PAGE_SIZE,
  canDownloadAnalysisReport,
  getAnalysisViewState,
  resolveAnalysisStatus,
  shouldPollProjectStatus,
  shouldPollSnapshot,
} from "./analysisResultModel";

async function downloadReportZip(projectId: number) {
  const response = await fetch(`/api/projects/${projectId}/report.zip`, {
    credentials: "include",
  });

  if (!response.ok) {
    let message = "下載報告失敗。";
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error ?? message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `legacy-lens-report-${projectId}.zip`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function renderDocumentPreview(content: string | null | undefined) {
  if (!content) {
    return "目前沒有可預覽的內容。";
  }

  return content.split("\n").slice(0, 12).join("\n");
}

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? Number(params.id) : Number.NaN;
  const [activeTab, setActiveTab] = useState("overview");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [symbolKind, setSymbolKind] = useState<string>("all");
  const [symbolPage, setSymbolPage] = useState(1);
  const [fieldSearch, setFieldSearch] = useState("");
  const [fieldTable, setFieldTable] = useState<string>("all");
  const [fieldPage, setFieldPage] = useState(1);
  const [riskSearch, setRiskSearch] = useState("");
  const [riskSeverity, setRiskSeverity] = useState<string>("all");
  const [riskPage, setRiskPage] = useState(1);
  const [ruleSearch, setRuleSearch] = useState("");
  const [ruleType, setRuleType] = useState<string>("all");
  const [rulePage, setRulePage] = useState(1);
  const [dependencySearch, setDependencySearch] = useState("");
  const [dependencyType, setDependencyType] = useState<string>("all");
  const [dependencyTargetKind, setDependencyTargetKind] = useState<string>("all");
  const [dependencyPage, setDependencyPage] = useState(1);
  const [fieldDependencySearch, setFieldDependencySearch] = useState("");
  const [fieldDependencyTable, setFieldDependencyTable] = useState<string>("all");
  const [fieldDependencyOperationType, setFieldDependencyOperationType] = useState<string>("all");
  const [fieldDependencyPage, setFieldDependencyPage] = useState(1);
  const [isReportDownloading, setIsReportDownloading] = useState(false);
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
    { enabled: Number.isFinite(projectId) }
  );

  const fieldsQuery = trpc.analysis.getFieldsPage.useQuery(
    {
      projectId,
      page: fieldPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: fieldSearch || undefined,
      tableName: fieldTable === "all" ? undefined : fieldTable,
    },
    { enabled: Number.isFinite(projectId) }
  );

  const risksQuery = trpc.analysis.getRisksPage.useQuery(
    {
      projectId,
      page: riskPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: riskSearch || undefined,
      severity: riskSeverity === "all" ? undefined : (riskSeverity as (typeof riskSeverities)[number]),
    },
    { enabled: Number.isFinite(projectId) }
  );

  const rulesQuery = trpc.analysis.getRulesPage.useQuery(
    {
      projectId,
      page: rulePage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: ruleSearch || undefined,
      ruleType: ruleType === "all" ? undefined : (ruleType as (typeof ruleTypes)[number]),
    },
    { enabled: Number.isFinite(projectId) }
  );

  const dependenciesQuery = trpc.analysis.getDependenciesPage.useQuery(
    {
      projectId,
      page: dependencyPage,
      pageSize: RESULT_LIST_PAGE_SIZE,
      search: dependencySearch || undefined,
      dependencyType: dependencyType === "all" ? undefined : (dependencyType as (typeof dependencyKinds)[number]),
      targetKind: dependencyTargetKind === "all" ? undefined : (dependencyTargetKind as (typeof dependencyTargetKinds)[number]),
    },
    { enabled: Number.isFinite(projectId) }
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
    { enabled: Number.isFinite(projectId) }
  );

  const triggerAnalysisMutation = trpc.analysis.trigger.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.projects.getById.invalidate(projectId), utils.analysis.getSnapshot.invalidate(projectId)]);
      toast.success("分析工作已送出。");
    },
  });

  const isLoading = projectQuery.isLoading || snapshotQuery.isLoading;
  const project = projectQuery.data;
  const snapshot = snapshotQuery.data;
  const report = snapshot?.report;
  const metrics = report?.summaryJson;
  const analysisStatus = resolveAnalysisStatus(report?.status, project?.analysisStatus);
  const viewState = getAnalysisViewState(project?.status, analysisStatus, project?.latestJob, Boolean(report));
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
      toast.error(error instanceof Error ? error.message : "建立分析工作失敗。");
    }
  };

  const handleDownloadReport = async () => {
    setIsReportDownloading(true);
    try {
      await downloadReportZip(projectId);
      toast.success("Report ZIP 已下載。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下載報告失敗。");
    } finally {
      setIsReportDownloading(false);
    }
  };

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>專案識別碼無效</AlertTitle>
          <AlertDescription>請從專案列表重新進入分析結果頁。</AlertDescription>
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
          <AlertTitle>找不到專案</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? "無法讀取專案資訊。"}</AlertDescription>
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
              返回專案列表
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-slate-950">{project.name}</h1>
              <p className="text-sm text-slate-600">分析摘要只載入精簡 snapshot，詳細列表改用後端分頁查詢。</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => void Promise.all([projectQuery.refetch(), snapshotQuery.refetch()])}>
              <RefreshCcw className="mr-2 size-4" />
              重新整理
            </Button>
            <Button onClick={handleDownloadReport} disabled={isReportDownloading || !canDownloadReport || viewState === "running"}>
              {isReportDownloading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              下載 Report ZIP
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>專案：{projectStatusLabels[project.status]}</Badge>
          <Badge variant={viewState === "failed" ? "destructive" : report?.status === "completed" || report?.status === "partial" ? "default" : "secondary"}>
            分析：{analysisStatusLabels[analysisStatus]}
          </Badge>
          <Badge variant="outline">語言：{project.language.toUpperCase()}</Badge>
          <Badge variant="outline">來源：{project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
          {project.latestJob ? (
            <Badge variant="outline">
              工作：{projectJobTypeLabels[project.latestJob.type]} / {projectJobStatusLabels[project.latestJob.status]} / {project.latestJob.progress}%
            </Badge>
          ) : null}
        </div>

        <Alert>
          <AlertTitle>分析說明</AlertTitle>
          <AlertDescription>
            Legacy Lens 以啟發式靜態分析整理 Go / SQL / Delphi 專案的結構、欄位使用、風險與規則。請將警告、跳過檔案與 degraded files 一併納入判讀。
          </AlertDescription>
        </Alert>

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>最近一次流程失敗</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {project.latestJob?.status === "failed" && project.latestJob.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>工作失敗</AlertTitle>
            <AlertDescription>{project.latestJob.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {(viewState === "queued" || viewState === "running") && project.latestJob ? (
          <Card data-testid="analysis-running">
            <CardHeader>
              <CardTitle>{viewState === "queued" ? "工作排隊中" : "工作執行中"}</CardTitle>
              <CardDescription>頁面會持續輪詢專案與工作狀態，完成後自動刷新摘要與分頁資料。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-700">
              <p>目前工作：{projectJobTypeLabels[project.latestJob.type]}</p>
              <p>工作狀態：{projectJobStatusLabels[project.latestJob.status]}</p>
              <p>進度：{project.latestJob.progress}%</p>
            </CardContent>
          </Card>
        ) : null}

        {!report && viewState === "idle" ? (
          <Card>
            <CardHeader>
              <CardTitle>尚未產生分析結果</CardTitle>
              <CardDescription>匯入完成後即可送出分析工作。</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                  啟動分析
                </Button>
              ) : (
                <p className="text-sm text-slate-600">目前專案狀態尚不可重新分析。</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="檔案數" value={metrics?.fileCount ?? snapshot?.totals.files ?? 0} />
          <MetricCard title="Symbols" value={metrics?.symbolCount ?? snapshot?.totals.symbols ?? 0} />
          <MetricCard title="Risks" value={metrics?.riskCount ?? snapshot?.totals.risks ?? 0} emphasis={(metrics?.riskCount ?? snapshot?.totals.risks ?? 0) > 0 ? "danger" : "default"} />
          <MetricCard title="Rules" value={metrics?.ruleCount ?? snapshot?.totals.rules ?? 0} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">總覽</TabsTrigger>
            <TabsTrigger value="impact">影響分析</TabsTrigger>
            <TabsTrigger value="symbols">Symbols</TabsTrigger>
            <TabsTrigger value="fields">Fields</TabsTrigger>
            <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
            <TabsTrigger value="field-dependencies">Field Dependencies</TabsTrigger>
            <TabsTrigger value="risks">Risks</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="documents">文件預覽</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>摘要</CardTitle>
                <CardDescription>這裡只顯示精簡 snapshot 與 top lists，不再一次回傳整包大型陣列。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                <SummaryRow label="專案狀態" value={projectStatusLabels[project.status]} />
                <SummaryRow label="分析狀態" value={analysisStatusLabels[analysisStatus]} />
                <SummaryRow label="可分析檔案" value={String(metrics?.eligibleFileCount ?? 0)} />
                <SummaryRow label="已分析檔案" value={String(metrics?.analyzedFileCount ?? 0)} />
                <SummaryRow label="跳過檔案" value={String(metrics?.skippedFileCount ?? 0)} />
                <SummaryRow label="欄位依賴" value={String(metrics?.fieldDependencyCount ?? snapshot?.totals.fieldDependencies ?? 0)} />
              </CardContent>
            </Card>

            {importWarnings.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>匯入警告</CardTitle>
                  <CardDescription>匯入階段發生的警告會保存在專案資料中。</CardDescription>
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
                title="Top Symbols"
                items={(snapshot?.topSymbols ?? []).map((item) => `${item.name} (${item.type})${item.filePath ? ` - ${item.filePath}` : ""}`)}
                emptyText="目前沒有 symbol。"
              />
              <SimpleListCard
                title="Top Risks"
                items={(snapshot?.topRisks ?? []).map((item) => `[${item.severity}] ${item.title}`)}
                emptyText="目前沒有 risk。"
              />
              <SimpleListCard
                title="Top Rules"
                items={(snapshot?.topRules ?? []).map((item) => `${item.name} (${item.ruleType})`)}
                emptyText="目前沒有 rule。"
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Field / Table 摘要</CardTitle>
                <CardDescription>按資料表聚合欄位數量與讀寫次數。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(snapshot?.fieldTables ?? []).length ? (
                  snapshot?.fieldTables.map((table) => (
                    <div key={table.tableName} className="rounded-lg border px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-slate-950">{table.tableName}</span>
                        <span className="text-slate-500">{table.fieldCount} 欄位</span>
                      </div>
                      <p className="text-slate-600">
                        references {table.referenceCount} / reads {table.readCount} / writes {table.writeCount}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-slate-500">目前沒有 field summary。</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="impact" className="space-y-4">
            <ImpactAnalysisPanel projectId={projectId} />
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <FilterCard title="Symbols" description="以後端分頁查詢 Symbols，可依名稱與類型篩選。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input
                  value={symbolSearch}
                  onChange={(event) => {
                    setSymbolSearch(event.target.value);
                    setSymbolPage(1);
                  }}
                  placeholder="搜尋 symbol 名稱或檔案路徑"
                />
                <Select
                  value={symbolKind}
                  onValueChange={(value) => {
                    setSymbolKind(value);
                    setSymbolPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="全部類型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部類型</SelectItem>
                    {symbolKinds.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PagedListState
              total={symbolsQuery.data?.total ?? 0}
              page={symbolsQuery.data?.page ?? symbolPage}
              pageCount={symbolsQuery.data?.pageCount ?? 0}
              onPrev={() => setSymbolPage((value) => Math.max(1, value - 1))}
              onNext={() => setSymbolPage((value) => value + 1)}
            />
            <ListCard
              loading={symbolsQuery.isLoading}
              items={(symbolsQuery.data?.items ?? []).map((symbol) => (
                <div key={symbol.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{symbol.name}</span>
                    <Badge variant="outline">{symbol.type}</Badge>
                  </div>
                  <p className="text-slate-500">{symbol.filePath ?? "無檔案路徑"}</p>
                  <p className="text-slate-500">行號 {symbol.startLine} - {symbol.endLine}</p>
                </div>
              ))}
              emptyText="查無符合條件的 symbol。"
            />
          </TabsContent>

          <TabsContent value="fields" className="space-y-4">
            <FilterCard title="Fields" description="以後端分頁查詢欄位與使用次數。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input
                  value={fieldSearch}
                  onChange={(event) => {
                    setFieldSearch(event.target.value);
                    setFieldPage(1);
                  }}
                  placeholder="搜尋 table 或 field 名稱"
                />
                <Select
                  value={fieldTable}
                  onValueChange={(value) => {
                    setFieldTable(value);
                    setFieldPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="全部資料表" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部資料表</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => (
                      <SelectItem key={table.tableName} value={table.tableName}>
                        {table.tableName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PagedListState
              total={fieldsQuery.data?.total ?? 0}
              page={fieldsQuery.data?.page ?? fieldPage}
              pageCount={fieldsQuery.data?.pageCount ?? 0}
              onPrev={() => setFieldPage((value) => Math.max(1, value - 1))}
              onNext={() => setFieldPage((value) => value + 1)}
            />
            <ListCard
              loading={fieldsQuery.isLoading}
              items={(fieldsQuery.data?.items ?? []).map((field) => (
                <div key={field.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">
                      {field.tableName}.{field.fieldName}
                    </span>
                    <Badge variant="outline">{field.fieldType ?? "unknown"}</Badge>
                  </div>
                  <p className="text-slate-500">
                    references {field.referenceCount} / reads {field.readCount} / writes {field.writeCount}
                  </p>
                </div>
              ))}
              emptyText="查無符合條件的欄位。"
            />
          </TabsContent>

          <TabsContent value="dependencies" className="space-y-4">
            <FilterCard title="Dependencies" description="分頁檢視符號依賴，支援依賴型別、目標型別與關鍵字搜尋。">
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  value={dependencySearch}
                  onChange={(event) => {
                    setDependencySearch(event.target.value);
                    setDependencyPage(1);
                  }}
                  placeholder="搜尋 source / target / external name"
                />
                <Select
                  value={dependencyType}
                  onValueChange={(value) => {
                    setDependencyType(value);
                    setDependencyPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="依賴型別" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部依賴型別</SelectItem>
                    {dependencyKinds.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={dependencyTargetKind}
                  onValueChange={(value) => {
                    setDependencyTargetKind(value);
                    setDependencyPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="目標型別" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部目標型別</SelectItem>
                    {dependencyTargetKinds.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PagedListState
              total={dependenciesQuery.data?.total ?? 0}
              page={dependenciesQuery.data?.page ?? dependencyPage}
              pageCount={dependenciesQuery.data?.pageCount ?? 0}
              onPrev={() => setDependencyPage((value) => Math.max(1, value - 1))}
              onNext={() => setDependencyPage((value) => value + 1)}
            />
            <ListCard
              loading={dependenciesQuery.isLoading}
              items={(dependenciesQuery.data?.items ?? []).map((dependency) => (
                <div key={dependency.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{dependency.sourceSymbolName}</span>
                    <Badge variant="outline">{dependency.dependencyType}</Badge>
                  </div>
                  <p className="text-slate-600">
                    target: {dependency.targetSymbolName ?? dependency.targetExternalName ?? "unknown"}
                  </p>
                  <p className="text-slate-500">
                    {dependency.targetKind}
                    {dependency.lineNumber ? ` / line ${dependency.lineNumber}` : ""}
                  </p>
                </div>
              ))}
              emptyText="目前沒有符合條件的 dependency。"
            />
          </TabsContent>

          <TabsContent value="field-dependencies" className="space-y-4">
            <FilterCard title="Field Dependencies" description="分頁檢視資料欄位讀寫依賴，支援 table 與 operation 篩選。">
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  value={fieldDependencySearch}
                  onChange={(event) => {
                    setFieldDependencySearch(event.target.value);
                    setFieldDependencyPage(1);
                  }}
                  placeholder="搜尋 table / field / symbol / context"
                />
                <Select
                  value={fieldDependencyTable}
                  onValueChange={(value) => {
                    setFieldDependencyTable(value);
                    setFieldDependencyPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Table" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部 Table</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => (
                      <SelectItem key={table.tableName} value={table.tableName}>
                        {table.tableName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={fieldDependencyOperationType}
                  onValueChange={(value) => {
                    setFieldDependencyOperationType(value);
                    setFieldDependencyPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Operation" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部 Operation</SelectItem>
                    {fieldDependencyOperationTypes.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PagedListState
              total={fieldDependenciesQuery.data?.total ?? 0}
              page={fieldDependenciesQuery.data?.page ?? fieldDependencyPage}
              pageCount={fieldDependenciesQuery.data?.pageCount ?? 0}
              onPrev={() => setFieldDependencyPage((value) => Math.max(1, value - 1))}
              onNext={() => setFieldDependencyPage((value) => value + 1)}
            />
            <ListCard
              loading={fieldDependenciesQuery.isLoading}
              items={(fieldDependenciesQuery.data?.items ?? []).map((item) => (
                <div key={item.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">
                      {item.tableName}.{item.fieldName}
                    </span>
                    <Badge variant="outline">{item.operationType}</Badge>
                  </div>
                  <p className="text-slate-600">{item.symbolName}</p>
                  <p className="text-slate-500">
                    {item.context ?? "no context"}
                    {item.lineNumber ? ` / line ${item.lineNumber}` : ""}
                  </p>
                </div>
              ))}
              emptyText="目前沒有符合條件的 field dependency。"
            />
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            <FilterCard title="Risks" description="以後端分頁查詢風險，可依 severity 與關鍵字篩選。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input
                  value={riskSearch}
                  onChange={(event) => {
                    setRiskSearch(event.target.value);
                    setRiskPage(1);
                  }}
                  placeholder="搜尋標題、描述或來源檔案"
                />
                <Select
                  value={riskSeverity}
                  onValueChange={(value) => {
                    setRiskSeverity(value);
                    setRiskPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="全部 severity" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部 severity</SelectItem>
                    {riskSeverities.map((severity) => (
                      <SelectItem key={severity} value={severity}>
                        {severity}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PagedListState
              total={risksQuery.data?.total ?? 0}
              page={risksQuery.data?.page ?? riskPage}
              pageCount={risksQuery.data?.pageCount ?? 0}
              onPrev={() => setRiskPage((value) => Math.max(1, value - 1))}
              onNext={() => setRiskPage((value) => value + 1)}
            />
            <ListCard
              loading={risksQuery.isLoading}
              items={(risksQuery.data?.items ?? []).map((risk) => (
                <Card key={risk.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-4">
                      <CardTitle className="text-lg">{risk.title}</CardTitle>
                      <Badge variant={risk.severity === "critical" || risk.severity === "high" ? "destructive" : "secondary"}>{risk.severity}</Badge>
                    </div>
                    <CardDescription>
                      {risk.sourceFile ?? "unknown"}
                      {risk.lineNumber ? `:${risk.lineNumber}` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-slate-700">
                    <p>{risk.description ?? "沒有額外描述。"}</p>
                    {risk.recommendation ? <p className="text-slate-600">建議：{risk.recommendation}</p> : null}
                  </CardContent>
                </Card>
              ))}
              emptyText="查無符合條件的風險。"
            />
          </TabsContent>

          <TabsContent value="rules" className="space-y-4">
            <FilterCard title="Rules" description="以後端分頁查詢推導出的規則。">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input
                  value={ruleSearch}
                  onChange={(event) => {
                    setRuleSearch(event.target.value);
                    setRulePage(1);
                  }}
                  placeholder="搜尋規則名稱或描述"
                />
                <Select
                  value={ruleType}
                  onValueChange={(value) => {
                    setRuleType(value);
                    setRulePage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="全部 rule type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部 rule type</SelectItem>
                    {ruleTypes.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PagedListState
              total={rulesQuery.data?.total ?? 0}
              page={rulesQuery.data?.page ?? rulePage}
              pageCount={rulesQuery.data?.pageCount ?? 0}
              onPrev={() => setRulePage((value) => Math.max(1, value - 1))}
              onNext={() => setRulePage((value) => value + 1)}
            />
            <ListCard
              loading={rulesQuery.isLoading}
              items={(rulesQuery.data?.items ?? []).map((rule) => (
                <div key={rule.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{rule.name}</span>
                    <Badge variant="outline">{rule.ruleType}</Badge>
                  </div>
                  <p className="text-slate-600">{rule.description ?? "沒有額外描述。"}</p>
                  <p className="text-slate-500">
                    {rule.sourceFile ?? "無來源檔案"}
                    {rule.lineNumber ? `:${rule.lineNumber}` : ""}
                  </p>
                </div>
              ))}
              emptyText="查無符合條件的規則。"
            />
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description="流程摘要" content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description="欄位讀寫摘要" content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
            <DocumentCard title="RISKS.md" description="風險清單" content={renderDocumentPreview(report?.risksMarkdown)} />
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium text-slate-950">{value}</span>
    </div>
  );
}

function FilterCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
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

function PagedListState({
  total,
  page,
  pageCount,
  onPrev,
  onNext,
}: {
  total: number;
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-slate-600">
      <p>
        共 {total} 筆，第 {page} / {Math.max(pageCount, 1)} 頁
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={page <= 1}>
          上一頁
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={pageCount === 0 || page >= pageCount}>
          下一頁
        </Button>
      </div>
    </div>
  );
}

function ListCard({ loading, items, emptyText }: { loading: boolean; items: React.ReactNode[]; emptyText: string }) {
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
