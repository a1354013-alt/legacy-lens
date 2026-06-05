import type { ImpactAnalysisResult } from "@shared/contracts";

export interface ImpactSectionItem {
  key: string;
  label: string;
  meta?: string;
  tone?: "default" | "symbol" | "field" | "rule" | "risk";
}

export interface ImpactSection {
  id: string;
  title: string;
  count: number;
  hiddenCount: number;
  items: ImpactSectionItem[];
}

export const DEFAULT_IMPACT_SECTION_LIMIT = 12;

function takeVisible<T>(items: T[], limit: number) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_IMPACT_SECTION_LIMIT;
  return {
    visible: items.slice(0, safeLimit),
    hiddenCount: Math.max(items.length - safeLimit, 0),
  };
}

function buildSection(id: string, title: string, items: ImpactSectionItem[], limit: number): ImpactSection | null {
  if (items.length === 0) {
    return null;
  }

  const { visible, hiddenCount } = takeVisible(items, limit);
  return {
    id,
    title,
    count: items.length,
    hiddenCount,
    items: visible,
  };
}

export function buildImpactSections(result: ImpactAnalysisResult, limit = DEFAULT_IMPACT_SECTION_LIMIT): ImpactSection[] {
  const sections = [
    buildSection(
      "symbols",
      "受影響符號",
      result.affectedSymbols.map((symbol) => ({
        key: `${symbol.file}:${symbol.name}:${symbol.type}`,
        label: symbol.name,
        meta: `${symbol.type} - ${symbol.file}`,
        tone: "symbol",
      })),
      limit
    ),
    buildSection(
      "files",
      "受影響檔案",
      result.affectedFiles.map((file) => ({
        key: file,
        label: file,
      })),
      limit
    ),
    buildSection(
      "tables",
      "受影響資料表",
      result.affectedTables.map((table) => ({
        key: table,
        label: table,
        tone: "field",
      })),
      limit
    ),
    buildSection(
      "fields",
      "受影響欄位",
      result.affectedFields.map((field) => ({
        key: `${field.table}.${field.field}`,
        label: `${field.table}.${field.field}`,
        tone: "field",
      })),
      limit
    ),
    buildSection(
      "rules",
      "受影響規則",
      result.affectedRules.map((rule) => ({
        key: rule,
        label: rule,
        tone: "rule",
      })),
      limit
    ),
    buildSection(
      "risks",
      "受影響風險",
      result.affectedRisks.map((risk) => ({
        key: risk,
        label: risk,
        tone: "risk",
      })),
      limit
    ),
  ];

  return sections.filter((section): section is ImpactSection => section !== null);
}
