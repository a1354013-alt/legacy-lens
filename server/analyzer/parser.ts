import type { AnalysisWarning } from "../../shared/contracts";
import type { AnalyzedSymbol, FieldReference, SymbolDependency, SymbolType } from "./types";
import { buildSymbolStableKey } from "./types";

export interface FileParser {
  parseSymbols(): AnalyzedSymbol[];
  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[];
  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[];
  collectWarnings(): AnalysisWarning[];
}

function normalizeName(value: string) {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "");
}

function normalizeFilePath(value: string) {
  return value.replace(/\\/g, "/");
}

function createSymbol(input: {
  name: string;
  qualifiedName?: string;
  type: SymbolType;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
}) {
  return {
    stableKey: buildSymbolStableKey({
      file: input.file,
      name: input.qualifiedName ?? input.name,
      startLine: input.startLine,
    }),
    name: input.name,
    qualifiedName: input.qualifiedName,
    type: input.type,
    file: normalizeFilePath(input.file),
    startLine: input.startLine,
    endLine: input.endLine,
    signature: input.signature,
  } satisfies AnalyzedSymbol;
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

function findOwnerSymbol(symbols: AnalyzedSymbol[], line: number, file?: string) {
  return symbols.find((symbol) => {
    if (file && normalizeFilePath(symbol.file) !== normalizeFilePath(file)) {
      return false;
    }
    return symbol.startLine <= line && symbol.endLine >= line;
  });
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

function parseSqlReference(sql: string, line: number, file: string, owner?: AnalyzedSymbol): FieldReference[] {
  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  const references: FieldReference[] = [];

  const base = {
    file,
    line,
    symbolStableKey: owner?.stableKey,
    symbolName: owner?.qualifiedName ?? owner?.name,
    context: normalizedSql,
  };

  const insertMatch = normalizedSql.match(/INSERT\s+INTO\s+([a-zA-Z_][\w$]*)\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table = normalizeName(insertMatch[1]);
    const fields = insertMatch[2].split(",").map((value) => normalizeName(value));
    for (const field of fields) {
      if (!field) continue;
      references.push({ table, field, type: "write", ...base });
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
      references.push({ table, field, type: "write", ...base });
    }
    return references;
  }

  const deleteMatch = normalizedSql.match(/DELETE\s+FROM\s+([a-zA-Z_][\w$]*)/i);
  if (deleteMatch) {
    references.push({
      table: normalizeName(deleteMatch[1]),
      field: "*",
      type: "write",
      ...base,
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
      references.push({ table, field, type: "read", ...base });
    }
  }

  return references;
}

function resolveDependencyTarget(owner: AnalyzedSymbol, candidateName: string, symbols: AnalyzedSymbol[]) {
  const matches = symbols.filter(
    (symbol) => symbol.name === candidateName || symbol.qualifiedName === candidateName
  );

  if (matches.length === 0) {
    return null;
  }

  const sameFileMatches = matches.filter((symbol) => normalizeFilePath(symbol.file) === normalizeFilePath(owner.file));
  if (sameFileMatches.length === 1) {
    return sameFileMatches[0];
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function buildCallDependencies(lines: string[], symbols: AnalyzedSymbol[], excludedNames: string[]): SymbolDependency[] {
  const dependencies: SymbolDependency[] = [];
  const builtins = new Set([...excludedNames, "if", "for", "switch", "return", "func", "select", "update", "delete"]);
  const callPattern = /\b([a-zA-Z_][\w$.]*)\s*\(/g;

  lines.forEach((line, index) => {
    const owner = findOwnerSymbol(symbols, index + 1);
    if (!owner) return;

    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(line)) !== null) {
      const rawTarget = match[1];
      if (!rawTarget || builtins.has(rawTarget.toLowerCase())) {
        continue;
      }

      const target = resolveDependencyTarget(owner, rawTarget.split(".").at(-1) ?? rawTarget, symbols);
      if (!target || target.stableKey === owner.stableKey) {
        continue;
      }

      dependencies.push({
        from: owner.stableKey,
        to: target.stableKey,
        fromName: owner.qualifiedName ?? owner.name,
        toName: target.qualifiedName ?? target.name,
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
        symbols.push(
          createSymbol({
            name: functionMatch[2],
            type: functionMatch[1] ? "method" : "function",
            file: this.file,
            startLine: index + 1,
            endLine: findBlockEnd(lines, index, /{/g, /}/g),
            signature: line.trim(),
          })
        );
        return;
      }

      const structMatch = line.match(structPattern);
      if (structMatch) {
        symbols.push(
          createSymbol({
            name: structMatch[1],
            type: "table",
            file: this.file,
            startLine: index + 1,
            endLine: index + 1,
            signature: line.trim(),
          })
        );
      }
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]) {
    return buildCallDependencies(this.content.split(/\r?\n/), symbols, []);
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]) {
    const fragments = parseSqlFragments(this.content);
    return fragments.flatMap(({ line, sql }) => parseSqlReference(sql, line, this.file, findOwnerSymbol(symbols, line, this.file)));
  }

  collectWarnings() {
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
        symbols.push(createSymbol({ name: tableMatch[1], type: "table", file: this.file, startLine: index + 1, endLine: index + 1, signature: line.trim() }));
        return;
      }

      const procedureMatch = line.match(/CREATE\s+PROCEDURE\s+([a-zA-Z_][\w$]*)/i);
      if (procedureMatch) {
        symbols.push(createSymbol({ name: procedureMatch[1], type: "procedure", file: this.file, startLine: index + 1, endLine: index + 1, signature: line.trim() }));
        return;
      }

      const functionMatch = line.match(/CREATE\s+FUNCTION\s+([a-zA-Z_][\w$]*)/i);
      if (functionMatch) {
        symbols.push(createSymbol({ name: functionMatch[1], type: "function", file: this.file, startLine: index + 1, endLine: index + 1, signature: line.trim() }));
        return;
      }

      if (/^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line.trim())) {
        symbols.push(createSymbol({ name: `query_${index + 1}`, type: "query", file: this.file, startLine: index + 1, endLine: index + 1, signature: line.trim() }));
      }
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]) {
    const dependencies: SymbolDependency[] = [];
    const lines = this.content.split(/\r?\n/);

    lines.forEach((line, index) => {
      const owner = findOwnerSymbol(symbols, index + 1, this.file);
      if (!owner) return;

      const match = line.match(/\bEXEC(?:UTE)?\s+([a-zA-Z_][\w$]*)/i);
      const targetName = match?.[1];
      if (!targetName) return;

      const target = resolveDependencyTarget(owner, targetName, symbols);
      if (!target) return;

      dependencies.push({
        from: owner.stableKey,
        to: target.stableKey,
        fromName: owner.qualifiedName ?? owner.name,
        toName: target.qualifiedName ?? target.name,
        type: "references",
        line: index + 1,
      });
    });

    return dependencies;
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]) {
    const lines = this.content.split(/\r?\n/);
    return lines.flatMap((line, index) => parseSqlReference(line, index + 1, this.file, findOwnerSymbol(symbols, index + 1, this.file)));
  }

  collectWarnings() {
    return [];
  }
}

function extractDelphiSymbol(line: string) {
  const pattern =
    /^\s*(?:(class)\s+)?(procedure|function|constructor|destructor)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\s*(\([^)]*\))?\s*(?::\s*([^;]+))?\s*(?:;\s*(.*))?$/i;
  const match = line.match(pattern);
  if (!match) {
    return null;
  }

  const qualifiedName = match[3];
  const name = qualifiedName.split(".").at(-1) ?? qualifiedName;
  const kind = match[2].toLowerCase();
  const modifiers = match[6]?.trim() ?? "";

  const type: SymbolType =
    kind === "constructor" || kind === "destructor" || qualifiedName.includes(".")
      ? "method"
      : kind === "procedure"
        ? "procedure"
        : "function";

  const signature = [match[1] ? "class" : "", match[2], qualifiedName, match[4] ?? "", match[5] ? `: ${match[5].trim()}` : "", modifiers ? `; ${modifiers}` : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    name,
    qualifiedName,
    type,
    signature,
  };
}

