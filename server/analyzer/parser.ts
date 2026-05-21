import type { AnalysisWarning } from "../../shared/contracts";
import { resolveMostSpecificSymbol } from "./symbolOwner";
import type { AnalyzedSymbol, FieldReference, SchemaField, SymbolDependency, SymbolType } from "./types";
import { buildSymbolStableKey } from "./types";

export interface FileParser {
  parseSymbols(): AnalyzedSymbol[];
  parseDependencies(symbols: AnalyzedSymbol[]): SymbolDependency[];
  parseFieldReferences(symbols: AnalyzedSymbol[]): FieldReference[];
  parseSchemaFields(): SchemaField[];
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

const SQL_IDENTIFIER_PART_PATTERN = String.raw`(?:[A-Za-z_][\w$]*|"(?:""|[^"])*"|\[(?:[^\]])+\]|` + "`(?:``|[^`])+`)";
const SQL_IDENTIFIER_PATTERN = String.raw`${SQL_IDENTIFIER_PART_PATTERN}(?:\s*\.\s*${SQL_IDENTIFIER_PART_PATTERN})*`;

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
  const countMatches = (value: string, pattern: RegExp) => {
    const localPattern = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    );
    return Array.from(value.matchAll(localPattern)).length;
  };

  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    depth += countMatches(line, openPattern);
    depth -= countMatches(line, closePattern);
    if (depth <= 0 && index > startIndex) {
      return index + 1;
    }
    if (depth <= 0 && index === startIndex && countMatches(line, openPattern) > 0) {
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
  const parts: string[] = [];
  let current = "";
  let parenthesesDepth = 0;
  let quote: "'" | '"' | "`" | "[" | null = null;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
    current = "";
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const nextCharacter = value[index + 1];

    if (quote) {
      current += character;
      if (quote === "[" && character === "]") {
        quote = null;
      } else if (quote !== "[" && character === quote) {
        if (nextCharacter === quote) {
          current += nextCharacter;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "[") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "(") {
      parenthesesDepth += 1;
      current += character;
      continue;
    }

    if (character === ")") {
      parenthesesDepth = Math.max(0, parenthesesDepth - 1);
      current += character;
      continue;
    }

    if (character === "," && parenthesesDepth === 0) {
      flush();
      continue;
    }

    current += character;
  }

  flush();
  return parts;
}

