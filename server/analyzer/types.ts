import type { AnalysisMetrics, AnalysisStatus, AnalysisWarning } from "../../shared/contracts";

export interface AnalyzableFile {
  path: string;
  content: string;
  language: string;
}

export type SymbolType = "function" | "procedure" | "method" | "query" | "table" | "class";

export interface AnalyzedSymbol {
  stableKey: string;
  name: string;
  qualifiedName?: string;
  type: SymbolType;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  description?: string;
}

export interface SymbolDependency {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  type: "calls" | "reads" | "writes" | "references";
  line: number;
}

export interface FieldReference {
  field: string;
  table: string;
  type: "read" | "write" | "calculate";
  file: string;
  line: number;
  symbolStableKey?: string;
  symbolName?: string;
  context?: string;
}

export interface DetectedRisk {
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "magic_value" | "multiple_writes" | "missing_condition" | "format_conversion" | "inconsistent_logic" | "other";
  sourceFile: string;
  lineNumber: number;
  suggestion?: string;
  codeSnippet?: string;
}

export interface DetectedRule {
  ruleType: "validation" | "format" | "magic_value" | "calculation";
  name: string;
  description: string;
  condition?: string;
  sourceFile?: string;
  lineNumber?: number;
}

export interface FileAnalysisResult {
  eligible: boolean;
  analyzed: boolean;
  degraded: boolean;
  heuristic: boolean;
  symbols: AnalyzedSymbol[];
  dependencies: SymbolDependency[];
  fieldReferences: FieldReference[];
  risks: DetectedRisk[];
  warnings: AnalysisWarning[];
}

export interface ProjectAnalysisResult {
  projectId: number;
  status: AnalysisStatus;
  language: string;
  symbols: AnalyzedSymbol[];
  dependencies: SymbolDependency[];
  fieldReferences: FieldReference[];
  risks: DetectedRisk[];
  rules: DetectedRule[];
  warnings: AnalysisWarning[];
  flowDocument: string;
  dataDependencyDocument: string;
  risksDocument: string;
  rulesYaml: string;
  riskScore: number;
  metrics: AnalysisMetrics;
}

export function buildSymbolStableKey(input: { file: string; name: string; startLine: number }) {
  return `${input.file.replace(/\\/g, "/")}::${input.name}::${input.startLine}`;
}