export class DelphiParser implements FileParser {
  constructor(private readonly content: string, private readonly file: string) {}

  parseSymbols(): AnalyzedSymbol[] {
    const lines = this.content.split(/\r?\n/);
    const symbols: AnalyzedSymbol[] = [];

    lines.forEach((line, index) => {
      const symbol = extractDelphiSymbol(line);
      if (!symbol) return;

      symbols.push(
        createSymbol({
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          type: symbol.type,
          file: this.file,
          startLine: index + 1,
          endLine: findBlockEnd(lines, index, /\bbegin\b/i, /\bend\b\s*;?/i),
          signature: symbol.signature,
        })
      );
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]) {
    return buildCallDependencies(this.content.split(/\r?\n/), symbols, ["inherited"]);
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]) {
    const fragments = parseSqlFragments(this.content);
    return fragments.flatMap(({ line, sql }) => parseSqlReference(sql, line, this.file, findOwnerSymbol(symbols, line, this.file)));
  }

  collectWarnings() {
    const warnings: AnalysisWarning[] = [];
    if (!/begin\b/i.test(this.content) || !/end\b/i.test(this.content)) {
      warnings.push({
        code: "DELPHI_BLOCK_UNBALANCED",
        message: "Delphi source may have incomplete procedure blocks; ranges are best-effort.",
        filePath: this.file,
        heuristic: true,
      });
    }

    warnings.push({
      code: "HEURISTIC_ANALYSIS",
      message: "Delphi parsing is heuristic and may miss semantic resolution across units.",
      filePath: this.file,
      heuristic: true,
    });

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
        heuristic: true,
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
