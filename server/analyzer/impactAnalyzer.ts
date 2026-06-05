import { eq } from "drizzle-orm";
import {
  dependencies,
  fieldDependencies,
  fields,
  files,
  risks,
  rules,
  symbols,
} from "../../drizzle/schema";
import type { ImpactAnalysisResult, ImpactTargetType } from "../../shared/contracts";
import { buildFieldIdentityKey, hasExplicitFieldSchema, hasExplicitTableSchema, normalizeFieldIdentity } from "./fieldIdentity";
import { getDb } from "../db";

type ProjectSymbol = typeof symbols.$inferSelect;
type ProjectFile = typeof files.$inferSelect;
type ProjectField = typeof fields.$inferSelect;
type ProjectDependency = typeof dependencies.$inferSelect;
type ProjectFieldDependency = typeof fieldDependencies.$inferSelect;
type ProjectRisk = typeof risks.$inferSelect;
type ProjectRule = typeof rules.$inferSelect;

type ProjectIndex = {
  projectId: number;
  symbols: ProjectSymbol[];
  files: ProjectFile[];
  fields: ProjectField[];
  dependencies: ProjectDependency[];
  fieldDependencies: ProjectFieldDependency[];
  risks: ProjectRisk[];
  rules: ProjectRule[];
  symbolById: Map<number, ProjectSymbol>;
  fileById: Map<number, ProjectFile>;
  fieldById: Map<number, ProjectField>;
};

type ResolvedTarget =
  | { type: "symbol"; symbols: ProjectSymbol[]; confidence: number }
  | { type: "file"; files: ProjectFile[]; confidence: number }
  | { type: "sql_table"; fields: ProjectField[]; confidence: number }
  | { type: "sql_field"; fields: ProjectField[]; confidence: number }
  | { type: "risk"; risks: ProjectRisk[]; confidence: number }
  | { type: "rule"; rules: ProjectRule[]; confidence: number }
  | { type: "auto"; confidence: 0 };

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function getShortSymbolName(symbol: ProjectSymbol) {
  return symbol.name.split(".").at(-1) ?? symbol.name;
}

function getFileIdentity(file: ProjectFile) {
  return [file.fileName, file.filePath].map((value) => normalize(value));
}

function uniqueSorted(values: Iterable<string>) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function addSymbolImpact(
  result: ImpactAnalysisResult,
  fileSet: Set<string>,
  symbolMap: Map<string, { name: string; file: string; type: string }>,
  symbol: ProjectSymbol,
  index: ProjectIndex
) {
  const filePath = index.fileById.get(symbol.fileId)?.filePath;
  if (!filePath) {
    return;
  }

  fileSet.add(filePath);
  symbolMap.set(`${filePath}:${symbol.name}:${symbol.type}`, {
    name: symbol.name,
    file: filePath,
    type: symbol.type,
  });
}

function addRuleImpact(ruleSet: Set<string>, rule: ProjectRule) {
  ruleSet.add(rule.name);
}

function addRiskImpact(riskSet: Set<string>, risk: ProjectRisk) {
  riskSet.add(risk.title);
}

function addFieldImpact(fieldSet: Map<string, { table: string; field: string }>, field: ProjectField) {
  fieldSet.set(buildFieldIdentityKey({ table: field.tableName, field: field.fieldName }), {
    table: field.tableName,
    field: field.fieldName,
  });
}

function normalizedFieldMatches(target: ReturnType<typeof normalizeFieldIdentity>, candidate: ReturnType<typeof normalizeFieldIdentity>, requireSchema: boolean) {
  if (target.table !== candidate.table || target.field !== candidate.field) {
    return false;
  }

  return requireSchema ? target.schema === candidate.schema : true;
}

function normalizedTableMatches(target: ReturnType<typeof normalizeFieldIdentity>, candidate: ReturnType<typeof normalizeFieldIdentity>, requireSchema: boolean) {
  if (target.table !== candidate.table) {
    return false;
  }

  return requireSchema ? target.schema === candidate.schema : true;
}

