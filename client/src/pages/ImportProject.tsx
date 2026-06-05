import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, GitBranch, Loader2, Upload } from "lucide-react";
import {
  focusLanguages,
  type FocusLanguage,
  type ProjectJobType,
  type ProjectSourceType,
} from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getImportUploadErrorMessage, readHttpApiError } from "@/lib/httpApiErrors";
import { trpc } from "@/lib/trpc";
import { t } from "@/locales";
import { projectJobStatusLabel, projectJobTypeLabel, projectStatusLabel } from "@/locales/uiLabels";
import { toast } from "sonner";
import { MAX_UPLOAD_ZIP_SIZE, validateUploadedZip } from "./importUpload";
import {
  acquireSubmitLock,
  invalidateProjectsListAfterImportSuccess,
  releaseSubmitLock,
  submitImportProject,
  type ImportUploadResponse,
} from "./importSubmit";

type WorkflowPhase = "idle" | "creating" | "waiting-import" | "waiting-analysis" | "redirecting";

export async function runImportProjectSubmitFlow<TJob>({
  validate,
  submit,
  afterSuccess,
  setPhase,
}: {
  validate: () => void;
  submit: () => Promise<TJob>;
  afterSuccess: (job: TJob) => Promise<void> | void;
  setPhase: (phase: WorkflowPhase) => void;
}) {
  validate();
  setPhase("creating");
  const job = await submit();
  await afterSuccess(job);
  setPhase("waiting-import");
  return job;
}

function getPhaseLabel(phase: WorkflowPhase) {
  return t(`importProject.phaseLabel.${phase}`);
}

function getPhaseDescription(phase: WorkflowPhase) {
  return t(`importProject.phaseDescription.${phase}`);
}

async function readApiErrorMessage(response: Response) {
  const payload = await readHttpApiError(response);
  if (payload) {
    return getImportUploadErrorMessage(response.status, payload, t("importProject.alerts.uploadFailed"));
  }

  return (await response.text()) || getImportUploadErrorMessage(response.status, null, t("importProject.alerts.uploadFailed"));
}

