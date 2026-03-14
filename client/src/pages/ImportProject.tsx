import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Upload, GitBranch, ArrowLeft } from "lucide-react";

export default function ImportProject() {
  const [, setLocation] = useLocation();
  const [sourceType, setSourceType] = useState<"upload" | "git">("upload");
  const [language, setLanguage] = useState<"go" | "sql" | "delphi">("go");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      console.log({
        projectName,
        language,
        sourceType,
        description,
        gitUrl,
      });
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
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">匯入新專案</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12">
        <div className="max-w-2xl mx-auto">
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
                    className={`p-4 border-2 rounded-lg transition-all ${
                      sourceType === "upload"
                        ? "border-blue-600 bg-blue-50"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <Upload className="w-8 h-8 mx-auto mb-2 text-blue-600" />
                    <p className="font-medium text-slate-900">上傳資料夾</p>
                    <p className="text-sm text-slate-600">ZIP 或本地資料夾</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSourceType("git")}
                    className={`p-4 border-2 rounded-lg transition-all ${
                      sourceType === "git"
                        ? "border-blue-600 bg-blue-50"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <GitBranch className="w-8 h-8 mx-auto mb-2 text-blue-600" />
                    <p className="font-medium text-slate-900">Git Clone</p>
                    <p className="text-sm text-slate-600">從 Git 倉庫克隆</p>
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
                  <Label htmlFor="projectName">專案名稱</Label>
                  <Input
                    id="projectName"
                    placeholder="例如：ERP System v2.0"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    required
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
                    className="mt-2"
                    rows={3}
                  />
                </div>

                <div>
                  <Label htmlFor="language">主要語言</Label>
                  <Select value={language} onValueChange={(value) => setLanguage(value as any)}>
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
                  <Label htmlFor="gitUrl">Git URL</Label>
                  <Input
                    id="gitUrl"
                    placeholder="https://github.com/username/repo.git"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    required
                    className="mt-2"
                  />
                </CardContent>
              </Card>
            ) : (
              <Card className="border-slate-200 border-dashed">
                <CardHeader>
                  <CardTitle>上傳程式碼</CardTitle>
                  <CardDescription>上傳包含程式碼的 ZIP 檔案或資料夾</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer">
                    <Upload className="w-12 h-12 text-slate-400 mx-auto mb-2" />
                    <p className="text-slate-600 mb-1">拖放檔案到此處或點擊選擇</p>
                    <p className="text-sm text-slate-500">支援 ZIP、TAR.GZ 等格式</p>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setLocation("/")}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !projectName}
                className="bg-blue-600 hover:bg-blue-700 text-white flex-1"
              >
                {isLoading ? "匯入中..." : "開始分析"}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
