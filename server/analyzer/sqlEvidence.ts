import { createHash } from "node:crypto";
import type { SqlStatementEvidence } from "../../shared/contracts";
import { collectSqlStatements } from "./parser";
import { resolveMostSpecificSymbol } from "./symbolOwner";
import type { AnalyzableFile, AnalyzedSymbol, FieldReference } from "./types";

const MAX_SQL_TEXT_LENGTH = 2_000;

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function normalizeSql(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function redactSql(value: string) {
  return value.replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*=\s*)'[^']*'/gi, "$1'<redacted>'");
}

function operationForSql(sql: string): SqlStatementEvidence["operation"] {
  const first = sql.trim().split(/\s+/)[0]?.toLowerCase();
  if (first === "select" || first === "insert" || first === "update" || first === "delete") return first;
  if (first === "exec" || first === "execute") return "execute";
  return "unknown";
}

function tableOperation(statementOperation: SqlStatementEvidence["operation"], table: string) {
  if (statementOperation === "select") return "read" as const;
  if (statementOperation === "execute" || statementOperation === "unknown") return "unknown" as const;
  if (statementOperation === "insert" || statementOperation === "update" || statementOperation === "delete") return "write" as const;
  return table ? "unknown" as const : "unknown" as const;
}

function collectTables(sql: string) {
  const tables = new Set<string>();
  const pattern = /\b(?:from|join|update|into|delete\s+from)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?|\[[^\]]+\](?:\.\[[^\]]+\])?|"[^"]+"(?:\."[^"]+")?)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const table = (match[1] ?? "").replace(/\[|\]|"/g, "").trim();
    if (table) tables.add(table);
  }
  return Array.from(tables).sort((left, right) => left.localeCompare(right));
}

function detectDynamicSql(fileContent: string, sql: string) {
  const escaped = sql.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nearby = escaped ? fileContent.match(new RegExp(`${escaped}[\\s\\S]{0,180}`, "i"))?.[0] ?? "" : "";
  return /(?:\+|&|\|\||Format\s*\(|StringReplace\s*\(|QuotedStr\s*\()/i.test(nearby);
}

export function collectSqlEvidence(files: AnalyzableFile[], symbols: AnalyzedSymbol[], fieldReferences: FieldReference[]): SqlStatementEvidence[] {
  const referencesByFile = new Map<string, FieldReference[]>();
  for (const reference of fieldReferences) {
    const key = normalizePath(reference.file);
    const bucket = referencesByFile.get(key) ?? [];
    bucket.push(reference);
    referencesByFile.set(key, bucket);
  }

  const evidence: SqlStatementEvidence[] = [];
  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    for (const statement of collectSqlStatements(file.content)) {
      const normalizedSql = normalizeSql(redactSql(statement.sql)).slice(0, MAX_SQL_TEXT_LENGTH);
      const owner = resolveMostSpecificSymbol(symbols, statement.line, normalizedPath);
      const operation = operationForSql(normalizedSql);
      const tables = collectTables(normalizedSql);
      const dynamic = detectDynamicSql(file.content, statement.sql);
      const hash = createHash("sha256").update(`${normalizedPath}:${statement.line}:${normalizedSql}`).digest("hex").slice(0, 16);
      const endLine = statement.line + Math.max(0, statement.sql.split(/\r?\n/).length - 1);
      const references = (referencesByFile.get(normalizedPath) ?? []).filter(
        (reference) => reference.line >= statement.line && reference.line <= endLine
      );

      evidence.push({
        stableKey: `${normalizedPath}::sql::${statement.line}::${hash}`,
        ownerSymbolStableKey: owner?.stableKey ?? null,
        ownerSymbolName: owner?.qualifiedName ?? owner?.name ?? null,
        filePath: normalizedPath,
        startLine: statement.line,
        endLine,
        operation,
        normalizedSql,
        tables: tables.map((table) => ({ name: table, operation: tableOperation(operation, table) })),
        fields: references.map((reference) => ({
          table: reference.table,
          field: reference.field,
          operation: reference.type === "calculate" ? "calculate" : reference.type,
        })),
        dynamic,
        confidence: dynamic ? "medium" : "high",
        warnings: dynamic ? ["SQL appears dynamically constructed; table or field extraction may be incomplete."] : [],
      });
    }
  }

  return evidence.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine || left.normalizedSql.localeCompare(right.normalizedSql));
}
