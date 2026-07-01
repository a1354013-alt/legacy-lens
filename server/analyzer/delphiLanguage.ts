const DELPHI_LANGUAGE_IDS = new Set(["delphi", "pas", "dpr", "dfm", "inc", "dpk", "fmx"]);
const DELPHI_EXTENSIONS = new Set([".pas", ".dpr", ".dfm", ".inc", ".dpk", ".fmx"]);

export function normalizeLanguageTag(language: string): string {
  return language.replace(/^\./, "").trim().toLowerCase();
}

export function getNormalizedFileExtension(filePath: string): string {
  const index = filePath.lastIndexOf(".");
  return index >= 0 ? filePath.slice(index).toLowerCase() : "";
}

export function isDelphiLikeLanguage(language: string, filePath: string): boolean {
  return DELPHI_LANGUAGE_IDS.has(normalizeLanguageTag(language)) || DELPHI_EXTENSIONS.has(getNormalizedFileExtension(filePath));
}
