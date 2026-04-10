import type { AnalysisMetrics, AnalysisStatus, AnalysisWarning } from "../../shared/contracts";
import { DocumentGenerator } from "./documentGenerator";
import { ParserFactory } from "./parser";
import { RiskDetector } from "./riskDetector";
import type {
  AnalyzableFile,
  DetectedRule,
  DetectedRisk,
  FieldReference,
  FileAnalysisResult,
  ProjectAnalysisResult,
  SymbolDependency,
} from "./types";

function collectMagicValues(content: string, filePath: string): Parameters<RiskDetector["detectMagicValues"]>[0] {
  const lines = content.split(/\r?\n/);
  const candidates: Parameters<RiskDetector["detectMagicValues"]>[0] = [];
  const stringPattern = /["']([^"']{4,})["']/g;
  const numberPattern = /\b(\d{4,})\b/g;

  lines.forEach((line, index) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("--")) {
      return;
    }

    let match: RegExpExecArray | null;
    while ((match = stringPattern.exec(line)) !== null) {
      candidates.push({
        value: match[1],
        file: filePath,
        line: index + 1,
        context: line.trim(),
        kind: "string",
      });
    }

    while ((match = numberPattern.exec(line)) !== null) {
      candidates.push({
        value: match[1],
        file: filePath,
        line: index + 1,
        context: line.trim(),
        kind: "number",
      });
    }
  });

  return candidates;
}

