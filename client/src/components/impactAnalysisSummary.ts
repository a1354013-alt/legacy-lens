import type { ImpactAnalysisResult } from "@shared/contracts";

type ImpactAnalysisSummaryInput = Partial<
  Pick<
    ImpactAnalysisResult,
    "affectedCount" | "affectedFiles" | "affectedSymbols" | "affectedTables" | "affectedFields" | "affectedRules" | "affectedRisks"
  >
>;

function safeLength<T>(value: T[] | undefined) {
  return Array.isArray(value) ? value.length : 0;
}

export function getAffectedComponentCount(result: ImpactAnalysisSummaryInput) {
  if (typeof result.affectedCount === "number" && Number.isFinite(result.affectedCount)) {
    return result.affectedCount;
  }

  return (
    safeLength(result.affectedFiles) +
    safeLength(result.affectedSymbols) +
    safeLength(result.affectedTables) +
    safeLength(result.affectedFields) +
    safeLength(result.affectedRules) +
    safeLength(result.affectedRisks)
  );
}
