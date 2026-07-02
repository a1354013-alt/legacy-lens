export function extractAffectedRows(result: unknown) {
  if (
    typeof (result as { affectedRows?: number } | undefined)?.affectedRows ===
    "number"
  ) {
    return (result as { affectedRows: number }).affectedRows;
  }

  if (
    Array.isArray(result) &&
    typeof (result[0] as { affectedRows?: number } | undefined)
      ?.affectedRows === "number"
  ) {
    return (result[0] as { affectedRows: number }).affectedRows;
  }

  return undefined;
}

export function isInMemoryDb<T extends object>(
  db: T
): db is T & { store: Record<string, Array<Record<string, unknown>>> } {
  return typeof db === "object" && db !== null && "store" in db;
}
