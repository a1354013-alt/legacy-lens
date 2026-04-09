import type { AnalysisMetrics, AnalysisStatus, AnalysisWarning } from "../../shared/contracts";

export interface AnalyzableFile {
  path: string;
  content: string;
  language: string;
}

export interface AnalyzedSymbol {
  name: string;
  type: "function" | "procedure" | "method" | "query" | "table";
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  description?: string;
}

export interface SymbolDependency {
  from: string;
  to: string;
  type: "calls" | "reads" | "writes" | "references";
  line: number;
}

export interface FieldReference {
  field: string;
  table: string;
  type: "read" | "write" | "calculate";
  file: string;
  line: number;
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
