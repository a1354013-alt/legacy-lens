import type { AnalysisWarning } from "../../shared/contracts";
import { resolveMostSpecificSymbol } from "./symbolOwner";
import type { AnalyzedSymbol, FieldReference, SymbolDependency, SymbolType } from "./types";
import { buildSymbolStableKey } from "./types";

export interface FileParser {
  parseSymbols(): AnalyzedSymbol[];
  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[];
  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[];
  collectWarnings(): AnalysisWarning[];
}

export interface DelphiUnitInfo {
  unitName: string;
  usesUnits: string[];
  interfaceSymbols: string[];
  implementationSymbols: string[];
}

export interface DfmObjectInfo {
  objectName: string;
  objectType: string;
  eventHandlers: Array<{ eventName: string; handlerName: string }>;
  properties: Record<string, string>;
}

export interface DfmAnalysisResult {
  formName?: string;
  objects: DfmObjectInfo[];
  warnings: AnalysisWarning[];
}

function normalizeName(value: string) {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "");
}

function normalizeFilePath(value: string) {
  return value.replace(/\\/g, "/");
}

function getFileExtension(filePath: string) {
  const index = filePath.lastIndexOf(".");
  return index >= 0 ? filePath.slice(index).toLowerCase() : "";
}

function createSymbol(input: {
  name: string;
  qualifiedName?: string;
  type: SymbolType;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  description?: string;
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
    description: input.description,
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
  return resolveMostSpecificSymbol(symbols, line, file);
}

function splitSqlList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitQualifiedIdentifier(value: string) {
  return value
    .split(".")
    .map((part) => normalizeName(part))
    .filter(Boolean);
}

function normalizeSqlIdentifier(value: string) {
  return normalizeName(value).replace(/^[[(]+|[\])]+$/g, "");
}

function normalizeSqlTableName(value: string) {
  return splitQualifiedIdentifier(value).join(".");
}

function normalizeSqlFieldName(value: string) {
  const withoutAlias = value
    .replace(/\s+AS\s+.+$/i, "")
    .replace(/\s+(?:ASC|DESC)\b.*$/i, "")
    .trim();

  if (withoutAlias === "*") {
    return "*";
  }

  return normalizeSqlIdentifier(withoutAlias);
}

function stripSqlStringLiterals(sql: string) {
  return sql.replace(/'[^']*'/g, " ");
}

function isSqlKeyword(value: string) {
  return /^(select|insert|update|delete)$/i.test(value);
}

function extractQuotedSqlFragments(content: string): Array<{ line: number; sql: string }> {
  const fragments: Array<{ line: number; sql: string }> = [];
  const stringPattern = /["'`]([^"'`]*(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?)["'`]/gi;
  let match: RegExpExecArray | null;

  while ((match = stringPattern.exec(content)) !== null) {
    const rawSql = match[1]?.trim();
    if (!rawSql) {
      continue;
    }

    const startIndex = match.index;
    const line = content.slice(0, startIndex).split(/\r?\n/).length;
    let combinedSql = rawSql;
    let cursor = stringPattern.lastIndex;

    while (true) {
      const between = content.slice(cursor, Math.min(content.length, cursor + 120));
      const joinMatch = between.match(/^\s*(?:\+|&|\|\|)\s*["'`]([^"'`]*)["'`]/);
      if (!joinMatch) {
        break;
      }

      combinedSql += ` ${joinMatch[1]}`;
      cursor += joinMatch[0].length;
      stringPattern.lastIndex = cursor;
    }

    fragments.push({
      line,
      sql: combinedSql,
    });
  }

  return fragments;
}

function parseSqlFragments(content: string): Array<{ line: number; sql: string }> {
  return extractQuotedSqlFragments(content).filter(({ sql }) => isSqlKeyword(sql.trim().split(/\s+/)[0] ?? ""));
}

function parseSqlStatements(content: string): Array<{ line: number; sql: string }> {
  const statements: Array<{ line: number; sql: string }> = [];
  const lines = content.split(/\r?\n/);
  let currentLine: number | null = null;
  let currentParts: string[] = [];

  const flush = () => {
    if (currentLine === null || currentParts.length === 0) {
      currentLine = null;
      currentParts = [];
      return;
    }

    statements.push({
      line: currentLine,
      sql: currentParts.join(" ").trim(),
    });
    currentLine = null;
    currentParts = [];
  };

  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    if (currentLine === null && isSqlKeyword(trimmed.split(/\s+/)[0] ?? "")) {
      currentLine = index + 1;
      currentParts.push(trimmed);
      if (trimmed.includes(";")) {
        flush();
      }
      continue;
    }

    if (currentLine !== null) {
      currentParts.push(trimmed);
      if (trimmed.includes(";")) {
        flush();
      }
      continue;
    }
  }

  flush();
  return statements;
}

