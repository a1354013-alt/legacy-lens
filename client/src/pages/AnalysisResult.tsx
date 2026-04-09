import { useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { analysisStatusLabels, projectStatusLabels } from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

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
    return "尚未產生。";
  }
  return content.split("\n").slice(0, 12).join("\n");
}

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? Number(params.id) : NaN;
  const [activeTab, setActiveTab] = useState("overview");
  const utils = trpc.useUtils();

  const projectQuery = trpc.projects.getById.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchOnWindowFocus: false,
  });
  const snapshotQuery = trpc.analysis.getSnapshot.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
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

  const criticalRisks = useMemo(
    () => snapshot?.risks.filter((risk) => risk.severity === "critical").length ?? 0,
    [snapshot?.risks]
  );

  const canRunAnalysis = project ? ["ready", "failed", "completed"].includes(project.status) : false;

  const handleRunAnalysis = async () => {
    if (!project) return;
    try {
      const result = await triggerAnalysisMutation.mutateAsync(project.id);
      toast.success(result.status === "partial" ? "分析已完成，但有警告。" : "分析已完成。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "分析失敗。");
    }
  };

  const handleDownloadReport = async () => {
    try {
      const result = await reportDownloadQuery.refetch();
      if (!result.data) {
        toast.error("報告尚未準備完成。");
        return;
      }
      downloadBase64File(result.data.base64, result.data.fileName, result.data.mimeType);
      toast.success("報告已下載。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下載失敗。");
    }
  };

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Alert variant="destructive">
          <AlertTitle>路由參數錯誤</AlertTitle>
          <AlertDescription>無法辨識專案編號。</AlertDescription>
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
          <AlertTitle>找不到專案</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? "此專案不存在或你沒有權限存取。"}</AlertDescription>
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
              返回首頁
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-slate-950">{project.name}</h1>
              <p className="text-sm text-slate-600">查看目前專案狀態、分析結果與報告產物。</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => snapshotQuery.refetch()} disabled={snapshotQuery.isFetching}>
              <RefreshCcw className="mr-2 size-4" />
              重新整理
            </Button>
            <Button onClick={handleDownloadReport} disabled={reportDownloadQuery.isFetching || !report}>
              {reportDownloadQuery.isFetching ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              下載報告
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>
            專案狀態：{projectStatusLabels[project.status]}
          </Badge>
          <Badge variant={report?.status === "failed" ? "destructive" : report?.status === "completed" ? "default" : "secondary"}>
            分析狀態：{analysisStatusLabels[report?.status ?? "pending"]}
          </Badge>
          <Badge variant="outline">語言：{project.language.toUpperCase()}</Badge>
          <Badge variant="outline">來源：{project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
        </div>

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>最近一次流程失敗</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {report?.status === "partial" ? (
          <Alert>
            <AlertTitle>分析已完成，但有警告</AlertTitle>
            <AlertDescription>
              {(report.warningsJson ?? []).map((warning) => warning.message).join("；") || "部分檔案被略過或只能提供最佳努力結果。"}
            </AlertDescription>
          </Alert>
        ) : null}

        {!report && project.status !== "analyzing" ? (
          <Card>
            <CardHeader>
              <CardTitle>尚未有可用分析結果</CardTitle>
              <CardDescription>只有在檔案成功匯入且分析寫回完成後，這個頁面才會顯示完整內容。</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <TriangleAlert className="mr-2 size-4" />}
                  重新執行分析
                </Button>
              ) : (
                <p className="text-sm text-slate-600">目前專案狀態不允許啟動分析。</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        {project.status === "analyzing" ? (
          <Card>
            <CardHeader>
              <CardTitle>分析進行中</CardTitle>
              <CardDescription>後端正在處理檔案與寫回結果，完成前不會顯示為成功。</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">分析進度 {project.analysisProgress}%</p>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="符號" value={metrics?.symbolCount ?? snapshot?.symbols.length ?? 0} />
          <MetricCard title="依賴" value={metrics?.dependencyCount ?? snapshot?.dependencies.length ?? 0} />
          <MetricCard title="欄位" value={metrics?.fieldCount ?? snapshot?.fields.length ?? 0} />
          <MetricCard title="Critical 風險" value={criticalRisks} emphasis={criticalRisks > 0 ? "danger" : "default"} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">總覽</TabsTrigger>
            <TabsTrigger value="risks">風險</TabsTrigger>
            <TabsTrigger value="symbols">符號</TabsTrigger>
            <TabsTrigger value="documents">文件</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>分析摘要</CardTitle>
                <CardDescription>這些數字全部來自後端實際落地的分析結果。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                <SummaryRow label="專案狀態" value={projectStatusLabels[project.status]} />
                <SummaryRow label="分析狀態" value={analysisStatusLabels[report?.status ?? "pending"]} />
                <SummaryRow label="檔案總數" value={String(metrics?.fileCount ?? 0)} />
                <SummaryRow label="已分析檔案" value={String(metrics?.analyzedFileCount ?? 0)} />
                <SummaryRow label="略過檔案" value={String(metrics?.skippedFileCount ?? 0)} />
                <SummaryRow label="規則數量" value={String(metrics?.ruleCount ?? snapshot?.rules.length ?? 0)} />
              </CardContent>
            </Card>

            {canRunAnalysis ? (
              <Card>
                <CardHeader>
                  <CardTitle>重新執行</CardTitle>
                  <CardDescription>當你重新匯入檔案或修正失敗狀態後，可以再次執行分析。</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                    {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                    重新分析
                  </Button>
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            {snapshot?.risks.length ? (
              snapshot.risks.map((risk) => (
                <Card key={risk.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-4">
                      <CardTitle className="text-lg">{risk.title}</CardTitle>
                      <Badge variant={risk.severity === "critical" || risk.severity === "high" ? "destructive" : "secondary"}>
                        {risk.severity}
                      </Badge>
                    </div>
                    <CardDescription>
                      {risk.sourceFile ?? "unknown"}:{risk.lineNumber ?? "?"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-slate-700">
                    <p>{risk.description ?? "未提供描述"}</p>
                    {risk.recommendation ? <p className="text-slate-600">建議：{risk.recommendation}</p> : null}
                  </CardContent>
                </Card>
              ))
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-slate-600">目前沒有已落地的風險紀錄。</CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>符號與欄位摘要</CardTitle>
                <CardDescription>確認資料流是否真的寫回到資料庫。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border p-4">
                  <h3 className="font-medium text-slate-950">符號</h3>
                  <div className="space-y-2 text-sm">
                    {(snapshot?.symbols.slice(0, 12) ?? []).map((symbol) => (
                      <div key={symbol.id} className="flex items-center justify-between gap-3">
                        <span className="truncate">{symbol.name}</span>
                        <Badge variant="outline">{symbol.type}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border p-4">
                  <h3 className="font-medium text-slate-950">欄位</h3>
                  <div className="space-y-2 text-sm">
                    {(snapshot?.fields.slice(0, 12) ?? []).map((field) => (
                      <div key={field.id} className="flex items-center justify-between gap-3">
                        <span className="truncate">
                          {field.tableName}.{field.fieldName}
                        </span>
                        <Badge variant="outline">{field.fieldType ?? "unknown"}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description="流程摘要" content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description="資料依賴" content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
            <DocumentCard title="RISKS.md" description="風險清單" content={renderDocumentPreview(report?.risksMarkdown)} />
            <DocumentCard title="RULES.yaml" description="規則彙整" content={renderDocumentPreview(report?.rulesYaml)} />
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
