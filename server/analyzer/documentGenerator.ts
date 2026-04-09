import type { AnalyzedSymbol, DetectedRisk, DetectedRule, FieldReference, SymbolDependency } from "./types";

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export class DocumentGenerator {
  generateFlowDocument(symbols: AnalyzedSymbol[], dependencies: SymbolDependency[]): string {
    const entryPoints = symbols.filter((symbol) => ["main", "serve", "handler"].includes(symbol.name.toLowerCase()));
    const roots = entryPoints.length > 0 ? entryPoints : symbols.slice(0, 8);
    const lines = ["# FLOW", "", "This document summarizes the discovered callable entry points and downstream calls.", ""];

    for (const symbol of roots) {
      lines.push(`## ${symbol.name}`);
      lines.push("");
      lines.push(`- Type: ${symbol.type}`);
      lines.push(`- Location: ${symbol.file}:${symbol.startLine}`);
      if (symbol.signature) {
        lines.push(`- Signature: \`${symbol.signature}\``);
      }

      const downstream = dependencies.filter((dependency) => dependency.from === symbol.name).map((dependency) => dependency.to);
      lines.push(`- Downstream calls: ${downstream.length > 0 ? unique(downstream).join(", ") : "None detected"}`);
      lines.push("");
    }

    if (roots.length === 0) {
      lines.push("- No callable symbols were detected.");
    }

    return lines.join("\n");
  }

  generateDataDependencyDocument(fieldReferences: FieldReference[]): string {
    const byTable = new Map<string, FieldReference[]>();
    for (const reference of fieldReferences) {
      const bucket = byTable.get(reference.table) ?? [];
      bucket.push(reference);
      byTable.set(reference.table, bucket);
    }

    const lines = ["# DATA_DEPENDENCY", "", "This document tracks read/write/calculate activity per table field.", ""];

    for (const [tableName, references] of Array.from(byTable.entries())) {
      lines.push(`## ${tableName}`);
      lines.push("");

      const fieldMap = new Map<string, FieldReference[]>();
      for (const reference of references) {
        const bucket = fieldMap.get(reference.field) ?? [];
        bucket.push(reference);
        fieldMap.set(reference.field, bucket);
      }

      for (const [fieldName, fieldEntries] of Array.from(fieldMap.entries())) {
        const reads = fieldEntries
          .filter((entry: FieldReference) => entry.type === "read")
          .map((entry: FieldReference) => `${entry.file}:${entry.line}`);
        const writes = fieldEntries
          .filter((entry: FieldReference) => entry.type === "write")
          .map((entry: FieldReference) => `${entry.file}:${entry.line}`);
        const calcs = fieldEntries
          .filter((entry: FieldReference) => entry.type === "calculate")
          .map((entry: FieldReference) => `${entry.file}:${entry.line}`);
        lines.push(`### ${fieldName}`);
        lines.push("");
        lines.push(`- Reads: ${reads.length > 0 ? reads.join(", ") : "None"}`);
        lines.push(`- Writes: ${writes.length > 0 ? writes.join(", ") : "None"}`);
        lines.push(`- Calculations: ${calcs.length > 0 ? calcs.join(", ") : "None"}`);
        lines.push("");
      }
    }

    if (byTable.size === 0) {
      lines.push("- No field references were detected.");
    }

    return lines.join("\n");
  }

  generateRisksDocument(risks: DetectedRisk[]): string {
    const groups: Array<DetectedRisk["severity"]> = ["critical", "high", "medium", "low"];
    const lines = ["# RISKS", "", "Detected implementation risks grouped by severity.", ""];

    for (const severity of groups) {
      const bucket = risks.filter((risk) => risk.severity === severity);
      if (bucket.length === 0) continue;

      lines.push(`## ${severity.toUpperCase()}`);
      lines.push("");

      for (const risk of bucket) {
        lines.push(`### ${risk.title}`);
        lines.push("");
        lines.push(`- Description: ${risk.description}`);
        lines.push(`- Location: ${risk.sourceFile}:${risk.lineNumber}`);
        lines.push(`- Category: ${risk.category}`);
        if (risk.suggestion) {
          lines.push(`- Recommendation: ${risk.suggestion}`);
        }
        lines.push("");
      }
    }

    if (risks.length === 0) {
      lines.push("- No risks were detected.");
    }

    return lines.join("\n");
  }

  generateRulesYaml(rules: DetectedRule[]): string {
    const lines = ["rules:"];
    if (rules.length === 0) {
      lines.push("  []");
      return lines.join("\n");
    }

    for (const rule of rules) {
      lines.push(`  - name: ${rule.name}`);
      lines.push(`    type: ${rule.ruleType}`);
      lines.push(`    description: ${rule.description.replace(/\n/g, " ")}`);
      if (rule.condition) {
        lines.push(`    condition: ${rule.condition.replace(/\n/g, " ")}`);
      }
      if (rule.sourceFile) {
        lines.push(`    source: ${rule.sourceFile}${rule.lineNumber ? `:${rule.lineNumber}` : ""}`);
      }
    }

    return lines.join("\n");
  }
}
