import type { AnalysisSnapshot, AnalysisStatus, ProjectStatus } from "@shared/contracts";

export type SymbolFilter = {
  search: string;
  kind: string;
};

export type FieldFilter = {
  search: string;
  table: string;
};

export type RiskFilter = {
  search: string;
  severity: string;
};

export type RuleFilter = {
  search: string;
};

export type AnalysisViewState = "idle" | "analyzing" | "completed" | "failed";

function normalize(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function shouldPollProjectStatus(status: ProjectStatus | null | undefined, analysisStatus: AnalysisStatus | null | undefined) {
  return status === "analyzing" || analysisStatus === "processing";
}

export function shouldPollSnapshot(status: ProjectStatus | null | undefined, analysisStatus: AnalysisStatus | null | undefined) {
  return shouldPollProjectStatus(status, analysisStatus);
}

export function getAnalysisViewState(status: ProjectStatus | null | undefined, analysisStatus: AnalysisStatus | null | undefined, hasReport: boolean) {
  if (status === "failed" || analysisStatus === "failed") {
    return "failed" satisfies AnalysisViewState;
  }

  if (status === "analyzing" || analysisStatus === "processing") {
    return "analyzing" satisfies AnalysisViewState;
  }

  if (hasReport && (analysisStatus === "completed" || analysisStatus === "partial")) {
    return "completed" satisfies AnalysisViewState;
  }

  return "idle" satisfies AnalysisViewState;
}

export function filterSymbols(snapshot: AnalysisSnapshot | undefined, filter: SymbolFilter) {
  const search = normalize(filter.search);
  return (snapshot?.symbols ?? []).filter((symbol) => {
    const matchesSearch =
      search.length === 0 ||
      normalize(symbol.name).includes(search) ||
      normalize(symbol.filePath).includes(search);
    const matchesKind = filter.kind === "all" || symbol.type === filter.kind;
    return matchesSearch && matchesKind;
  });
}

export function filterFields(snapshot: AnalysisSnapshot | undefined, filter: FieldFilter) {
  const search = normalize(filter.search);
  return (snapshot?.fields ?? []).filter((field) => {
    const matchesSearch =
      search.length === 0 ||
      normalize(field.tableName).includes(search) ||
      normalize(field.fieldName).includes(search);
    const matchesTable = filter.table === "all" || field.tableName === filter.table;
    return matchesSearch && matchesTable;
  });
}

export function filterRisks(snapshot: AnalysisSnapshot | undefined, filter: RiskFilter) {
  const search = normalize(filter.search);
  return (snapshot?.risks ?? []).filter((risk) => {
    const matchesSearch =
      search.length === 0 ||
      normalize(risk.title).includes(search) ||
      normalize(risk.description).includes(search) ||
      normalize(risk.sourceFile).includes(search);
    const matchesSeverity = filter.severity === "all" || risk.severity === filter.severity;
    return matchesSearch && matchesSeverity;
  });
}

export function filterRules(snapshot: AnalysisSnapshot | undefined, filter: RuleFilter) {
  const search = normalize(filter.search);
  return (snapshot?.rules ?? []).filter((rule) => {
    if (search.length === 0) {
      return true;
    }

    return (
      normalize(rule.name).includes(search) ||
      normalize(rule.description).includes(search)
    );
  });
}

export function getSymbolKinds(snapshot: AnalysisSnapshot | undefined) {
  return Array.from(new Set((snapshot?.symbols ?? []).map((symbol) => symbol.type))).sort((left, right) => left.localeCompare(right));
}

export function getFieldTables(snapshot: AnalysisSnapshot | undefined) {
  return Array.from(new Set((snapshot?.fields ?? []).map((field) => field.tableName))).sort((left, right) => left.localeCompare(right));
}
