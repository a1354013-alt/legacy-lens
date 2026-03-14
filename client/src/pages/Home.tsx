import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Upload, GitBranch, BarChart3, AlertTriangle, FileText } from "lucide-react";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";

export default function Home() {
  const { user, loading, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { data: projects, isLoading: projectsLoading } = trpc.projects.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-slate-600">載入中...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
        {/* Header */}
        <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-blue-700 rounded-lg flex items-center justify-center">
                <FileText className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-slate-900">Legacy Lens</h1>
            </div>
            <a href={getLoginUrl()} className="text-blue-600 hover:text-blue-700 font-medium">
              登入
            </a>
          </div>
        </header>

        {/* Hero Section */}
        <section className="container mx-auto px-4 py-20">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="text-5xl font-bold text-slate-900 mb-6">
              程式碼考古 × 規則文件生成
            </h2>
            <p className="text-xl text-slate-600 mb-8">
              把看不懂的舊系統程式碼（Delphi/Go/SQL）變成「可接手的規格書＋風險清單」
            </p>
            <a href={getLoginUrl()}>
              <Button size="lg" className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-6 text-lg">
                開始使用
              </Button>
            </a>
          </div>
        </section>

        {/* Features */}
        <section className="container mx-auto px-4 py-16">
          <div className="grid md:grid-cols-3 gap-8">
            <Card className="border-slate-200 hover:shadow-lg transition-shadow">
              <CardHeader>
                <FileText className="w-8 h-8 text-blue-600 mb-2" />
                <CardTitle>自動生成文件</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-600">
                  一鍵生成 FLOW.md、DATA_DEPENDENCY.md、RISKS.md，清晰展示系統流程與風險
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200 hover:shadow-lg transition-shadow">
              <CardHeader>
                <BarChart3 className="w-8 h-8 text-blue-600 mb-2" />
                <CardTitle>欄位依賴分析</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-600">
                  清晰展示欄位的讀/寫/計算關係，快速定位變更影響範圍
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200 hover:shadow-lg transition-shadow">
              <CardHeader>
                <AlertTriangle className="w-8 h-8 text-blue-600 mb-2" />
                <CardTitle>風險自動檢測</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-600">
                  檢測魔法值、多處寫入、缺少條件等風險，每個結論都附出處
                </p>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-blue-700 rounded-lg flex items-center justify-center">
              <FileText className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Legacy Lens</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-slate-600">{user?.name}</span>
            <Button variant="outline" size="sm">
              登出
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-12">
        {/* Page Title */}
        <div className="mb-12">
          <h2 className="text-4xl font-bold text-slate-900 mb-2">我的專案</h2>
          <p className="text-slate-600">管理和分析您的程式碼專案</p>
        </div>

        {/* Import Project Button */}
        <div className="mb-8">
          <Button
            size="lg"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => setLocation("/import")}
          >
            <Upload className="w-5 h-5 mr-2" />
            匯入新專案
          </Button>
        </div>

        {/* Projects Grid */}
        {projectsLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <Card
                key={project.id}
                className="border-slate-200 hover:shadow-lg transition-all cursor-pointer"
                onClick={() => setLocation(`/projects/${project.id}`)}
              >
                <CardHeader>
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{project.name}</CardTitle>
                      <CardDescription>{project.description}</CardDescription>
                    </div>
                    <Badge variant={project.status === "completed" ? "default" : "secondary"}>
                      {getStatusLabel(project.status)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-600">語言:</span>
                      <span className="font-medium text-slate-900">{project.language.toUpperCase()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">來源:</span>
                      <span className="font-medium text-slate-900">
                        {project.sourceType === "upload" ? "上傳" : "Git"}
                      </span>
                    </div>
                    {project.status === "analyzing" && (
                      <div className="mt-4">
                        <div className="w-full bg-slate-200 rounded-full h-2">
                          <div
                            className="bg-blue-600 h-2 rounded-full transition-all"
                            style={{ width: `${project.analysisProgress}%` }}
                          />
                        </div>
                        <p className="text-xs text-slate-500 mt-1">{project.analysisProgress}%</p>
                      </div>
                    )}
                    {project.status === "failed" && project.errorMessage && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
                        {project.errorMessage}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="border-slate-200 border-dashed">
            <CardContent className="pt-12 pb-12 text-center">
              <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-600 mb-4">還沒有任何專案</p>
              <Button
                variant="outline"
                onClick={() => setLocation("/import")}
              >
                建立第一個專案
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

function getStatusLabel(status: string | null): string {
  if (!status) return "未知";
  const labels: Record<string, string> = {
    pending: "待分析",
    analyzing: "分析中",
    completed: "已完成",
    failed: "失敗",
  };
  return labels[status] || status;
}
