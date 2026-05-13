import { useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Download, FileText, Loader2, RefreshCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import { analysisStatusLabels, projectStatusLabels } from "@shared/contracts";
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
  filterFields,
  filterRisks,
  filterRules,
  filterSymbols,
  getAnalysisViewState,
  getFieldTables,
  getSymbolKinds,
  shouldPollProjectStatus,
  shouldPollSnapshot,
} from "./analysisResultModel";

function downloadBase64File(base64: string, fileName: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
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
    return "尚未產生可預覽的持久化文件。";
  }

  return content.split("\n").slice(0, 12).join("\n");
}

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? Number(params.id) : Number.NaN;
  const [activeTab, setActiveTab] = useState("overview");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [symbolKind, setSymbolKind] = useState("all");
  const [fieldSearch, setFieldSearch] = useState("");
  const [fieldTable, setFieldTable] = useState("all");
  const [riskSearch, setRiskSearch] = useState("");
  const [riskSeverity, setRiskSeverity] = useState("all");
  const [ruleSearch, setRuleSearch] = useState("");
  const utils = trpc.useUtils();

  const projectQuery = trpc.projects.getById.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return shouldPollProjectStatus(data?.status, data?.analysisStatus) ? 2000 : false;
    },
    refetchOnWindowFocus: false,
  });

  const snapshotQuery = trpc.analysis.getSnapshot.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchInterval: (query) =>
      shouldPollSnapshot(projectQuery.data?.status, query.state.data?.report?.status ?? projectQuery.data?.analysisStatus)
        ? 2000
        : false,
    refetchOnWindowFocus: false,
  });

  const reportDownloadQuery = trpc.analysis.downloadReport.useQuery(
    { projectId, format: "zip" },
    { enabled: false }
  );

  const triggerAnalysisMutation = trpc.analysis.trigger.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.projects.getById.invalidate(projectId), utils.analysis.getSnapshot.invalidate(projectId)]);
    },
  });

  const isLoading = projectQuery.isLoading || snapshotQuery.isLoading;
  const project = projectQuery.data;
  const snapshot = snapshotQuery.data;
  const report = snapshot?.report;
  const metrics = report?.summaryJson;
  const analysisStatus = report?.status ?? project?.analysisStatus;
  const viewState = getAnalysisViewState(project?.status, analysisStatus, Boolean(report));
  const symbolKinds = useMemo(() => getSymbolKinds(snapshot), [snapshot]);
  const fieldTables = useMemo(() => getFieldTables(snapshot), [snapshot]);
  const visibleSymbols = useMemo(
    () => filterSymbols(snapshot, { search: symbolSearch, kind: symbolKind }),
    [snapshot, symbolSearch, symbolKind]
  );
  const visibleFields = useMemo(
    () => filterFields(snapshot, { search: fieldSearch, table: fieldTable }),
    [snapshot, fieldSearch, fieldTable]
  );
  const visibleRisks = useMemo(
    () => filterRisks(snapshot, { search: riskSearch, severity: riskSeverity }),
    [snapshot, riskSearch, riskSeverity]
  );
  const visibleRules = useMemo(() => filterRules(snapshot, { search: ruleSearch }), [snapshot, ruleSearch]);

  const criticalRisks = useMemo(
    () => snapshot?.risks.filter((risk) => risk.severity === "critical").length ?? 0,
    [snapshot?.risks]
  );

  const canRunAnalysis = project ? ["ready", "failed", "completed"].includes(project.status) : false;
  const isAnalyzing = viewState === "analyzing";
  const isFailed = viewState === "failed";

  const handleRunAnalysis = async () => {
    if (!project) {
      return;
    }

    try {
      const result = await triggerAnalysisMutation.mutateAsync(project.id);
      toast.success(
        result.status === "partial"
          ? "分析完成，但包含警告。請將結果視為 heuristic 參考，而不是唯一真相。"
          : "分析完成。"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "分析失敗。");
    }
  };

  const handleDownloadReport = async () => {
    try {
      const result = await reportDownloadQuery.refetch();
      if (!result.data) {
        toast.error("持久化報告尚未準備完成。");
        return;
      }

      downloadBase64File(result.data.base64, result.data.fileName, result.data.mimeType);
      toast.success("報告已下載。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下載報告失敗。");
    }
  };

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>專案編號無效</AlertTitle>
          <AlertDescription>找不到可用的專案編號，請返回專案列表後重新開啟分析結果頁。</AlertDescription>
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
          <AlertTitle>無法載入專案</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? "目前無法取得專案資訊。"}</AlertDescription>
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
              <p className="text-sm text-slate-600">
                檢視 ZIP 或 Git 匯入後的持久化分析結果，確認 symbols、fields、risks、impact analysis 與報告輸出是否一致。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => snapshotQuery.refetch()} disabled={snapshotQuery.isFetching}>
              <RefreshCcw className="mr-2 size-4" />
              重新整理
            </Button>
            <Button onClick={handleDownloadReport} disabled={reportDownloadQuery.isFetching || !report || isAnalyzing}>
              {reportDownloadQuery.isFetching ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              下載 ZIP 報告
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>Project: {projectStatusLabels[project.status]}</Badge>
          <Badge variant={isFailed ? "destructive" : report?.status === "completed" || report?.status === "partial" ? "default" : "secondary"}>
            Analysis: {analysisStatusLabels[report?.status ?? "pending"]}
          </Badge>
          <Badge variant="outline">Focus: {project.language.toUpperCase()}</Badge>
          <Badge variant="outline">Source: {project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
        </div>

        <Alert>
          <AlertTitle>分析定位</AlertTitle>
          <AlertDescription>
            Legacy Lens 提供 Go / SQL / Delphi 的 heuristic static analysis，用於 legacy code inventory、dependency review、impact analysis 與報告輸出，
            不是 compiler-grade semantic truth。
          </AlertDescription>
        </Alert>

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>工作流程失敗</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {report?.status === "partial" ? (
          <Alert>
            <AlertTitle>分析完成，但有警告</AlertTitle>
            <AlertDescription>
              {(report.warningsJson ?? []).map((warning) => warning.message).join(" | ") || "部分檔案被略過，或僅以降級模式完成分析。"}
            </AlertDescription>
          </Alert>
        ) : null}

        {isAnalyzing ? (
          <Card data-testid="analysis-running">
            <CardHeader>
              <CardTitle>分析進行中</CardTitle>
              <CardDescription>伺服器正在更新持久化分析結果。這個頁面只會在分析執行中輪詢，完成或失敗後會自動停止。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-600">
              <p>專案狀態：{project.status}</p>
              <p>分析狀態：{report?.status ?? project.analysisStatus ?? "pending"}</p>
            </CardContent>
          </Card>
        ) : null}

        {!report && !isAnalyzing ? (
          <Card>
            <CardHeader>
              <CardTitle>尚未開始分析</CardTitle>
              <CardDescription>匯入已完成，但目前還沒有持久化分析結果。你可以從這裡手動啟動分析。</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <TriangleAlert className="mr-2 size-4" />}
                  開始分析
                </Button>
              ) : (
                <p className="text-sm text-slate-600">目前專案狀態不允許啟動分析，請先確認匯入流程是否已完成。</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="Imported files" value={metrics?.fileCount ?? 0} />
          <MetricCard title="Analyzed files" value={metrics?.analyzedFileCount ?? 0} />
          <MetricCard title="Skipped files" value={metrics?.skippedFileCount ?? 0} emphasis={(metrics?.skippedFileCount ?? 0) > 0 ? "danger" : "default"} />
          <MetricCard title="Degraded files" value={metrics?.degradedFileCount ?? 0} emphasis={(metrics?.degradedFileCount ?? 0) > 0 ? "danger" : "default"} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">總覽</TabsTrigger>
            <TabsTrigger value="impact">影響分析</TabsTrigger>
            <TabsTrigger value="risks">風險</TabsTrigger>
            <TabsTrigger value="symbols">Symbols / Fields</TabsTrigger>
            <TabsTrigger value="rules">規則</TabsTrigger>
            <TabsTrigger value="documents">文件</TabsTrigger>
          </TabsList>

          <TabsContent value="impact" className="space-y-4">
            <ImpactAnalysisPanel projectId={projectId} />
          </TabsContent>

          <TabsContent value="overview" className="space-y-4">
            <Card data-testid={viewState === "completed" ? "analysis-completed" : undefined}>
              <CardHeader>
                <CardTitle>分析摘要</CardTitle>
                <CardDescription>這裡呈現目前持久化快照中的核心計數，方便快速確認是否還有 skipped、heuristic 或 degraded 訊號。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                <SummaryRow label="Project status" value={projectStatusLabels[project.status]} />
                <SummaryRow label="Analysis status" value={analysisStatusLabels[report?.status ?? "pending"]} />
                <SummaryRow label="Imported files" value={String(metrics?.fileCount ?? 0)} />
                <SummaryRow label="Eligible files" value={String(metrics?.eligibleFileCount ?? 0)} />
                <SummaryRow label="Analyzed files" value={String(metrics?.analyzedFileCount ?? 0)} />
                <SummaryRow label="Skipped files" value={String(metrics?.skippedFileCount ?? 0)} />
                <SummaryRow label="Heuristic files" value={String(metrics?.heuristicFileCount ?? 0)} />
                <SummaryRow label="Degraded files" value={String(metrics?.degradedFileCount ?? 0)} />
                <SummaryRow label="Derived rules" value={String(metrics?.ruleCount ?? snapshot?.rules.length ?? 0)} />
                <SummaryRow label="Critical risks" value={String(criticalRisks)} />
              </CardContent>
            </Card>

            {(report?.warningsJson?.length ?? 0) > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>分析警告</CardTitle>
                  <CardDescription>如果結果是 partial 或 heuristic，請先閱讀這些訊息，再把輸出拿去做後續判斷。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-700">
                  {(report?.warningsJson ?? []).map((warning, index) => (
                    <div key={`${warning.code}-${warning.filePath ?? index}`} className="rounded-lg border px-3 py-2">
                      <p className="font-medium text-slate-950">{warning.code}</p>
                      <p>{warning.message}</p>
                      {warning.filePath ? <p className="text-slate-500">{warning.filePath}</p> : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {canRunAnalysis ? (
              <Card>
                <CardHeader>
                  <CardTitle>重新執行分析</CardTitle>
                  <CardDescription>如果你重新匯入了專案，或想重新驗證目前快照，可以從這裡再次執行分析。</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                    {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                    開始分析
                  </Button>
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>風險搜尋與篩選</CardTitle>
                <CardDescription>依關鍵字或 severity 篩選持久化風險項目，便於快速確認高風險寫入與 heuristic 偵測結果。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input placeholder="搜尋標題、描述或檔案路徑" value={riskSearch} onChange={(event) => setRiskSearch(event.target.value)} />
                <Select value={riskSeverity} onValueChange={setRiskSeverity}>
                  <SelectTrigger>
                    <SelectValue placeholder="選擇 severity" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部 severity</SelectItem>
                    <SelectItem value="critical">critical</SelectItem>
                    <SelectItem value="high">high</SelectItem>
                    <SelectItem value="medium">medium</SelectItem>
                    <SelectItem value="low">low</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            {visibleRisks.length ? (
              visibleRisks.map((risk) => (
                <Card key={risk.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-4">
                      <CardTitle className="text-lg">{risk.title}</CardTitle>
                      <Badge variant={risk.severity === "critical" || risk.severity === "high" ? "destructive" : "secondary"}>{risk.severity}</Badge>
                    </div>
                    <CardDescription>
                      {risk.sourceFile ?? "unknown"}:{risk.lineNumber ?? "?"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-slate-700">
                    <p>{risk.description ?? "沒有額外描述。"}</p>
                    <p className="text-slate-500">來源：heuristic analysis</p>
                    {risk.recommendation ? <p className="text-slate-600">Recommendation: {risk.recommendation}</p> : null}
                  </CardContent>
                </Card>
              ))
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-slate-600">查無符合條件的風險項目。</CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Symbols 與 Fields</CardTitle>
                <CardDescription>支援大量結果的搜尋與篩選，方便從持久化分析結果定位 procedure、method、SQL field 與其讀寫次數。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border p-4">
                  <div className="space-y-3">
                    <h3 className="font-medium text-slate-950">Symbols</h3>
                    <Input placeholder="搜尋 symbol 名稱或檔案路徑" value={symbolSearch} onChange={(event) => setSymbolSearch(event.target.value)} />
                    <Select value={symbolKind} onValueChange={setSymbolKind}>
                      <SelectTrigger>
                        <SelectValue placeholder="選擇 symbol 類型" />
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
                  <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm">
                    {visibleSymbols.length ? (
                      visibleSymbols.map((symbol) => (
                        <div key={symbol.id} className="rounded-lg border px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate font-medium text-slate-950">{symbol.name}</span>
                            <Badge variant="outline">{symbol.type}</Badge>
                          </div>
                          <p className="truncate text-slate-500">{symbol.filePath ?? "無檔案路徑"}</p>
                          <p className="text-slate-500">行號 {symbol.startLine} - {symbol.endLine}</p>
                        </div>
                      ))
                    ) : (
                      <p className="py-6 text-center text-slate-500">查無符合條件的 symbols。</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border p-4">
                  <div className="space-y-3">
                    <h3 className="font-medium text-slate-950">Fields</h3>
                    <Input placeholder="搜尋 table 或 field 名稱" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} />
                    <Select value={fieldTable} onValueChange={setFieldTable}>
                      <SelectTrigger>
                        <SelectValue placeholder="選擇資料表" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部資料表</SelectItem>
                        {fieldTables.map((tableName) => (
                          <SelectItem key={tableName} value={tableName}>
                            {tableName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm">
                    {visibleFields.length ? (
                      visibleFields.map((field) => (
                        <div key={field.id} className="rounded-lg border px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate font-medium text-slate-950">
                              {field.tableName}.{field.fieldName}
                            </span>
                            <Badge variant="outline">{field.fieldType ?? "unknown"}</Badge>
                          </div>
                          <p className="text-slate-500">
                            references {field.referenceCount} / reads {field.readCount} / writes {field.writeCount}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="py-6 text-center text-slate-500">查無符合條件的 fields。</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="rules" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>規則搜尋</CardTitle>
                <CardDescription>依名稱或描述搜尋衍生規則，用來確認 business rule、validation rule 與 magic value rule 的落點。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input placeholder="搜尋 rule 名稱或描述" value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} />
                <div className="max-h-[36rem] space-y-2 overflow-y-auto pr-1 text-sm">
                  {visibleRules.length ? (
                    visibleRules.map((rule) => (
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
                    ))
                  ) : (
                    <p className="py-6 text-center text-slate-500">查無符合條件的規則。</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description="Call-flow summary" content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description="Field read/write summary" content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
            <DocumentCard title="RISKS.md" description="Risk register" content={renderDocumentPreview(report?.risksMarkdown)} />
            <DocumentCard title="RULES.yaml" description="Derived rules" content={renderDocumentPreview(report?.rulesYaml)} />
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
