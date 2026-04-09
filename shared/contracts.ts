import { z } from "zod";

export const projectLanguages = ["go", "delphi", "sql"] as const;
export const projectSourceTypes = ["upload", "git"] as const;
export const projectStatuses = ["draft", "importing", "ready", "analyzing", "completed", "failed"] as const;
export const fileStatuses = ["stored", "failed"] as const;
export const analysisStatuses = ["pending", "processing", "completed", "partial", "failed"] as const;
export const reportFormats = ["zip"] as const;

export const projectLanguageSchema = z.enum(projectLanguages);
export const projectSourceTypeSchema = z.enum(projectSourceTypes);
export const projectStatusSchema = z.enum(projectStatuses);
export const fileStatusSchema = z.enum(fileStatuses);
export const analysisStatusSchema = z.enum(analysisStatuses);
export const reportFormatSchema = z.enum(reportFormats);

export type ProjectLanguage = z.infer<typeof projectLanguageSchema>;
export type ProjectSourceType = z.infer<typeof projectSourceTypeSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type FileStatus = z.infer<typeof fileStatusSchema>;
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;
export type ReportFormat = z.infer<typeof reportFormatSchema>;

export const projectStatusLabels: Record<ProjectStatus, string> = {
  draft: "待匯入",
  importing: "匯入中",
  ready: "可分析",
  analyzing: "分析中",
  completed: "已完成",
  failed: "失敗",
};

export const analysisStatusLabels: Record<AnalysisStatus, string> = {
  pending: "未開始",
  processing: "分析中",
  completed: "分析完成",
  partial: "部分完成",
  failed: "分析失敗",
};

export const statusDescriptions: Record<ProjectStatus, string> = {
  draft: "專案已建立，尚未匯入檔案。",
  importing: "系統正在寫入或替換專案檔案。",
  ready: "檔案已成功匯入，尚未啟動分析。",
  analyzing: "分析器正在讀取檔案並寫回結果。",
  completed: "分析與報告已成功落地。",
  failed: "最近一次匯入或分析失敗，請查看錯誤訊息。",
};

export const appErrorCodes = [
  "DATABASE_UNAVAILABLE",
  "PROJECT_NOT_FOUND",
  "INVALID_PROJECT_STATE",
  "INVALID_GIT_URL",
  "GIT_CLONE_FAILED",
  "EMPTY_SOURCE",
  "ZIP_INVALID",
  "IMPORT_FAILED",
  "ANALYSIS_FAILED",
  "REPORT_NOT_READY",
  "DELETE_FAILED",
] as const;

export const appErrorCodeSchema = z.enum(appErrorCodes);
export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;

export interface AppErrorShape {
  code: AppErrorCode;
  message: string;
  details?: string;
}

export interface ReportArchivePayload {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface AnalysisMetrics {
  fileCount: number;
  analyzedFileCount: number;
  skippedFileCount: number;
  symbolCount: number;
  dependencyCount: number;
  fieldCount: number;
  fieldDependencyCount: number;
  riskCount: number;
  ruleCount: number;
  warningCount: number;
}

export interface AnalysisWarning {
  code: string;
  message: string;
  filePath?: string;
}

export interface AnalysisSnapshot {
  report: {
    id: number;
    projectId: number;
    status: AnalysisStatus;
    flowMarkdown: string | null;
    dataDependencyMarkdown: string | null;
    risksMarkdown: string | null;
    rulesYaml: string | null;
    summaryJson: AnalysisMetrics | null;
    warningsJson: AnalysisWarning[];
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  symbols: Array<{
    id: number;
    name: string;
    type: string;
    fileId: number;
    startLine: number;
    endLine: number;
    signature: string | null;
    description: string | null;
  }>;
  dependencies: Array<{
    id: number;
    sourceSymbolId: number;
    targetSymbolId: number;
    dependencyType: string;
    lineNumber: number | null;
  }>;
  fields: Array<{
    id: number;
    tableName: string;
    fieldName: string;
    fieldType: string | null;
    description: string | null;
  }>;
  fieldDependencies: Array<{
    id: number;
    fieldId: number;
    symbolId: number;
    operationType: string;
    lineNumber: number | null;
    context: string | null;
  }>;
  risks: Array<{
    id: number;
    riskType: string;
    severity: string;
    title: string;
    description: string | null;
    sourceFile: string | null;
    lineNumber: number | null;
    recommendation: string | null;
  }>;
  rules: Array<{
    id: number;
    ruleType: string;
    name: string;
    description: string | null;
    condition: string | null;
    sourceFile: string | null;
    lineNumber: number | null;
  }>;
}