function collectSqlSnippets(content: string, filePath: string): Array<{ file: string; line: number; sql: string }> {
  const snippets: Array<{ file: string; line: number; sql: string }> = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line)) {
      snippets.push({ file: filePath, line: index + 1, sql: line.trim() });
    }

    const fragmentMatches = line.match(/["'`](SELECT|INSERT|UPDATE|DELETE)[^"'`]+["'`]/gi);
    if (!fragmentMatches) {
      return;
    }

    for (const fragment of fragmentMatches) {
      snippets.push({
        file: filePath,
        line: index + 1,
        sql: fragment.slice(1, -1),
      });
    }
  });

  return snippets;
}

function dedupeDependencies(dependencies: SymbolDependency[]): SymbolDependency[] {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = `${dependency.from}:${dependency.to}:${dependency.type}:${dependency.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeRisks(risks: DetectedRisk[]): DetectedRisk[] {
  const seen = new Set<string>();
  return risks.filter((risk) => {
    const key = `${risk.title}:${risk.sourceFile}:${risk.lineNumber}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeWarnings(warnings: AnalysisWarning[]): AnalysisWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.filePath ?? ""}:${warning.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildRules(fieldReferences: FieldReference[], risks: DetectedRisk[]): DetectedRule[] {
  const rules: DetectedRule[] = [];
  const writeCounts = new Map<string, number>();

  for (const reference of fieldReferences) {
    if (reference.type === "write") {
      const key = `${reference.table}.${reference.field}`;
      writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1);
    }

    if (reference.type === "calculate") {
      rules.push({
        ruleType: "calculation",
        name: `recalculate_${reference.table}_${reference.field}`.replace(/[^\w]+/g, "_"),
        description: `Calculated field ${reference.table}.${reference.field} should be reproducible.`,
        condition: reference.context,
        sourceFile: reference.file,
        lineNumber: reference.line,
      });
    }
  }

  for (const [fieldKey, count] of Array.from(writeCounts.entries())) {
    if (count < 2) continue;
    rules.push({
      ruleType: "validation",
      name: `validate_${fieldKey.replace(/[^\w]+/g, "_")}_single_owner`,
      description: `Review write ownership for ${fieldKey}; multiple write sites were detected.`,
      condition: `${fieldKey} should have a documented write owner`,
    });
  }

  for (const risk of risks) {
    if (risk.category === "magic_value") {
      rules.push({
        ruleType: "magic_value",
        name: `externalize_${risk.sourceFile.replace(/[^\w]+/g, "_")}_${risk.lineNumber}`,
        description: risk.title,
        condition: risk.description,
        sourceFile: risk.sourceFile,
        lineNumber: risk.lineNumber,
      });
    }

    if (risk.category === "format_conversion") {
      rules.push({
        ruleType: "format",
        name: `format_guard_${risk.sourceFile.replace(/[^\w]+/g, "_")}_${risk.lineNumber}`,
        description: risk.title,
        condition: risk.description,
        sourceFile: risk.sourceFile,
        lineNumber: risk.lineNumber,
      });
    }
  }

  const uniqueRules = new Map<string, DetectedRule>();
  for (const rule of rules) {
    uniqueRules.set(`${rule.ruleType}:${rule.name}`, rule);
  }

  return Array.from(uniqueRules.values());
}

export class Analyzer {
  private readonly riskDetector = new RiskDetector();
  private readonly documentGenerator = new DocumentGenerator();

  async analyzeFile(file: AnalyzableFile): Promise<FileAnalysisResult> {
    const parser = ParserFactory.createParser(file.language, file.content, file.path);
    const symbols = parser.parseSymbols();
    const dependencies = parser.parseDependencies(symbols);
    const fieldReferences = parser.parseFieldReferences(symbols);
    const warnings = parser.collectWarnings();
    const sqlSnippets = collectSqlSnippets(file.content, file.path);

    const risks = dedupeRisks([
      ...this.riskDetector.detectMagicValues(collectMagicValues(file.content, file.path)),
      ...this.riskDetector.detectMissingConditions(sqlSnippets),
      ...this.riskDetector.detectFormatConversionRisks(file.content, file.path),
    ]);

    return {
      symbols,
      dependencies,
      fieldReferences,
      risks,
      warnings,
    };
  }

  async analyzeProject(files: AnalyzableFile[], projectId: number): Promise<ProjectAnalysisResult> {
    const symbols = [];
    const dependencies = [];
    const fieldReferences = [];
    const risks = [];
    const warnings: AnalysisWarning[] = [];

    for (const file of files) {
      const result = await this.analyzeFile(file);
      symbols.push(...result.symbols);
      dependencies.push(...result.dependencies);
      fieldReferences.push(...result.fieldReferences);
      risks.push(...result.risks);
      warnings.push(...result.warnings);
    }

    const combinedRisks = dedupeRisks([...risks, ...this.riskDetector.detectMultipleWrites(fieldReferences)]);
    const combinedDependencies = dedupeDependencies(dependencies);
    const combinedWarnings = dedupeWarnings([
      ...warnings,
      {
        code: "HEURISTIC_ANALYSIS",
        message: "Analysis results are heuristic for Go, SQL, and Delphi; review before using them as source-of-truth.",
        heuristic: true,
      },
    ]);
    const rules = buildRules(fieldReferences, combinedRisks);

    const metrics: AnalysisMetrics = {
      fileCount: files.length,
      analyzedFileCount: files.length - combinedWarnings.filter((warning) => warning.code === "LANGUAGE_UNSUPPORTED").length,
      skippedFileCount: combinedWarnings.filter((warning) => warning.code === "LANGUAGE_UNSUPPORTED").length,
      symbolCount: symbols.length,
      dependencyCount: combinedDependencies.length,
      fieldCount: new Set(fieldReferences.map((reference) => `${reference.table}.${reference.field}`)).size,
      fieldDependencyCount: fieldReferences.length,
      riskCount: combinedRisks.length,
      ruleCount: rules.length,
      warningCount: combinedWarnings.length,
    };

    const status: AnalysisStatus =
      metrics.analyzedFileCount === 0
        ? "failed"
        : combinedWarnings.length > 0
          ? "partial"
          : "completed";

    return {
      projectId,
      status,
      language: files[0]?.language ?? "unknown",
      symbols,
      dependencies: combinedDependencies,
      fieldReferences,
      risks: combinedRisks,
      rules,
      warnings: combinedWarnings,
      flowDocument: this.documentGenerator.generateFlowDocument(symbols, combinedDependencies),
      dataDependencyDocument: this.documentGenerator.generateDataDependencyDocument(fieldReferences),
      risksDocument: this.documentGenerator.generateRisksDocument(combinedRisks),
      rulesYaml: this.documentGenerator.generateRulesYaml(rules),
      riskScore: this.riskDetector.calculateRiskScore(combinedRisks),
      metrics,
    };
  }
}
