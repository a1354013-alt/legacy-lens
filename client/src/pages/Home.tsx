import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, Plus, FileSearch, GitBranch, Trash2, RefreshCcw, FileText } from "lucide-react";
import { projectStatusLabels, analysisStatusLabels, type AnalysisStatus, type ProjectStatus, type ProjectLanguage, type ProjectSourceType } from "@shared/contracts";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useLocation } from "wouter";

type ProjectRow = {
  id: number;
  name: string;
  description: string | null;
  language: ProjectLanguage;
  sourceType: ProjectSourceType;
  status: ProjectStatus;
  importProgress: number;
  analysisProgress: number;
  errorMessage: string | null;
  analysisStatus: AnalysisStatus;
};

function getBadgeVariant(status: ProjectStatus | AnalysisStatus) {
  if (status === "failed") return "destructive";
  if (status === "completed") return "default";
  return "secondary";
}

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const projectsQuery = trpc.projects.list.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
  });

  const deleteProjectMutation = trpc.projects.delete.useMutation({
    onSuccess: async () => {
      await utils.projects.list.invalidate();
    },
  });

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="size-10 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50">
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-10 px-6 py-16">
          <div className="space-y-4">
            <Badge variant="outline">PlateauBreaker</Badge>
            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-950">
              匯入舊系統程式碼，產出可追蹤的流程、資料依賴與風險報告。
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-600">
              目前版本支援 ZIP 匯入與 Git 匯入，分析 Go、SQL、Delphi 檔案，並將結果寫回資料庫後提供下載。
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard title="流程閉合" description="專案建立、檔案匯入、分析寫回、報告下載與刪除都會反映在狀態欄位。" />
            <FeatureCard title="資料契約清楚" description="前後端共用狀態與下載契約，避免欄位漂移與假成功畫面。" />
            <FeatureCard title="可追蹤結果" description="風險、欄位依賴、符號、規則與 Markdown 產物會一起落地。" />
          </div>

          <div>
            <Button size="lg" onClick={() => (window.location.href = getLoginUrl())}>
              登入並開始
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const projects = projectsQuery.data ?? [];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-sm font-medium text-slate-500">PlateauBreaker</p>
            <h1 className="text-2xl font-semibold text-slate-950">專案首頁</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{user?.name ?? user?.email ?? "使用者"}</span>
            <Button variant="outline" onClick={() => setLocation("/import")}>
              <Plus className="mr-2 size-4" />
              匯入專案
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await logout();
                window.location.href = getLoginUrl();
              }}
            >
              登出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        {projectsQuery.error ? (
          <Alert variant="destructive">
            <AlertTitle>專案列表載入失敗</AlertTitle>
            <AlertDescription>{projectsQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">最近專案</h2>
            <p className="text-sm text-slate-600">每個專案都會顯示匯入與分析的最新狀態。</p>
          </div>
          <Button variant="outline" onClick={() => projectsQuery.refetch()} disabled={projectsQuery.isFetching}>
            <RefreshCcw className="mr-2 size-4" />
            重新整理
          </Button>
        </div>

        {projectsQuery.isLoading ? (
          <div className="flex justify-center py-24">
            <Loader2 className="size-8 animate-spin text-slate-600" />
          </div>
        ) : projects.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileSearch />
                  </EmptyMedia>
                  <EmptyTitle>還沒有專案</EmptyTitle>
                  <EmptyDescription>先建立一個專案並匯入 ZIP 或 Git repository，之後才能啟動分析。</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => setLocation("/import")}>前往匯入頁</Button>
                </EmptyContent>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                deleting={deleteProjectMutation.isPending && deleteProjectMutation.variables === project.id}
                onOpen={() => setLocation(`/projects/${project.id}/analysis`)}
                onDelete={async () => {
                  const confirmed = window.confirm(`確定要刪除專案「${project.name}」嗎？這會一併刪除檔案與分析結果。`);
                  if (!confirmed) return;
                  try {
                    await deleteProjectMutation.mutateAsync(project.id);
                    toast.success("專案已刪除。");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "刪除失敗。");
                  }
                }}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-slate-600">{description}</p>
      </CardContent>
    </Card>
  );
}

function ProjectCard({
  project,
  deleting,
  onOpen,
  onDelete,
}: {
  project: ProjectRow;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => Promise<void>;
}) {
  const analysisStatus = project.analysisStatus ?? "pending";

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>{project.name}</CardTitle>
            <CardDescription>{project.description || "未提供描述"}</CardDescription>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge variant={getBadgeVariant(project.status)}>{projectStatusLabels[project.status]}</Badge>
            <Badge variant={getBadgeVariant(analysisStatus)}>{analysisStatusLabels[analysisStatus]}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <FileText className="size-4" />
            <span>{project.language.toUpperCase()}</span>
          </div>
          <div className="flex items-center gap-2">
            <GitBranch className="size-4" />
            <span>{project.sourceType === "git" ? "Git 匯入" : "ZIP 匯入"}</span>
          </div>
        </div>

        {project.importProgress > 0 && project.importProgress < 100 ? (
          <p className="text-sm text-slate-600">匯入進度 {project.importProgress}%</p>
        ) : null}

        {project.analysisProgress > 0 && project.status === "analyzing" ? (
          <p className="text-sm text-slate-600">分析進度 {project.analysisProgress}%</p>
        ) : null}

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>最近一次流程失敗</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={onOpen}>
            開啟結果
          </Button>
          <Button variant="ghost" disabled={deleting} onClick={() => void onDelete()}>
            {deleting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Trash2 className="mr-2 size-4" />}
            刪除
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
