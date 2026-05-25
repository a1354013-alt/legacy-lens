import { sql } from "drizzle-orm";

export function escapeLikePattern(value: string) {
  return value.replace(/([\\%_])/g, "\\$1");
}

export function buildContainsLikePattern(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  return `%${escapeLikePattern(normalized)}%`;
}

export function likeContainsEscaped(column: unknown, value: string) {
  return sql`${column} LIKE ${value} ESCAPE '\\'`;
}
