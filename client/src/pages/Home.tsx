import { useAuth } from "@/_core/hooks/useAuth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { getAuthModeLabel, getLoginUrl, getLogoutRedirectUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import {
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

function getBadgeVariant(status: ProjectStatus | AnalysisStatus | "queued" | "running" | "failed") {
  if (status === "failed") return "destructive" as const;
  if (status === "completed") return "default" as const;
  return "secondary" as const;
}

export function getDisplayLanguage(language: string | null | undefined) {
  if (language === "go") return "Go";
  if (language === "delphi") return "Delphi";
  if (language === "sql") return "SQL";
  return "Unknown";
}

export function getProjectDisplayStatus(project: ProjectRow) {
  const latestJob = project.latestJob;

  if (latestJob?.status === "failed") {
    return latestJob.type === "analyze" ? "Analysis failed" : "Import failed";
  }

  if (project.status === "failed" || project.analysisStatus === "failed") {
    return project.analysisStatus === "failed" ? "Analysis failed" : "Import failed";
  }

  if (latestJob?.status === "queued") {
    return latestJob.type === "analyze" ? "Analysis queued" : "Import pending";
  }

  if (latestJob?.status === "running") {
    return latestJob.type === "analyze" ? "Analyzing" : "Importing";
  }

  if (project.analysisStatus === "completed" || project.analysisStatus === "partial") {
    return "Analysis ready";
  }

  if (project.status === "ready") {
    return "Ready for analysis";
  }

  if (project.status === "draft") {
    return latestJob ? "Import pending" : "Import not started";
  }

  return projectStatusLabels[project.status];
}

export function isAnalysisResultReady(project: ProjectRow) {
  return project.analysisStatus === "completed" || project.analysisStatus === "partial";
}

export function getProjectOpenActionLabel(project: ProjectRow) {
  return isAnalysisResultReady(project) ? "View analysis result" : "View progress";
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

  const refreshProjects = async () => {
    try {
      await utils.projects.list.invalidate();
      await projectsQuery.refetch();
      toast.success("Project list refreshed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Project refresh failed.");
    }
  };

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
              Analyze legacy Go, SQL, and Delphi code without losing the project trail.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-600">
              Upload a ZIP or Git source, track import progress, and review generated impact analysis when it is ready.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard title="Import source" description="Queue ZIP or Git imports with a real project job and visible progress." />
            <FeatureCard title="Inspect impact" description="Review symbols, fields, dependencies, risks, and rules after analysis completes." />
            <FeatureCard title="Demo ready" description="Local demo auth is explicit, and dashboard actions reflect server state." />
          </div>

          <div>
            <Button size="lg" onClick={() => (window.location.href = getLoginUrl())}>
              Sign in
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const projects = (projectsQuery.data ?? []) as ProjectRow[];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="shrink-0 border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-sm font-medium text-slate-500">Legacy Lens</p>
            <h1 className="text-2xl font-semibold text-slate-950">Project dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline" title={getAuthModeLabel()}>
              {user?.name ?? user?.email ?? getAuthModeLabel()}
            </span>
            <Button variant="outline" onClick={() => setLocation("/import")}>
              <Plus className="mr-2 size-4" />
              New project
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await logout();
                window.location.href = getLogoutRedirectUrl();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8 max-md:min-h-[calc(100vh-73px)]">
        {projectsQuery.error ? (
          <Alert variant="destructive">
            <AlertTitle>Project list failed to load</AlertTitle>
            <AlertDescription>{projectsQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Projects</h2>
            <p className="text-sm text-slate-600">Refresh reads the latest project, job, and analysis-result state from the server.</p>
          </div>
          <Button variant="outline" onClick={() => void refreshProjects()} disabled={projectsQuery.isFetching}>
            {projectsQuery.isFetching ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCcw className="mr-2 size-4" />}
            Refresh
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
                  <EmptyTitle>No projects yet</EmptyTitle>
                  <EmptyDescription>Create a project from a ZIP upload or Git URL to start analysis.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => setLocation("/import")}>Create project</Button>
                </EmptyContent>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="min-h-0 overflow-auto pr-1">
            <div className="grid gap-3 lg:grid-cols-2">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  deleting={deleteProjectMutation.isPending && deleteProjectMutation.variables === project.id}
                  onOpen={() => setLocation(`/projects/${project.id}/analysis`)}
                  onDelete={async () => {
                    const confirmed = window.confirm(`Delete project "${project.name}" and its jobs, files, and analysis artifacts?`);
                    if (!confirmed) return;
                    try {
                      await deleteProjectMutation.mutateAsync(project.id);
                      toast.success("Project deleted.");
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Project deletion failed.");
                    }
                  }}
                />
              ))}
            </div>
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
  const latestJob = project.latestJob;
  const displayStatus = getProjectDisplayStatus(project);

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>{project.name}</CardTitle>
            <CardDescription>{project.description || "No project description"}</CardDescription>
          </div>
          <Badge variant={displayStatus.endsWith("failed") ? "destructive" : getBadgeVariant(project.status)}>{displayStatus}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <FileText className="size-4" />
            <span>{getDisplayLanguage(project.language)}</span>
          </div>
          <div className="flex items-center gap-2">
            <GitBranch className="size-4" />
            <span>{project.sourceType === "git" ? "Git import" : "ZIP upload"}</span>
          </div>
        </div>

        {latestJob ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{projectJobTypeLabels[latestJob.type]}</span>
              <Badge variant={getBadgeVariant(latestJob.status)}>{latestJob.status}</Badge>
            </div>
            <Progress value={latestJob.progress} />
            <p className="text-xs text-slate-500">Progress {latestJob.progress}%</p>
            {latestJob.errorMessage ? <p className="text-xs text-red-600">{latestJob.errorMessage}</p> : null}
          </div>
        ) : null}

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Project error</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={onOpen}>
            {getProjectOpenActionLabel(project)}
          </Button>
          <Button variant="ghost" disabled={deleting} onClick={() => void onDelete()}>
            {deleting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Trash2 className="mr-2 size-4" />}
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
