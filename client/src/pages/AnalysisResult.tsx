import { useMemo, useState } from "react";
import { ImpactAnalysisPanel } from "@/components/ImpactAnalysisPanel";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Download, FileText, Loader2, RefreshCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import { analysisStatusLabels, projectStatusLabels } from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { filterFields, filterRisks, filterRules, filterSymbols, getFieldTables, getSymbolKinds, shouldPollProjectStatus, shouldPollSnapshot } from "./analysisResultModel";

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
    return "No persisted document is available yet.";
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
      shouldPollSnapshot(projectQuery.data?.status, query.state.data?.report?.status ?? projectQuery.data?.analysisStatus) ? 2000 : false,
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
  const visibleRules = useMemo(
    () => filterRules(snapshot, { search: ruleSearch }),
    [snapshot, ruleSearch]
  );

  const criticalRisks = useMemo(
    () => snapshot?.risks.filter((risk) => risk.severity === "critical").length ?? 0,
    [snapshot?.risks]
  );

  const canRunAnalysis = project ? ["ready", "failed", "completed"].includes(project.status) : false;
  const isAnalyzing = project?.status === "analyzing" || report?.status === "processing";

  const handleRunAnalysis = async () => {
    if (!project) return;
    try {
      const result = await triggerAnalysisMutation.mutateAsync(project.id);
      toast.success(
        result.status === "partial"
          ? "Analysis completed with warnings. Review heuristic output before using it as source-of-truth."
          : "Analysis completed."
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Analysis failed.");
    }
  };

  const handleDownloadReport = async () => {
    try {
      const result = await reportDownloadQuery.refetch();
      if (!result.data) {
        toast.error("The persisted report archive is not ready yet.");
        return;
      }
      downloadBase64File(result.data.base64, result.data.fileName, result.data.mimeType);
      toast.success("Report downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to download report.");
    }
  };

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <Alert variant="destructive">
          <AlertTitle>專案編號無效</AlertTitle>
          <AlertDescription>目前網址中的專案編號格式不正確。</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="size-10 animate-spin text-slate-600" />
      </div>
    );
  }

  if (projectQuery.error || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>無法載入專案</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? "目前無法讀取這個專案。"}</AlertDescription>
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
              <p className="text-sm text-slate-600">畫面瀏覽與 ZIP 匯出都來自同一份持久化分析快照。</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => snapshotQuery.refetch()} disabled={snapshotQuery.isFetching}>
              <RefreshCcw className="mr-2 size-4" />
              重新整理
            </Button>
            <Button onClick={handleDownloadReport} disabled={reportDownloadQuery.isFetching || !report || isAnalyzing}>
              {reportDownloadQuery.isFetching ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              下載 ZIP
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>Project: {projectStatusLabels[project.status]}</Badge>
          <Badge variant={report?.status === "failed" ? "destructive" : report?.status === "completed" ? "default" : "secondary"}>
            Analysis: {analysisStatusLabels[report?.status ?? "pending"]}
          </Badge>
          <Badge variant="outline">Focus: {project.language.toUpperCase()}</Badge>
          <Badge variant="outline">Source: {project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
        </div>

        <Alert>
          <AlertTitle>啟發式分析說明</AlertTitle>
          <AlertDescription>Go、SQL、Delphi 目前都是 heuristic static analysis，適合 legacy 探索與初步 impact analysis，不應視為 compiler-grade semantic truth。</AlertDescription>
        </Alert>

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>最新工作流程錯誤</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {report?.status === "partial" ? (
          <Alert>
            <AlertTitle>分析完成，但有警告</AlertTitle>
            <AlertDescription>
              {(report.warningsJson ?? []).map((warning) => warning.message).join(" | ") || "Some files were skipped or analyzed with reduced confidence."}
            </AlertDescription>
          </Alert>
        ) : null}

        {isAnalyzing ? (
          <Card>
            <CardHeader>
              <CardTitle>分析進行中</CardTitle>
              <CardDescription>分析期間會定期同步專案狀態與分析快照，完成或失敗後會自動停止輪詢。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-600">
              <p>專案工作流程：{project.status}</p>
              <p>分析快照狀態：{report?.status ?? project.analysisStatus ?? "pending"}</p>
            </CardContent>
          </Card>
        ) : null}

        {!report && !isAnalyzing ? (
          <Card>
            <CardHeader>
              <CardTitle>尚無分析結果</CardTitle>
              <CardDescription>請先執行分析，系統才會產生持久化快照、UI 瀏覽內容與可下載報告。</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <TriangleAlert className="mr-2 size-4" />}
                  執行分析
                </Button>
              ) : (
                <p className="text-sm text-slate-600">目前專案狀態暫時不能啟動分析。</p>
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
            <TabsTrigger value="symbols">符號與欄位</TabsTrigger>
            <TabsTrigger value="rules">規則</TabsTrigger>
            <TabsTrigger value="documents">文件</TabsTrigger>
          </TabsList>

          <TabsContent value="impact" className="space-y-4">
            <ImpactAnalysisPanel projectId={projectId} />
          </TabsContent>

          <TabsContent value="overview" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>分析摘要</CardTitle>
                <CardDescription>以下數字都來自資料庫中的持久化分析快照。</CardDescription>
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
                  <CardTitle>持久化警告</CardTitle>
                  <CardDescription>這些警告說明為什麼目前結果是 partial 或 heuristic。</CardDescription>
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
                  <CardTitle>重新分析</CardTitle>
                  <CardDescription>匯入內容更新後，或想重新產生資料庫快照時，可以再次執行分析。</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                    {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                    執行分析
                  </Button>
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>風險搜尋與篩選</CardTitle>
                <CardDescription>可依 severity、訊息或檔案路徑篩選大量風險清單。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input placeholder="搜尋訊息或檔案路徑" value={riskSearch} onChange={(event) => setRiskSearch(event.target.value)} />
                <Select value={riskSeverity} onValueChange={setRiskSeverity}>
                  <SelectTrigger>
                    <SelectValue placeholder="全部等級" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部等級</SelectItem>
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
                    <p>{risk.description ?? "No description provided."}</p>
                    <p className="text-slate-500">信心等級：heuristic</p>
                    {risk.recommendation ? <p className="text-slate-600">Recommendation: {risk.recommendation}</p> : null}
                  </CardContent>
                </Card>
              ))
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-slate-600">目前沒有符合條件的風險項目。</CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>符號搜尋與欄位瀏覽</CardTitle>
                <CardDescription>這個區塊直接讀取持久化快照，不會在瀏覽器重新推導分析結果。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border p-4">
                  <div className="space-y-3">
                    <h3 className="font-medium text-slate-950">Symbols</h3>
                    <Input placeholder="搜尋 symbol 名稱或檔案路徑" value={symbolSearch} onChange={(event) => setSymbolSearch(event.target.value)} />
                    <Select value={symbolKind} onValueChange={setSymbolKind}>
                      <SelectTrigger>
                        <SelectValue placeholder="全部種類" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部種類</SelectItem>
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
                          <p className="truncate text-slate-500">{symbol.filePath ?? "未知檔案"}</p>
                          <p className="text-slate-500">行號 {symbol.startLine} - {symbol.endLine}</p>
                        </div>
                      ))
                    ) : (
                      <p className="py-6 text-center text-slate-500">沒有符合條件的 symbols。</p>
                    )}
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border p-4">
                  <div className="space-y-3">
                    <h3 className="font-medium text-slate-950">Fields</h3>
                    <Input placeholder="搜尋 table 或 field" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} />
                    <Select value={fieldTable} onValueChange={setFieldTable}>
                      <SelectTrigger>
                        <SelectValue placeholder="全部資料表" />
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
                      <p className="py-6 text-center text-slate-500">沒有符合條件的欄位。</p>
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
                <CardDescription>可依規則名稱或描述搜尋商業規則 / 驗證規則。</CardDescription>
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
                        <p className="text-slate-600">{rule.description ?? "No description provided."}</p>
                        <p className="text-slate-500">{rule.sourceFile ?? "未知來源"}{rule.lineNumber ? `:${rule.lineNumber}` : ""}</p>
                      </div>
                    ))
                  ) : (
                    <p className="py-6 text-center text-slate-500">目前沒有符合條件的規則。</p>
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
