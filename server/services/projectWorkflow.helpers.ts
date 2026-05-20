import type { AnalysisMetrics, AnalysisStatus, AnalysisWarning } from "../../shared/contracts";

export function sanitizeExportBaseName(value: string) {
  const normalized = String(value ?? "").trim();
  const fallback = normalized.length > 0 ? normalized : "project";
  const withoutReserved = fallback.replace(/[<>:"/\\|?*]/g, "_");
  const collapsed = withoutReserved.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? collapsed.slice(0, 80).trim() : collapsed;
}

function compareStrings(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "");
}

function compareNumbers(left: number | null | undefined, right: number | null | undefined) {
  return (left ?? 0) - (right ?? 0);
}

export function severityRank(severity: string | null | undefined) {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

export function sortProjectFiles<T extends { id?: number; filePath?: string | null; fileName?: string | null }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.filePath, right.filePath) ||
      compareStrings(left.fileName, right.fileName) ||
      compareNumbers(left.id, right.id)
  );
}

export function sortProjectSymbols<T extends { id?: number; name?: string | null; fileId?: number | null; startLine?: number | null }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.name, right.name) ||
      compareNumbers(left.fileId, right.fileId) ||
      compareNumbers(left.startLine, right.startLine) ||
      compareNumbers(left.id, right.id)
  );
}

export function sortProjectDependencies<
  T extends { id?: number; sourceSymbolId?: number | null; targetSymbolId?: number | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareNumbers(left.sourceSymbolId, right.sourceSymbolId) ||
      compareNumbers(left.targetSymbolId, right.targetSymbolId) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

export function sortProjectFields<T extends { id?: number; tableName?: string | null; fieldName?: string | null }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.tableName, right.tableName) ||
      compareStrings(left.fieldName, right.fieldName) ||
      compareNumbers(left.id, right.id)
  );
}

export function sortProjectRisks<
  T extends { id?: number; severity?: string | null; title?: string | null; sourceFile?: string | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      compareStrings(left.title, right.title) ||
      compareStrings(left.sourceFile, right.sourceFile) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

export function sortProjectRules<
  T extends { id?: number; ruleType?: string | null; name?: string | null; sourceFile?: string | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareStrings(left.ruleType, right.ruleType) ||
      compareStrings(left.name, right.name) ||
      compareStrings(left.sourceFile, right.sourceFile) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

export function sortFieldDependencies<
  T extends { id?: number; fieldId?: number | null; symbolId?: number | null; lineNumber?: number | null }
>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareNumbers(left.fieldId, right.fieldId) ||
      compareNumbers(left.symbolId, right.symbolId) ||
      compareNumbers(left.lineNumber, right.lineNumber) ||
      compareNumbers(left.id, right.id)
  );
}

export function mapSnapshotReport<T extends {
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
}>(report: T) {
  return {
    id: report.id,
    projectId: report.projectId,
    status: report.status,
    flowMarkdown: report.flowMarkdown,
    dataDependencyMarkdown: report.dataDependencyMarkdown,
    risksMarkdown: report.risksMarkdown,
    rulesYaml: report.rulesYaml,
    summaryJson: report.summaryJson,
    warningsJson: report.warningsJson,
    errorMessage: report.errorMessage,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

export function renderProjectImpactSummaryMarkdown(
  summary: {
    totals: { files: number; symbols: number; dependencies: number; risks: number; rules: number };
    topImpactedFiles: Array<{ filePath: string; impactCount: number }>;
    topDependencies: string[];
    highRiskItems: Array<{ title: string; severity: string | null; sourceFile: string | null; lineNumber: number | null }>;
    businessRules: {
      countsByType: Record<string, number>;
      items: Array<{ name: string; ruleType: string; sourceFile: string | null; lineNumber: number | null }>;
    };
  },
  generatedAtIso: string
) {
  const lines = [
    "# IMPACT_ANALYSIS",
    "",
    `Snapshot timestamp: ${generatedAtIso}`,
    "",
    "## Totals",
    `- Files: ${summary.totals.files}`,
    `- Symbols: ${summary.totals.symbols}`,
    `- Dependencies: ${summary.totals.dependencies}`,
    `- Risks: ${summary.totals.risks}`,
    `- Rules: ${summary.totals.rules}`,
    "",
    "## Top Impacted Files",
  ];

  if (summary.topImpactedFiles.length === 0) {
    lines.push("- No impacted files recorded.");
  } else {
    summary.topImpactedFiles.forEach((entry) => {
      lines.push(`- ${entry.filePath}: ${entry.impactCount} impact signals`);
    });
  }

  lines.push("", "## Top Dependencies");
  if (summary.topDependencies.length === 0) {
    lines.push("- No dependencies recorded.");
  } else {
    summary.topDependencies.forEach((entry) => lines.push(`- ${entry}`));
  }

  lines.push("", "## High Risk Items");
  if (summary.highRiskItems.length === 0) {
    lines.push("- No high-severity risks recorded.");
  } else {
    summary.highRiskItems.forEach((risk) => {
      const location = risk.sourceFile ? `${risk.sourceFile}${risk.lineNumber ? `:${risk.lineNumber}` : ""}` : "unknown";
      lines.push(`- [${risk.severity}] ${risk.title} (${location})`);
    });
  }

  lines.push("", "## Business Rules Summary");
  const ruleTypeEntries = Object.entries(summary.businessRules.countsByType).sort((left, right) => left[0].localeCompare(right[0]));
  if (ruleTypeEntries.length === 0) {
    lines.push("- No business rules recorded.");
  } else {
    ruleTypeEntries.forEach(([ruleType, count]) => lines.push(`- ${ruleType}: ${count}`));
  }

  if (summary.businessRules.items.length > 0) {
    lines.push("", "## Sample Rules");
    summary.businessRules.items.forEach((rule) => {
      const location = rule.sourceFile ? `${rule.sourceFile}${rule.lineNumber ? `:${rule.lineNumber}` : ""}` : "no source file";
      lines.push(`- ${rule.name} (${rule.ruleType}, ${location})`);
    });
  }

  return lines.join("\n");
}