function addDependencyChain(result: ImpactAnalysisResult, chain: string[]) {
  result.dependencyChains.push(chain);
}

function buildBaseResult(target: string, targetType: ImpactTargetType, confidence: number): ImpactAnalysisResult {
  return {
    target,
    targetType,
    confidence,
    affectedCount: 0,
    summary: "",
    affectedFiles: [],
    affectedSymbols: [],
    affectedTables: [],
    affectedFields: [],
    affectedRules: [],
    affectedRisks: [],
    dependencyChains: [],
    warnings: [],
  };
}

function findMatchingSymbols(projectSymbols: ProjectSymbol[], target: string) {
  const normalizedTarget = normalize(target);
  return projectSymbols.filter((symbol) => {
    const candidates = [symbol.name, getShortSymbolName(symbol)];
    return candidates.some((candidate) => normalize(candidate) === normalizedTarget);
  });
}

function findMatchingFiles(projectFiles: ProjectFile[], target: string) {
  const normalizedTarget = normalize(target);
  return projectFiles.filter((file) => getFileIdentity(file).includes(normalizedTarget));
}

function findMatchingRules(projectRules: ProjectRule[], target: string) {
  const normalizedTarget = normalize(target);
  return projectRules.filter((rule) => {
    const candidates = [rule.name, rule.description ?? "", rule.condition ?? ""];
    return candidates.some((candidate) => normalize(candidate) === normalizedTarget);
  });
}

function findMatchingRisks(projectRisks: ProjectRisk[], target: string) {
  const normalizedTarget = normalize(target);
  return projectRisks.filter((risk) => normalize(risk.title) === normalizedTarget);
}

function findMatchingSqlFields(projectFields: ProjectField[], target: string) {
  const targetIdentity = { table: "", field: target };
  const normalizedTarget = normalizeFieldIdentity(targetIdentity);
  if (!normalizedTarget.table || !normalizedTarget.field) {
    return [];
  }

  const requireSchema = hasExplicitFieldSchema(targetIdentity);
  return projectFields.filter((field) =>
    normalizedFieldMatches(normalizedTarget, normalizeFieldIdentity({ table: field.tableName, field: field.fieldName }), requireSchema)
  );
}

function findMatchingSqlTable(projectFields: ProjectField[], target: string) {
  const normalizedTarget = normalizeFieldIdentity({ table: target, field: "__legacy_lens_placeholder__" });
  const requireSchema = hasExplicitTableSchema(target);
  return projectFields.filter((field) =>
    normalizedTableMatches(normalizedTarget, normalizeFieldIdentity({ table: field.tableName, field: field.fieldName }), requireSchema)
  );
}

function findSymbolsForFile(fileId: number, projectSymbols: ProjectSymbol[]) {
  return projectSymbols.filter((symbol) => symbol.fileId === fileId);
}

function findRulesForFile(filePath: string, projectRules: ProjectRule[]) {
  const normalizedPath = normalize(filePath);
  return projectRules.filter((rule) => normalize(rule.sourceFile ?? "") === normalizedPath);
}

function findRisksForFile(filePath: string, projectRisks: ProjectRisk[]) {
  const normalizedPath = normalize(filePath);
  return projectRisks.filter((risk) => normalize(risk.sourceFile ?? "") === normalizedPath);
}

function findDependenciesForSymbolIds(symbolIds: number[], projectDependencies: ProjectDependency[]) {
  const symbolIdSet = new Set(symbolIds);
  return projectDependencies.filter(
    (dependency) =>
      symbolIdSet.has(dependency.sourceSymbolId) ||
      (dependency.targetSymbolId !== null && symbolIdSet.has(dependency.targetSymbolId))
  );
}

function findSymbolsForFieldIds(fieldIds: number[], projectFieldDependencies: ProjectFieldDependency[]) {
  const fieldIdSet = new Set(fieldIds);
  return projectFieldDependencies.filter((dependency) => fieldIdSet.has(dependency.fieldId));
}

