import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Upload, GitBranch, ArrowLeft, AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";

export default function ImportProject() {
  const [, setLocation] = useLocation();
  const [sourceType, setSourceType] = useState<"upload" | "git">("upload");
  const [language, setLanguage] = useState<"go" | "sql" | "delphi">("go");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<"idle" | "uploading" | "analyzing" | "complete">("idle");
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ fileName: string; language: string; size: number }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createProjectMutation = trpc.projects.create.useMutation();
  const uploadFilesMutation = trpc.projects.uploadFiles.useMutation();
  const triggerAnalysisMutation = trpc.analysis.trigger.useMutation();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type !== "application/zip" && !file.name.endsWith(".zip")) {
        setError("請選擇 ZIP 檔案");
        return;
      }
      setUploadedFile(file);
      setError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      if (file.type !== "application/zip" && !file.name.endsWith(".zip")) {
        setError("請選擇 ZIP 檔案");
        return;
      }
      setUploadedFile(file);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    setCurrentStep("uploading");
    setUploadProgress(0);

    try {
      // 驗證輸入
      if (!projectName.trim()) {
        throw new Error("請輸入專案名稱");
      }

      if (sourceType === "upload" && !uploadedFile) {
        throw new Error("請選擇要上傳的 ZIP 檔案");
      }

      if (sourceType === "git" && !gitUrl.trim()) {
        throw new Error("請輸入 Git URL");
      }

      // Step 1: 建立專案
      setUploadProgress(10);
      const projectResult = await createProjectMutation.mutateAsync({
        name: projectName,
        language: language as "go" | "sql" | "delphi",
        sourceType: sourceType,
        description: description || undefined,
      });

      if (!projectResult.success) {
        throw new Error("建立專案失敗");
      }

      // 提取實際的 projectId
      const actualProjectId = projectResult.projectId;
      if (!actualProjectId) {
        throw new Error("無法獲取專案 ID");
      }

      toast.success("專案建立成功！");
      setUploadProgress(30);

      // Step 2: 上傳 ZIP 檔案
      if (sourceType === "upload" && uploadedFile) {
        // 讀取檔案為 Base64（使用 FileReader，相容瀏覽器環境）
        const base64Content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // 移除 data:application/zip;base64, 前綴
            const base64 = result.split(",")[1] || result;
            resolve(base64);
          };
          reader.onerror = () => reject(new Error("檔案讀取失敗"));
          reader.readAsDataURL(uploadedFile);
        });

        setUploadProgress(50);

        // 呼叫上傳 API
        const uploadResult = await uploadFilesMutation.mutateAsync({
          projectId: actualProjectId, // 使用實際的 projectId
          zipContent: base64Content,
        });

        if (!uploadResult.success) {
          throw new Error("上傳檔案失敗");
        }

        setUploadedFiles(uploadResult.files);
        toast.success(`成功上傳 ${uploadResult.fileCount} 個檔案！`);
        setUploadProgress(70);

        // Step 3: 觸發分析
        setCurrentStep("analyzing");
        setAnalysisProgress(0);

        const analysisResult = await triggerAnalysisMutation.mutateAsync(actualProjectId); // 使用實際的 projectId

        if (!analysisResult.success) {
          throw new Error("分析失敗");
        }

        setAnalysisProgress(100);
        setCurrentStep("complete");
        toast.success("分析完成！");

        // 導向結果頁面
        setTimeout(() => {
          setLocation(`/projects/${actualProjectId}/analysis`); // 使用實際的 projectId
        }, 1500);
      } else {
        // Git 上傳流程（待實作）
        toast.info("Git 上傳功能開發中...");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "未知錯誤";
      setError(errorMessage);
      setCurrentStep("idle");
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/")}
            disabled={isLoading}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">匯入新專案</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12">
        <div className="max-w-2xl mx-auto">
          {error && (
            <Card className="mb-6 border-red-200 bg-red-50">
              <CardContent className="pt-6">
                <div className="flex gap-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <p className="text-red-800">{error}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {currentStep !== "idle" && (
            <Card className="mb-6 border-blue-200 bg-blue-50">
              <CardContent className="pt-6">
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      {currentStep === "uploading" && (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                          <span className="text-blue-900 font-medium">上傳檔案中...</span>
                        </>
                      )}
                      {currentStep === "analyzing" && (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                          <span className="text-blue-900 font-medium">分析中...</span>
                        </>
                      )}
                      {currentStep === "complete" && (
                        <>
                          <CheckCircle className="w-4 h-4 text-green-600" />
                          <span className="text-green-900 font-medium">完成！</span>
                        </>
                      )}
                    </div>
                    <Progress
                      value={currentStep === "uploading" ? uploadProgress : analysisProgress}
                      className="h-2"
                    />
                  </div>

                  {uploadedFiles.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm font-medium text-blue-900 mb-2">
                        已上傳 {uploadedFiles.length} 個檔案：
                      </p>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {uploadedFiles.map((file, idx) => (
                          <div key={idx} className="text-xs text-blue-800 flex justify-between">
                            <span>{file.fileName}</span>
                            <span className="text-blue-600">({file.language})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <form onSubmit={handleSubmit} className="space-y-8">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>選擇來源類型</CardTitle>
                <CardDescription>選擇如何提供您的程式碼</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setSourceType("upload")}
                    disabled={isLoading}
                    className={`p-4 border-2 rounded-lg transition-all ${
                      sourceType === "upload"
                        ? "border-blue-600 bg-blue-50"
                        : "border-slate-200 hover:border-slate-300"
                    } ${isLoading ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <Upload className="w-8 h-8 mx-auto mb-2 text-blue-600" />
                    <p className="font-medium text-slate-900">上傳資料夾</p>
                    <p className="text-sm text-slate-600">ZIP 或本地資料夾</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSourceType("git")}
                    disabled={true}
                    className={`p-4 border-2 rounded-lg transition-all opacity-50 cursor-not-allowed border-slate-200`}
                  >
                    <GitBranch className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                    <p className="font-medium text-slate-600">Git Clone</p>
                    <p className="text-sm text-slate-500">從 Git 倉庫克隆</p>
                    <p className="text-xs text-amber-600 mt-2 font-semibold">Beta - 開發中</p>
                  </button>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>專案信息</CardTitle>
                <CardDescription>提供您的專案基本信息</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <Label htmlFor="projectName">專案名稱 *</Label>
                  <Input
                    id="projectName"
                    placeholder="例如：ERP System v2.0"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    required
                    disabled={isLoading}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label htmlFor="description">描述</Label>
                  <Textarea
                    id="description"
                    placeholder="簡單描述您的專案..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={isLoading}
                    className="mt-2"
                    rows={3}
                  />
                </div>

                <div>
                  <Label htmlFor="language">主要語言 *</Label>
                  <Select value={language} onValueChange={(value) => setLanguage(value as any)} disabled={isLoading}>
                    <SelectTrigger id="language" className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="go">Go</SelectItem>
                      <SelectItem value="sql">SQL</SelectItem>
                      <SelectItem value="delphi">Delphi</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {sourceType === "git" ? (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle>Git 倉庫</CardTitle>
                  <CardDescription>提供 Git 倉庫的 URL</CardDescription>
                </CardHeader>
                <CardContent>
                  <Label htmlFor="gitUrl">Git URL *</Label>
                  <Input
                    id="gitUrl"
                    placeholder="https://github.com/username/repo.git"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    required
                    disabled={isLoading}
                    className="mt-2"
                  />
                </CardContent>
              </Card>
            ) : (
              <Card className="border-slate-200 border-dashed">
                <CardHeader>
                  <CardTitle>上傳程式碼</CardTitle>
                  <CardDescription>上傳包含程式碼的 ZIP 檔案</CardDescription>
                </CardHeader>
                <CardContent>
                  <div
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onClick={() => !isLoading && fileInputRef.current?.click()}
                    className={`border-2 border-dashed border-slate-300 rounded-lg p-8 text-center transition-colors cursor-pointer ${
                      !isLoading ? "hover:border-blue-400" : "opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <Upload className="w-12 h-12 text-slate-400 mx-auto mb-2" />
                    <p className="text-slate-600 mb-1">
                      {uploadedFile ? uploadedFile.name : "拖放檔案到此處或點擊選擇"}
                    </p>
                    <p className="text-sm text-slate-500">支援 ZIP 格式</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".zip"
                      onChange={handleFileSelect}
                      disabled={isLoading}
                      className="hidden"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setLocation("/")}
                disabled={isLoading}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !projectName}
                className="bg-blue-600 hover:bg-blue-700 text-white flex-1"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    處理中...
                  </>
                ) : (
                  "開始分析"
                )}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
