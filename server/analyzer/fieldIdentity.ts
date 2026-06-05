export interface FieldIdentity {
  table: string;
  field: string;
  schema?: string | null;
}

export interface NormalizedFieldIdentity {
  schema: string | null;
  table: string;
  field: string;
  originalTable: string;
  originalField: string;
  originalName: string;
}

function splitSqlIdentifier(value: string) {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "`" | "]" | null = null;

  for (const char of value.trim()) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "[") {
      quote = "]";
      current += char;
      continue;
    }

    if (char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ".") {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.filter(Boolean);
}

function stripIdentifierQuotes(value: string) {
  let normalized = value.trim();
  let changed = true;

  while (changed && normalized.length >= 2) {
    changed = false;
    const first = normalized[0];
    const last = normalized.at(-1);
    if ((first === "[" && last === "]") || (first === "`" && last === "`") || (first === '"' && last === '"')) {
      normalized = normalized.slice(1, -1).trim();
      changed = true;
    }
  }

  return normalized;
}

function normalizeIdentifierPart(value: string | null | undefined) {
  return stripIdentifierQuotes(String(value ?? "")).trim().toLowerCase();
}

function normalizeSchema(value: string | null | undefined) {
  const schema = normalizeIdentifierPart(value);
  return !schema || schema === "dbo" ? null : schema;
}

export function normalizeFieldIdentity(identity: FieldIdentity): NormalizedFieldIdentity {
  const tableParts = splitSqlIdentifier(identity.table);
  const fieldParts = splitSqlIdentifier(identity.field);
  const combinedParts = [...tableParts, ...fieldParts].map(stripIdentifierQuotes).filter(Boolean);
  const field = combinedParts.at(-1) ?? stripIdentifierQuotes(identity.field);
  const table = combinedParts.at(-2) ?? stripIdentifierQuotes(identity.table);
  const schema = normalizeSchema(identity.schema ?? (combinedParts.length >= 3 ? combinedParts.at(-3) : null));
  const originalTableParts = combinedParts.slice(0, -1);
  const originalTable = originalTableParts.length > 0 ? originalTableParts.join(".") : stripIdentifierQuotes(identity.table);
  const originalField = field;

  return {
    schema,
    table: normalizeIdentifierPart(table),
    field: normalizeIdentifierPart(field),
    originalTable,
    originalField,
    originalName: `${originalTable}.${originalField}`,
  };
}

export function buildFieldIdentityKey(identity: FieldIdentity) {
  const normalized = normalizeFieldIdentity(identity);
  return JSON.stringify({
    schema: normalized.schema,
    table: normalized.table,
    field: normalized.field,
  });
}

export function parseFieldIdentityKey(key: string): FieldIdentity {
  const parsed = JSON.parse(key) as { schema?: string | null; table: string; field: string };
  return {
    schema: parsed.schema ?? null,
    table: parsed.table,
    field: parsed.field,
  };
}
