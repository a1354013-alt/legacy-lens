import type { AnalyzedSymbol } from "./types";

const symbolSpecificityRank: Record<AnalyzedSymbol["type"], number> = {
  method: 6,
  function: 5,
  procedure: 4,
  query: 3,
  table: 2,
  class: 1,
};

function normalizeFilePath(value: string) {
  return value.replace(/\\/g, "/");
}

function getSymbolRangeSize(symbol: AnalyzedSymbol) {
  return Math.max(0, symbol.endLine - symbol.startLine);
}

export function resolveMostSpecificSymbol(symbols: AnalyzedSymbol[], line: number, file?: string) {
  const normalizedFile = file ? normalizeFilePath(file) : undefined;
  const matches = symbols.filter((symbol) => {
    if (normalizedFile && normalizeFilePath(symbol.file) !== normalizedFile) {
      return false;
    }

    return symbol.startLine <= line && symbol.endLine >= line;
  });

  if (matches.length === 0) {
    return undefined;
  }

  return [...matches].sort((left, right) => {
    const rangeDelta = getSymbolRangeSize(left) - getSymbolRangeSize(right);
    if (rangeDelta !== 0) {
      return rangeDelta;
    }

    const rankDelta = symbolSpecificityRank[right.type] - symbolSpecificityRank[left.type];
    if (rankDelta !== 0) {
      return rankDelta;
    }

    const lineDelta = right.startLine - left.startLine;
    if (lineDelta !== 0) {
      return lineDelta;
    }

    return (right.qualifiedName ?? right.name).localeCompare(left.qualifiedName ?? left.name);
  })[0];
}
