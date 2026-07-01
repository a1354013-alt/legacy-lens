export type AnalysisConfidenceLevel = "high" | "medium" | "low";

export interface AnalysisConfidenceBreakdownItem {
  label: string;
  impact: number;
  reason: string;
}

export interface AnalysisConfidence {
  score: number;
  level: AnalysisConfidenceLevel;
  breakdown: AnalysisConfidenceBreakdownItem[];
}

interface WarningLike {
  code?: string | null;
  message?: string | null;
  filePath?: string | null;
  level?: string | null;
  heuristic?: boolean | null;
}

interface RiskLike {
  riskType?: string | null;
  category?: string | null;
  title?: string | null;
  description?: string | null;
}

interface DelphiEventLike {
  status?: string | null;
}

interface DelphiBindingLike {
  confidence?: string | null;
  accessHint?: string | null;
  warnings?: string[] | null;
}

interface MetricsLike {
  fileCount?: number | null;
  eligibleFileCount?: number | null;
  analyzedFileCount?: number | null;
  skippedFileCount?: number | null;
  degradedFileCount?: number | null;
  heuristicFileCount?: number | null;
  warningCount?: number | null;
  delphiEventMap?: DelphiEventLike[] | null;
  delphiDataBindings?: DelphiBindingLike[] | null;
}

export interface AnalysisConfidenceInput {
  metrics?: MetricsLike | null;
  importWarnings?: WarningLike[] | null;
  analyzerWarnings?: WarningLike[] | null;
  fileTypes?: Array<string | null | undefined> | null;
  risks?: RiskLike[] | null;
}

function toCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function confidenceLevel(score: number): AnalysisConfidenceLevel {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

function normalizeFileType(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : normalized ? `.${normalized}` : "";
}

function pushImpact(
  breakdown: AnalysisConfidenceBreakdownItem[],
  label: string,
  impact: number,
  reason: string
) {
  if (impact !== 0) {
    breakdown.push({ label, impact, reason });
  }
}

function countMatchingWarnings(warnings: WarningLike[], matcher: (warning: WarningLike) => boolean) {
  return warnings.filter(matcher).length;
}

function countMatchingRisks(risks: RiskLike[], pattern: RegExp) {
  return risks.filter((risk) => pattern.test(`${risk.riskType ?? ""} ${risk.category ?? ""} ${risk.title ?? ""} ${risk.description ?? ""}`)).length;
}

export function calculateAnalysisConfidence(input: AnalysisConfidenceInput): AnalysisConfidence {
  const metrics = input.metrics ?? {};
  const importWarnings = input.importWarnings ?? [];
  const analyzerWarnings = input.analyzerWarnings ?? [];
  const allWarnings = [...importWarnings, ...analyzerWarnings];
  const risks = input.risks ?? [];
  const fileTypes = (input.fileTypes ?? []).map(normalizeFileType).filter(Boolean);
  const fileTypeSet = new Set(fileTypes);
  const breakdown: AnalysisConfidenceBreakdownItem[] = [
    {
      label: "Base score",
      impact: 100,
      reason: "Start from full confidence, then subtract known heuristic uncertainty signals.",
    },
  ];

  const fileCount = toCount(metrics.fileCount) || fileTypes.length;
  const eligibleFileCount = toCount(metrics.eligibleFileCount);
  const analyzedFileCount = toCount(metrics.analyzedFileCount);
  if (eligibleFileCount > 0) {
    const missedEligible = Math.max(0, eligibleFileCount - analyzedFileCount);
    const penalty = Math.min(25, Math.ceil((missedEligible / eligibleFileCount) * 25));
    pushImpact(breakdown, "Analyzed file coverage", -penalty, `${analyzedFileCount}/${eligibleFileCount} eligible files were analyzed.`);
  }

  const skippedOrDegraded = Math.max(toCount(metrics.skippedFileCount), 0) + Math.max(toCount(metrics.degradedFileCount), 0);
  pushImpact(
    breakdown,
    "Skipped or degraded files",
    -Math.min(20, skippedOrDegraded * 2),
    `${skippedOrDegraded} files were skipped or degraded during analysis.`
  );

  const limitedFilePaths = new Set<string>();
  for (const warning of allWarnings) {
    if (warning.filePath && (warning.code === "IMPORT_LIMITED_ANALYSIS" || warning.heuristic)) {
      limitedFilePaths.add(warning.filePath);
    }
  }
  pushImpact(
    breakdown,
    "Limited analysis files",
    -Math.min(20, limitedFilePaths.size * 2),
    `${limitedFilePaths.size} files had limited or heuristic analysis warnings.`
  );

  pushImpact(
    breakdown,
    "Import warnings",
    -Math.min(15, importWarnings.length * 2),
    `${importWarnings.length} import warnings were recorded.`
  );

  const materialAnalyzerWarnings = analyzerWarnings.filter((warning) => warning.level !== "note");
  pushImpact(
    breakdown,
    "Analyzer warnings",
    -Math.min(20, materialAnalyzerWarnings.length),
    `${materialAnalyzerWarnings.length} analyzer warnings were recorded.`
  );

  if (fileCount > 0 && fileTypes.length > 0) {
    const knownTypes = new Set([".go", ".sql", ".pas", ".dpr", ".delphi", ".dfm", ".inc", ".dpk", ".fmx"]);
    const unknownCount = fileTypes.filter((type) => !knownTypes.has(type)).length;
    pushImpact(
      breakdown,
      "Unknown language files",
      -Math.min(12, Math.ceil((unknownCount / fileTypes.length) * 12)),
      `${unknownCount}/${fileTypes.length} files had unknown language or extension.`
    );
  }

  const delphiLikeCount = fileTypes.filter((type) => [".pas", ".dpr", ".delphi", ".dfm", ".inc", ".dpk", ".fmx"].includes(type)).length;
  if (delphiLikeCount > 0) {
    if (fileTypeSet.has(".pas") && fileTypeSet.has(".dfm")) {
      breakdown.push({ label: "Delphi unit/form coverage", impact: 0, reason: "Both .pas and .dfm files were present." });
    } else {
      pushImpact(
        breakdown,
        "Delphi unit/form coverage",
        fileTypeSet.has(".pas") ? -3 : -4,
        fileTypeSet.has(".pas") ? "Delphi form files were not present." : "Delphi Pascal unit files were not present."
      );
    }

    if (fileTypeSet.has(".dpr") || fileTypeSet.has(".dproj") || fileTypeSet.has(".dpk")) {
      breakdown.push({ label: "Delphi project entry", impact: 0, reason: ".dpr, .dproj, or .dpk project structure file was present." });
    } else {
      pushImpact(breakdown, "Delphi project entry", -4, "Missing .dpr, .dproj, or .dpk project entry.");
    }
  }

  const eventMap = metrics.delphiEventMap ?? [];
  const unresolvedEvents = eventMap.filter((entry) => entry.status === "unresolved").length;
  pushImpact(
    breakdown,
    "Unresolved DFM event handlers",
    -Math.min(20, unresolvedEvents * 4),
    `${unresolvedEvents}/${eventMap.length} DFM event handlers were unresolved.`
  );

  const dataBindings = metrics.delphiDataBindings ?? [];
  const unresolvedBindings = dataBindings.filter((binding) => binding.confidence !== "high" || binding.accessHint === "unresolved").length;
  pushImpact(
    breakdown,
    "Unresolved DFM data bindings",
    -Math.min(20, unresolvedBindings * 4),
    `${unresolvedBindings}/${dataBindings.length} DFM DataSource/DataSet bindings were unresolved or lower confidence.`
  );

  const dynamicSqlCount =
    countMatchingWarnings(allWarnings, (warning) => warning.code === "SQL_DYNAMIC_STRING") + countMatchingRisks(risks, /dynamic sql|sql\.text|sql\.add/i);
  pushImpact(
    breakdown,
    "Dynamic SQL",
    -Math.min(18, dynamicSqlCount * 3),
    `${dynamicSqlCount} dynamic SQL fragments or risk findings were detected.`
  );

  const hardcodedConfigCount = countMatchingRisks(risks, /hardcoded|connection string|filesystem path/i);
  pushImpact(
    breakdown,
    "Hardcoded path or connection string",
    -Math.min(12, hardcodedConfigCount * 2),
    `${hardcodedConfigCount} hardcoded path or connection string findings were detected.`
  );

  const emptyExceptionCount = countMatchingRisks(risks, /empty exception|empty except|swallowed exception/i);
  pushImpact(
    breakdown,
    "Empty exception handlers",
    -Math.min(10, emptyExceptionCount * 2),
    `${emptyExceptionCount} empty exception handler findings were detected.`
  );

  const runtimeLimitationWarnings = countMatchingWarnings(allWarnings, (warning) =>
    /with block|with-block|runtime binding|runtime assignment/i.test(`${warning.code ?? ""} ${warning.message ?? ""}`)
  );
  pushImpact(
    breakdown,
    "Delphi runtime binding limitations",
    -Math.min(12, runtimeLimitationWarnings * 3),
    `${runtimeLimitationWarnings} Delphi with-block or runtime binding limitation warnings were recorded.`
  );

  const score = Math.max(0, Math.min(100, breakdown.reduce((total, item) => total + item.impact, 0)));
  return {
    score,
    level: confidenceLevel(score),
    breakdown,
  };
}
