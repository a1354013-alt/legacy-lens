import type {
  AnalysisWarning,
  DependencyListItem,
  ImportWarning,
  RiskListItem,
  RiskSeverity,
  RuleListItem,
} from "../../shared/contracts";

export const DELPHI_STANDARD_LIBRARIES = new Set([
  "Windows",
  "Messages",
  "SysUtils",
  "Classes",
  "Forms",
  "Dialogs",
  "DB",
  "ADODB",
  "Variants",
  "Controls",
  "Graphics",
  "StdCtrls",
  "ExtCtrls",
  "ComCtrls",
  "DBCtrls",
  "Mask",
  "Math",
  "StrUtils",
  "DateUtils",
  "IniFiles",
  "TypInfo",
  "Contnrs",
  "Types",
  "Clipbrd",
  "Menus",
  "Buttons",
  "Grids",
  "DBGrids",
  "ActnList",
  "ShellApi",
]);

type WarningLike = ImportWarning | AnalysisWarning;
type RawRiskLike = {
  riskType: RiskListItem["riskType"];
  severity: RiskListItem["severity"];
  title: string;
  description?: string | null;
  sourceFile?: string | null;
  lineNumber?: number | null;
  recommendation?: string | null;
};
type RawRuleLike = {
  ruleType: RuleListItem["ruleType"];
  title?: string | null;
  name?: string | null;
  description?: string | null;
  recommendation?: string | null;
  condition?: string | null;
  sourceFile?: string | null;
  lineNumber?: number | null;
};

type RiskOccurrence = Omit<RiskListItem, "id"> & {
  id: string;
  occurrenceCount: number;
  affectedFileCount: number;
  sampleLocations: Array<{ sourceFile: string | null; lineNumber: number | null }>;
};

type RuleOccurrence = Omit<RuleListItem, "id" | "name" | "condition"> & {
  id: string;
  title: string;
  recommendation: string | null;
  occurrenceCount: number;
  affectedFileCount: number;
  sampleLocations: Array<{ sourceFile: string | null; lineNumber: number | null }>;
  sourceLabel: string | null;
};

export type WarningSummary = {
  code: string;
  label: string;
  description: string;
  count: number;
  sampleMessages: string[];
  sampleFiles: string[];
  partialReason: string | null;
};

export type RiskGroup = RiskOccurrence;

export type RuleGroup = RuleOccurrence;

export type AffectedFileSummary = {
  filePath: string;
  riskCount: number;
  ruleCount: number;
  totalCount: number;
};

export type DependencySummary = {
  internalCount: number;
  externalCount: number;
  standardLibraryCount: number;
  hiddenByDefaultCount: number;
  defaultHideStandardLibrary: boolean;
};

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/["'`].*?["'`]/g, "<value>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[a-z]:\\[^\s)]+/gi, "<path>")
    .replace(/\\\\[^\s)]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}

