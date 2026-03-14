import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileText,
  AlertCircle,
  CheckCircle,
  AlertOctagon,
  Loader2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [isRoute, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? parseInt(params.id) : null;
  const [activeTab, setActiveTab] = useState("overview");
  const [isDownloading, setIsDownloading] = useState(false);

  const { data: project } = trpc.projects.getById.useQuery(projectId || 0, {
    enabled: !!projectId,
  });

  const { data: analysisResult } = trpc.analysis.getResult.useQuery(projectId || 0, {
    enabled: !!projectId,
  });

  const { data: risks } = trpc.analysis.getRisks.useQuery(projectId || 0, {
    enabled: !!projectId,
  });

  const { data: symbols } = trpc.analysis.getSymbols.useQuery(projectId || 0, {
    enabled: !!projectId,
  });

  const { data: reportData } = trpc.analysis.downloadReport.useQuery(projectId || 0, {
    enabled: !!projectId,
  });

  const handleDownloadReport = async () => {
    if (!projectId || !reportData) return;

    setIsDownloading(true);
    try {
      const result = reportData;

      if (!result) {
        toast.error("報告不可用，請先完成分析");
        return;
      }

      // 建立 ZIP 檔案並下載
      const files = {
        "FLOW.md": result.flowMarkdown || "",
        "DATA_DEPENDENCY.md": result.dataDependencyMarkdown || "",
        "RISKS.md": result.risksMarkdown || "",
        "RULES.yaml": result.rulesYaml || "",
      };

      // 簡單的下載實現：將檔案內容合併為一個文本檔案
      const reportContent = Object.entries(files)
        .map(([name, content]) => `\n\n=== ${name} ===\n\n${content}`)
        .join("\n");

      const blob = new Blob([reportContent], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.name || "project"}-analysis-report.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("報告下載成功！");
    } catch (error) {
      console.error("Download error:", error);
      toast.error("下載報告失敗");
    } finally {
      setIsDownloading(false);
    }
  };

  if (!projectId || !project) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <p className="text-slate-600">專案未找到</p>
        </div>
      </div>
    );
  }

  const criticalRisks = risks?.filter((r) => r.severity === "critical") || [];
  const highRisks = risks?.filter((r) => r.severity === "high") || [];
  const mediumRisks = risks?.filter((r) => r.severity === "medium") || [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/")}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              返回
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
              <p className="text-sm text-slate-600">分析結果</p>
            </div>
          </div>
          <Button
            onClick={handleDownloadReport}
            disabled={isDownloading || !reportData}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                下載中...
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                下載報告
              </>
            )}
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12">
        <div className="grid md:grid-cols-4 gap-4 mb-8">
          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">總符號數</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-slate-900">{symbols?.length || 0}</div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">Critical 風險</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-600">{criticalRisks.length}</div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">High 風險</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-orange-600">{highRisks.length}</div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">Medium 風險</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-yellow-600">{mediumRisks.length}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-slate-100 border-slate-200">
            <TabsTrigger value="overview">概覽</TabsTrigger>
            <TabsTrigger value="risks">風險分析</TabsTrigger>
            <TabsTrigger value="symbols">符號清單</TabsTrigger>
            <TabsTrigger value="documents">文件</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>分析摘要</CardTitle>
                <CardDescription>專案的整體分析結果</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="font-medium text-slate-900 mb-2">專案信息</h4>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-slate-600">語言:</dt>
                        <dd className="font-medium text-slate-900">{project.language.toUpperCase()}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-600">來源:</dt>
                        <dd className="font-medium text-slate-900">
                          {project.sourceType === "upload" ? "上傳" : "Git"}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-600">狀態:</dt>
                        <dd>
                          <Badge>{project.status}</Badge>
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div>
                    <h4 className="font-medium text-slate-900 mb-2">分析統計</h4>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-slate-600">檢測到的函數/程序:</dt>
                        <dd className="font-medium text-slate-900">{symbols?.length || 0}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-600">風險項目:</dt>
                        <dd className="font-medium text-slate-900">{risks?.length || 0}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-600">Critical 風險:</dt>
                        <dd className="font-medium text-red-600">{criticalRisks.length}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="risks" className="space-y-6">
            {criticalRisks.length > 0 && (
              <Card className="border-red-200 bg-red-50">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <AlertOctagon className="w-5 h-5 text-red-600" />
                    <CardTitle className="text-red-900">Critical 風險 ({criticalRisks.length})</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {criticalRisks.map((risk, idx) => (
                    <div key={idx} className="border-l-4 border-red-600 pl-4 py-2">
                      <h4 className="font-medium text-slate-900">{risk.title}</h4>
                      <p className="text-sm text-slate-600 mt-1">{risk.description}</p>
                      <div className="flex gap-4 mt-2 text-xs text-slate-600">
                        <span>
                          {risk.sourceFile}:{risk.lineNumber}
                        </span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {highRisks.length > 0 && (
              <Card className="border-orange-200 bg-orange-50">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-orange-600" />
                    <CardTitle className="text-orange-900">High 風險 ({highRisks.length})</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {highRisks.slice(0, 5).map((risk, idx) => (
                    <div key={idx} className="border-l-4 border-orange-600 pl-4 py-2">
                      <h4 className="font-medium text-slate-900">{risk.title}</h4>
                      <p className="text-sm text-slate-600 mt-1">{risk.description}</p>
                    </div>
                  ))}
                  {highRisks.length > 5 && (
                    <p className="text-sm text-slate-600">及其他 {highRisks.length - 5} 個風險</p>
                  )}
                </CardContent>
              </Card>
            )}

            {mediumRisks.length > 0 && (
              <Card className="border-yellow-200 bg-yellow-50">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-yellow-600" />
                    <CardTitle className="text-yellow-900">Medium 風險 ({mediumRisks.length})</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-slate-600">
                    檢測到 {mediumRisks.length} 個中等風險項目，請查看詳細報告。
                  </p>
                </CardContent>
              </Card>
            )}

            {risks && risks.length === 0 && (
              <Card className="border-green-200 bg-green-50">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                    <CardTitle className="text-green-900">沒有檢測到風險</CardTitle>
                  </div>
                </CardHeader>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="symbols" className="space-y-6">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>檢測到的符號</CardTitle>
                <CardDescription>函數、方法、查詢等</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {symbols && symbols.length > 0 ? (
                    symbols.slice(0, 20).map((symbol, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                        <div>
                          <p className="font-medium text-slate-900">{symbol.name}</p>
                          <p className="text-xs text-slate-600">
                            {symbol.type} • 行 {symbol.startLine}
                          </p>
                        </div>
                        <Badge variant="outline">{symbol.type}</Badge>
                      </div>
                    ))
                  ) : (
                    <p className="text-slate-600 text-center py-8">尚未檢測到符號</p>
                  )}
                </div>
                {symbols && symbols.length > 20 && (
                  <p className="text-sm text-slate-600 mt-4">
                    及其他 {symbols.length - 20} 個符號
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="documents" className="space-y-6">
            <div className="grid md:grid-cols-2 gap-4">
              <Card className="border-slate-200 cursor-pointer hover:border-blue-400 transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <FileText className="w-5 h-5" />
                        FLOW.md
                      </CardTitle>
                      <CardDescription>流程說明</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-slate-600">
                    {analysisResult?.flowMarkdown
                      ? `${analysisResult.flowMarkdown.split("\n").length} 行`
                      : "尚未生成"}
                  </p>
                </CardContent>
              </Card>

              <Card className="border-slate-200 cursor-pointer hover:border-blue-400 transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <FileText className="w-5 h-5" />
                        DATA_DEPENDENCY.md
                      </CardTitle>
                      <CardDescription>欄位依賴分析</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-slate-600">
                    {analysisResult?.dataDependencyMarkdown
                      ? `${analysisResult.dataDependencyMarkdown.split("\n").length} 行`
                      : "尚未生成"}
                  </p>
                </CardContent>
              </Card>

              <Card className="border-slate-200 cursor-pointer hover:border-blue-400 transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5" />
                        RISKS.md
                      </CardTitle>
                      <CardDescription>風險提示</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-slate-600">
                    {analysisResult?.risksMarkdown
                      ? `${analysisResult.risksMarkdown.split("\n").length} 行`
                      : "尚未生成"}
                  </p>
                </CardContent>
              </Card>

              <Card className="border-slate-200 cursor-pointer hover:border-blue-400 transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <FileText className="w-5 h-5" />
                        RULES.yaml
                      </CardTitle>
                      <CardDescription>規則定義</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-slate-600">
                    {analysisResult?.rulesYaml
                      ? `${analysisResult.rulesYaml.split("\n").length} 行`
                      : "尚未生成"}
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
