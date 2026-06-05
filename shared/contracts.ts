import { z } from "zod";

export const focusLanguages = ["go", "delphi", "sql"] as const;
export const projectSourceTypes = ["upload", "git"] as const;
export const projectStatuses = ["draft", "importing", "ready", "analyzing", "completed", "failed"] as const;
export const fileStatuses = ["stored", "failed"] as const;
export const analysisStatuses = ["pending", "processing", "completed", "partial", "failed"] as const;
export const reportFormats = ["zip"] as const;
export const projectJobTypes = ["import_zip", "import_git", "analyze"] as const;
export const projectJobStatuses = ["queued", "running", "completed", "failed"] as const;
export const analysisWarningLevels = ["note", "warning", "error"] as const;
export const symbolKinds = ["function", "procedure", "method", "query", "table", "class"] as const;
export const dependencyKinds = ["calls", "reads", "writes", "references"] as const;
export const dependencyTargetKinds = ["internal", "external", "unresolved"] as const;
export const fieldDependencyOperationTypes = ["read", "write", "calculate"] as const;
export const riskSeverities = ["low", "medium", "high", "critical"] as const;
export const riskTypes = [
  "magic_value",
  "multiple_writes",
  "missing_condition",
  "format_conversion",
  "inconsistent_logic",
  "other",
] as const;
export const ruleTypes = ["validation", "format", "magic_value", "calculation"] as const;

export const focusLanguageDescription =
  "Primary report focus language. Legacy Lens still scans other supported languages to build cross-file and cross-language relationships.";

export const focusLanguageSchema = z.enum(focusLanguages).describe(focusLanguageDescription);
export const projectSourceTypeSchema = z.enum(projectSourceTypes);
export const projectStatusSchema = z.enum(projectStatuses);
export const fileStatusSchema = z.enum(fileStatuses);
export const analysisStatusSchema = z.enum(analysisStatuses);
export const reportFormatSchema = z.enum(reportFormats);
export const projectJobTypeSchema = z.enum(projectJobTypes);
export const projectJobStatusSchema = z.enum(projectJobStatuses);
export const analysisWarningLevelSchema = z.enum(analysisWarningLevels);
export const symbolKindSchema = z.enum(symbolKinds);
export const dependencyKindSchema = z.enum(dependencyKinds);
export const dependencyTargetKindSchema = z.enum(dependencyTargetKinds);
export const fieldDependencyOperationTypeSchema = z.enum(fieldDependencyOperationTypes);
export const riskSeveritySchema = z.enum(riskSeverities);
export const riskTypeSchema = z.enum(riskTypes);
export const ruleTypeSchema = z.enum(ruleTypes);

export type FocusLanguage = z.infer<typeof focusLanguageSchema>;
export type ProjectSourceType = z.infer<typeof projectSourceTypeSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type FileStatus = z.infer<typeof fileStatusSchema>;
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;
export type ReportFormat = z.infer<typeof reportFormatSchema>;
export type ProjectJobType = z.infer<typeof projectJobTypeSchema>;
export type ProjectJobStatus = z.infer<typeof projectJobStatusSchema>;
export type AnalysisWarningLevel = z.infer<typeof analysisWarningLevelSchema>;
export type SymbolKind = z.infer<typeof symbolKindSchema>;
export type DependencyKind = z.infer<typeof dependencyKindSchema>;
export type DependencyTargetKind = z.infer<typeof dependencyTargetKindSchema>;
export type FieldDependencyOperationType = z.infer<typeof fieldDependencyOperationTypeSchema>;
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;
export type RiskType = z.infer<typeof riskTypeSchema>;
export type RuleType = z.infer<typeof ruleTypeSchema>;

export const importWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  filePath: z.string().optional(),
});

export const analysisWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  level: analysisWarningLevelSchema.default("warning"),
  filePath: z.string().optional(),
  heuristic: z.boolean().optional(),
});

export type ImportWarning = z.infer<typeof importWarningSchema>;
export type AnalysisWarning = z.infer<typeof analysisWarningSchema>;

export const analysisMetricsSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  eligibleFileCount: z.number().int().nonnegative(),
  analyzedFileCount: z.number().int().nonnegative(),
  skippedFileCount: z.number().int().nonnegative(),
  heuristicFileCount: z.number().int().nonnegative(),
  degradedFileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
  dependencyCount: z.number().int().nonnegative(),
  fieldCount: z.number().int().nonnegative(),
  fieldDependencyCount: z.number().int().nonnegative(),
  riskCount: z.number().int().nonnegative(),
  ruleCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
});

