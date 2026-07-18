import type { AnalysisRunProjectContext, AnalysisStatus } from "../../shared/contracts";
import type { ProjectAnalysisResult } from "../analyzer/types";
import { ANALYZER_VERSION, buildAnalysisRunSnapshot, parseAnalysisSnapshotStrict } from "./analysisHistory";

export type TestProjectFileInput = {
  path: string;
  content: string;
  fileType?: string | null;
  lineCount?: number | null;
};

export function createProjectFileRecord(file: TestProjectFileInput) {
  return {
    filePath: file.path,
    fileType: file.fileType ?? inferFileType(file.path),
    lineCount: file.lineCount ?? countLines(file.content),
    content: file.content,
  };
}

export function createAnalysisResultFixture(overrides: Partial<ProjectAnalysisResult> = {}): ProjectAnalysisResult {
  return {
    projectId: 1,
    status: "completed",
    language: "go",
    symbols: [],
    dependencies: [],
    fieldReferences: [],
    schemaFields: [],
    risks: [],
    rules: [],
    warnings: [],
    flowDocument: "# FLOW",
    dataDependencyDocument: "# DATA_DEPENDENCY",
    risksDocument: "# RISKS",
    rulesYaml: "rules: []",
    delphiEventMap: [],
    delphiDataBindings: [],
    sqlStatements: [],
    buildDoctor: {
      status: "not_applicable",
      score: 100,
      compilerFamily: { value: null, confidence: "low", evidence: [] },
      projectEntries: [],
      configurations: [],
      platforms: [],
      defines: [],
      searchPaths: [],
      runtimePackages: [],
      requiredPackages: [],
      requiredUnits: [],
      missingUnits: [],
      unresolvedUnits: [],
      missingPackages: [],
      externalDependencies: [],
      findings: [],
      limitations: [],
    },
    flowTraces: [],
    riskScore: 0,
    metrics: {
      fileCount: 0,
      eligibleFileCount: 0,
      analyzedFileCount: 0,
      skippedFileCount: 0,
      heuristicFileCount: 0,
      degradedFileCount: 0,
      symbolCount: 0,
      dependencyCount: 0,
      fieldCount: 0,
      fieldDependencyCount: 0,
      riskCount: 0,
      ruleCount: 0,
      warningCount: 0,
    },
    ...overrides,
  };
}

export function createValidAnalysisRunFixture(options: {
  id?: number;
  projectId: number;
  runNumber: number;
  status?: AnalysisStatus;
  jobId?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  projectFiles: TestProjectFileInput[];
  projectContext?: Partial<AnalysisRunProjectContext>;
  result?: Partial<ProjectAnalysisResult>;
  analyzerVersion?: string;
  errorMessage?: string | null;
}) {
  const projectFiles = options.projectFiles.map(createProjectFileRecord);
  const createdAt = options.createdAt ?? new Date("2026-01-01T00:00:00.000Z");
  const updatedAt = options.updatedAt ?? createdAt;
  const completedAt = options.completedAt ?? createdAt;
  const projectContext: AnalysisRunProjectContext = {
    projectName: options.projectContext?.projectName ?? `project-${options.projectId}`,
    sourceType: options.projectContext?.sourceType ?? "upload",
    focusLanguage: options.projectContext?.focusLanguage ?? "go",
    importWarnings: options.projectContext?.importWarnings ?? [],
  };

  const baseResult = createAnalysisResultFixture(options.result);
  const status = options.status ?? baseResult.status;
  const metrics = {
    ...baseResult.metrics,
    fileCount: baseResult.metrics?.fileCount ?? projectFiles.length,
    eligibleFileCount: baseResult.metrics?.eligibleFileCount ?? projectFiles.length,
    analyzedFileCount: baseResult.metrics?.analyzedFileCount ?? projectFiles.length,
    symbolCount: baseResult.metrics?.symbolCount ?? baseResult.symbols.length,
    dependencyCount: baseResult.metrics?.dependencyCount ?? baseResult.dependencies.length,
    fieldCount: baseResult.metrics?.fieldCount ?? baseResult.schemaFields.length,
    fieldDependencyCount: baseResult.metrics?.fieldDependencyCount ?? baseResult.fieldReferences.length,
    riskCount: baseResult.metrics?.riskCount ?? baseResult.risks.length,
    ruleCount: baseResult.metrics?.ruleCount ?? baseResult.rules.length,
    warningCount: baseResult.metrics?.warningCount ?? baseResult.warnings.length,
  };
  const result: ProjectAnalysisResult = {
    ...baseResult,
    projectId: options.projectId,
    status,
    metrics,
  };

  const built = buildAnalysisRunSnapshot(projectFiles, result, projectContext);
  const parsedSnapshot = parseAnalysisSnapshotStrict(built.snapshotJson);

  return {
    sourceFingerprint: built.sourceFingerprint,
    snapshot: parsedSnapshot,
    row: {
      ...(typeof options.id === "number" ? { id: options.id } : {}),
      projectId: options.projectId,
      runNumber: options.runNumber,
      jobId: options.jobId ?? null,
      analyzerVersion: options.analyzerVersion ?? ANALYZER_VERSION,
      sourceFingerprint: built.sourceFingerprint,
      snapshotSchemaVersion: 1,
      snapshotJson: built.snapshotJson,
      completedAt,
      status,
      flowMarkdown: result.flowDocument,
      dataDependencyMarkdown: result.dataDependencyDocument,
      risksMarkdown: result.risksDocument,
      rulesYaml: result.rulesYaml,
      summaryJson: result.metrics,
      warningsJson: result.warnings,
      errorMessage: options.errorMessage ?? null,
      createdAt,
      updatedAt,
    },
  };
}

function inferFileType(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex).toLowerCase() : null;
}

function countLines(content: string) {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}
