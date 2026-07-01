import type { AnalysisMetrics, AnalysisStatus, AnalysisWarning } from "../../shared/contracts";
import { calculateAnalysisConfidence } from "../../shared/analysisConfidence";
import { getNormalizedFileExtension, isDelphiLikeLanguage } from "./delphiLanguage";
import { DocumentGenerator } from "./documentGenerator";
import { buildFieldIdentityKey, parseFieldIdentityKey } from "./fieldIdentity";
import { collectSqlStatements, parseDfmContent, ParserFactory } from "./parser";
import { RiskDetector } from "./riskDetector";
import type {
  AnalyzableFile,
  AnalyzedSymbol,
  DelphiDataBinding,
  DelphiEventBinding,
  DelphiEventMapEntry,
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
  return collectSqlStatements(content).map((statement) => ({
    file: filePath,
    line: statement.line,
    sql: statement.sql,
  }));
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
    const normalizedDescription = risk.description
      .toLowerCase()
      .replace(/["'`].*?["'`]/g, "<value>")
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim();
    const key = `${risk.category}:${risk.title.toLowerCase()}:${normalizedDescription}:${risk.sourceFile}:${risk.lineNumber}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildFieldFamily(field: string) {
  const parts = field.split(/[_\W]+/).filter(Boolean);
  if (parts.length >= 3) {
    return `${parts.slice(0, -1).join("_")}.*`;
  }
  if (parts.length === 2) {
    return `${parts[0]}.*`;
  }
  return field;
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error || "Unknown analysis error");
}

function getBaseName(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const fileName = normalized.split("/").at(-1) ?? normalized;
  return fileName.replace(/\.[^.]+$/, "").toLowerCase();
}

function collectDfmProjectMetadata(files: AnalyzableFile[]) {
  const eventBindings: DelphiEventBinding[] = [];
  const dataBindings: DelphiDataBinding[] = [];
  const warnings: AnalysisWarning[] = [];

  for (const file of files) {
    if (![".dfm", ".fmx"].includes(getNormalizedFileExtension(file.path))) {
      continue;
    }

    try {
      const parsed = parseDfmContent(file.content, file.path);
      eventBindings.push(...parsed.eventBindings);
      dataBindings.push(...parsed.dataBindings);
      warnings.push(...parsed.warnings);
    } catch (error) {
      warnings.push({
        code: "DFM_LIMITED_ANALYSIS",
        message: `DFM analysis was limited after parser failure: ${getErrorMessage(error)}`,
        level: "warning",
        filePath: file.path,
        heuristic: true,
      });
    }
  }

  return { eventBindings, dataBindings, warnings };
}

function collectPascalMethods(symbols: AnalyzedSymbol[]) {
  return symbols.filter((symbol) => {
    const extension = getNormalizedFileExtension(symbol.file);
    return [".pas", ".dpr", ".inc", ".dpk"].includes(extension) && ["method", "procedure", "function"].includes(symbol.type);
  });
}

function resolveDelphiEventMap(bindings: DelphiEventBinding[], symbols: AnalyzedSymbol[]): DelphiEventMapEntry[] {
  const pascalMethods = collectPascalMethods(symbols);

  return bindings.map((binding) => {
    const dfmBaseName = getBaseName(binding.filePath);
    const sameBase = pascalMethods.filter((method) => getBaseName(method.file) === dfmBaseName);
    const candidates = sameBase.length > 0 ? sameBase : pascalMethods;
    const qualifiedFormCandidates = [binding.formClass, `T${binding.formName}`]
      .filter((value): value is string => Boolean(value))
      .map((formClass) => `${formClass}.${binding.handlerName}`.toLowerCase());

    const resolved =
      candidates.find((method) => qualifiedFormCandidates.includes((method.qualifiedName ?? method.name).toLowerCase())) ??
      candidates.find((method) => (method.qualifiedName ?? "").toLowerCase().endsWith(`.${binding.handlerName.toLowerCase()}`)) ??
      candidates.find((method) => method.name.toLowerCase() === binding.handlerName.toLowerCase()) ??
      pascalMethods.find((method) => qualifiedFormCandidates.includes((method.qualifiedName ?? method.name).toLowerCase())) ??
      pascalMethods.find((method) => method.name.toLowerCase() === binding.handlerName.toLowerCase());

    const warnings: string[] = [];
    if (!resolved) {
      warnings.push("No matching Pascal procedure/function/method was found by handler name, form-qualified name, or same-basename pairing.");
    } else if (getBaseName(resolved.file) !== dfmBaseName) {
      warnings.push("Resolved outside the same DFM/PAS basename; verify inherited forms or cross-unit handler wiring.");
    }

    return {
      ...binding,
      resolvedMethod: resolved?.qualifiedName ?? resolved?.name ?? null,
      resolvedFile: resolved?.file ?? null,
      status: resolved ? "resolved" : "unresolved",
      warnings,
    };
  });
}

function buildRules(fieldReferences: FieldReference[], risks: DetectedRisk[]): DetectedRule[] {
  const rules: DetectedRule[] = [];
  const writeCounts = new Map<string, number>();
  const writeReferences = new Map<string, FieldReference[]>();
  const groupedWriteFamilies = new Map<
    string,
    { table: string; family: string; fields: Set<string>; occurrences: FieldReference[] }
  >();
  const groupedRiskRules = new Map<
    string,
    { ruleType: DetectedRule["ruleType"]; name: string; description: string; condition?: string; sourceFile?: string; lineNumber?: number; count: number }
  >();

  for (const reference of fieldReferences) {
    if (reference.type === "write") {
      const key = buildFieldIdentityKey(reference);
      writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1);
      const bucket = writeReferences.get(key) ?? [];
      bucket.push(reference);
      writeReferences.set(key, bucket);
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
    const identity = parseFieldIdentityKey(fieldKey);
    const family = buildFieldFamily(identity.field);
    const groupKey = `${identity.table}:${family}`;
    const current =
      groupedWriteFamilies.get(groupKey) ??
      { table: identity.table, family, fields: new Set<string>(), occurrences: [] };
    current.fields.add(identity.field);
    current.occurrences.push(...(writeReferences.get(fieldKey) ?? []));
    groupedWriteFamilies.set(groupKey, current);
  }

  for (const group of groupedWriteFamilies.values()) {
    const slug = `${group.table}_${group.family}`.replace(/[^\w]+/g, "_");
    const displayName = `${group.table}.${group.family}`;
    const first = group.occurrences[0];
    rules.push({
      ruleType: "validation",
      name: `validate_${slug}_single_owner`,
      description: `Review write ownership for ${displayName}; ${group.fields.size} related fields have multiple write sites.`,
      condition: `${displayName} should have a documented write owner`,
      sourceFile: first?.file,
      lineNumber: first?.line,
    });
  }

  for (const risk of risks) {
    if (risk.category === "magic_value") {
      const name = `externalize_${risk.sourceFile.replace(/[^\w]+/g, "_")}_${risk.title.replace(/[^\w]+/g, "_").toLowerCase()}`;
      const key = `magic_value:${name}`;
      const current =
        groupedRiskRules.get(key) ??
        {
          ruleType: "magic_value" as const,
          name,
          description: risk.title,
          condition: risk.description,
          sourceFile: risk.sourceFile,
          lineNumber: risk.lineNumber,
          count: 0,
        };
      current.count += 1;
      groupedRiskRules.set(key, current);
    }

    if (risk.category === "format_conversion") {
      const name = `format_guard_${risk.sourceFile.replace(/[^\w]+/g, "_")}_${risk.title.replace(/[^\w]+/g, "_").toLowerCase()}`;
      const key = `format:${name}`;
      const current =
        groupedRiskRules.get(key) ??
        {
          ruleType: "format" as const,
          name,
          description: risk.title,
          condition: risk.description,
          sourceFile: risk.sourceFile,
          lineNumber: risk.lineNumber,
          count: 0,
        };
      current.count += 1;
      groupedRiskRules.set(key, current);
    }
  }

  for (const rule of groupedRiskRules.values()) {
    rules.push({
      ruleType: rule.ruleType,
      name: rule.name,
      description: rule.count > 1 ? `${rule.description} (${rule.count} occurrences)` : rule.description,
      condition: rule.condition,
      sourceFile: rule.sourceFile,
      lineNumber: rule.lineNumber,
    });
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
    const eligible = ParserFactory.isLanguageSupported(file.language);
    const symbols = parser.parseSymbols();
    const dependencies = parser.parseDependencies(symbols);
    const fieldReferences = parser.parseFieldReferences(symbols);
    const schemaFields = parser.parseSchemaFields();
    const warnings = parser.collectWarnings();
    const sqlSnippets = collectSqlSnippets(file.content, file.path);

    const risks = dedupeRisks([
      ...this.riskDetector.detectMagicValues(collectMagicValues(file.content, file.path)),
      ...this.riskDetector.detectMissingConditions(sqlSnippets),
      ...this.riskDetector.detectFormatConversionRisks(file.content, file.path),
      ...(isDelphiLikeLanguage(file.language, file.path) ? this.riskDetector.detectDelphiPatterns(file.content, file.path) : []),
    ]);

    return {
      eligible,
      analyzed: eligible,
      degraded: warnings.some((warning) => warning.level !== "note"),
      heuristic: warnings.some((warning) => warning.heuristic),
      symbols,
      dependencies,
      fieldReferences,
      schemaFields,
      risks,
      warnings,
    };
  }

  async analyzeProject(files: AnalyzableFile[], projectId: number): Promise<ProjectAnalysisResult> {
    const symbols = [];
    const fieldReferences = [];
    const schemaFields = [];
    const risks = [];
    const warnings: AnalysisWarning[] = [];
    const dependencyFiles: AnalyzableFile[] = [];
    let eligibleFileCount = 0;
    let analyzedFileCount = 0;
    let degradedFileCount = 0;
    let heuristicFileCount = 0;

    for (const file of files) {
      let result: FileAnalysisResult;
      try {
        result = await this.analyzeFile(file);
      } catch (error) {
        const eligible = ParserFactory.isLanguageSupported(file.language);
        if (eligible) {
          eligibleFileCount += 1;
        }
        warnings.push({
          code: "ANALYSIS_FILE_SKIPPED",
          message: `Skipped file after parser failure: ${getErrorMessage(error)}`,
          level: "warning",
          filePath: file.path,
          heuristic: true,
        });
        continue;
      }

      eligibleFileCount += result.eligible ? 1 : 0;
      analyzedFileCount += result.analyzed ? 1 : 0;
      degradedFileCount += result.degraded ? 1 : 0;
      heuristicFileCount += result.heuristic ? 1 : 0;
      symbols.push(...result.symbols);
      fieldReferences.push(...result.fieldReferences);
      schemaFields.push(...result.schemaFields);
      risks.push(...result.risks);
      warnings.push(...result.warnings);
      if (result.analyzed) {
        dependencyFiles.push(file);
      }
    }

    const dependencies: SymbolDependency[] = [];
    for (const file of dependencyFiles) {
      const parser = ParserFactory.createParser(file.language, file.content, file.path);
      dependencies.push(...parser.parseDependencies(symbols));
    }

    const combinedRisks = dedupeRisks([...risks, ...this.riskDetector.detectMultipleWrites(fieldReferences)]);
    const combinedDependencies = dedupeDependencies(dependencies);
    const dfmMetadata = collectDfmProjectMetadata(files);
    const delphiEventMap = resolveDelphiEventMap(dfmMetadata.eventBindings, symbols);
    warnings.push(...dfmMetadata.warnings);
    for (const eventEntry of delphiEventMap) {
      if (eventEntry.status === "unresolved") {
        warnings.push({
          code: "DELPHI_EVENT_HANDLER_UNRESOLVED",
          message: `${eventEntry.formName}.${eventEntry.componentName}.${eventEntry.eventName} references ${eventEntry.handlerName}, but no Pascal method was resolved.`,
          level: "warning",
          filePath: eventEntry.filePath,
          heuristic: true,
        });
      }
    }
    for (const binding of dfmMetadata.dataBindings) {
      if (binding.confidence !== "high") {
        warnings.push({
          code: "DELPHI_DATA_BINDING_UNRESOLVED",
          message: `${binding.componentName} has incomplete static DB binding metadata: ${binding.warnings.join(" ") || "runtime assignment may be required."}`,
          level: "warning",
          filePath: binding.sourceFile,
          heuristic: true,
        });
      }
    }
    const combinedWarnings = dedupeWarnings([
      ...warnings,
      {
        code: "HEURISTIC_ANALYSIS",
        message:
          "Analysis results are heuristic for Go, SQL, and Delphi. Use them to support legacy impact review and human code review, not as a compiler-grade source-of-truth.",
        level: "note",
        heuristic: true,
      },
    ]);
    const rules = buildRules(fieldReferences, combinedRisks);

    const metrics: AnalysisMetrics = {
      fileCount: files.length,
      eligibleFileCount,
      analyzedFileCount,
      skippedFileCount: files.length - analyzedFileCount,
      heuristicFileCount,
      degradedFileCount,
      symbolCount: symbols.length,
      dependencyCount: combinedDependencies.length,
      fieldCount: new Set([
        ...fieldReferences.map((reference) => buildFieldIdentityKey(reference)),
        ...schemaFields.map((field) => buildFieldIdentityKey({ table: field.table, field: field.field })),
      ]).size,
      fieldDependencyCount: fieldReferences.length,
      riskCount: combinedRisks.length,
      ruleCount: rules.length,
      warningCount: combinedWarnings.length,
      delphiEventMap,
      delphiDataBindings: dfmMetadata.dataBindings,
    };
    metrics.confidence = calculateAnalysisConfidence({
      metrics,
      analyzerWarnings: combinedWarnings,
      fileTypes: files.map((file) => file.path.match(/\.[^.\\/]+$/)?.[0] ?? file.language),
      risks: combinedRisks,
    });

    const hasMaterialWarnings = combinedWarnings.some((warning) => warning.level !== "note");
    const status: AnalysisStatus =
      metrics.eligibleFileCount === 0 || metrics.analyzedFileCount === 0
        ? "failed"
        : metrics.skippedFileCount > 0 || metrics.degradedFileCount > 0
          ? "partial"
          : hasMaterialWarnings
            ? "completed_with_warnings"
            : "completed";

    return {
      projectId,
      status,
      language: files[0]?.language ?? "unknown",
      symbols,
      dependencies: combinedDependencies,
      fieldReferences,
      schemaFields,
      risks: combinedRisks,
      rules,
      warnings: combinedWarnings,
      flowDocument: this.documentGenerator.generateFlowDocument(symbols, combinedDependencies),
      dataDependencyDocument: this.documentGenerator.generateDataDependencyDocument(fieldReferences),
      risksDocument: this.documentGenerator.generateRisksDocument(combinedRisks),
      rulesYaml: this.documentGenerator.generateRulesYaml(rules),
      delphiEventMap,
      delphiDataBindings: dfmMetadata.dataBindings,
      riskScore: this.riskDetector.calculateRiskScore(combinedRisks),
      metrics,
    };
  }
}
