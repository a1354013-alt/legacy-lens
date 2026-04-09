import type { AnalysisWarning } from "../../shared/contracts";
import type { AnalyzedSymbol, FieldReference, SymbolDependency } from "./types";

export interface FileParser {
  parseSymbols(): AnalyzedSymbol[];
  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[];
  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[];
  collectWarnings(): AnalysisWarning[];
}

function normalizeName(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "");
}

function findBlockEnd(lines: string[], startIndex: number, openPattern: RegExp, closePattern: RegExp): number {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    if (openPattern.test(lines[index] ?? "")) {
      depth += 1;
    }
    if (closePattern.test(lines[index] ?? "")) {
      depth -= 1;
      if (depth <= 0) {
        return index + 1;
      }
    }
  }
  return startIndex + 1;
}

function findOwnerSymbol(symbols: AnalyzedSymbol[], line: number): AnalyzedSymbol | undefined {
  return symbols.find((symbol) => symbol.startLine <= line && symbol.endLine >= line);
}

function parseSqlFragments(content: string): Array<{ line: number; sql: string }> {
  const fragments: Array<{ line: number; sql: string }> = [];
  const lines = content.split(/\r?\n/);
  const quotePattern = /["'`](SELECT|INSERT|UPDATE|DELETE)[\s\S]*?["'`]/gi;

  lines.forEach((line, index) => {
    const matches = line.match(quotePattern);
    if (!matches) return;

    for (const raw of matches) {
      fragments.push({
        line: index + 1,
        sql: raw.slice(1, -1),
      });
    }
  });

  return fragments;
}

function parseSqlReference(sql: string, line: number, file: string, symbolName?: string): FieldReference[] {
  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  const references: FieldReference[] = [];

  const insertMatch = normalizedSql.match(/INSERT\s+INTO\s+([a-zA-Z_][\w$]*)\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table = normalizeName(insertMatch[1]);
    const fields = insertMatch[2].split(",").map((value) => normalizeName(value));
    for (const field of fields) {
      if (!field) continue;
      references.push({ table, field, type: "write", file, line, symbolName, context: normalizedSql });
    }
    return references;
  }

  const updateMatch = normalizedSql.match(/UPDATE\s+([a-zA-Z_][\w$]*)\s+SET\s+(.+?)(?:\s+WHERE|$)/i);
  if (updateMatch) {
    const table = normalizeName(updateMatch[1]);
    const assignments = updateMatch[2].split(",");
    for (const assignment of assignments) {
      const field = normalizeName(assignment.split("=")[0] ?? "");
      if (!field) continue;
      references.push({ table, field, type: "write", file, line, symbolName, context: normalizedSql });
    }
    return references;
  }

  const deleteMatch = normalizedSql.match(/DELETE\s+FROM\s+([a-zA-Z_][\w$]*)/i);
  if (deleteMatch) {
    references.push({
      table: normalizeName(deleteMatch[1]),
      field: "*",
      type: "write",
      file,
      line,
      symbolName,
      context: normalizedSql,
    });
    return references;
  }

  const selectMatch = normalizedSql.match(/SELECT\s+(.+?)\s+FROM\s+([a-zA-Z_][\w$]*)/i);
  if (selectMatch) {
    const fields = selectMatch[1].split(",");
    const table = normalizeName(selectMatch[2]);
    for (const rawField of fields) {
      const field = normalizeName(rawField.split(/\s+AS\s+/i)[0] ?? rawField);
      if (!field || field === "*") continue;
      references.push({ table, field, type: "read", file, line, symbolName, context: normalizedSql });
    }
  }

  return references;
}

function buildCallDependencies(lines: string[], symbols: AnalyzedSymbol[], excludedNames: string[]): SymbolDependency[] {
  const dependencies: SymbolDependency[] = [];
  const knownNames = new Set(symbols.map((symbol) => symbol.name));
  const builtins = new Set([...excludedNames, "if", "for", "switch", "return", "func", "select", "update", "delete"]);
  const callPattern = /\b([a-zA-Z_][\w$]*)\s*\(/g;

  lines.forEach((line, index) => {
    const owner = findOwnerSymbol(symbols, index + 1);
    if (!owner) return;

    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(line)) !== null) {
      const target = match[1];
      if (!target || builtins.has(target.toLowerCase()) || !knownNames.has(target) || target === owner.name) {
        continue;
      }

      dependencies.push({
        from: owner.name,
        to: target,
        type: "calls",
        line: index + 1,
      });
    }
  });

  return dependencies;
}

export class GoParser implements FileParser {
  constructor(private readonly content: string, private readonly file: string) {}