function findSymbolsNearRule(rule: ProjectRule, index: ProjectIndex) {
  if (!rule.sourceFile) {
    return [];
  }

  const file = index.files.find((candidate) => candidate.filePath === rule.sourceFile);
  if (!file) {
    return [];
  }

  const fileSymbols = findSymbolsForFile(file.id, index.symbols);
  if (!rule.lineNumber) {
    return fileSymbols;
  }

  const lineMatches = fileSymbols.filter((symbol) => symbol.startLine <= rule.lineNumber! && symbol.endLine >= rule.lineNumber!);
  return lineMatches.length > 0 ? lineMatches : fileSymbols;
}

export class ImpactAnalyzer {
  private async loadProjectIndex(projectId: number): Promise<ProjectIndex> {
    const db = await getDb();
    if (!db) {
      throw new Error("Database not available");
    }

    const [projectSymbols, projectFiles, projectFields, projectDependencies, projectFieldDependencies, projectRisks, projectRules] =
      await Promise.all([
        db.select().from(symbols).where(eq(symbols.projectId, projectId)),
        db.select().from(files).where(eq(files.projectId, projectId)),
        db.select().from(fields).where(eq(fields.projectId, projectId)),
        db.select().from(dependencies).where(eq(dependencies.projectId, projectId)),
        db.select().from(fieldDependencies).where(eq(fieldDependencies.projectId, projectId)),
        db.select().from(risks).where(eq(risks.projectId, projectId)),
        db.select().from(rules).where(eq(rules.projectId, projectId)),
      ]);

    return {
      projectId,
      symbols: projectSymbols,
      files: projectFiles,
      fields: projectFields,
      dependencies: projectDependencies,
      fieldDependencies: projectFieldDependencies,
      risks: projectRisks,
      rules: projectRules,
      symbolById: new Map(projectSymbols.map((symbol) => [symbol.id, symbol])),
      fileById: new Map(projectFiles.map((file) => [file.id, file])),
      fieldById: new Map(projectFields.map((field) => [field.id, field])),
    };
  }

  private resolveTarget(index: ProjectIndex, target: string, type: ImpactTargetType): ResolvedTarget {
    if (type === "sql_field") {
      const matchedFields = findMatchingSqlFields(index.fields, target);
      return matchedFields.length > 0 ? { type, fields: matchedFields, confidence: 1 } : { type: "auto", confidence: 0 };
    }

    if (type === "symbol") {
      const matchedSymbols = findMatchingSymbols(index.symbols, target);
      return matchedSymbols.length > 0 ? { type, symbols: matchedSymbols, confidence: 1 } : { type: "auto", confidence: 0 };
    }

    if (type === "file") {
      const matchedFiles = findMatchingFiles(index.files, target);
      return matchedFiles.length > 0 ? { type, files: matchedFiles, confidence: 1 } : { type: "auto", confidence: 0 };
    }

    if (type === "sql_table") {
      const matchedFields = findMatchingSqlTable(index.fields, target);
      return matchedFields.length > 0 ? { type, fields: matchedFields, confidence: 1 } : { type: "auto", confidence: 0 };
    }

    if (type === "risk") {
      const matchedRisks = findMatchingRisks(index.risks, target);
      return matchedRisks.length > 0 ? { type, risks: matchedRisks, confidence: 1 } : { type: "auto", confidence: 0 };
    }

    if (type === "rule") {
      const matchedRules = findMatchingRules(index.rules, target);
      return matchedRules.length > 0 ? { type, rules: matchedRules, confidence: 1 } : { type: "auto", confidence: 0 };
    }

    const fieldTarget = findMatchingSqlFields(index.fields, target);
    if (fieldTarget.length > 0) {
      return { type: "sql_field", fields: fieldTarget, confidence: 1 };
    }

    const symbolTarget = findMatchingSymbols(index.symbols, target);
    if (symbolTarget.length > 0) {
      return { type: "symbol", symbols: symbolTarget, confidence: 1 };
    }

    const fileTarget = findMatchingFiles(index.files, target);
    if (fileTarget.length > 0) {
      return { type: "file", files: fileTarget, confidence: 1 };
    }

    const tableTarget = findMatchingSqlTable(index.fields, target);
    if (tableTarget.length > 0) {
      return { type: "sql_table", fields: tableTarget, confidence: 1 };
    }

    const riskTarget = findMatchingRisks(index.risks, target);
    if (riskTarget.length > 0) {
      return { type: "risk", risks: riskTarget, confidence: 1 };
    }

    const ruleTarget = findMatchingRules(index.rules, target);
    if (ruleTarget.length > 0) {
      return { type: "rule", rules: ruleTarget, confidence: 1 };
    }

    return { type: "auto", confidence: 0 };
  }

