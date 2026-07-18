import type { AnalyzedSymbol } from "./types";

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizePath(value: string | null | undefined) {
  return (value ?? "").replace(/\\/g, "/");
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
      || normalizePath(left.file).localeCompare(normalizePath(right.file))
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

  if (input.qualifiedName) {
    const exactQualified = sortCandidates(allCandidates.filter((symbol) => normalize(symbol.qualifiedName) === normalize(input.qualifiedName)));
    if (exactQualified.length === 1) {
      return { symbol: exactQualified[0] ?? null, ambiguous: false, candidates: exactQualified, strategy: "qualified_name" };
    }
    if (exactQualified.length > 1) {
      return { symbol: null, ambiguous: true, candidates: exactQualified, strategy: "ambiguous" };
    }
  }

  if (input.ownerName) {
    const ownerMatches = sortCandidates(allCandidates.filter((symbol) => normalize(ownerNameOf(symbol)) === normalize(input.ownerName)));
    if (ownerMatches.length === 1) {
      return { symbol: ownerMatches[0] ?? null, ambiguous: false, candidates: ownerMatches, strategy: "owner_match" };
    }
    if (ownerMatches.length > 1) {
      return { symbol: null, ambiguous: true, candidates: ownerMatches, strategy: "ambiguous" };
    }
  }

  if (input.sourceFile) {
    const sameSource = sortCandidates(allCandidates.filter((symbol) => normalizePath(symbol.file) === normalizePath(input.sourceFile)));
    if (sameSource.length === 1) {
      return { symbol: sameSource[0] ?? null, ambiguous: false, candidates: sameSource, strategy: "same_source_file" };
    }
    if (sameSource.length > 1) {
      return { symbol: null, ambiguous: true, candidates: sameSource, strategy: "ambiguous" };
    }
  }

  if (input.pascalUnit) {
    const sameUnit = sortCandidates(allCandidates.filter((symbol) => baseNameWithoutExtension(symbol.file) === normalize(input.pascalUnit)));
    if (sameUnit.length === 1) {
      return { symbol: sameUnit[0] ?? null, ambiguous: false, candidates: sameUnit, strategy: "same_pascal_unit" };
    }
    if (sameUnit.length > 1) {
      return { symbol: null, ambiguous: true, candidates: sameUnit, strategy: "ambiguous" };
    }
  }

  if (allCandidates.length === 1) {
    return { symbol: allCandidates[0] ?? null, ambiguous: false, candidates: allCandidates, strategy: "unique_project_candidate" };
  }

  if (allCandidates.length > 1) {
    return { symbol: null, ambiguous: true, candidates: allCandidates, strategy: "ambiguous" };
  }

  return { symbol: null, ambiguous: false, candidates: [], strategy: "unresolved" };
}

export function formatDelphiResolverCandidates(candidates: AnalyzedSymbol[]) {
  return sortCandidates(candidates).map((candidate) => `${candidate.qualifiedName ?? candidate.name} (${normalizePath(candidate.file)}:${candidate.startLine})`);
}
