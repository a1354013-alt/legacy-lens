import type { AnalyzedSymbol } from "./types";

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizePath(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function normalizeComparablePath(value: string | null | undefined) {
  return normalizePath(value).toLowerCase();
}

function baseNameWithoutExtension(filePath: string | null | undefined) {
  const normalized = normalizePath(filePath);
  const fileName = normalized.split("/").at(-1) ?? normalized;
  return fileName.replace(/\.[^.]+$/, "").toLowerCase();
}

function ownerNameOf(symbol: AnalyzedSymbol) {
  const qualified = symbol.qualifiedName ?? symbol.name;
  const parts = qualified.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
}

function sortCandidates(symbols: AnalyzedSymbol[]) {
  return [...symbols].sort(
    (left, right) =>
      normalize(left.qualifiedName ?? left.name).localeCompare(normalize(right.qualifiedName ?? right.name))
      || normalizeComparablePath(left.file).localeCompare(normalizeComparablePath(right.file))
      || left.startLine - right.startLine
      || left.endLine - right.endLine
  );
}

export interface DelphiSymbolResolutionResult {
  symbol: AnalyzedSymbol | null;
  ambiguous: boolean;
  candidates: AnalyzedSymbol[];
  strategy:
    | "stable_key"
    | "qualified_name"
    | "owner_match"
    | "same_source_file"
    | "same_pascal_unit"
    | "unique_project_candidate"
    | "unresolved"
    | "ambiguous";
}

export function resolveDelphiSymbol(input: {
  symbols: AnalyzedSymbol[];
  stableKey?: string | null;
  qualifiedName?: string | null;
  name: string;
  ownerName?: string | null;
  sourceFile?: string | null;
  pascalUnit?: string | null;
}): DelphiSymbolResolutionResult {
  const allCandidates = sortCandidates(
    input.symbols.filter((symbol) => {
      const names = [symbol.name, symbol.qualifiedName].filter(Boolean).map(normalize);
      return names.includes(normalize(input.name)) || (input.qualifiedName ? names.includes(normalize(input.qualifiedName)) : false);
    })
  );

  if (input.stableKey) {
    const exact = input.symbols.find((symbol) => symbol.stableKey === input.stableKey) ?? null;
    if (exact) {
      return { symbol: exact, ambiguous: false, candidates: [exact], strategy: "stable_key" };
    }
  }

  let candidates = allCandidates;
  let narrowedStrategy: DelphiSymbolResolutionResult["strategy"] | null = null;

  const narrow = (
    nextCandidates: AnalyzedSymbol[],
    strategy: Exclude<DelphiSymbolResolutionResult["strategy"], "stable_key" | "unresolved" | "ambiguous">
  ): AnalyzedSymbol | null => {
    if (nextCandidates.length === 0) {
      return null;
    }
    candidates = sortCandidates(nextCandidates);
    narrowedStrategy = strategy;
    if (candidates.length === 1) {
      return candidates[0] ?? null;
    }
    return null;
  };

  if (input.qualifiedName) {
    const exactQualified = candidates.filter((symbol) => normalize(symbol.qualifiedName) === normalize(input.qualifiedName));
    const resolved = narrow(exactQualified, "qualified_name");
    if (resolved) {
      return { symbol: resolved, ambiguous: false, candidates: [resolved], strategy: "qualified_name" };
    }
  }

  if (input.ownerName) {
    const ownerMatches = candidates.filter((symbol) => normalize(ownerNameOf(symbol)) === normalize(input.ownerName));
    const resolved = narrow(ownerMatches, "owner_match");
    if (resolved) {
      return { symbol: resolved, ambiguous: false, candidates: [resolved], strategy: "owner_match" };
    }
  }

  if (input.sourceFile) {
    const sameSource = candidates.filter((symbol) => normalizeComparablePath(symbol.file) === normalizeComparablePath(input.sourceFile));
    const resolved = narrow(sameSource, "same_source_file");
    if (resolved) {
      return { symbol: resolved, ambiguous: false, candidates: [resolved], strategy: "same_source_file" };
    }
  }

  if (input.pascalUnit) {
    const sameUnit = candidates.filter((symbol) => baseNameWithoutExtension(symbol.file) === normalize(input.pascalUnit));
    const resolved = narrow(sameUnit, "same_pascal_unit");
    if (resolved) {
      return { symbol: resolved, ambiguous: false, candidates: [resolved], strategy: "same_pascal_unit" };
    }
  }

  if (candidates.length === 1) {
    return { symbol: candidates[0] ?? null, ambiguous: false, candidates, strategy: narrowedStrategy ?? "unique_project_candidate" };
  }

  if (allCandidates.length === 1) {
    return { symbol: allCandidates[0] ?? null, ambiguous: false, candidates: allCandidates, strategy: "unique_project_candidate" };
  }

  if (candidates.length > 1) {
    return { symbol: null, ambiguous: true, candidates, strategy: "ambiguous" };
  }

  if (allCandidates.length > 1) {
    return { symbol: null, ambiguous: true, candidates: allCandidates, strategy: "ambiguous" };
  }

  return { symbol: null, ambiguous: false, candidates: [], strategy: "unresolved" };
}

export function formatDelphiResolverCandidates(candidates: AnalyzedSymbol[]) {
  return sortCandidates(candidates).map((candidate) => `${candidate.qualifiedName ?? candidate.name} (${normalizePath(candidate.file)}:${candidate.startLine})`);
}