  private analyzeSymbolTarget(index: ProjectIndex, result: ImpactAnalysisResult, matchedSymbols: ProjectSymbol[]) {
    const fileSet = new Set<string>();
    const symbolMap = new Map<string, { name: string; file: string; type: string }>();
    const tableSet = new Set<string>();
    const fieldMap = new Map<string, { table: string; field: string }>();
    const ruleSet = new Set<string>();
    const riskSet = new Set<string>();

    for (const symbol of matchedSymbols) {
      addSymbolImpact(result, fileSet, symbolMap, symbol, index);

      const relatedFieldDependencies = index.fieldDependencies.filter((dependency) => dependency.symbolId === symbol.id);
      relatedFieldDependencies.forEach((dependency) => {
        const field = index.fieldById.get(dependency.fieldId);
        if (!field) return;
        tableSet.add(field.tableName);
        addFieldImpact(fieldMap, field);
        addDependencyChain(result, [symbol.name, `${field.tableName}.${field.fieldName}`]);
      });

      const relatedDependencies = findDependenciesForSymbolIds([symbol.id], index.dependencies);
      relatedDependencies.forEach((dependency) => {
        const sourceSymbol = index.symbolById.get(dependency.sourceSymbolId);
        const targetSymbol = dependency.targetSymbolId ? index.symbolById.get(dependency.targetSymbolId) : undefined;
        if (sourceSymbol) {
          addSymbolImpact(result, fileSet, symbolMap, sourceSymbol, index);
        }
        if (targetSymbol) {
          addSymbolImpact(result, fileSet, symbolMap, targetSymbol, index);
        }
        addDependencyChain(result, [
          sourceSymbol?.name ?? `symbol:${dependency.sourceSymbolId}`,
          targetSymbol?.name ?? dependency.targetExternalName ?? "unresolved",
        ]);
      });

      const filePath = index.fileById.get(symbol.fileId)?.filePath;
      if (!filePath) continue;

      findRulesForFile(filePath, index.rules).forEach((rule) => addRuleImpact(ruleSet, rule));
      findRisksForFile(filePath, index.risks).forEach((risk) => addRiskImpact(riskSet, risk));
    }

    result.affectedFiles = uniqueSorted(fileSet);
    result.affectedSymbols = Array.from(symbolMap.values()).sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
    result.affectedTables = uniqueSorted(tableSet);
    result.affectedFields = Array.from(fieldMap.values()).sort((left, right) => left.table.localeCompare(right.table) || left.field.localeCompare(right.field));
    result.affectedRules = uniqueSorted(ruleSet);
    result.affectedRisks = uniqueSorted(riskSet);
  }

