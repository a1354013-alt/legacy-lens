import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, GitBranch, Loader2, Upload } from "lucide-react";
import { projectLanguages, projectSourceTypes, type ProjectLanguage, type ProjectSourceType } from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

type WorkflowPhase = "idle" | "creating" | "importing" | "analyzing" | "redirecting";

type ImportedFile = {
  path: string;
  fileName: string;
  language: string;
  size: number;
};

type ImportWarning = {
  code: string;
  message: string;
  filePath?: string;
};

function getPhaseLabel(phase: WorkflowPhase) {
  switch (phase) {
    case "creating":
      return "Creating project";
    case "importing":
      return "Importing source";
    case "analyzing":
      return "Running analysis";
    case "redirecting":
      return "Opening result";
    default:
      return "Waiting";
  }
}

function getPhaseDescription(phase: WorkflowPhase) {
  switch (phase) {
    case "creating":
      return "The server is creating a project record and reserving its identifier.";
    case "importing":
      return "The server is validating the source package and storing imported files.";
    case "analyzing":
      return "The analyzer is producing persisted artifacts. Results are heuristic and should be reviewed.";
    case "redirecting":
      return "The latest persisted analysis result is ready and the UI is opening the report page.";
    default:
      return "Fill out the form to start.";
  }
}

async function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.split(",")[1] ?? value);
    };
    reader.onerror = () => reject(new Error("Failed to read the selected file."));
    reader.readAsDataURL(file);
  });
}

