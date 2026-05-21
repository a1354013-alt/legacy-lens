import { useAuth } from "@/_core/hooks/useAuth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  analysisStatusLabels,
  projectJobStatusLabels,
  projectJobTypeLabels,
  projectStatusLabels,
  type AnalysisStatus,
  type FocusLanguage,
  type ProjectSourceType,
  type ProjectStatus,
} from "@shared/contracts";
import { FileSearch, FileText, GitBranch, Loader2, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type ProjectRow = {
  id: number;
  name: string;
  description: string | null;
  language: FocusLanguage;
  sourceType: ProjectSourceType;
  status: ProjectStatus;
  importProgress: number;
  analysisProgress: number;
  errorMessage: string | null;
  analysisStatus: AnalysisStatus;
  latestJob: {
    id: number;
    type: "import_zip" | "import_git" | "analyze";
    status: "queued" | "running" | "completed" | "failed";
    progress: number;
    errorMessage: string | null;
  } | null;
};

function hasActiveProjectWork(project: ProjectRow) {
  return (
    project.status === "importing" ||
    project.status === "analyzing" ||
    project.latestJob?.status === "queued" ||
    project.latestJob?.status === "running"
  );
}

export function getProjectsPollingInterval(projects: ProjectRow[]) {
  return projects.some(hasActiveProjectWork) ? 2000 : 15000;
}

function getBadgeVariant(status: ProjectStatus | AnalysisStatus | "queued" | "running") {
  if (status === "failed") return "destructive" as const;
  if (status === "completed") return "default" as const;
  return "secondary" as const;
}

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const projectsQuery = trpc.projects.list.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const projects = (query.state.data ?? []) as ProjectRow[];
      return getProjectsPollingInterval(projects);
    },
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
            <Badge variant="outline">Legacy Lens</Badge>
            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-950">
              匯入舊系統原始碼，分析結構依賴，並輸出可審閱的報告封包。
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-600">
              支援 Go / SQL / Delphi，提供可追蹤的匯入工作、持久化分析結果與可重現的報告下載。
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard title="來源匯入" description="透過 ZIP 或 Git 建立專案，由伺服器統一驗證與儲存檔案。" />
            <FeatureCard title="持久化分析" description="將 Symbols、Dependencies、Fields、Risks、Rules 與文件輸出寫入資料庫。" />
            <FeatureCard title="可交付報告" description="在 UI 檢視摘要後，下載與資料庫一致的 Report ZIP。" />
          </div>

          <div>
            <Button size="lg" onClick={() => (window.location.href = getLoginUrl())}>
              登入開始使用
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const projects = (projectsQuery.data ?? []) as ProjectRow[];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-sm font-medium text-slate-500">Legacy Lens</p>
            <h1 className="text-2xl font-semibold text-slate-950">專案列表</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{user?.name ?? user?.email ?? "已登入使用者"}</span>
            <Button variant="outline" onClick={() => setLocation("/import")}>
              <Plus className="mr-2 size-4" />
              建立專案
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
            <AlertTitle>讀取專案失敗</AlertTitle>
            <AlertDescription>{projectsQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">最近工作</h2>
            <p className="text-sm text-slate-600">專案狀態與工作佇列狀態分開顯示，便於追蹤目前卡在哪個階段。</p>
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
                  <EmptyTitle>目前還沒有專案</EmptyTitle>
                  <EmptyDescription>建立專案後即可上傳 ZIP 或輸入 Git 儲存庫開始分析。</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => setLocation("/import")}>建立第一個專案</Button>
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
                  const confirmed = window.confirm(`確定要刪除專案「${project.name}」以及所有匯入檔案、分析結果與報告嗎？`);
                  if (!confirmed) return;
                  try {
                    await deleteProjectMutation.mutateAsync(project.id);
                    toast.success("專案已刪除。");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "刪除專案失敗。");
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
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>{project.name}</CardTitle>
            <CardDescription>{project.description || "尚未提供描述。"}</CardDescription>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge variant={getBadgeVariant(project.status)}>{projectStatusLabels[project.status]}</Badge>
            <Badge variant={getBadgeVariant(project.analysisStatus)}>{analysisStatusLabels[project.analysisStatus]}</Badge>
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
            <span>{project.sourceType === "git" ? "Git 匯入" : "ZIP 上傳"}</span>
          </div>
        </div>

        {project.latestJob ? (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{projectJobTypeLabels[project.latestJob.type]}</span>
              <Badge variant={getBadgeVariant(project.latestJob.status)}>{projectJobStatusLabels[project.latestJob.status]}</Badge>
            </div>
            <Progress value={project.latestJob.progress} />
            <p className="text-xs text-slate-500">進度 {project.latestJob.progress}%</p>
            {project.latestJob.errorMessage ? <p className="text-xs text-red-600">{project.latestJob.errorMessage}</p> : null}
          </div>
        ) : null}

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>最近一次流程錯誤</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={onOpen}>
            開啟分析結果
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
