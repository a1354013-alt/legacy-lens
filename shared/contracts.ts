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
  draft: "Draft",
  importing: "Importing",
  ready: "Ready",
  analyzing: "Analyzing",
  completed: "Completed",
  failed: "Failed",
};

export const analysisStatusLabels: Record<AnalysisStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  partial: "Completed with warnings",
  failed: "Failed",
};

export const statusDescriptions: Record<ProjectStatus, string> = {
  draft: "The project exists but source import has not started yet.",
  importing: "The server is validating and storing imported source files.",
  ready: "The source import completed successfully and analysis can start.",
  analyzing: "The server workflow is computing analysis artifacts for this project.",
  completed: "The latest server-side analysis finished successfully.",
  failed: "The latest import or analysis workflow failed and needs attention.",
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
  eligibleFileCount: number;
  analyzedFileCount: number;
  skippedFileCount: number;
  heuristicFileCount: number;
  degradedFileCount: number;
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
  heuristic?: boolean;
}

export interface ImportWarning {
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