  parseSymbols(): AnalyzedSymbol[] {
    const lines = this.content.split(/\r?\n/);
    const symbols: AnalyzedSymbol[] = [];
    const functionPattern = /^\s*func\s+(?:\(([^)]+)\)\s+)?([a-zA-Z_][\w$]*)\s*\(/;
    const structPattern = /^\s*type\s+([a-zA-Z_][\w$]*)\s+struct\b/;

    lines.forEach((line, index) => {
      const functionMatch = line.match(functionPattern);
      if (functionMatch) {
        symbols.push({
          name: functionMatch[2],
          type: functionMatch[1] ? "method" : "function",
          file: this.file,
          startLine: index + 1,
          endLine: findBlockEnd(lines, index, /{/g, /}/g),
          signature: line.trim(),
        });
        return;
      }

      const structMatch = line.match(structPattern);
      if (structMatch) {
        symbols.push({
          name: structMatch[1],
          type: "table",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
      }
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[] {
    return buildCallDependencies(this.content.split(/\r?\n/), symbols, []);
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[] {
    const fragments = parseSqlFragments(this.content);
    return fragments.flatMap(({ line, sql }) => {
      const owner = findOwnerSymbol(symbols, line);
      return parseSqlReference(sql, line, this.file, owner?.name);
    });
  }

  collectWarnings(): AnalysisWarning[] {
    return [];
  }
}

export class SQLParser implements FileParser {
  constructor(private readonly content: string, private readonly file: string) {}

  parseSymbols(): AnalyzedSymbol[] {
    const lines = this.content.split(/\r?\n/);
    const symbols: AnalyzedSymbol[] = [];

    lines.forEach((line, index) => {
      const tableMatch = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w$]*)/i);
      if (tableMatch) {
        symbols.push({
          name: tableMatch[1],
          type: "table",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
        return;
      }

      const procedureMatch = line.match(/CREATE\s+PROCEDURE\s+([a-zA-Z_][\w$]*)/i);
      if (procedureMatch) {
        symbols.push({
          name: procedureMatch[1],
          type: "procedure",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
        return;
      }

      const functionMatch = line.match(/CREATE\s+FUNCTION\s+([a-zA-Z_][\w$]*)/i);
      if (functionMatch) {
        symbols.push({
          name: functionMatch[1],
          type: "function",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
        return;
      }

      if (/^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line.trim())) {
        symbols.push({
          name: `query_${index + 1}`,
          type: "query",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
      }
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[] {
    const dependencies: SymbolDependency[] = [];
    const lines = this.content.split(/\r?\n/);
    const knownNames = new Set(symbols.map((symbol) => symbol.name));

    lines.forEach((line, index) => {
      const owner = findOwnerSymbol(symbols, index + 1);
      if (!owner) return;

      const match = line.match(/\bEXEC(?:UTE)?\s+([a-zA-Z_][\w$]*)/i);
      const target = match?.[1];
      if (target && knownNames.has(target)) {
        dependencies.push({
          from: owner.name,
          to: target,
          type: "references",
          line: index + 1,
        });
      }
    });

    return dependencies;
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[] {
    const lines = this.content.split(/\r?\n/);
    return lines.flatMap((line, index) => {
      const owner = findOwnerSymbol(symbols, index + 1);
      return parseSqlReference(line, index + 1, this.file, owner?.name);
    });
  }

  collectWarnings(): AnalysisWarning[] {
    return [];
  }
}

export class DelphiParser implements FileParser {
  constructor(private readonly content: string, private readonly file: string) {}

  parseSymbols(): AnalyzedSymbol[] {
    const lines = this.content.split(/\r?\n/);
    const symbols: AnalyzedSymbol[] = [];
    const pattern = /^\s*(procedure|function)\s+([a-zA-Z_][\w$]*)/i;

    lines.forEach((line, index) => {
      const match = line.match(pattern);
      if (!match) return;

      symbols.push({
        name: match[2],
        type: match[1].toLowerCase() === "procedure" ? "procedure" : "function",
        file: this.file,
        startLine: index + 1,
        endLine: findBlockEnd(lines, index, /\bbegin\b/i, /\bend\b\s*;?/i),
        signature: line.trim(),
      });
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[] {
    return buildCallDependencies(this.content.split(/\r?\n/), symbols, ["inherited"]);
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[] {
    const fragments = parseSqlFragments(this.content);
    return fragments.flatMap(({ line, sql }) => {
      const owner = findOwnerSymbol(symbols, line);
      return parseSqlReference(sql, line, this.file, owner?.name);
    });
  }

  collectWarnings(): AnalysisWarning[] {
    const warnings: AnalysisWarning[] = [];
    if (!/begin\b/i.test(this.content) || !/end\b/i.test(this.content)) {
      warnings.push({
        code: "DELPHI_BLOCK_UNBALANCED",
        message: "Delphi source may have incomplete procedure blocks; line ranges are best-effort.",
        filePath: this.file,
      });
    }
    return warnings;
  }
}

export class UnsupportedParser implements FileParser {
  constructor(private readonly file: string, private readonly language: string) {}

  parseSymbols(): AnalyzedSymbol[] {
    return [];
  }

  parseDependencies(): SymbolDependency[] {
    return [];
  }

  parseFieldReferences(): FieldReference[] {
    return [];
  }

  collectWarnings(): AnalysisWarning[] {
    return [
      {
        code: "LANGUAGE_UNSUPPORTED",
        message: `Unsupported language for analysis: ${this.language}`,
        filePath: this.file,
      },
    ];
  }
}

export class ParserFactory {
  static createParser(language: string, content: string, file: string): FileParser {
    const normalized = language.replace(/^\./, "").toLowerCase();

    if (normalized === "go") {
      return new GoParser(content, file);
    }

    if (normalized === "sql") {
      return new SQLParser(content, file);
    }

    if (normalized === "pas" || normalized === "dpr" || normalized === "delphi") {
      return new DelphiParser(content, file);
    }

    return new UnsupportedParser(file, normalized);
  }
}
