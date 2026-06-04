export function extractInsertId(insertResult: unknown): number {
  const visit = (value: unknown): number | null => {
    if (!value) return null;

    if (typeof value === "object" && "insertId" in value) {
      const insertId = Number((value as { insertId?: unknown }).insertId);
      if (Number.isSafeInteger(insertId) && insertId > 0) {
        return insertId;
      }
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested !== null) return nested;
      }
    }

    return null;
  };

  return visit(insertResult) ?? 0;
}