export type AnalysisMetrics = z.infer<typeof analysisMetricsSchema>;

const basePagedQuerySchema = z.object({
  projectId: z.number().int().positive(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
});

export const symbolsPageInputSchema = basePagedQuerySchema.extend({
  kind: symbolKindSchema.optional(),
});

export const fieldsPageInputSchema = basePagedQuerySchema.extend({
  tableName: z.string().trim().max(255).optional(),
});

export const risksPageInputSchema = basePagedQuerySchema.extend({
  severity: riskSeveritySchema.optional(),
});

export const rulesPageInputSchema = basePagedQuerySchema.extend({
  ruleType: ruleTypeSchema.optional(),
});

export const dependenciesPageInputSchema = basePagedQuerySchema.extend({
  dependencyType: dependencyKindSchema.optional(),
  targetKind: dependencyTargetKindSchema.optional(),
});

export const fieldDependenciesPageInputSchema = basePagedQuerySchema.extend({
  tableName: z.string().trim().max(255).optional(),
  operationType: fieldDependencyOperationTypeSchema.optional(),
});

export type SymbolsPageInput = z.infer<typeof symbolsPageInputSchema>;
export type FieldsPageInput = z.infer<typeof fieldsPageInputSchema>;
export type RisksPageInput = z.infer<typeof risksPageInputSchema>;
export type RulesPageInput = z.infer<typeof rulesPageInputSchema>;
export type DependenciesPageInput = z.infer<typeof dependenciesPageInputSchema>;
export type FieldDependenciesPageInput = z.infer<typeof fieldDependenciesPageInputSchema>;

export const appErrorCodes = [
  "DATABASE_UNAVAILABLE",
  "PROJECT_NOT_FOUND",
  "PROJECT_JOB_NOT_FOUND",
  "PROJECT_JOB_ACTIVE",
  "PROJECT_JOB_STALE",
  "JOB_STALE_MAX_ATTEMPTS",
  "PROJECT_JOB_TIMEOUT",
  "PROJECT_JOB_WORKER_EXITED",
  "INVALID_PROJECT_STATE",
  "INVALID_GIT_URL",
  "GIT_CLONE_FAILED",
  "EMPTY_SOURCE",
  "ZIP_INVALID",
  "ZIP_UNSAFE_PATH",
  "IMPORT_FAILED",
  "ANALYSIS_FAILED",
  "REPORT_NOT_READY",
  "REPORT_TOO_LARGE",
  "DELETE_FAILED",
] as const;

export const appErrorCodeSchema = z.enum(appErrorCodes);
export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;

export interface AppErrorShape {
  code: AppErrorCode;
  message: string;
  details?: string;
}

export const httpApiErrorCodes = [...appErrorCodes, "UNAUTHORIZED", "RATE_LIMITED", "BAD_REQUEST", "INTERNAL_SERVER_ERROR"] as const;
export const httpApiErrorCodeSchema = z.enum(httpApiErrorCodes);
export type HttpApiErrorCode = z.infer<typeof httpApiErrorCodeSchema>;

export const httpApiErrorResponseSchema = z.object({
  code: httpApiErrorCodeSchema,
  error: z.string(),
  message: z.string(),
  details: z.string().optional(),
  remediation: z.string().optional(),
});
export type HttpApiErrorResponse = z.infer<typeof httpApiErrorResponseSchema>;

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
  partial: "Partial",
  failed: "Failed",
};

export const projectJobStatusLabels: Record<ProjectJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export const projectJobTypeLabels: Record<ProjectJobType, string> = {
  import_zip: "ZIP Import",
  import_git: "Git Import",
  analyze: "Analyze",
};

export const statusDescriptions: Record<ProjectStatus, string> = {
  draft: "Project created and waiting for source import.",
  importing: "Import job is ingesting and normalizing project files.",
  ready: "Import completed and the project is ready for analysis.",
  analyzing: "Analysis job is processing the persisted project snapshot.",
  completed: "Analysis completed and report artifacts are available.",
  failed: "The latest import or analysis job failed. Review the recorded error and retry.",
};