function extractSqlAliasMap(sql: string) {
  const aliasMap = new Map<string, string>();
  const tablePattern = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  let match: RegExpExecArray | null;

  while ((match = tablePattern.exec(sql)) !== null) {
    const tableName = normalizeSqlTableName(match[1]);
    const alias = normalizeSqlIdentifier(match[2] ?? "");
    if (tableName) {
      aliasMap.set(tableName.toLowerCase(), tableName);
    }
    if (alias) {
      aliasMap.set(alias.toLowerCase(), tableName);
    }
  }

  return aliasMap;
}

function resolveSqlFieldTarget(rawField: string, primaryTable: string | undefined, aliasMap: Map<string, string>) {
  const normalizedField = normalizeSqlFieldName(rawField);
  if (!normalizedField) {
    return null;
  }

  const parts = splitQualifiedIdentifier(normalizedField);
  if (parts.length >= 2) {
    const field = parts.at(-1);
    const owner = parts.slice(0, -1).join(".");
    const table = aliasMap.get(owner.toLowerCase()) ?? owner;
    if (table && field) {
      return { table, field };
    }
  }

  if (!primaryTable || normalizedField === "*") {
    return null;
  }

  return {
    table: primaryTable,
    field: normalizedField,
  };
}

function extractSqlPredicateFields(sql: string, primaryTable: string | undefined, aliasMap: Map<string, string>) {
  const references: Array<{ table: string; field: string }> = [];
  const strippedSql = stripSqlStringLiterals(sql);
  const predicatePattern = /\b([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+|[A-Za-z_][\w$]*)\b(?=\s*(?:=|<>|!=|<|>|<=|>=|IN\b|LIKE\b))/gi;
  let match: RegExpExecArray | null;

  while ((match = predicatePattern.exec(strippedSql)) !== null) {
    const candidate = match[1];
    if (!candidate || isSqlKeyword(candidate)) {
      continue;
    }

    const resolved = resolveSqlFieldTarget(candidate, primaryTable, aliasMap);
    if (resolved && resolved.field !== "*") {
      references.push(resolved);
    }
  }

  return references;
}

function detectSqlHeuristicWarnings(content: string, file: string): AnalysisWarning[] {
  const warnings: AnalysisWarning[] = [];

  if (/["'`](SELECT|INSERT|UPDATE|DELETE)[\s\S]*?\n[\s\S]*?["'`]/i.test(content)) {
    warnings.push({
      code: "SQL_STRING_MULTILINE",
      message: "Detected multi-line SQL string; field extraction may be incomplete.",
      filePath: file,
      heuristic: true,
    });
  }

  if (/(SELECT|INSERT|UPDATE|DELETE)[^;\n]*("?\s*\+|&|\|\|)/i.test(content)) {
    warnings.push({
      code: "SQL_DYNAMIC_STRING",
      message: "Detected dynamically constructed SQL; dependency extraction may be incomplete.",
      filePath: file,
      heuristic: true,
    });
  }

  return warnings;
}

function parseSqlReference(sql: string, line: number, file: string, owner?: AnalyzedSymbol): FieldReference[] {
  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  const references: FieldReference[] = [];
  const aliasMap = extractSqlAliasMap(normalizedSql);

  const base = {
    file,
    line,
    symbolStableKey: owner?.stableKey,
    symbolName: owner?.qualifiedName ?? owner?.name,
    context: normalizedSql,
  };

  const insertMatch = normalizedSql.match(/INSERT\s+INTO\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table = normalizeSqlTableName(insertMatch[1]);
    const fields = splitSqlList(insertMatch[2]).map((value) => normalizeSqlFieldName(value));
    for (const field of fields) {
      if (!field) continue;
      references.push({ table, field, type: "write", ...base });
    }
    return references;
  }

  const updateMatch = normalizedSql.match(/UPDATE\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\s+SET\s+(.+?)(?:\s+WHERE|$)/i);
  if (updateMatch) {
    const table = normalizeSqlTableName(updateMatch[1]);
    const assignments = splitSqlList(updateMatch[2]);
    for (const assignment of assignments) {
      const field = normalizeSqlFieldName(assignment.split("=")[0] ?? "");
      if (!field) continue;
      references.push({ table, field, type: "write", ...base });
    }

    for (const predicate of extractSqlPredicateFields(normalizedSql, table, aliasMap)) {
      references.push({ ...predicate, type: "read", ...base });
    }
    return references;
  }

  const deleteMatch = normalizedSql.match(/DELETE\s+FROM\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/i);
  if (deleteMatch) {
    const table = normalizeSqlTableName(deleteMatch[1]);
    references.push({
      table,
      field: "*",
      type: "write",
      ...base,
    });

    for (const predicate of extractSqlPredicateFields(normalizedSql, table, aliasMap)) {
      references.push({ ...predicate, type: "read", ...base });
    }
    return references;
  }

  const selectMatch = normalizedSql.match(/SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/i);
  if (selectMatch) {
    const fields = splitSqlList(selectMatch[1]);
    const table = normalizeSqlTableName(selectMatch[2]);
    for (const rawField of fields) {
      const resolved = resolveSqlFieldTarget(rawField, table, aliasMap);
      if (!resolved || resolved.field === "*") continue;
      references.push({ ...resolved, type: "read", ...base });
    }

    for (const predicate of extractSqlPredicateFields(normalizedSql, table, aliasMap)) {
      references.push({ ...predicate, type: "read", ...base });
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
  const builtins = new Set([
    ...excludedNames,
    "if",
    "for",
    "while",
    "repeat",
    "until",
    "try",
    "except",
    "finally",
    "begin",
    "end",
    "inherited",
    "raise",
    "exit",
    "class",
    "procedure",
    "function",
    "constructor",
    "destructor",
    "record",
    "property",
    "interface",
    "implementation",
    "initialization",
    "finalization",
    "override",
    "virtual",
    "in",
    "nil",
    "true",
    "false",
    "null",
    "and",
    "or",
    "xor",
    "not",
    "as",
    "is",
    "try",
    "except",
    "finally",
    "fieldbyname",
    "parambyname",
    "sql.add",
    "sql.text",
    "quotedstr",
    "format",
  ]);
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
            type: "class",
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
    return detectSqlHeuristicWarnings(this.content, this.file);
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
    return parseSqlStatements(this.content).flatMap(({ line, sql }) =>
      parseSqlReference(sql, line, this.file, findOwnerSymbol(symbols, line, this.file))
    );
  }

  collectWarnings() {
    const warnings = detectSqlHeuristicWarnings(this.content, this.file);
    if (this.content.includes("\n") && /(SELECT|INSERT|UPDATE|DELETE)\b/i.test(this.content) && !/;/.test(this.content)) {
      warnings.push({
        code: "SQL_STATEMENT_MULTILINE",
        message: "Detected SQL statement spanning multiple lines; object extraction is best-effort.",
        filePath: this.file,
        heuristic: true,
      });
    }
    return warnings;
  }
}

function extractDelphiTypeDeclaration(line: string) {
  // Match class declarations with or without "type" on the same line
  const classPattern = /^\s*(?:type\s+)?([A-Za-z_][\w$]*)\s*=\s*class\b/i;
  const match = line.match(classPattern);
  if (!match) {
    return null;
  }

  return {
    name: match[1],
    qualifiedName: match[1],
    type: "class" as const,
    signature: line.trim(),
  };
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

/**
 * Extract Delphi unit name and uses clause from content.
 * Returns null if no unit/library/program declaration is found.
 */
export function extractDelphiUnitInfo(content: string): DelphiUnitInfo | null {
  const lines = content.split(/\r?\n/);
  let unitName: string | null = null;
  const usesUnits: string[] = [];
  const interfaceSymbols: string[] = [];
  const implementationSymbols: string[] = [];
  let inUsesClause = false;
  let section: "interface" | "implementation" | "other" = "other";

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and compiler directives
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("(*") ||
      trimmed.startsWith("{$")
    ) {
      continue;
    }

    // Match unit/library/program declaration
    const unitMatch = trimmed.match(/^\s*(unit|library|program)\s+([A-Za-z_][\w$]*)/i);
    if (unitMatch && !unitName) {
      unitName = unitMatch[2];
    }

    // Detect uses clause start
    const usesStartMatch = trimmed.match(/^\s*uses(?:\s+(.*))?$/i);
    if (usesStartMatch) {
      inUsesClause = true;
      const rest = usesStartMatch[1] ?? "";
      if (rest.includes(";")) {
        // Single-line uses clause
        const units = rest.split(";")[0]?.split(",").map((u) => u.trim().replace(/\s+in\s+.*/i, "")) ?? [];
        usesUnits.push(...units.filter(Boolean));
        inUsesClause = false;
      } else {
        // Multi-line uses clause
        const units = rest.split(",").map((u) => u.trim().replace(/\s+in\s+.*/i, "")) ?? [];
        usesUnits.push(...units.filter(Boolean));
      }
      continue;
    }

    // Continue parsing multi-line uses clause
    if (inUsesClause) {
      if (trimmed.includes(";")) {
        const beforeSemi = trimmed.split(";")[0] ?? "";
        const units = beforeSemi.split(",").map((u) => u.trim().replace(/\s+in\s+.*/i, "")) ?? [];
        usesUnits.push(...units.filter(Boolean));
        inUsesClause = false;
      } else {
        const units = trimmed.split(",").map((u) => u.trim().replace(/\s+in\s+.*/i, "")) ?? [];
        usesUnits.push(...units.filter(Boolean));
      }
    }

    // Track section boundaries for Delphi symbols
    if (/^\s*interface\b/i.test(trimmed)) {
      section = "interface";
      inUsesClause = false;
      continue;
    }

    if (/^\s*implementation\b/i.test(trimmed)) {
      section = "implementation";
      inUsesClause = false;
      continue;
    }

    if (/^\s*(initialization|finalization)\b/i.test(trimmed)) {
      section = "other";
      inUsesClause = false;
    }

    const sectionSymbol = extractDelphiSymbol(trimmed) ?? extractDelphiTypeDeclaration(trimmed);
    if (sectionSymbol) {
      if (section === "interface") {
        interfaceSymbols.push(sectionSymbol.qualifiedName);
      } else if (section === "implementation") {
        implementationSymbols.push(sectionSymbol.qualifiedName);
      }
    }
  }

  if (!unitName) {
    return null;
  }

  return {
    unitName,
    usesUnits: Array.from(new Set(usesUnits)),
    interfaceSymbols: Array.from(new Set(interfaceSymbols)),
    implementationSymbols: Array.from(new Set(implementationSymbols)),
  };
}

/**
 * Parse .dfm file to extract form metadata and object tree.
 * This is a basic parser that handles common DFM patterns.
 */
export function parseDfmContent(content: string, filePath: string): DfmAnalysisResult {
  const warnings: AnalysisWarning[] = [];
  const objects: DfmObjectInfo[] = [];
  let formName: string | undefined;

  const lines = content.split(/\r?\n/);
  let currentObject: DfmObjectInfo | null = null;
  let depth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Match object declaration: object ClassName or object TButton: Button1
    const objectMatch = trimmed.match(/^object\s+([A-Za-z_][\w$]*)(?::\s*([A-Za-z_][\w$]*))?/i);
    if (objectMatch) {
      const objName = objectMatch[1];
      const objType = objectMatch[2] ?? objectMatch[1];
      
      // First object at root level is typically the form
      if (depth === 0 && !formName) {
        formName = objName;
      }

      currentObject = {
        objectName: objName,
        objectType: objType,
        eventHandlers: [],
        properties: {},
      };
      objects.push(currentObject);
      depth += 1;
      continue;
    }

    // Match end of object
    if (/^end$/i.test(trimmed)) {
      depth -= 1;
      if (depth <= 0) {
        currentObject = null;
        depth = 0;
      }
      continue;
    }

    // Match property assignment: PropertyName = Value
    const propMatch = trimmed.match(/^([A-Za-z_][\w$]*)\s*=\s*(.+)$/);
    if (propMatch && currentObject) {
      const propName = propMatch[1];
      const propValue = propMatch[2]?.trim() ?? "";
      
      // Check for event handler (On<Event> = HandlerName)
      if (propName.startsWith("On") && /^[A-Za-z_][\w$]*$/.test(propValue)) {
        currentObject.eventHandlers.push({
          eventName: propName,
          handlerName: propValue,
        });
      } else {
        currentObject.properties[propName] = propValue;
      }
    }
  }

  if (objects.length === 0) {
    warnings.push({
      code: "DFM_NO_OBJECTS",
      message: "No objects were found in the DFM file. The file may be malformed or use an unsupported format.",
      filePath,
      heuristic: true,
    });
  }

  return { formName, objects, warnings };
}

export class DfmParser implements FileParser {
  private readonly parsed: DfmAnalysisResult;

  constructor(private readonly content: string, private readonly file: string) {
    this.parsed = parseDfmContent(content, file);
  }

  parseSymbols(): AnalyzedSymbol[] {
    const symbols: AnalyzedSymbol[] = [];
    const lines = this.content.split(/\r?\n/);

    if (this.parsed.formName) {
      symbols.push(
        createSymbol({
          name: this.parsed.formName,
          qualifiedName: this.parsed.formName,
          type: "class",
          file: this.file,
          startLine: 1,
          endLine: lines.length,
          signature: "DFM root form object",
          description: "DFM form metadata",
        })
      );
    }

    for (const [objectIndex, dfmObject] of this.parsed.objects.entries()) {
      for (const handler of dfmObject.eventHandlers) {
        symbols.push(
          createSymbol({
            name: handler.handlerName,
            qualifiedName: `${dfmObject.objectName}.${handler.handlerName}`,
            type: "method",
            file: this.file,
            startLine: objectIndex + 1,
            endLine: objectIndex + 1,
            signature: `${dfmObject.objectName}.${handler.eventName} -> ${handler.handlerName}`,
            description: `DFM event handler for ${dfmObject.objectName}`,
          })
        );
      }
    }

    return symbols;
  }

  parseDependencies(): SymbolDependency[] {
    return [];
  }

  parseFieldReferences(): FieldReference[] {
    return [];
  }

  collectWarnings() {
    return this.parsed.warnings;
  }
}

export class DelphiParser implements FileParser {
  private readonly unitInfo: ReturnType<typeof extractDelphiUnitInfo> | null;
  private readonly limitedAnalysis: boolean;

  constructor(private readonly content: string, private readonly file: string, limitedAnalysis = false) {
    this.unitInfo = extractDelphiUnitInfo(content);
    this.limitedAnalysis = limitedAnalysis;
  }

  parseSymbols(): AnalyzedSymbol[] {
    const lines = this.content.split(/\r?\n/);
    const symbols: AnalyzedSymbol[] = [];
    let section: "interface" | "implementation" | "other" = "other";

    if (this.unitInfo) {
      symbols.push(
        createSymbol({
          name: this.unitInfo.unitName,
          qualifiedName: this.unitInfo.unitName,
          type: "class",
          file: this.file,
          startLine: 1,
          endLine: lines.length,
          signature: `unit ${this.unitInfo.unitName}`,
          description: "Delphi unit declaration",
        })
      );
    }

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (/^\s*interface\b/i.test(trimmed)) {
        section = "interface";
        return;
      }
      if (/^\s*implementation\b/i.test(trimmed)) {
        section = "implementation";
        return;
      }
      if (/^\s*(initialization|finalization)\b/i.test(trimmed)) {
        section = "other";
        return;
      }

      const symbol = extractDelphiSymbol(line) ?? extractDelphiTypeDeclaration(line);
      if (!symbol) return;

      symbols.push(
        createSymbol({
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          type: symbol.type,
          file: this.file,
          startLine: index + 1,
          endLine: symbol.type === "class" ? findBlockEnd(lines, index, /\bclass\b/i, /\bend\b\s*;?/i) : findBlockEnd(lines, index, /\bbegin\b/i, /\bend\b\s*;?/i),
          signature: symbol.signature,
          description: section !== "other" ? `${section} section` : undefined,
        })
      );
    });

    return symbols;
  }

  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[] {
    const dependencies: SymbolDependency[] = [];
    
    // Add uses clause dependencies
    if (this.unitInfo) {
      for (const usedUnit of this.unitInfo.usesUnits) {
        // Create a synthetic dependency for the unit reference
        dependencies.push({
          from: symbols[0]?.stableKey ?? `${this.file}::${this.unitInfo.unitName}::1`,
          to: `unit::${usedUnit}`,
          fromName: this.unitInfo.unitName,
          toName: usedUnit,
          type: "references",
          line: 1,
        });
      }
    }
    
    // Add call dependencies
    dependencies.push(...buildCallDependencies(this.content.split(/\r?\n/), symbols, ["inherited"]));
    
    return dependencies;
  }

  parseFieldReferences(symbols: AnalyzedSymbol[]) {
    const fragments = parseSqlFragments(this.content);
    const references = fragments.flatMap(({ line, sql }) => parseSqlReference(sql, line, this.file, findOwnerSymbol(symbols, line, this.file)));
    const lines = this.content.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      const fieldMatches = Array.from(line.matchAll(/FieldByName\(\s*['"]([^'"]+)['"]\s*\)/gi));
      for (const match of fieldMatches) {
        references.push({
          table: "delphi",
          field: match[1],
          type: "read",
          file: this.file,
          line: index + 1,
          symbolStableKey: findOwnerSymbol(symbols, index + 1, this.file)?.stableKey,
          symbolName: findOwnerSymbol(symbols, index + 1, this.file)?.qualifiedName,
          context: line.trim(),
        });
      }

      const paramMatches = Array.from(line.matchAll(/ParamByName\(\s*['"]([^'"]+)['"]\s*\)/gi));
      for (const match of paramMatches) {
        references.push({
          table: "delphi",
          field: match[1],
          type: /:=|As(?:String|Integer|Float|Date|Time)|Value\s*[:=]/i.test(line) ? "write" : "read",
          file: this.file,
          line: index + 1,
          symbolStableKey: findOwnerSymbol(symbols, index + 1, this.file)?.stableKey,
          symbolName: findOwnerSymbol(symbols, index + 1, this.file)?.qualifiedName,
          context: line.trim(),
        });
      }
    }

    return references;
  }

  collectWarnings() {
    const warnings: AnalysisWarning[] = detectSqlHeuristicWarnings(this.content, this.file);
    
    if (!/begin\b/i.test(this.content) || !/end\b/i.test(this.content)) {
      warnings.push({
        code: "DELPHI_BLOCK_UNBALANCED",
        message: "Delphi source may have incomplete procedure blocks; ranges are best-effort.",
        filePath: this.file,
        heuristic: true,
      });
    }

    if (!this.unitInfo) {
      warnings.push({
        code: "DELPHI_UNIT_NOT_FOUND",
        message: "No unit/library/program declaration found; file may be an include file or malformed.",
        filePath: this.file,
        heuristic: true,
      });
    }

    if (this.limitedAnalysis) {
      warnings.push({
        code: "DELPHI_LIMITED_ANALYSIS",
        message: "This Delphi file type is imported but analyzed with reduced heuristics.",
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
  static isLanguageSupported(language: string) {
    const normalized = language.replace(/^\./, "").toLowerCase();
    return ["go", "sql", "pas", "dpr", "delphi", "dfm", "inc", "dpk", "fmx"].includes(normalized);
  }

  static createParser(language: string, content: string, file: string): FileParser {
    const normalized = language.replace(/^\./, "").toLowerCase();
    const extension = getFileExtension(file);

    if (normalized === "go") {
      return new GoParser(content, file);
    }

    if (normalized === "sql") {
      return new SQLParser(content, file);
    }

    if (extension === ".dfm") {
      return new DfmParser(content, file);
    }

    if (normalized === "pas" || normalized === "dpr" || normalized === "delphi" || extension === ".inc" || extension === ".dpk" || extension === ".fmx") {
      return new DelphiParser(content, file, [".inc", ".dpk", ".fmx"].includes(extension));
    }

    return new UnsupportedParser(file, normalized);
  }
}
