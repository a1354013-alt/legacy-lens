import { useAuth } from "@/_core/hooks/useAuth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { analysisStatusLabels, projectStatusLabels, type AnalysisStatus, type FocusLanguage, type ProjectSourceType, type ProjectStatus } from "@shared/contracts";
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
};

function getBadgeVariant(status: ProjectStatus | AnalysisStatus) {
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
              Import a legacy codebase, analyze structural dependencies, and export a reviewable report package.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-600">
              The current delivery path focuses on deterministic import, server-owned workflow state, persisted analysis artifacts, and reproducible report export.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard title="Import Sources" description="Create a project from ZIP upload or Git clone and store normalized source files in MySQL." />
            <FeatureCard title="Persisted Analysis" description="Run heuristic analysis for Go, SQL, and Delphi, then persist symbols, dependencies, risks, rules, and documents." />
            <FeatureCard title="Exportable Reports" description="Review the saved result in the UI and download the same persisted report bundle as a ZIP archive." />
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

  const projects = projectsQuery.data ?? [];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-sm font-medium text-slate-500">Legacy Lens</p>
            <h1 className="text-2xl font-semibold text-slate-950">Projects</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{user?.name ?? user?.email ?? "Signed-in user"}</span>
            <Button variant="outline" onClick={() => setLocation("/import")}>
              <Plus className="mr-2 size-4" />
              New project
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await logout();
                window.location.href = getLoginUrl();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        {projectsQuery.error ? (
          <Alert variant="destructive">
            <AlertTitle>Failed to load projects</AlertTitle>
            <AlertDescription>{projectsQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Recent work</h2>
            <p className="text-sm text-slate-600">Server workflow state and analysis status are shown separately so the delivery path stays traceable.</p>
          </div>
          <Button variant="outline" onClick={() => projectsQuery.refetch()} disabled={projectsQuery.isFetching}>
            <RefreshCcw className="mr-2 size-4" />
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
                  <EmptyDescription>Create a project and import a ZIP archive or Git repository to begin analysis.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => setLocation("/import")}>Create project</Button>
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
                  const confirmed = window.confirm(`Delete project "${project.name}" and all imported files, analysis artifacts, and reports?`);
                  if (!confirmed) return;
                  try {
                    await deleteProjectMutation.mutateAsync(project.id);
                    toast.success("Project deleted.");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Failed to delete project.");
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
            <CardDescription>{project.description || "No description provided."}</CardDescription>
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
            <span>{project.sourceType === "git" ? "Git import" : "ZIP upload"}</span>
          </div>
        </div>

        {project.status === "importing" ? <p className="text-sm text-slate-600">Import is running on the server.</p> : null}
        {project.status === "analyzing" ? <p className="text-sm text-slate-600">Analysis is running on the server.</p> : null}

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Latest workflow error</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={onOpen}>
            Open analysis
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