export const projectRecordSummarySchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  language: focusLanguageSchema,
  sourceType: projectSourceTypeSchema,
  sourceUrl: z.string().nullable(),
  status: projectStatusSchema,
  importProgress: z.number().int().nonnegative(),
  analysisProgress: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  importWarningsJson: z.array(importWarningSchema),
  lastAnalyzedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  analysisStatus: analysisStatusSchema,
  latestJob: z
    .object({
      id: z.number().int().positive(),
      projectId: z.number().int().positive(),
      userId: z.number().int().positive(),
      type: projectJobTypeSchema,
      status: projectJobStatusSchema,
      progress: z.number().int().min(0).max(100),
      errorCode: z.string().nullable(),
      errorMessage: z.string().nullable(),
      createdAt: z.date(),
      startedAt: z.date().nullable(),
      finishedAt: z.date().nullable(),
      attemptCount: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
    })
    .nullable(),
});

export type ProjectRecordSummary = z.infer<typeof projectRecordSummarySchema>;

export const analysisSnapshotReportSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  status: analysisStatusSchema,
  flowMarkdown: z.string().nullable(),
  dataDependencyMarkdown: z.string().nullable(),
  risksMarkdown: z.string().nullable(),
  rulesYaml: z.string().nullable(),
  summaryJson: analysisMetricsSchema.nullable(),
  warningsJson: z.array(analysisWarningSchema),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AnalysisSnapshotReport = z.infer<typeof analysisSnapshotReportSchema>;

export const summarySymbolSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: symbolKindSchema,
  filePath: z.string().nullable(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});

export const summaryRiskSchema = z.object({
  id: z.number().int().positive(),
  riskType: riskTypeSchema,
  severity: riskSeveritySchema,
  title: z.string(),
  sourceFile: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
});

export const summaryRuleSchema = z.object({
  id: z.number().int().positive(),
  ruleType: ruleTypeSchema,
  name: z.string(),
  sourceFile: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
});

export const analysisFieldTableSummarySchema = z.object({
  tableName: z.string(),
  fieldCount: z.number().int().nonnegative(),
  readCount: z.number().int().nonnegative(),
  writeCount: z.number().int().nonnegative(),
  referenceCount: z.number().int().nonnegative(),
});

export type AnalysisFieldTableSummary = z.infer<typeof analysisFieldTableSummarySchema>;

export const analysisSnapshotSummarySchema = z.object({
  report: analysisSnapshotReportSchema.nullable(),
  importWarnings: z.array(importWarningSchema),
  totals: z.object({
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    fieldDependencies: z.number().int().nonnegative(),
    risks: z.number().int().nonnegative(),
    rules: z.number().int().nonnegative(),
    importWarnings: z.number().int().nonnegative(),
  }),
  topSymbols: z.array(summarySymbolSchema),
  topRisks: z.array(summaryRiskSchema),
  topRules: z.array(summaryRuleSchema),
  fieldTables: z.array(analysisFieldTableSummarySchema),
});

export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSummarySchema>;

export const symbolListItemSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: symbolKindSchema,
  fileId: z.number().int().positive(),
  filePath: z.string().nullable(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  signature: z.string().nullable(),
  description: z.string().nullable(),
});

export type SymbolListItem = z.infer<typeof symbolListItemSchema>;

export const dependencyListItemSchema = z.object({
  id: z.number().int().positive(),
  sourceSymbolId: z.number().int().positive(),
  sourceSymbolName: z.string(),
  targetSymbolId: z.number().int().nullable(),
  targetSymbolName: z.string().nullable(),
  targetExternalName: z.string().nullable(),
  targetKind: dependencyTargetKindSchema,
  dependencyType: dependencyKindSchema,
  lineNumber: z.number().int().nullable(),
});

export type DependencyListItem = z.infer<typeof dependencyListItemSchema>;

export const fieldListItemSchema = z.object({
  id: z.number().int().positive(),
  tableName: z.string(),
  fieldName: z.string(),
  fieldType: z.string().nullable(),
  description: z.string().nullable(),
  readCount: z.number().int().nonnegative(),
  writeCount: z.number().int().nonnegative(),
  referenceCount: z.number().int().nonnegative(),
});

export type FieldListItem = z.infer<typeof fieldListItemSchema>;

