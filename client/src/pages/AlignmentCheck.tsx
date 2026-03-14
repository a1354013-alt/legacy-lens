import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, AlertCircle, CheckCircle, AlertTriangle, AlertOctagon } from "lucide-react";

interface AlignmentGap {
  id: string;
  oldStep: string;
  newStep: string;
  gapType: "missing_in_new" | "missing_in_old" | "logic_difference" | "data_mismatch";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  recommendation: string;
}

interface AlignmentReport {
  totalSteps: number;
  alignedSteps: number;
  gaps: AlignmentGap[];
  overallAlignment: number;
  riskScore: number;
  summary: string;
}

export default function AlignmentCheck() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [report, setReport] = useState<AlignmentReport | null>(null);
  const [selectedGap, setSelectedGap] = useState<AlignmentGap | null>(null);

  // 模擬數據（實際應從後端 API 獲取）
  const mockReport: AlignmentReport = {
    totalSteps: 15,
    alignedSteps: 12,
    gaps: [
      {
        id: "gap_1",
        oldStep: "ValidateUserPermission",
        newStep: "CheckUserRole",
        gapType: "logic_difference",
        severity: "high",
        description: "舊系統使用 permission 表，新系統使用 role 表",
        recommendation: "需要在遷移時建立 permission 到 role 的映射表",
      },
      {
        id: "gap_2",
        oldStep: "CalculateDiscount",
        newStep: "",
        gapType: "missing_in_new",
        severity: "critical",
        description: "新系統中未找到折扣計算功能",
        recommendation: "需要在新系統中實現折扣計算邏輯，或確認已被其他模組替代",
      },
      {
        id: "gap_3",
        oldStep: "LogAuditTrail",
        newStep: "RecordAuditLog",
        gapType: "logic_difference",
        severity: "medium",
        description: "舊系統記錄到本地檔案，新系統記錄到資料庫",
        recommendation: "驗證新系統的審計日誌是否包含所有必要信息",
      },
      {
        id: "gap_4",
        oldStep: "",
        newStep: "SendNotification",
        gapType: "missing_in_old",
        severity: "low",
        description: "新系統新增通知功能",
        recommendation: "確認是否符合業務需求，可考慮在舊系統中補充",
      },
    ],
    overallAlignment: 80,
    riskScore: 35,
    summary: "對齊度: 80% | 風險評分: 35/100\n⚠️ 發現 1 個關鍵差異，需要立即處理\n⚠️ 發現 1 個高風險差異，建議優先處理",
  };

  const handleLoadReport = () => {
    setIsLoading(true);
    setTimeout(() => {
      setReport(mockReport);
      setIsLoading(false);
    }, 1000);
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case "critical":
        return <AlertOctagon className="w-5 h-5 text-red-600" />;
      case "high":
        return <AlertTriangle className="w-5 h-5 text-orange-600" />;
      case "medium":
        return <AlertCircle className="w-5 h-5 text-yellow-600" />;
      case "low":
        return <CheckCircle className="w-5 h-5 text-green-600" />;
      default:
        return null;
    }
  };

  const getSeverityBadge = (severity: string): any => {
    const variantMap: Record<string, any> = {
      critical: "destructive",
      high: "secondary",
      medium: "outline",
      low: "default",
    };
    return variantMap[severity] || "default";
  };

  const getAlignmentColor = (alignment: number) => {
    if (alignment >= 90) return "text-green-600";
    if (alignment >= 70) return "text-yellow-600";
    return "text-red-600";
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
          <h1 className="text-2xl font-bold text-slate-900">差異對齊檢查</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12">
        {!report ? (
          <div className="max-w-2xl mx-auto">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>系統對齊分析</CardTitle>
                <CardDescription>
                  對比舊系統（Delphi）與新系統（Go API）的流程差異
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <h3 className="font-semibold text-slate-900">分析功能</h3>
                  <ul className="space-y-2 text-sm text-slate-700">
                    <li className="flex gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                      <span>自動提取舊系統流程步驟</span>
                    </li>
                    <li className="flex gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                      <span>自動提取新系統 API 端點</span>
                    </li>
                    <li className="flex gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                      <span>識別缺失功能和邏輯差異</span>
                    </li>
                    <li className="flex gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                      <span>生成風險評估和遷移建議</span>
                    </li>
                  </ul>
                </div>

                <Button
                  onClick={handleLoadReport}
                  disabled={isLoading}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {isLoading ? "分析中..." : "開始分析"}
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 摘要卡片 */}
            <Card className="border-slate-200 bg-gradient-to-br from-blue-50 to-indigo-50">
              <CardHeader>
                <CardTitle>分析摘要</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600">對齊度</p>
                    <p className={`text-3xl font-bold ${getAlignmentColor(report.overallAlignment)}`}>
                      {report.overallAlignment}%
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600">風險評分</p>
                    <p className="text-3xl font-bold text-orange-600">{report.riskScore}/100</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600">已對齊步驟</p>
                    <p className="text-3xl font-bold text-green-600">
                      {report.alignedSteps}/{report.totalSteps}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600">發現差異</p>
                    <p className="text-3xl font-bold text-red-600">{report.gaps.length}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-900">進度</p>
                  <Progress value={report.overallAlignment} className="h-2" />
                </div>

                <div className="p-4 bg-white rounded-lg border border-slate-200">
                  <p className="text-sm text-slate-700 whitespace-pre-line">{report.summary}</p>
                </div>
              </CardContent>
            </Card>

            {/* 差異詳情 */}
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>差異詳情</CardTitle>
                <CardDescription>
                  {report.gaps.length} 個差異項目需要處理
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="all" className="w-full">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="all">全部 ({report.gaps.length})</TabsTrigger>
                    <TabsTrigger value="critical">
                      關鍵 ({report.gaps.filter((g) => g.severity === "critical").length})
                    </TabsTrigger>
                    <TabsTrigger value="high">
                      高 ({report.gaps.filter((g) => g.severity === "high").length})
                    </TabsTrigger>
                    <TabsTrigger value="medium">
                      中 ({report.gaps.filter((g) => g.severity === "medium").length})
                    </TabsTrigger>
                    <TabsTrigger value="low">
                      低 ({report.gaps.filter((g) => g.severity === "low").length})
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="all" className="space-y-3 mt-4">
                    {report.gaps.map((gap) => (
                      <GapCard
                        key={gap.id}
                        gap={gap}
                        isSelected={selectedGap?.id === gap.id}
                        onSelect={setSelectedGap}
                        getSeverityIcon={getSeverityIcon}
                        getSeverityBadge={getSeverityBadge}
                      />
                    ))}
                  </TabsContent>

                  {["critical", "high", "medium", "low"].map((severity) => (
                    <TabsContent key={severity} value={severity} className="space-y-3 mt-4">
                      {report.gaps
                        .filter((g) => g.severity === severity)
                        .map((gap) => (
                          <GapCard
                            key={gap.id}
                            gap={gap}
                            isSelected={selectedGap?.id === gap.id}
                            onSelect={setSelectedGap}
                            getSeverityIcon={getSeverityIcon}
                            getSeverityBadge={getSeverityBadge}
                          />
                        ))}
                    </TabsContent>
                  ))}
                </Tabs>
              </CardContent>
            </Card>

            {/* 詳細信息 */}
            {selectedGap && (
              <Card className="border-slate-200 bg-slate-50">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    {getSeverityIcon(selectedGap.severity)}
                    <div>
                      <CardTitle>{selectedGap.description}</CardTitle>
                      <CardDescription>
                        <Badge variant={getSeverityBadge(selectedGap.severity) as any}>
                          {selectedGap.severity.toUpperCase()}
                        </Badge>
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <h4 className="font-semibold text-slate-900 mb-2">舊系統步驟</h4>
                    <p className="text-sm text-slate-700">{selectedGap.oldStep || "N/A"}</p>
                  </div>
                  <div>
                    <h4 className="font-semibold text-slate-900 mb-2">新系統步驟</h4>
                    <p className="text-sm text-slate-700">{selectedGap.newStep || "N/A"}</p>
                  </div>
                  <div>
                    <h4 className="font-semibold text-slate-900 mb-2">建議</h4>
                    <p className="text-sm text-slate-700">{selectedGap.recommendation}</p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Button onClick={() => setReport(null)} variant="outline" className="w-full">
              返回分析
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}

interface GapCardProps {
  gap: AlignmentGap;
  isSelected: boolean;
  onSelect: (gap: AlignmentGap) => void;
  getSeverityIcon: (severity: string) => React.ReactNode;
  getSeverityBadge: (severity: string) => string;
}

function GapCard({
  gap,
  isSelected,
  onSelect,
  getSeverityIcon,
  getSeverityBadge,
}: GapCardProps) {
  return (
    <div
      onClick={() => onSelect(gap)}
      className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
        isSelected
          ? "border-blue-500 bg-blue-50"
          : "border-slate-200 hover:border-slate-300 bg-white"
      }`}
    >
      <div className="flex items-start gap-3">
        {getSeverityIcon(gap.severity)}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-medium text-slate-900 truncate">{gap.description}</p>
            <Badge variant={getSeverityBadge(gap.severity) as any} className="flex-shrink-0">
              {gap.severity}
            </Badge>
          </div>
          <p className="text-sm text-slate-600">
            {gap.oldStep ? `舊: ${gap.oldStep}` : "舊系統無此步驟"} →{" "}
            {gap.newStep ? `新: ${gap.newStep}` : "新系統無此步驟"}
          </p>
        </div>
      </div>
    </div>
  );
}