  private analyzeFileTarget(index: ProjectIndex, result: ImpactAnalysisResult, matchedFiles: ProjectFile[]) {
    const fileSet = new Set<string>();
    const symbolMap = new Map<string, { name: string; file: string; type: string }>();
    const ruleSet = new Set<string>();
    const riskSet = new Set<string>();

    for (const file of matchedFiles) {
      fileSet.add(file.filePath);

      const fileSymbols = findSymbolsForFile(file.id, index.symbols);
      fileSymbols.forEach((symbol) => addSymbolImpact(result, fileSet, symbolMap, symbol, index));

      findRulesForFile(file.filePath, index.rules).forEach((rule) => {
        addRuleImpact(ruleSet, rule);
        addDependencyChain(result, [file.fileName, rule.name]);
      });

      findRisksForFile(file.filePath, index.risks).forEach((risk) => {
        addRiskImpact(riskSet, risk);
        addDependencyChain(result, [file.fileName, risk.title]);
      });

      const fileDependencies = findDependenciesForSymbolIds(fileSymbols.map((symbol) => symbol.id), index.dependencies);
      fileDependencies.forEach((dependency) => {
        const sourceSymbol = index.symbolById.get(dependency.sourceSymbolId);
        const targetSymbol = dependency.targetSymbolId ? index.symbolById.get(dependency.targetSymbolId) : undefined;
        if (sourceSymbol) {
          addSymbolImpact(result, fileSet, symbolMap, sourceSymbol, index);
        }
        if (targetSymbol) {
          addSymbolImpact(result, fileSet, symbolMap, targetSymbol, index);
        }
        addDependencyChain(result, [
          sourceSymbol?.name ?? `symbol:${dependency.sourceSymbolId}`,
          targetSymbol?.name ?? dependency.targetExternalName ?? "unresolved",
        ]);
      });
    }

    result.affectedFiles = uniqueSorted(fileSet);
    result.affectedSymbols = Array.from(symbolMap.values()).sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
    result.affectedRules = uniqueSorted(ruleSet);
    result.affectedRisks = uniqueSorted(riskSet);
  }

  private analyzeSqlTarget(index: ProjectIndex, result: ImpactAnalysisResult, matchedFields: ProjectField[]) {
    const fileSet = new Set<string>();
    const symbolMap = new Map<string, { name: string; file: string; type: string }>();
    const tableSet = new Set<string>();
    const fieldMap = new Map<string, { table: string; field: string }>();
    const ruleSet = new Set<string>();

    matchedFields.forEach((field) => {
      tableSet.add(field.tableName);
      addFieldImpact(fieldMap, field);
    });

    const usages = findSymbolsForFieldIds(
      matchedFields.map((field) => field.id),
      index.fieldDependencies
    );

    usages.forEach((usage) => {
      const symbol = index.symbolById.get(usage.symbolId);
      if (!symbol) return;
      addSymbolImpact(result, fileSet, symbolMap, symbol, index);

      const field = index.fieldById.get(usage.fieldId);
      if (field) {
        addDependencyChain(result, [symbol.name, `${field.tableName}.${field.fieldName}`]);
      }
    });

    const matchedFieldKeys = new Set(
      matchedFields.flatMap((field) => {
        const normalized = normalizeFieldIdentity({ table: field.tableName, field: field.fieldName });
        return [`${normalized.table}.${normalized.field}`, normalized.originalName.toLowerCase()];
      })
    );
    index.rules.forEach((rule) => {
      const haystack = [rule.name, rule.description ?? "", rule.condition ?? "", rule.sourceFile ?? ""]
        .map((value) => normalize(value))
        .join(" ");

      if (Array.from(matchedFieldKeys).some((key) => haystack.includes(key))) {
        addRuleImpact(ruleSet, rule);
      }
    });

    result.affectedFiles = uniqueSorted(fileSet);
    result.affectedSymbols = Array.from(symbolMap.values()).sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
    result.affectedTables = uniqueSorted(tableSet);
    result.affectedFields = Array.from(fieldMap.values()).sort((left, right) => left.table.localeCompare(right.table) || left.field.localeCompare(right.field));
    result.affectedRules = uniqueSorted(ruleSet);
  }

