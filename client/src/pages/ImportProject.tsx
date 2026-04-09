import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, GitBranch, Loader2, Upload } from "lucide-react";
import { projectLanguages, projectSourceTypes, type ProjectLanguage, type ProjectSourceType } from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

type WorkflowPhase = "idle" | "creating" | "importing" | "analyzing" | "done";

type ImportedFile = {
  path: string;
  fileName: string;
  language: string;
  size: number;
};

function getPhaseLabel(phase: WorkflowPhase) {
  switch (phase) {
    case "creating":
      return "建立專案中";
    case "importing":
      return "匯入檔案中";
    case "analyzing":
      return "分析中";
    case "done":
      return "流程完成";
    default:
      return "尚未開始";
  }
}

async function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.split(",")[1] ?? value);
    };
    reader.onerror = () => reject(new Error("無法讀取上傳檔案。"));
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
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [importedFiles, setImportedFiles] = useState<ImportedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      throw new Error("請輸入專案名稱。");
    }
    if (sourceType === "upload" && !uploadedFile) {
      throw new Error("請選擇 ZIP 檔案。");
    }
    if (sourceType === "git" && !gitUrl.trim()) {
      throw new Error("請輸入 Git repository URL。");
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      validateForm();
      setPhase("creating");
      setProgress(5);

      const createResult = await createProjectMutation.mutateAsync({
        name: projectName.trim(),
        description: description.trim() || undefined,
        language,
        sourceType,
      });

      const projectId = createResult.projectId;
      setPhase("importing");
      setProgress(25);

      const importResult =
        sourceType === "upload"
          ? await uploadFilesMutation.mutateAsync({
              projectId,
              zipContent: await fileToBase64(uploadedFile as File),
            })
          : await cloneGitMutation.mutateAsync({
              projectId,
              gitUrl: gitUrl.trim(),
            });

      setImportedFiles(importResult.files);
      setProgress(60);
      setPhase("analyzing");

      const analysisResult = await analyzeMutation.mutateAsync(projectId);
      setProgress(100);
      setPhase("done");

      toast.success(
        analysisResult.status === "partial" ? "分析已完成，但有部分警告。" : "專案已成功完成分析。"
      );
      setLocation(`/projects/${projectId}/analysis`);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "匯入流程失敗。";
      setError(message);
      setPhase("idle");
      setProgress(0);
      toast.error(message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-4">
          <Button variant="ghost" onClick={() => setLocation("/")}>
            <ArrowLeft className="mr-2 size-4" />
            返回首頁
          </Button>
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">匯入專案</h1>
            <p className="text-sm text-slate-600">建立專案後立即匯入檔案並啟動分析。</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>流程中斷</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {phase !== "idle" ? (
          <Card>
            <CardHeader>
              <CardTitle>{getPhaseLabel(phase)}</CardTitle>
              <CardDescription>只有後端狀態落地成功後才會前進到下一步。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={progress} />
              <p className="text-sm text-slate-600">{progress}%</p>
              {importedFiles.length > 0 ? (
                <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
                  已匯入 {importedFiles.length} 個檔案。
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <form className="space-y-6" onSubmit={handleSubmit}>
          <Card>
            <CardHeader>
              <CardTitle>來源</CardTitle>
              <CardDescription>ZIP 與 Git 匯入都會在後端真正寫入檔案並更新專案狀態。</CardDescription>
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
                    <span className="font-medium">{value === "upload" ? "ZIP 匯入" : "Git 匯入"}</span>
                  </div>
                  <p className={`text-sm ${sourceType === value ? "text-slate-100" : "text-slate-600"}`}>
                    {value === "upload" ? "適合本機整理好的壓縮專案。" : "適合直接從 repository clone 後掃描。"}
                  </p>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>專案資訊</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">專案名稱</Label>
                <Input
                  id="project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="例如 legacy-erp-migration"
                  disabled={isBusy}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-description">描述</Label>
                <Textarea
                  id="project-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="可選，說明這個專案的範圍與背景。"
                  disabled={isBusy}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-language">主要語言</Label>
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
                <CardTitle>上傳 ZIP</CardTitle>
                <CardDescription>只會讀取支援的程式碼檔案，並忽略建置輸出與依賴資料夾。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBusy}
                  className="flex w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-600 transition hover:border-slate-500"
                >
                  <Upload className="size-8" />
                  <span>{uploadedFile ? uploadedFile.name : "選擇或拖放 ZIP 檔案"}</span>
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
                <CardDescription>支援 HTTPS 與 SSH 格式，clone 失敗時會明確回傳錯誤。</CardDescription>
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
              取消
            </Button>
            <Button type="submit" disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              建立並分析
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