function splitQualifiedIdentifier(value: string) {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "`" | "[" | null = null;

  const pushCurrent = () => {
    const trimmed = normalizeSqlIdentifier(current);
    if (trimmed) {
      parts.push(trimmed);
    }
    current = "";
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const nextCharacter = value[index + 1];

    if (quote) {
      current += character;
      if (quote === "[" && character === "]") {
        quote = null;
      } else if (quote !== "[" && character === quote) {
        if (nextCharacter === quote) {
          current += nextCharacter;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "[") {
      quote = character;
      current += character;
      continue;
    }

    if (character === ".") {
      pushCurrent();
      continue;
    }

    current += character;
  }

  pushCurrent();

  return parts;
}

function normalizeSqlIdentifier(value: string) {
  const normalized = normalizeName(value).trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
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
  return /^(select|insert|update|delete|with)$/i.test(value);
}

function isSqlReservedIdentifier(value: string) {
  return /^(and|or|not|in|like|is|null|exists|between|on|where|having|join|inner|left|right|full|outer|as|case|when|then|else|end|from|group|by|order|limit|values|into)$/i.test(
    value
  );
}

function decodeQuotedSqlFragment(fragment: string, quote: string) {
  if (quote === "'") {
    return fragment.replace(/''/g, "'");
  }

  if (quote === '"') {
    return fragment.replace(/\\"/g, '"');
  }

  return fragment.replace(/\\`/g, "`");
}

function extractQuotedSqlFragments(content: string): Array<{ line: number; sql: string }> {
  const fragments: Array<{ line: number; sql: string }> = [];
  const stringPattern = /'((?:''|[^'])*)'|"((?:\\"|[^"])*)"|`((?:\\`|[^`])*)`/g;
  let match: RegExpExecArray | null;

  while ((match = stringPattern.exec(content)) !== null) {
    const rawFragment = match[1] ?? match[2] ?? match[3] ?? "";
    const quote = match[1] !== undefined ? "'" : match[2] !== undefined ? '"' : "`";
    const rawSql = decodeQuotedSqlFragment(rawFragment, quote).trim();
    if (!rawSql) {
      continue;
    }

    if (!isSqlKeyword(rawSql.split(/\s+/)[0] ?? "")) {
      continue;
    }

    const startIndex = match.index;
    const line = content.slice(0, startIndex).split(/\r?\n/).length;
    let combinedSql = rawSql;
    let cursor = stringPattern.lastIndex;

    while (true) {
      const between = content.slice(cursor, Math.min(content.length, cursor + 120));
      const joinMatch = between.match(/^\s*(?:\+|&|\|\|)\s*(?:'((?:''|[^'])*)'|"((?:\\"|[^"])*)"|`((?:\\`|[^`])*)`)/);
      if (!joinMatch) {
        break;
      }

      const joinedFragment = joinMatch[1] ?? joinMatch[2] ?? joinMatch[3] ?? "";
      const joinedQuote = joinMatch[1] !== undefined ? "'" : joinMatch[2] !== undefined ? '"' : "`";
      combinedSql += ` ${decodeQuotedSqlFragment(joinedFragment, joinedQuote)}`;
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

function normalizeSqlStatement(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

export function collectSqlStatements(content: string): Array<{ line: number; sql: string }> {
  const deduped = new Map<string, { line: number; sql: string }>();

  for (const statement of [...parseSqlStatements(content), ...parseSqlFragments(content)]) {
    const normalizedSql = normalizeSqlStatement(statement.sql);
    if (!normalizedSql) {
      continue;
    }

    const key = `${statement.line}:${normalizedSql}`;
    if (!deduped.has(key)) {
      deduped.set(key, { line: statement.line, sql: normalizedSql });
    }
  }

  return Array.from(deduped.values()).sort((left, right) => left.line - right.line || left.sql.localeCompare(right.sql));
}

function extractSqlAliasMap(sql: string) {
  const aliasMap = new Map<string, string>();
  const tablePattern = new RegExp(
    String.raw`\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+(${SQL_IDENTIFIER_PATTERN})(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?`,
    "gi"
  );
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

  if (aliasMap.has(normalizedField.toLowerCase())) {
    return null;
  }

  if (!primaryTable || normalizedField === "*") {
    return null;
  }

  return {
    table: primaryTable,
    field: normalizedField,
  };
}

function isTableReferenceContext(value: string, matchIndex: number) {
  const prefix = value.slice(Math.max(0, matchIndex - 40), matchIndex);
  return /\b(?:from|join|update|into|delete\s+from)\s*$/i.test(prefix.trimEnd());
}

function extractSqlReferencesFromExpression(expression: string, primaryTable: string | undefined, aliasMap: Map<string, string>) {
  const references: Array<{ table: string; field: string }> = [];
  const seen = new Set<string>();
  const identifierPattern = new RegExp(SQL_IDENTIFIER_PATTERN, "g");
  const cleanedExpression = stripSqlStringLiterals(expression).replace(/\s+AS\s+.+$/i, "");
  let match: RegExpExecArray | null;

  while ((match = identifierPattern.exec(cleanedExpression)) !== null) {
    const candidate = match[0]?.trim();
    if (!candidate || isSqlKeyword(candidate) || isSqlReservedIdentifier(candidate)) {
      continue;
    }
    if (isTableReferenceContext(cleanedExpression, match.index)) {
      continue;
    }
    const nextNonWhitespaceCharacter = cleanedExpression.slice(match.index + candidate.length).match(/^\s*(.)/)?.[1];
    if (nextNonWhitespaceCharacter === "(") {
      continue;
    }

    const resolved = resolveSqlFieldTarget(candidate, primaryTable, aliasMap);
    if (!resolved || resolved.field === "*") {
      continue;
    }

    const key = `${resolved.table}.${resolved.field}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push(resolved);
  }

  return references;
}

function extractSqlPredicateFields(sql: string, primaryTable: string | undefined, aliasMap: Map<string, string>) {
  const references: Array<{ table: string; field: string }> = [];
  const seen = new Set<string>();
  const strippedSql = stripSqlStringLiterals(sql);
  const predicatePattern = new RegExp(SQL_IDENTIFIER_PATTERN, "g");
  const predicateClauses = [
    ...Array.from(strippedSql.matchAll(/\bON\s+(.+?)(?=\bJOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/gi), (match) => match[1] ?? ""),
    ...Array.from(strippedSql.matchAll(/\bWHERE\s+(.+?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/gi), (match) => match[1] ?? ""),
    ...Array.from(strippedSql.matchAll(/\bHAVING\s+(.+?)(?=\bORDER\s+BY\b|\bLIMIT\b|$)/gi), (match) => match[1] ?? ""),
  ];

  for (const clause of predicateClauses) {
    let match: RegExpExecArray | null;

    while ((match = predicatePattern.exec(clause)) !== null) {
      const candidate = match[0]?.trim();
      if (!candidate || isSqlKeyword(candidate) || isSqlReservedIdentifier(candidate)) {
        continue;
      }
      if (isTableReferenceContext(clause, match.index)) {
        continue;
      }

      const resolved = resolveSqlFieldTarget(candidate, primaryTable, aliasMap);
      if (!resolved || resolved.field === "*") {
        continue;
      }

      const key = `${resolved.table}.${resolved.field}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
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
      level: "warning",
      filePath: file,
      heuristic: true,
    });
  }

  if (/(SELECT|INSERT|UPDATE|DELETE)[^;\n]*("?\s*\+|&|\|\|)/i.test(content)) {
    warnings.push({
      code: "SQL_DYNAMIC_STRING",
      message: "Detected dynamically constructed SQL; dependency extraction may be incomplete.",
      level: "warning",
      filePath: file,
      heuristic: true,
    });
  }

  return warnings;
}

function extractLeadingCteBodies(sql: string) {
  if (!/^\s*WITH\b/i.test(sql)) {
    return [];
  }

  const bodies: string[] = [];
  let cursor = sql.search(/\bWITH\b/i);

  while (cursor >= 0 && cursor < sql.length) {
    const asMatch = /\bAS\s*\(/gi;
    asMatch.lastIndex = cursor;
    const match = asMatch.exec(sql);
    if (!match) {
      break;
    }

    let index = asMatch.lastIndex;
    let depth = 1;
    while (index < sql.length && depth > 0) {
      const character = sql[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      index += 1;
    }

    if (depth !== 0) {
      break;
    }

    bodies.push(sql.slice(asMatch.lastIndex, index - 1).trim());
    cursor = /^\s*,/.test(sql.slice(index)) ? index + 1 : -1;
  }

  return bodies;
}

function parseSqlReference(sql: string, line: number, file: string, owner?: AnalyzedSymbol): FieldReference[] {
  const normalizedSql = normalizeSqlStatement(sql);
  const references: FieldReference[] = [];
  for (const cteBody of extractLeadingCteBodies(normalizedSql)) {
    references.push(...parseSqlReference(cteBody, line, file, owner));
  }
  const aliasMap = extractSqlAliasMap(normalizedSql);

  const base = {
    file,
    line,
    symbolStableKey: owner?.stableKey,
    symbolName: owner?.qualifiedName ?? owner?.name,
    context: normalizedSql,
  };

  const insertMatch = normalizedSql.match(new RegExp(String.raw`INSERT\s+INTO\s+(${SQL_IDENTIFIER_PATTERN})\s*\(([^)]+)\)`, "i"));
  if (insertMatch) {
    const table = normalizeSqlTableName(insertMatch[1]);
    const fields = splitSqlList(insertMatch[2]).map((value) => normalizeSqlFieldName(value));
    for (const field of fields) {
      if (!field) continue;
      references.push({ table, field, type: "write", ...base });
    }
    const selectMatch = normalizedSql.match(/\)\s+SELECT\s+(.+?)\s+FROM\s+/i);
    if (selectMatch) {
      const readTableMatch = normalizedSql.match(new RegExp(String.raw`\)\s+SELECT\s+(.+?)\s+FROM\s+(${SQL_IDENTIFIER_PATTERN})`, "i"));
      const primaryTable = readTableMatch ? normalizeSqlTableName(readTableMatch[2]) : undefined;
      for (const expression of splitSqlList(selectMatch[1])) {
        for (const reference of extractSqlReferencesFromExpression(expression, primaryTable, aliasMap)) {
          references.push({ ...reference, type: "read", ...base });
        }
      }
      for (const predicate of extractSqlPredicateFields(normalizedSql, primaryTable, aliasMap)) {
        references.push({ ...predicate, type: "read", ...base });
      }
    }
    return references;
  }

  const updateMatch = normalizedSql.match(new RegExp(String.raw`UPDATE\s+(${SQL_IDENTIFIER_PATTERN})\s+SET\s+(.+?)(?:\s+WHERE|$)`, "i"));
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

  const deleteMatch = normalizedSql.match(new RegExp(String.raw`DELETE\s+FROM\s+(${SQL_IDENTIFIER_PATTERN})`, "i"));
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

  const selectMatch = normalizedSql.match(new RegExp(String.raw`SELECT\s+(.+?)\s+FROM\s+(${SQL_IDENTIFIER_PATTERN})`, "i"));
  if (selectMatch) {
    const table = normalizeSqlTableName(selectMatch[2]);
    for (const expression of splitSqlList(selectMatch[1])) {
      for (const reference of extractSqlReferencesFromExpression(expression, table, aliasMap)) {
        references.push({ ...reference, type: "read", ...base });
      }
    }

    for (const predicate of extractSqlPredicateFields(normalizedSql, table, aliasMap)) {
      references.push({ ...predicate, type: "read", ...base });
    }
  }

  return references;
}

function isSqlSchemaConstraint(definition: string) {
  return /^(constraint|primary\s+key|foreign\s+key|unique(?:\s+key)?|key|index|check)\b/i.test(definition.trim());
}

function parseSqlSchemaColumn(definition: string, table: string, file: string, line: number): SchemaField | null {
  const trimmed = definition.trim().replace(/,+$/, "");
  if (!trimmed || isSqlSchemaConstraint(trimmed)) {
    return null;
  }

  const columnMatch = trimmed.match(new RegExp(String.raw`^(${SQL_IDENTIFIER_PART_PATTERN})\s+(.+)$`, "i"));
  if (!columnMatch) {
    return null;
  }

  const field = normalizeSqlIdentifier(columnMatch[1]);
  const remainder = columnMatch[2].trim();
  const fieldType = extractSqlColumnType(remainder);
  const defaultMatch = remainder.match(/\bdefault\s+(.+?)(?=\s+comment\b|\s+constraint\b|\s+references\b|$)/i);
  const commentMatch = remainder.match(/\bcomment\s+('(?:''|[^'])*'|"(?:[^"]|"")*"|`(?:``|[^`])*`|\[[^\]]+\])/i);

  return {
    table,
    field,
    fieldType,
    nullable: /\bnot\s+null\b/i.test(remainder) ? false : /\bnull\b/i.test(remainder) ? true : undefined,
    primaryKey: /\bprimary\s+key\b/i.test(remainder),
    defaultValue: defaultMatch?.[1]?.trim(),
    comment: commentMatch ? normalizeName(commentMatch[1]) : undefined,
    file,
    line,
  };
}

function extractSqlColumnType(remainder: string) {
  const stopWords = new Set(["not", "null", "default", "constraint", "primary", "references", "comment", "check", "unique", "key"]);
  let token = "";
  let depth = 0;
  const parts: string[] = [];

  const flush = () => {
    const trimmed = token.trim();
    if (!trimmed) {
      token = "";
      return;
    }

    if (depth === 0 && stopWords.has(trimmed.toLowerCase())) {
      token = "";
      return "stop";
    }

    parts.push(trimmed);
    token = "";
    return undefined;
  };

  for (const character of remainder) {
    if (character === "(") {
      depth += 1;
      token += character;
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      token += character;
      continue;
    }

    if (character === " " && depth === 0) {
      const result = flush();
      if (result === "stop") {
        break;
      }
      continue;
    }

    token += character;
  }

  flush();
  return parts.join(" ").trim() || undefined;
}

function parseCreateTableBlocks(content: string) {
  const blocks: Array<{ table: string; body: string; line: number }> = [];
  const createTablePattern = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${SQL_IDENTIFIER_PATTERN})`, "gi");
  let match: RegExpExecArray | null;

  while ((match = createTablePattern.exec(content)) !== null) {
    const table = normalizeSqlTableName(match[1]);
    const startIndex = match.index;
    const openIndex = content.indexOf("(", createTablePattern.lastIndex);
    if (openIndex < 0) {
      continue;
    }

    let cursor = openIndex + 1;
    let depth = 1;
    let quote: "'" | '"' | "`" | "[" | null = null;
    while (cursor < content.length && depth > 0) {
      const character = content[cursor];
      const nextCharacter = content[cursor + 1];

      if (quote) {
        if (quote === "[" && character === "]") {
          quote = null;
        } else if (quote !== "[" && character === quote) {
          if (nextCharacter === quote) {
            cursor += 1;
          } else {
            quote = null;
          }
        }
        cursor += 1;
        continue;
      }

      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        cursor += 1;
        continue;
      }

      if (character === "[") {
        quote = character;
        cursor += 1;
        continue;
      }

      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      cursor += 1;
    }

    if (depth !== 0) {
      continue;
    }

    blocks.push({
      table,
      body: content.slice(openIndex + 1, cursor - 1),
      line: content.slice(0, startIndex).split(/\r?\n/).length,
    });
  }

  return blocks;
}

function parseSqlSchemaFields(content: string, file: string): SchemaField[] {
  const schemaFields: SchemaField[] = [];

  for (const block of parseCreateTableBlocks(content)) {
    const definitions = splitSqlList(block.body);
    const primaryKeyColumns = new Set<string>();
    const columns: SchemaField[] = [];

    for (const [index, definition] of definitions.entries()) {
      const trimmed = definition.trim();
      const primaryKeyMatch = trimmed.match(/\bprimary\s+key\s*\((.+)\)/i);
      if (primaryKeyMatch) {
        for (const columnName of splitSqlList(primaryKeyMatch[1])) {
          primaryKeyColumns.add(normalizeSqlIdentifier(columnName));
        }
        continue;
      }

      const column = parseSqlSchemaColumn(trimmed, block.table, file, block.line + index);
      if (column) {
        columns.push(column);
      }
    }

    for (const column of columns) {
      if (primaryKeyColumns.has(column.field)) {
        column.primaryKey = true;
      }
      schemaFields.push(column);
    }
  }

  return schemaFields;
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

function normalizeGoReceiverType(receiver: string | undefined) {
  if (!receiver) {
    return null;
  }

  const parts = receiver.trim().split(/\s+/);
  const rawType = parts.at(-1) ?? "";
  const normalizedType = rawType.replace(/^\*+/, "").trim();
  return normalizedType || null;
}

function collectGoVariableTypes(lines: string[]) {
  const variableTypes = new Map<string, string>();

  for (const line of lines) {
    const funcMatch = line.match(/^\s*func\s+[A-Za-z_][\w$]*\s*\((.*)\)/);
    if (funcMatch) {
      const params = funcMatch[1].split(",").map((value) => value.trim()).filter(Boolean);
      for (const param of params) {
        const paramMatch = param.match(/^([A-Za-z_][\w$]*)\s+\*?([A-Za-z_][\w$]*)$/);
        if (paramMatch) {
          variableTypes.set(paramMatch[1], paramMatch[2]);
        }
      }
    }

    const varMatch = line.match(/^\s*var\s+([A-Za-z_][\w$]*)\s+\*?([A-Za-z_][\w$]*)\b/);
    if (varMatch) {
      variableTypes.set(varMatch[1], varMatch[2]);
    }

    const literalMatch = line.match(/^\s*([A-Za-z_][\w$]*)\s*:=\s*&?([A-Za-z_][\w$]*)\s*\{/);
    if (literalMatch) {
      variableTypes.set(literalMatch[1], literalMatch[2]);
    }

    const newMatch = line.match(/^\s*([A-Za-z_][\w$]*)\s*:=\s*new\(\s*([A-Za-z_][\w$]*)\s*\)/);
    if (newMatch) {
      variableTypes.set(newMatch[1], newMatch[2]);
    }
  }

  return variableTypes;
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
        const receiverType = normalizeGoReceiverType(functionMatch[1]);
        symbols.push(
          createSymbol({
            name: functionMatch[2],
            qualifiedName: receiverType ? `${receiverType}.${functionMatch[2]}` : functionMatch[2],
            type: functionMatch[1] ? "method" : "function",
            file: this.file,
            startLine: index + 1,
            endLine: findBlockEnd(lines, index, /{/, /}/),
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
    const lines = this.content.split(/\r?\n/);
    const dependencies: SymbolDependency[] = [];
    const variableTypes = collectGoVariableTypes(lines);
    const builtins = new Set(["if", "for", "switch", "return", "go", "defer", "select", "make", "new", "append", "len", "cap", "panic", "recover", "close", "copy", "delete"]);
    const methodCallPattern = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\s*\(/g;
    const functionCallPattern = /\b([A-Za-z_][\w$]*)\s*\(/g;

    lines.forEach((line, index) => {
      const owner = findOwnerSymbol(symbols, index + 1, this.file);
      if (!owner) return;

      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodCallPattern.exec(line)) !== null) {
        const receiverType = variableTypes.get(methodMatch[1]);
        const methodName = methodMatch[2];
        if (!methodName || builtins.has(methodName.toLowerCase())) {
          continue;
        }

        const target =
          (receiverType
            ? symbols.find((symbol) => symbol.type === "method" && symbol.qualifiedName === `${receiverType}.${methodName}`)
            : undefined) ??
          symbols.find((symbol) => symbol.type === "method" && symbol.name === methodName);

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

      let functionMatch: RegExpExecArray | null;
      while ((functionMatch = functionCallPattern.exec(line)) !== null) {
        const functionName = functionMatch[1];
        if (!functionName || builtins.has(functionName.toLowerCase())) {
          continue;
        }

        const previousCharacter = functionMatch.index > 0 ? line[functionMatch.index - 1] : "";
        if (previousCharacter === ".") {
          continue;
        }

        if (/^\s*func\b/.test(line)) {
          continue;
        }

        const target = symbols.find((symbol) => symbol.type === "function" && symbol.name === functionName);
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

  parseFieldReferences(symbols: AnalyzedSymbol[]) {
    return collectSqlStatements(this.content).flatMap(({ line, sql }) =>
      parseSqlReference(sql, line, this.file, findOwnerSymbol(symbols, line, this.file))
    );
  }

  parseSchemaFields(): SchemaField[] {
    return [];
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
      const tableMatch = line.match(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${SQL_IDENTIFIER_PATTERN})`, "i"));
      if (tableMatch) {
        symbols.push(
          createSymbol({
            name: normalizeSqlTableName(tableMatch[1]),
            type: "table",
            file: this.file,
            startLine: index + 1,
            endLine: index + 1,
            signature: line.trim(),
          })
        );
        return;
      }

      const procedureMatch = line.match(new RegExp(String.raw`CREATE\s+PROCEDURE\s+(${SQL_IDENTIFIER_PATTERN})`, "i"));
      if (procedureMatch) {
        symbols.push(
          createSymbol({
            name: normalizeSqlTableName(procedureMatch[1]),
            type: "procedure",
            file: this.file,
            startLine: index + 1,
            endLine: index + 1,
            signature: line.trim(),
          })
        );
        return;
      }

      const functionMatch = line.match(new RegExp(String.raw`CREATE\s+FUNCTION\s+(${SQL_IDENTIFIER_PATTERN})`, "i"));
      if (functionMatch) {
        symbols.push(
          createSymbol({
            name: normalizeSqlTableName(functionMatch[1]),
            type: "function",
            file: this.file,
            startLine: index + 1,
            endLine: index + 1,
            signature: line.trim(),
          })
        );
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
    return collectSqlStatements(this.content).flatMap(({ line, sql }) =>
      parseSqlReference(sql, line, this.file, findOwnerSymbol(symbols, line, this.file))
    );
  }

  parseSchemaFields(): SchemaField[] {
    return parseSqlSchemaFields(this.content, this.file);
  }

  collectWarnings() {
    const warnings = detectSqlHeuristicWarnings(this.content, this.file);
    if (this.content.includes("\n") && /(SELECT|INSERT|UPDATE|DELETE)\b/i.test(this.content) && !/;/.test(this.content)) {
      warnings.push({
        code: "SQL_STATEMENT_MULTILINE",
        message: "Detected SQL statement spanning multiple lines; object extraction is best-effort.",
        level: "warning",
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
      level: "warning",
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

  parseSchemaFields(): SchemaField[] {
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
      const owner = findOwnerSymbol(symbols, index + 1, this.file);
      const fieldMatches = Array.from(line.matchAll(/FieldByName\(\s*['"]([^'"]+)['"]\s*\)/gi));
      for (const match of fieldMatches) {
        references.push({
          table: "delphi",
          field: match[1],
          type: "read",
          file: this.file,
          line: index + 1,
          symbolStableKey: owner?.stableKey,
          symbolName: owner?.qualifiedName ?? owner?.name,
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
          symbolStableKey: owner?.stableKey,
          symbolName: owner?.qualifiedName ?? owner?.name,
          context: line.trim(),
        });
      }
    }

    return references;
  }

  parseSchemaFields(): SchemaField[] {
    return [];
  }

  collectWarnings() {
    const warnings: AnalysisWarning[] = detectSqlHeuristicWarnings(this.content, this.file);
    
    if (!/begin\b/i.test(this.content) || !/end\b/i.test(this.content)) {
      warnings.push({
        code: "DELPHI_BLOCK_UNBALANCED",
        message: "Delphi source may have incomplete procedure blocks; ranges are best-effort.",
        level: "warning",
        filePath: this.file,
        heuristic: true,
      });
    }

    if (!this.unitInfo) {
      warnings.push({
        code: "DELPHI_UNIT_NOT_FOUND",
        message: "No unit/library/program declaration found; file may be an include file or malformed.",
        level: "warning",
        filePath: this.file,
        heuristic: true,
      });
    }

    if (this.limitedAnalysis) {
      warnings.push({
        code: "DELPHI_LIMITED_ANALYSIS",
        message: "This Delphi file type is imported but analyzed with reduced heuristics.",
        level: "warning",
        filePath: this.file,
        heuristic: true,
      });
    }

    warnings.push({
      code: "HEURISTIC_ANALYSIS",
      message: "Delphi parsing is heuristic and may miss semantic resolution across units.",
      level: "note",
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

  parseSchemaFields(): SchemaField[] {
    return [];
  }

  collectWarnings(): AnalysisWarning[] {
    return [
      {
        code: "LANGUAGE_UNSUPPORTED",
        message: `Unsupported language for analysis: ${this.language}`,
        level: "warning",
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