  private analyzeRiskTarget(index: ProjectIndex, result: ImpactAnalysisResult, matchedRisks: ProjectRisk[]) {
    const fileSet = new Set<string>();
    const symbolMap = new Map<string, { name: string; file: string; type: string }>();
    const riskSet = new Set<string>();

    matchedRisks.forEach((risk) => {
      addRiskImpact(riskSet, risk);
      if (risk.sourceFile) {
        fileSet.add(risk.sourceFile);
        const file = index.files.find((candidate) => candidate.filePath === risk.sourceFile);
        if (file) {
          const fileSymbols = findSymbolsForFile(file.id, index.symbols).filter((symbol) =>
            risk.lineNumber ? symbol.startLine <= risk.lineNumber && symbol.endLine >= risk.lineNumber : true
          );
          fileSymbols.forEach((symbol) => addSymbolImpact(result, fileSet, symbolMap, symbol, index));
        }
      }
    });

    result.affectedFiles = uniqueSorted(fileSet);
    result.affectedSymbols = Array.from(symbolMap.values()).sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
    result.affectedRisks = uniqueSorted(riskSet);
  }

  private analyzeRuleTarget(index: ProjectIndex, result: ImpactAnalysisResult, matchedRules: ProjectRule[]) {
    const fileSet = new Set<string>();
    const symbolMap = new Map<string, { name: string; file: string; type: string }>();
    const ruleSet = new Set<string>();
    const riskSet = new Set<string>();

    matchedRules.forEach((rule) => {
      addRuleImpact(ruleSet, rule);
      if (rule.sourceFile) {
        fileSet.add(rule.sourceFile);
      }

      const relatedSymbols = findSymbolsNearRule(rule, index);
      relatedSymbols.forEach((symbol) => addSymbolImpact(result, fileSet, symbolMap, symbol, index));

      relatedSymbols.forEach((symbol) => {
        findDependenciesForSymbolIds([symbol.id], index.dependencies).forEach((dependency) => {
          const sourceSymbol = index.symbolById.get(dependency.sourceSymbolId);
          const targetSymbol = dependency.targetSymbolId ? index.symbolById.get(dependency.targetSymbolId) : undefined;
          addDependencyChain(result, [
            sourceSymbol?.name ?? `symbol:${dependency.sourceSymbolId}`,
            targetSymbol?.name ?? dependency.targetExternalName ?? "unresolved",
          ]);
        });
      });

      if (rule.sourceFile) {
        findRisksForFile(rule.sourceFile, index.risks).forEach((risk) => addRiskImpact(riskSet, risk));
      }
    });

    result.affectedFiles = uniqueSorted(fileSet);
    result.affectedSymbols = Array.from(symbolMap.values()).sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
    result.affectedRules = uniqueSorted(ruleSet);
    result.affectedRisks = uniqueSorted(riskSet);
  }

  async analyze(projectId: number, target: string, type: ImpactTargetType = "auto"): Promise<ImpactAnalysisResult> {
    const index = await this.loadProjectIndex(projectId);
    const resolved = this.resolveTarget(index, target, type);
    const result = buildBaseResult(target, resolved.type === "auto" ? type : resolved.type, resolved.confidence);

    if (resolved.type === "auto") {
      result.warnings.push(`Could not resolve target type for "${target}"`);
      result.summary = "No impact found as the target could not be identified inside the current project.";
      return result;
    }

    if (resolved.type === "symbol") {
      this.analyzeSymbolTarget(index, result, resolved.symbols);
    } else if (resolved.type === "file") {
      this.analyzeFileTarget(index, result, resolved.files);
    } else if (resolved.type === "sql_table" || resolved.type === "sql_field") {
      this.analyzeSqlTarget(index, result, resolved.fields);
    } else if (resolved.type === "risk") {
      this.analyzeRiskTarget(index, result, resolved.risks);
    } else if (resolved.type === "rule") {
      this.analyzeRuleTarget(index, result, resolved.rules);
    }

    const affectedCount =
      result.affectedFiles.length +
      result.affectedSymbols.length +
      result.affectedTables.length +
      result.affectedFields.length +
      result.affectedRules.length +
      result.affectedRisks.length;

    result.affectedCount = affectedCount;

    result.summary =
      result.affectedCount > 0
        ? `Modifying ${target} (${result.targetType}) affects ${result.affectedCount} scoped items inside project ${projectId}.`
        : `No additional impacts were found for ${target} inside project ${projectId}.`;

    return result;
  }
}