function severityWeight(severity: RiskSeverity | null | undefined) {
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

function normalizeLocation(sourceFile: string | null | undefined, lineNumber: number | null | undefined) {
  return `${sourceFile ?? ""}:${lineNumber ?? ""}`;
}

function pushSampleLocation(
  locations: Array<{ sourceFile: string | null; lineNumber: number | null }>,
  sourceFile: string | null | undefined,
  lineNumber: number | null | undefined,
  limit: number
) {
  const normalized = normalizeLocation(sourceFile, lineNumber);
  if (locations.some((location) => normalizeLocation(location.sourceFile, location.lineNumber) === normalized)) {
    return;
  }
  if (locations.length < limit) {
    locations.push({ sourceFile: sourceFile ?? null, lineNumber: lineNumber ?? null });
  }
}

function warningPresentation(code: string) {
  switch (code) {
    case "IMPORT_LIMITED_ANALYSIS":
      return {
        label: "DFM 有限分析",
        description: "部分 Delphi 表單檔僅做有限分析，可能缺少更細的結構資訊。",
        partialReason: "DFM 僅有限分析",
      };
    case "IMPORT_ENCODING_DETECTED":
      return {
        label: "舊編碼偵測",
        description: "已偵測到舊式編碼，檔案內容可能需要人工確認。",
        partialReason: "偵測到 legacy encoding",
      };
    case "ANALYSIS_DOCUMENT_TRUNCATED":
      return {
        label: "報告內容過大已截斷",
        description: "部分輸出文件因內容過大被截斷，但主要分析資料仍可查看。",
        partialReason: "報告過大已截斷",
      };
    case "ANALYSIS_INPUT_SUMMARY":
      return {
        label: "分析輸入摘要",
        description: "分析器已記錄本次輸入來源與限制摘要。",
        partialReason: null,
      };
    case "ANALYSIS_FILE_SKIPPED":
      return {
        label: "檔案略過",
        description: "部分檔案解析失敗或不支援，已略過後續分析。",
        partialReason: "部分檔案未完成分析",
      };
    case "HEURISTIC_ANALYSIS":
      return {
        label: "啟發式分析提醒",
        description: "結果屬啟發式推論，仍需搭配人工審查。",
        partialReason: null,
      };
    default:
      return {
        label: code,
        description: "分析過程中有補充提醒或限制資訊。",
        partialReason: null,
      };
  }
}

export function summarizeWarnings(warnings: WarningLike[]) {
  const grouped = new Map<string, WarningSummary>();

  for (const warning of warnings) {
    const presentation = warningPresentation(warning.code);
    const current =
      grouped.get(warning.code) ??
      {
        code: warning.code,
        label: presentation.label,
        description: presentation.description,
        count: 0,
        sampleMessages: [],
        sampleFiles: [],
        partialReason: presentation.partialReason,
      };

    current.count += 1;
    if (current.sampleMessages.length < 3 && warning.message && !current.sampleMessages.includes(warning.message)) {
      current.sampleMessages.push(warning.message);
    }
    if (current.sampleFiles.length < 50 && warning.filePath && !current.sampleFiles.includes(warning.filePath)) {
      current.sampleFiles.push(warning.filePath);
    }
    grouped.set(warning.code, current);
  }

  return Array.from(grouped.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-Hant"));
}

export function summarizePartialReasons(importWarnings: ImportWarning[], analysisWarnings: AnalysisWarning[], errorMessage: string | null | undefined) {
  const reasons = new Set<string>();

  for (const warning of summarizeWarnings([...importWarnings, ...analysisWarnings])) {
    if (warning.partialReason) {
      reasons.add(warning.partialReason);
    }
  }

  if (errorMessage === "Analysis completed with warnings.") {
    reasons.add("分析已完成，但部分報告因資料量過大或檔案格式限制被截斷。");
  }

  return Array.from(reasons);
}

export function isDelphiStandardLibrary(targetName: string | null | undefined) {
  const normalized = String(targetName ?? "").trim();
  return normalized.length > 0 && DELPHI_STANDARD_LIBRARIES.has(normalized);
}

export function buildDependencySummary(rows: DependencyListItem[]) {
  let internalCount = 0;
  let externalCount = 0;
  let standardLibraryCount = 0;

  for (const row of rows) {
    if (row.targetKind === "internal") {
      internalCount += 1;
      continue;
    }

    externalCount += 1;
    if (isDelphiStandardLibrary(row.targetExternalName ?? row.targetSymbolName)) {
      standardLibraryCount += 1;
    }
  }

  return {
    internalCount,
    externalCount,
    standardLibraryCount,
    hiddenByDefaultCount: standardLibraryCount,
    defaultHideStandardLibrary: true,
  } satisfies DependencySummary;
}

export function dedupeRiskOccurrences(rows: Array<RawRiskLike & { id?: number | string }>) {
  const deduped = new Map<string, RiskOccurrence>();

  for (const row of rows) {
    const dedupeKey = [
      row.riskType,
      normalizeText(row.title),
      normalizeText(row.description),
      normalizeText(row.sourceFile),
      row.lineNumber ?? "",
      normalizeText(row.recommendation),
    ].join("|");

    const current =
      deduped.get(dedupeKey) ??
      {
        id: `risk:${dedupeKey}`,
        riskType: row.riskType,
        severity: row.severity,
        title: row.title,
        description: row.description ?? null,
        sourceFile: row.sourceFile ?? null,
        lineNumber: row.lineNumber ?? null,
        recommendation: row.recommendation ?? null,
        occurrenceCount: 0,
        affectedFileCount: 0,
        sampleLocations: [],
      };

    current.occurrenceCount += 1;
    if (severityWeight(row.severity) > severityWeight(current.severity)) {
      current.severity = row.severity;
    }
    pushSampleLocation(current.sampleLocations, row.sourceFile, row.lineNumber, 5);
    deduped.set(dedupeKey, current);
  }

  return Array.from(deduped.values()).map((item) => ({
    ...item,
    affectedFileCount: new Set(item.sampleLocations.map((location) => location.sourceFile ?? "")).size,
  }));
}

export function groupRisks(
  rows: Array<RawRiskLike & { id?: number | string }>,
  options: {
    severity?: RiskSeverity;
    riskType?: string;
    search?: string;
    file?: string;
    criticalOnly?: boolean;
    hideDuplicates?: boolean;
  } = {}
) {
  const hideDuplicates = options.hideDuplicates ?? true;
  const search = normalizeText(options.search);
  const fileSearch = normalizeText(options.file);
  const occurrences = dedupeRiskOccurrences(rows);
  const filteredOccurrences = occurrences.filter((row) => {
    if (options.severity && row.severity !== options.severity) return false;
    if (options.riskType && row.riskType !== options.riskType) return false;
    if (options.criticalOnly && row.severity !== "critical") return false;
    if (fileSearch && !normalizeText(row.sourceFile).includes(fileSearch)) return false;
    if (!search) return true;
    return [row.title, row.description, row.recommendation, row.sourceFile, row.riskType].some((value) => normalizeText(value).includes(search));
  });

  if (!hideDuplicates) {
    return filteredOccurrences.sort(
      (left, right) =>
        severityWeight(right.severity) - severityWeight(left.severity) ||
        right.occurrenceCount - left.occurrenceCount ||
        left.title.localeCompare(right.title, "en")
    );
  }

  const grouped = new Map<string, RiskGroup>();

  for (const row of filteredOccurrences) {
    const groupKey = [row.riskType, normalizeText(row.title), normalizeText(row.description), normalizeText(row.recommendation)].join("|");
    const current =
      grouped.get(groupKey) ??
      {
        ...row,
        id: `risk-group:${groupKey}`,
        occurrenceCount: 0,
        affectedFileCount: 0,
        sampleLocations: [],
      };

    current.occurrenceCount += row.occurrenceCount;
    if (severityWeight(row.severity) > severityWeight(current.severity)) {
      current.severity = row.severity;
    }
    for (const location of row.sampleLocations) {
      pushSampleLocation(current.sampleLocations, location.sourceFile, location.lineNumber, 5);
    }
    current.affectedFileCount = new Set([
      ...current.sampleLocations.map((location) => location.sourceFile ?? ""),
      row.sourceFile ?? "",
    ]).size;
    grouped.set(groupKey, current);
  }

  return Array.from(grouped.values()).sort(
    (left, right) =>
      severityWeight(right.severity) - severityWeight(left.severity) ||
      right.occurrenceCount - left.occurrenceCount ||
      right.affectedFileCount - left.affectedFileCount ||
      left.title.localeCompare(right.title, "en")
  );
}

function getRawRuleName(row: RawRuleLike) {
  return String(row.name ?? row.title ?? "").trim();
}

function normalizeRuleFamily(name: string) {
  const normalized = name.replace(/^validate_/i, "").replace(/_single_owner$/i, "");
  const parts = normalized.split("_").filter(Boolean);
  if (parts.length >= 3) {
    return `${parts.slice(0, -1).join("_")}.*`;
  }
  return normalized || name;
}

function humanizeRuleTitle(row: RawRuleLike) {
  const rawName = getRawRuleName(row);
  if (/single_owner/i.test(rawName)) {
    const family = normalizeRuleFamily(rawName);
    return `${family} 欄位有多處寫入來源`;
  }

  if (row.ruleType === "calculation") {
    return "計算欄位需可重現";
  }

  if (row.ruleType === "magic_value") {
    return "商業常數應抽離管理";
  }

  if (row.ruleType === "format") {
    return "格式轉換規則需一致";
  }

  return rawName.replace(/_/g, " ");
}

function normalizeRuleDescription(row: RawRuleLike) {
  if (/single_owner/i.test(getRawRuleName(row))) {
    return "同一組欄位偵測到多處寫入來源，建議確認單一寫入責任與驗證邏輯。";
  }

  return row.description ?? row.condition ?? null;
}

function normalizeRuleRecommendation(row: RawRuleLike) {
  if (/single_owner/i.test(getRawRuleName(row))) {
    return "整併寫入入口，或補上明確的 ownership 與資料一致性驗證。";
  }

  if (row.ruleType === "format") {
    return "確認轉換格式、精度、時區與目標系統規則一致。";
  }

  if (row.ruleType === "magic_value") {
    return "將商業常數抽成命名常數、設定檔或對照表。";
  }

  if (row.ruleType === "calculation") {
    return "補上計算來源、公式與回歸測試。";
  }

  return null;
}

export function dedupeRuleOccurrences(rows: Array<RawRuleLike & { id?: number | string }>) {
  const deduped = new Map<string, RuleOccurrence>();

  for (const row of rows) {
    const title = humanizeRuleTitle(row);
    const description = normalizeRuleDescription(row);
    const recommendation = normalizeRuleRecommendation(row);
    const dedupeKey = [
      row.ruleType,
      normalizeText(title),
      normalizeText(description),
      normalizeText(row.sourceFile),
      row.lineNumber ?? "",
    ].join("|");

    const current =
      deduped.get(dedupeKey) ??
      {
        id: `rule:${dedupeKey}`,
        ruleType: row.ruleType,
        title,
        description,
        recommendation,
        sourceFile: row.sourceFile ?? null,
        lineNumber: row.lineNumber ?? null,
        occurrenceCount: 0,
        affectedFileCount: 0,
        sampleLocations: [],
        sourceLabel: row.sourceFile ? row.sourceFile : "來源待確認",
      };

    current.occurrenceCount += 1;
    pushSampleLocation(current.sampleLocations, row.sourceFile, row.lineNumber, 5);
    deduped.set(dedupeKey, current);
  }

  return Array.from(deduped.values()).map((item) => ({
    ...item,
    affectedFileCount: new Set(item.sampleLocations.map((location) => location.sourceFile ?? "")).size,
  }));
}

export function groupRules(
  rows: Array<RawRuleLike & { id?: number | string }>,
  options: { ruleType?: string; search?: string; file?: string; hideDuplicates?: boolean } = {}
) {
  const hideDuplicates = options.hideDuplicates ?? true;
  const search = normalizeText(options.search);
  const fileSearch = normalizeText(options.file);
  const occurrences = dedupeRuleOccurrences(rows);
  const filteredOccurrences = occurrences.filter((row) => {
    if (options.ruleType && row.ruleType !== options.ruleType) return false;
    if (fileSearch && !normalizeText(row.sourceFile).includes(fileSearch)) return false;
    if (!search) return true;
    return [row.title, row.description, row.recommendation, row.sourceFile, row.ruleType].some((value) => normalizeText(value).includes(search));
  });

  if (!hideDuplicates) {
    return filteredOccurrences.sort(
      (left, right) =>
        right.occurrenceCount - left.occurrenceCount ||
        right.affectedFileCount - left.affectedFileCount ||
        left.title.localeCompare(right.title, "zh-Hant")
    );
  }

  const grouped = new Map<string, RuleGroup>();

  for (const row of filteredOccurrences) {
    const groupKey = [row.ruleType, normalizeText(row.title)].join("|");
    const current =
      grouped.get(groupKey) ??
      {
        ...row,
        id: `rule-group:${groupKey}`,
        occurrenceCount: 0,
        affectedFileCount: 0,
        sampleLocations: [],
      };

    current.occurrenceCount += row.occurrenceCount;
    for (const location of row.sampleLocations) {
      pushSampleLocation(current.sampleLocations, location.sourceFile, location.lineNumber, 5);
    }
    current.affectedFileCount = new Set([
      ...current.sampleLocations.map((location) => location.sourceFile ?? ""),
      row.sourceFile ?? "",
    ]).size;
    grouped.set(groupKey, current);
  }

  return Array.from(grouped.values()).sort(
    (left, right) =>
      right.occurrenceCount - left.occurrenceCount ||
      right.affectedFileCount - left.affectedFileCount ||
      left.title.localeCompare(right.title, "zh-Hant")
  );
}

export function summarizeAffectedFiles(riskGroups: RiskGroup[], ruleGroups: RuleGroup[]) {
  const grouped = new Map<string, AffectedFileSummary>();

  for (const risk of riskGroups) {
    for (const location of risk.sampleLocations) {
      if (!location.sourceFile) continue;
      const current =
        grouped.get(location.sourceFile) ??
        {
          filePath: location.sourceFile,
          riskCount: 0,
          ruleCount: 0,
          totalCount: 0,
        };
      current.riskCount += 1;
      current.totalCount += 1;
      grouped.set(location.sourceFile, current);
    }
  }

  for (const rule of ruleGroups) {
    for (const location of rule.sampleLocations) {
      if (!location.sourceFile) continue;
      const current =
        grouped.get(location.sourceFile) ??
        {
          filePath: location.sourceFile,
          riskCount: 0,
          ruleCount: 0,
          totalCount: 0,
        };
      current.ruleCount += 1;
      current.totalCount += 1;
      grouped.set(location.sourceFile, current);
    }
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.totalCount - left.totalCount || left.filePath.localeCompare(right.filePath, "en"))
    .slice(0, 10);
}