export default function ImportProject() {
  const [, setLocation] = useLocation();
  const [sourceType, setSourceType] = useState<ProjectSourceType>("upload");
  const [language, setLanguage] = useState<ProjectLanguage>("go");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<WorkflowPhase>("idle");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importedFiles, setImportedFiles] = useState<ImportedFile[]>([]);
  const [importWarnings, setImportWarnings] = useState<ImportWarning[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projectQuery = trpc.projects.getById.useQuery(projectId ?? -1, {
    enabled: projectId !== null && phase !== "idle",
    refetchInterval: phase === "idle" ? false : 1500,
    refetchOnWindowFocus: false,
  });

  const createProjectMutation = trpc.projects.create.useMutation();
  const uploadFilesMutation = trpc.projects.uploadFiles.useMutation();
  const cloneGitMutation = trpc.projects.cloneGit.useMutation();
  const analyzeMutation = trpc.analysis.trigger.useMutation();

  const isBusy =
    createProjectMutation.isPending ||
    uploadFilesMutation.isPending ||
    cloneGitMutation.isPending ||
    analyzeMutation.isPending;

  const validateForm = () => {
    if (!projectName.trim()) {
      throw new Error("Project name is required.");
    }
    if (sourceType === "upload" && !uploadedFile) {
      throw new Error("Please choose a ZIP archive.");
    }
    if (sourceType === "git" && !gitUrl.trim()) {
      throw new Error("Repository URL is required.");
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      validateForm();
      setPhase("creating");

      const createResult = await createProjectMutation.mutateAsync({
        name: projectName.trim(),
        description: description.trim() || undefined,
        language,
        sourceType,
      });

      setProjectId(createResult.projectId);
      setPhase("importing");

      const importResult =
        sourceType === "upload"
          ? await uploadFilesMutation.mutateAsync({
              projectId: createResult.projectId,
              zipContent: await fileToBase64(uploadedFile as File),
            })
          : await cloneGitMutation.mutateAsync({
              projectId: createResult.projectId,
              gitUrl: gitUrl.trim(),
            });

      setImportedFiles(importResult.files);
      setImportWarnings(importResult.warnings);
      setPhase("analyzing");

      const analysisResult = await analyzeMutation.mutateAsync(createResult.projectId);
      setPhase("redirecting");

      toast.success(
        analysisResult.status === "partial"
          ? "Analysis completed with warnings. Review the result before using it as source-of-truth."
          : "Analysis completed."
      );
      setLocation(`/projects/${createResult.projectId}/analysis`);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Import failed.";
      setError(message);
      setPhase("idle");
      toast.error(message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-4">
          <Button variant="ghost" onClick={() => setLocation("/")}>
            <ArrowLeft className="mr-2 size-4" />
            Back to projects
          </Button>
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">Create project</h1>
            <p className="text-sm text-slate-600">Source import and analysis remain server-owned. This screen shows the current workflow phase rather than a fake percentage.</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Workflow failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {phase !== "idle" ? (
          <Card>
            <CardHeader>
              <CardTitle>{getPhaseLabel(phase)}</CardTitle>
              <CardDescription>{getPhaseDescription(phase)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-600">
              <p>Server project status: {projectQuery.data?.status ?? "pending"}</p>
              <p>Analysis status: {projectQuery.data?.analysisStatus ?? "pending"}</p>
              {importedFiles.length > 0 ? <p>Imported files: {importedFiles.length}</p> : null}
              {importWarnings.length > 0 ? <p>Import warnings: {importWarnings.length}</p> : null}
            </CardContent>
          </Card>
        ) : null}

        {importWarnings.length > 0 ? (
          <Alert>
            <AlertTitle>Some files were skipped during import</AlertTitle>
            <AlertDescription>
              {importWarnings.slice(0, 5).map((warning) => warning.filePath ?? warning.message).join(" | ")}
            </AlertDescription>
          </Alert>
        ) : null}

        <form className="space-y-6" onSubmit={handleSubmit}>
          <Card>
            <CardHeader>
              <CardTitle>Import source</CardTitle>
              <CardDescription>Choose the source type first, then provide the project metadata and import payload.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {projectSourceTypes.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={isBusy}
                  onClick={() => setSourceType(value)}
                  className={`rounded-lg border p-4 text-left transition ${sourceType === value ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-900 hover:border-slate-400"}`}
                >
                  <div className="mb-3 flex items-center gap-2">
                    {value === "upload" ? <Upload className="size-5" /> : <GitBranch className="size-5" />}
                    <span className="font-medium">{value === "upload" ? "ZIP upload" : "Git clone"}</span>
                  </div>
                  <p className={`text-sm ${sourceType === value ? "text-slate-100" : "text-slate-600"}`}>
                    {value === "upload"
                      ? "Upload a ZIP archive and let the server validate and persist supported source files."
                      : "Clone a Git repository on the server and import supported source files."}
                  </p>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Project details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="legacy-erp-migration"
                  disabled={isBusy}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-description">Description</Label>
                <Textarea
                  id="project-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional context about the imported system or validation scope."
                  disabled={isBusy}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-language">Primary language</Label>
                <Select value={language} onValueChange={(value) => setLanguage(value as ProjectLanguage)} disabled={isBusy}>
                  <SelectTrigger id="project-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projectLanguages.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {sourceType === "upload" ? (
            <Card>
              <CardHeader>
                <CardTitle>Upload ZIP archive</CardTitle>
                <CardDescription>The server accepts supported source files and skips ignored build or dependency directories. Delphi import includes .pas/.dpr/.delphi and related files such as .dfm, .inc, .dpk, and .fmx.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBusy}
                  className="flex w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-600 transition hover:border-slate-500"
                >
                  <Upload className="size-8" />
                  <span>{uploadedFile ? uploadedFile.name : "Choose a ZIP archive"}</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] ?? null;
                    setUploadedFile(nextFile);
                  }}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Git repository</CardTitle>
                <CardDescription>Use an HTTP(S) or SSH repository URL that the server can clone directly.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="git-url">Repository URL</Label>
                <Input
                  id="git-url"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  disabled={isBusy}
                />
              </CardContent>
            </Card>
          )}

          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={() => setLocation("/")} disabled={isBusy}>
              Cancel
            </Button>
            <Button type="submit" disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Start import
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