export default function ImportProject() {
  const [, setLocation] = useLocation();
  const [sourceType, setSourceType] = useState<ProjectSourceType>("upload");
  const [focusLanguage, setFocusLanguage] = useState<FocusLanguage>("go");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<WorkflowPhase>("idle");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [activeJobType, setActiveJobType] = useState<ProjectJobType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const analysisQueuedRef = useRef(false);
  const submittingRef = useRef(false);
  const utils = trpc.useUtils();

  const projectQuery = trpc.projects.getById.useQuery(projectId ?? -1, {
    enabled: projectId !== null,
    refetchInterval: (query) => {
      if (projectId === null) {
        return false;
      }

      const project = query.state.data;
      const isActive =
        project?.status === "importing" ||
        project?.status === "analyzing" ||
        project?.latestJob?.status === "queued" ||
        project?.latestJob?.status === "running";

      return isActive ? 1500 : false;
    },
    refetchOnWindowFocus: false,
  });

  const activeJobQuery = trpc.jobs.getById.useQuery(activeJobId ?? -1, {
    enabled: activeJobId !== null,
    refetchInterval: (query) => {
      if (activeJobId === null) {
        return false;
      }

      const status = query.state.data?.status;
      return status === "queued" || status === "running" || status === undefined ? 1500 : false;
    },
    refetchOnWindowFocus: false,
  });

  const analyzeMutation = trpc.analysis.trigger.useMutation();
  const isBusy = phase !== "idle" || analyzeMutation.isPending;

  useEffect(() => {
    const job = activeJobQuery.data;
    if (!job || !projectId || !activeJobType) {
      return;
    }

    if (job.status === "failed") {
      const message = job.errorMessage ?? t("importProject.alerts.importFailed");
      setError(message);
      setPhase("idle");
      setActiveJobId(null);
      setActiveJobType(null);
      releaseSubmitLock(submittingRef);
      toast.error(message);
      return;
    }

    if (job.status !== "completed") {
      return;
    }

    if (activeJobType === "import_zip" || activeJobType === "import_git") {
      if (analysisQueuedRef.current) {
        return;
      }

      analysisQueuedRef.current = true;
      setPhase("waiting-analysis");
      void analyzeMutation
        .mutateAsync(projectId)
        .then((result) => {
          setActiveJobId(result.jobId);
          setActiveJobType("analyze");
        })
        .catch((caughtError) => {
          const message = caughtError instanceof Error ? caughtError.message : t("importProject.alerts.analysisQueueFailed");
          setError(message);
          setPhase("idle");
          setActiveJobId(null);
          setActiveJobType(null);
          analysisQueuedRef.current = false;
          releaseSubmitLock(submittingRef);
          toast.error(message);
        });
      return;
    }

    if (activeJobType === "analyze") {
      setPhase("redirecting");
      toast.success(t("importProject.alerts.analysisComplete"));
      setLocation(`/projects/${projectId}/analysis`);
    }
  }, [activeJobQuery.data, activeJobType, analyzeMutation, projectId, setLocation]);

  const validateForm = () => {
    if (!projectName.trim()) {
      throw new Error(t("importProject.errors.projectNameRequired"));
    }

    if (sourceType === "upload" && !uploadedFile) {
      throw new Error(t("importProject.errors.fileRequired"));
    }

    if (sourceType === "git" && !gitUrl.trim()) {
      throw new Error(t("importProject.errors.gitUrlRequired"));
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!acquireSubmitLock(submittingRef)) {
      return;
    }

    setError(null);
    analysisQueuedRef.current = false;

    try {
      await runImportProjectSubmitFlow<ImportUploadResponse>({
        validate: validateForm,
        setPhase,
        submit: () =>
          submitImportProject(
            {
              projectName,
              description,
              focusLanguage,
              sourceType,
              uploadedFile,
              gitUrl,
            },
            readApiErrorMessage
          ),
        afterSuccess: async (job) => {
          await invalidateProjectsListAfterImportSuccess(utils);
          setProjectId(job.projectId);
          setActiveJobId(job.jobId);
          setActiveJobType(job.jobType);
        },
      });
      toast.success(t("importProject.alerts.importQueued"));
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : t("importProject.alerts.createFailed");
      setError(message);
      setPhase("idle");
      setActiveJobId(null);
      setActiveJobType(null);
      toast.error(message);
      releaseSubmitLock(submittingRef);
    }
  };

  const activeJob = activeJobQuery.data;
  const latestJob = projectQuery.data?.latestJob ?? activeJob ?? null;

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <header className="shrink-0 border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          <Button variant="ghost" onClick={() => setLocation("/")}>
            <ArrowLeft className="mr-2 size-4" />
            {t("importProject.backHome")}
          </Button>
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">{t("importProject.pageTitle")}</h1>
            <p className="text-sm text-slate-600">{t("importProject.pageDescription")}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 px-6 py-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("importProject.alerts.errorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {(phase !== "idle" || latestJob) && (
          <Card>
            <CardHeader>
              <CardTitle>{getPhaseLabel(phase)}</CardTitle>
              <CardDescription>{getPhaseDescription(phase)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-700">
              <div className="grid gap-2 md:grid-cols-2">
                <p>
                  {t("importProject.status.project")}:
                  {" "}
                  {projectQuery.data ? projectStatusLabel(projectQuery.data.status) : t("importProject.status.loading")}
                </p>
                <p>
                  {t("importProject.status.jobType")}:
                  {" "}
                  {latestJob ? projectJobTypeLabel(latestJob.type) : t("importProject.status.none")}
                </p>
                <p>
                  {t("importProject.status.jobStatus")}:
                  {" "}
                  {latestJob ? projectJobStatusLabel(latestJob.status) : t("importProject.status.none")}
                </p>
                <p>
                  {t("importProject.status.progress")}:
                  {" "}
                  {latestJob ? `${latestJob.progress}%` : "0%"}
                </p>
              </div>
              <Progress value={latestJob?.progress ?? 0} />
              {latestJob?.errorMessage ? <p className="text-red-600">{latestJob.errorMessage}</p> : null}
            </CardContent>
          </Card>
        )}

        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={handleSubmit}>
          <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <Card className="min-h-0">
              <CardHeader className="pb-3">
                <CardTitle>{t("importProject.detailCard.title")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="project-name">{t("importProject.detailCard.name")}</Label>
                  <Input
                    id="project-name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="legacy-erp-migration"
                    disabled={isBusy}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-description">{t("importProject.detailCard.description")}</Label>
                  <Textarea
                    id="project-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t("importProject.detailCard.descriptionPlaceholder")}
                    disabled={isBusy}
                    className="min-h-20"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-language">{t("importProject.detailCard.language")}</Label>
                  <Select value={focusLanguage} onValueChange={(value) => setFocusLanguage(value as FocusLanguage)} disabled={isBusy}>
                    <SelectTrigger id="project-language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {focusLanguages.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">{t("importProject.detailCard.languageHint")}</p>
                </div>
              </CardContent>
            </Card>

            <div className="flex min-h-0 flex-col gap-4">
              <Card className="shrink-0">
                <CardHeader className="pb-3">
                  <CardTitle>{t("importProject.sourceCard.title")}</CardTitle>
                  <CardDescription>{t("importProject.sourceCard.description")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setSourceType("upload")}
                    className={`rounded-lg border p-3 text-left transition ${
                      sourceType === "upload"
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-slate-200 bg-white text-slate-900 hover:border-slate-400"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Upload className="size-5" />
                      <span className="font-medium">{t("importProject.sourceCard.uploadTitle")}</span>
                    </div>
                    <p className={`text-sm ${sourceType === "upload" ? "text-slate-100" : "text-slate-600"}`}>
                      {t("importProject.sourceCard.uploadDescription")}
                    </p>
                  </button>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setSourceType("git")}
                    className={`rounded-lg border p-3 text-left transition ${
                      sourceType === "git"
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-slate-200 bg-white text-slate-900 hover:border-slate-400"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <GitBranch className="size-5" />
                      <span className="font-medium">{t("importProject.sourceCard.gitTitle")}</span>
                    </div>
                    <p className={`text-sm ${sourceType === "git" ? "text-slate-100" : "text-slate-600"}`}>
                      {t("importProject.sourceCard.gitDescription")}
                    </p>
                  </button>
                </CardContent>
              </Card>

              {sourceType === "upload" ? (
                <Card className="min-h-0">
                  <CardHeader className="pb-3">
                    <CardTitle>{t("importProject.uploadCard.title")}</CardTitle>
                    <CardDescription>{t("importProject.uploadCard.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isBusy}
                      className="flex h-40 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 text-sm text-slate-600 transition hover:border-slate-500"
                    >
                      <Upload className="size-8" />
                      <span>{uploadedFile ? uploadedFile.name : t("importProject.uploadCard.pickFile")}</span>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".zip"
                      className="hidden"
                      onChange={(event) => {
                        const nextFile = event.target.files?.[0] ?? null;
                        if (!nextFile) {
                          setUploadedFile(null);
                          return;
                        }

                        const uploadError = validateUploadedZip(nextFile);
                        if (uploadError) {
                          event.target.value = "";
                          setUploadedFile(null);
                          setError(uploadError);
                          toast.error(uploadError);
                          return;
                        }

                        setError(null);
                        setUploadedFile(nextFile);
                      }}
                    />
                    <p className="text-xs text-slate-500">
                      {t("importProject.uploadCard.fileLimit", {
                        size: (MAX_UPLOAD_ZIP_SIZE / (1024 * 1024)).toFixed(0),
                      })}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <Card className="min-h-0">
                  <CardHeader>
                    <CardTitle>{t("importProject.gitCard.title")}</CardTitle>
                    <CardDescription>{t("importProject.gitCard.description")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Label htmlFor="git-url">{t("importProject.gitCard.urlLabel")}</Label>
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
            </div>
          </section>

          <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t bg-slate-50/95 py-3 backdrop-blur">
            <Button type="button" variant="outline" onClick={() => setLocation("/")} disabled={isBusy}>
              {t("importProject.actions.cancel")}
            </Button>
            <Button type="submit" disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t("importProject.actions.submit")}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