export const fieldDependencyListItemSchema = z.object({
  id: z.number().int().positive(),
  fieldId: z.number().int().positive(),
  tableName: z.string(),
  fieldName: z.string(),
  symbolId: z.number().int().positive(),
  symbolName: z.string(),
  operationType: fieldDependencyOperationTypeSchema,
  lineNumber: z.number().int().nullable(),
  context: z.string().nullable(),
});

export type FieldDependencyListItem = z.infer<typeof fieldDependencyListItemSchema>;

export const riskListItemSchema = z.object({
  id: z.number().int().positive(),
  riskType: riskTypeSchema,
  severity: riskSeveritySchema,
  title: z.string(),
  description: z.string().nullable(),
  sourceFile: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
  recommendation: z.string().nullable(),
});

export type RiskListItem = z.infer<typeof riskListItemSchema>;

export const ruleListItemSchema = z.object({
  id: z.number().int().positive(),
  ruleType: ruleTypeSchema,
  name: z.string(),
  description: z.string().nullable(),
  condition: z.string().nullable(),
  sourceFile: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
});

export type RuleListItem = z.infer<typeof ruleListItemSchema>;

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const pagedResultMetaSchema = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
});

export const projectJobSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  userId: z.number().int().positive(),
  type: projectJobTypeSchema,
  status: projectJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
});

export type ProjectJobRecord = z.infer<typeof projectJobSchema>;

export const projectJobCreateResultSchema = z.object({
  jobId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  status: projectJobStatusSchema,
});

export type ProjectJobCreateResult = z.infer<typeof projectJobCreateResultSchema>;

export const reportArchivePayloadSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  base64: z.string(),
});

export type ReportArchivePayload = z.infer<typeof reportArchivePayloadSchema>;

export function pagedResultSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    pageCount: z.number().int().nonnegative(),
  });
}

export const projectsListOutputSchema = z.array(projectRecordSummarySchema);
export const projectByIdOutputSchema = projectRecordSummarySchema.nullable();
export const analysisResultOutputSchema = analysisSnapshotReportSchema.nullable();
export const analysisSnapshotOutputSchema = analysisSnapshotSummarySchema;
export const symbolsPageOutputSchema = pagedResultSchema(symbolListItemSchema);
export const fieldsPageOutputSchema = pagedResultSchema(fieldListItemSchema);
export const risksPageOutputSchema = pagedResultSchema(riskListItemSchema);
export const rulesPageOutputSchema = pagedResultSchema(ruleListItemSchema);
export const dependenciesPageOutputSchema = pagedResultSchema(dependencyListItemSchema);
export const fieldDependenciesPageOutputSchema = pagedResultSchema(fieldDependencyListItemSchema);
export const jobByIdOutputSchema = projectJobSchema;
export const projectCreateOutputSchema = z.object({
  success: z.literal(true),
  projectId: z.number().int().positive(),
});
export const projectDeleteOutputSchema = z.object({
  success: z.literal(true),
});

export const impactTargetTypes = ["auto", "symbol", "file", "sql_table", "sql_field", "risk", "rule"] as const;
export const impactTargetTypeSchema = z.enum(impactTargetTypes);
export type ImpactTargetType = z.infer<typeof impactTargetTypeSchema>;

export const impactAnalysisResultSchema = z.object({
  target: z.string(),
  targetType: impactTargetTypeSchema,
  confidence: z.number(),
  affectedCount: z.number().int().nonnegative(),
  summary: z.string(),
  affectedFiles: z.array(z.string()),
  affectedSymbols: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      type: z.string(),
    })
  ),
  affectedTables: z.array(z.string()),
  affectedFields: z.array(
    z.object({
      table: z.string(),
      field: z.string(),
    })
  ),
  affectedRules: z.array(z.string()),
  affectedRisks: z.array(z.string()),
  dependencyChains: z.array(z.array(z.string())),
  warnings: z.array(z.string()),
});

export interface ImpactAnalysisResult {
  target: string;
  targetType: ImpactTargetType;
  confidence: number;
  affectedCount: number;
  summary: string;
  affectedFiles: string[];
  affectedSymbols: Array<{ name: string; file: string; type: string }>;
  affectedTables: string[];
  affectedFields: Array<{ table: string; field: string }>;
  affectedRules: string[];
  affectedRisks: string[];
  dependencyChains: string[][];
  warnings: string[];
}
