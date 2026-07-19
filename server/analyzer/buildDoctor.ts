import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { DelphiBuildDoctorResult, DelphiBuildFinding, DelphiPackageResolutionDetail } from "../../shared/contracts";
import type { AnalyzableFile } from "./types";

const DELPHI_BUILD_EXTENSIONS = new Set([".dpr", ".dpk", ".dproj", ".groupproj", ".bdsproj", ".cfg", ".dof", ".rc"]);
const DELPHI_SOURCE_EXTENSIONS = new Set([".pas", ".dpr", ".dpk", ".inc"]);
const XML_METADATA_EXTENSIONS = new Set([".dproj", ".bdsproj", ".groupproj"]);
const PATH_LIST_TAGS = new Set(["dcc_unitsearchpath", "dcc_includepath", "searchpath", "includepath"]);
const OUTPUT_PATH_TAGS = new Set(["outputdir", "dcc_outputneverbuilddcus", "dcc_dcuoutput", "dcc_exeoutput", "dcc_bploutput", "dcc_dcpoutput"]);
const DEFINE_TAGS = new Set(["dcc_define"]);
const PLATFORM_TAGS = new Set(["platform"]);
const CONFIG_TAGS = new Set(["config"]);
const PACKAGE_TAGS = new Set(["dcc_usepackage"]);
const RUNTIME_PACKAGE_TAGS = new Set(["runtimeonlypackage", "buildwithruntimepackages"]);
const PROJECT_REFERENCE_TAGS = new Set(["projects", "project", "target"]);
const XML_INPUT_LIMIT_BYTES = 1_000_000;

const STANDARD_UNIT_EXACT = new Set([
  "system",
  "sysutils",
  "classes",
  "variants",
  "windows",
  "messages",
  "controls",
  "forms",
  "dialogs",
  "graphics",
  "db",
  "dbctrls",
  "dbgrids",
  "sqlexpr",
  "math",
  "types",
  "strutils",
  "dateutils",
  "contnrs",
  "rtlconsts",
]);

const STANDARD_UNIT_PREFIXES = [
  "system.",
  "system.net.",
  "winapi.",
  "vcl.",
  "data.",
  "xml.",
  "web.",
  "soap.",
  "datasnap.",
  "firedac.",
  "fmx.",
  "rest.",
] as const;

const STANDARD_PACKAGES = new Set([
  "rtl",
  "vcl",
  "vclx",
  "dbrtl",
  "vcldb",
  "xmlrtl",
  "soaprtl",
  "dsnap",
  "fmx",
  "fmxase",
  "firedac",
  "designide",
]);

interface DelphiMetadataValue {
  value: string;
  sourceFile: string;
  lineNumber: number | null;
  condition?: string;
}

interface XmlWalkContext {
  condition?: string;
  parentTags: string[];
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function extensionOf(path: string) {
  const match = path.toLowerCase().match(/\.[^.\\/]+$/);
  return match?.[0] ?? "";
}

function pathDir(path: string) {
  const normalized = normalizePath(path);
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}

function baseName(path: string) {
  const normalized = normalizePath(path);
  return normalized.split("/").at(-1) ?? normalized;
}

function stem(path: string) {
  return baseName(path).replace(/\.[^.]+$/, "");
}

function normalizeKey(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function findLine(content: string, pattern: RegExp) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index + 1;
  }
  return null;
}

function lineForLiteral(content: string, literal: string) {
  return findLine(content, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

function unitNameFromPascal(content: string) {
  return content.match(/^\s*unit\s+([A-Za-z_][\w.]*)\s*;/im)?.[1] ?? null;
}

function packageNameFromDpk(content: string) {
  return content.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/im)?.[1] ?? null;
}

function parseUses(content: string) {
  const units: string[] = [];
  for (const match of content.matchAll(/\buses\s+([\s\S]*?);/gi)) {
    for (const part of (match[1] ?? "").split(",")) {
      const unit = part.trim().replace(/\s+in\s+['"][^'"]+['"]/i, "").replace(/[^\w.].*$/, "").trim();
      if (unit) units.push(unit);
    }
  }
  return units;
}

function explicitUnitPaths(content: string) {
  return Array.from(content.matchAll(/\b([A-Za-z_][\w.]*)\s+in\s+['"]([^'"]+)['"]/gi), (match) => ({
    unit: match[1] ?? "",
    path: match[2] ?? "",
  })).filter((entry) => entry.unit && entry.path);
}

function resourceRefs(content: string) {
  return Array.from(content.matchAll(/\{\$R\s+([^}]+)\}/gi), (match) => (match[1] ?? "").trim().replace(/^['"]|['"]$/g, ""));
}

function parseRequiredPackagesFromDpk(content: string) {
  const packages: string[] = [];
  for (const match of content.matchAll(/\brequires\s+([\s\S]*?);/gi)) {
    packages.push(...(match[1] ?? "").split(",").map((value) => value.trim().replace(/[^\w.\\/:$()-].*$/, "")).filter(Boolean));
  }
  return packages;
}

function parseCfgLikeList(content: string, patterns: RegExp[]) {
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      values.push(...splitDelimitedValues(match[1] ?? ""));
    }
  }
  return values;
}

function splitDelimitedValues(value: string) {
  return value.split(/[;\r\n]+/).map((part) => part.trim()).filter(Boolean);
}

function splitPackageValues(value: string) {
  return value.split(/[;,]+/).map((part) => part.trim()).filter(Boolean);
}

function metadataValue(value: string, sourceFile: string, lineNumber: number | null, condition?: string): DelphiMetadataValue {
  return { value, sourceFile, lineNumber, ...(condition ? { condition } : {}) };
}

function metadataEntryKey(entry: DelphiMetadataValue) {
  return [entry.sourceFile, entry.lineNumber ?? "unknown", entry.condition ?? "", entry.value].join("::");
}

function dedupeMetadataValues(values: DelphiMetadataValue[]) {
  return Array.from(new Map(values.map((entry) => [metadataEntryKey(entry), entry])).values());
}

function metadataEvidence(entry: DelphiMetadataValue, extra?: { resolvedPath?: string | null }) {
  return [
    `sourceFile=${entry.sourceFile}`,
    `lineNumber=${entry.lineNumber ?? "unknown"}`,
    `condition=${entry.condition ?? "none"}`,
    `rawValue=${entry.value}`,
    `resolvedPath=${extra?.resolvedPath ?? "unresolved"}`,
  ].join("; ");
}

function collapsePath(path: string) {
  const segments: string[] = [];
  const normalized = normalizePath(path).replace(/^["']|["']$/g, "");
  const prefixMatch = normalized.match(/^[A-Za-z]:/);
  const prefix = prefixMatch?.[0] ?? (normalized.startsWith("/") ? "/" : "");
  const remainder = prefix ? normalized.slice(prefix.length) : normalized;
  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const body = segments.join("/");
  if (!prefix) return body;
  return prefix === "/" ? `/${body}` : `${prefix}/${body}`.replace(/\/$/, "");
}

function isAbsoluteLocalPath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function hasUnresolvedMacro(path: string) {
  return /\$\([^)]+\)|%[^%]+%/.test(path);
}

function resolveRelativePath(baseFile: string, rawPath: string) {
  const cleaned = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) return { rawPath: cleaned, resolvedPath: null as string | null, escaping: false, absolute: false, unresolvedMacro: false };
  const unresolvedMacro = hasUnresolvedMacro(cleaned);
  const absolute = isAbsoluteLocalPath(cleaned);
  const baseDir = pathDir(baseFile);
  const joined = absolute ? cleaned : baseDir ? `${baseDir}/${cleaned}` : cleaned;
  const resolvedPath = unresolvedMacro ? null : collapsePath(joined);
  const escaping = !unresolvedMacro && /(?:^|\/)\.\.(?:\/|$)/.test(collapsePath(absolute ? cleaned : cleaned));
  return { rawPath: cleaned, resolvedPath, escaping, absolute, unresolvedMacro };
}

function isStandardUnit(unit: string) {
  const normalized = normalizeKey(unit);
  return STANDARD_UNIT_EXACT.has(normalized) || STANDARD_UNIT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isStandardPackage(packageName: string) {
  const normalized = normalizeKey(packageName);
  if (STANDARD_PACKAGES.has(normalized)) return true;
  const match = normalized.match(/^([a-z][a-z0-9]*?)(\d+)$/);
  return !!match && STANDARD_PACKAGES.has(match[1] ?? "");
}

function parseRcReferences(content: string) {
  const refs: Array<{ kind: string; target: string; lineNumber: number }> = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*[A-Za-z_][\w$]*\s+(ICON|BITMAP|RCDATA|HTML)\s+["']([^"']+)["']/i);
    if (!match) return;
    refs.push({ kind: match[1]?.toUpperCase() ?? "RESOURCE", target: match[2] ?? "", lineNumber: index + 1 });
  });
  return refs;
}

function safeText(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value).trim()].filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => safeText(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const own = record["#text"];
    if (typeof own === "string" && own.trim()) {
      return [own.trim()];
    }
  }
  return [];
}

function walkXml(
  node: unknown,
  visit: (tagName: string, value: unknown, attrs: Record<string, string>, context: XmlWalkContext) => void,
  context: XmlWalkContext = { parentTags: [] }
) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => walkXml(item, visit, context));
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@_") || key === "#text") continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const attrs = typeof item === "object" && item && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([childKey]) => childKey.startsWith("@_")).map(([childKey, childValue]) => [childKey.slice(2), String(childValue)]))
        : {};
      const nextContext: XmlWalkContext = {
        condition: typeof attrs.Condition === "string" && attrs.Condition.trim() ? attrs.Condition : context.condition,
        parentTags: [...context.parentTags, key],
      };
      visit(key, item, attrs, nextContext);
      walkXml(item, visit, nextContext);
    }
  }
}

function parseXmlMetadata(file: { path: string; content: string }, findings: DelphiBuildFinding[]) {
  const result = {
    configurations: [] as string[],
    platforms: [] as string[],
    defines: [] as DelphiMetadataValue[],
    searchPaths: [] as DelphiMetadataValue[],
    includePaths: [] as DelphiMetadataValue[],
    outputPaths: [] as DelphiMetadataValue[],
    requiredPackages: [] as DelphiMetadataValue[],
    runtimePackages: [] as DelphiMetadataValue[],
    projectReferences: [] as Array<{ path: string; lineNumber: number | null; condition?: string }>,
    evidence: [] as string[],
    parseLimited: false,
    personalityEvidence: [] as string[],
  };

  if (Buffer.byteLength(file.content, "utf8") > XML_INPUT_LIMIT_BYTES) {
    findings.push({
      code: "DELPHI_CONFIG_PARSE_LIMITED",
      severity: "warning",
      title: "Project metadata exceeded the safe XML parse limit",
      description: `${file.path} is larger than the configured safe XML input limit, so Build Doctor skipped deep metadata parsing.`,
      recommendation: "Reduce imported metadata size or review the project file directly in Delphi/MSBuild tooling.",
      confidence: "high",
      sourceFile: file.path,
      evidence: `Input bytes > ${XML_INPUT_LIMIT_BYTES}`,
    });
    result.parseLimited = true;
    return result;
  }

  try {
    const validation = XMLValidator.validate(file.content, {
      allowBooleanAttributes: true,
      unpairedTags: [],
    });
    if (validation !== true) {
      findings.push({
        code: "DELPHI_CONFIG_PARSE_LIMITED",
        severity: "warning",
        title: "Project XML could not be parsed safely",
        description: "Build Doctor could not parse this Delphi XML metadata file and fell back to limited evidence only.",
        recommendation: "Repair malformed XML and re-import the project metadata for more complete findings.",
        confidence: "medium",
        sourceFile: file.path,
        evidence: typeof validation === "object" ? `${validation.err?.code ?? "XML"}:${validation.err?.msg ?? "invalid"}` : file.content.slice(0, 160),
      });
      result.parseLimited = true;
      return result;
    }
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      processEntities: false,
      allowBooleanAttributes: true,
      trimValues: true,
      parseTagValue: false,
      parseAttributeValue: false,
    });
    const xml = parser.parse(file.content);
    walkXml(xml, (tagName, value, attrs, context) => {
      const normalizedTag = normalizeKey(tagName);
      const texts = safeText(value);
      const effectiveCondition = typeof attrs.Condition === "string" && attrs.Condition.trim() ? attrs.Condition : context.condition;
      if (CONFIG_TAGS.has(normalizedTag)) result.configurations.push(...texts);
      if (PLATFORM_TAGS.has(normalizedTag)) result.platforms.push(...texts);
      if (DEFINE_TAGS.has(normalizedTag)) {
        result.defines.push(
          ...texts.flatMap((entry) =>
            splitDelimitedValues(entry.replace(/,/g, ";")).map((part) => metadataValue(part, file.path, lineForLiteral(file.content, part), effectiveCondition))
          )
        );
      }
      if (PATH_LIST_TAGS.has(normalizedTag)) {
        const target = normalizedTag.includes("include") ? result.includePaths : result.searchPaths;
        target.push(
          ...texts.flatMap((entry) =>
            splitDelimitedValues(entry).map((part) => metadataValue(part, file.path, lineForLiteral(file.content, part), effectiveCondition))
          )
        );
      }
      if (OUTPUT_PATH_TAGS.has(normalizedTag)) {
        result.outputPaths.push(
          ...texts.flatMap((entry) =>
            splitDelimitedValues(entry).map((part) => metadataValue(part, file.path, lineForLiteral(file.content, part), effectiveCondition))
          )
        );
      }
      if (PACKAGE_TAGS.has(normalizedTag)) {
        result.requiredPackages.push(
          ...texts.flatMap((entry) =>
            splitPackageValues(entry).map((part) => metadataValue(part, file.path, lineForLiteral(file.content, part), effectiveCondition))
          )
        );
      }
      if (RUNTIME_PACKAGE_TAGS.has(normalizedTag)) {
        result.runtimePackages.push(
          ...texts.flatMap((entry) =>
            splitPackageValues(entry).map((part) => metadataValue(part, file.path, lineForLiteral(file.content, part), effectiveCondition))
          )
        );
      }
      if (normalizeKey(attrs.Personality)) result.personalityEvidence.push(`Personality=${attrs.Personality}`);
      if (normalizeKey(attrs.Version)) result.personalityEvidence.push(`Version=${attrs.Version}`);
      if (normalizeKey(tagName) === "mainsource") result.evidence.push(`MainSource=${texts.join(", ")}`);
      if (normalizeKey(tagName).includes("projectguid")) result.evidence.push(`ProjectGUID=${texts.join(", ")}`);
      if (PROJECT_REFERENCE_TAGS.has(normalizedTag)) {
        const include = typeof (value as Record<string, unknown> | null)?.["@_Include"] === "string"
          ? String((value as Record<string, unknown>)["@_Include"])
          : typeof attrs.Include === "string"
            ? attrs.Include
            : "";
        if (include) {
          result.projectReferences.push({
            path: include,
            lineNumber: lineForLiteral(file.content, include),
            condition: effectiveCondition,
          });
        }
      }
      if (effectiveCondition) {
        result.evidence.push(`Condition=${effectiveCondition}`);
      }
    });
  } catch {
    findings.push({
      code: "DELPHI_CONFIG_PARSE_LIMITED",
      severity: "warning",
      title: "Project XML could not be parsed safely",
      description: "Build Doctor could not parse this Delphi XML metadata file and fell back to limited evidence only.",
      recommendation: "Repair malformed XML and re-import the project metadata for more complete findings.",
      confidence: "medium",
      sourceFile: file.path,
      evidence: file.content.slice(0, 160),
    });
    result.parseLimited = true;
  }

  result.defines = dedupeMetadataValues(result.defines);
  result.searchPaths = dedupeMetadataValues(result.searchPaths);
  result.includePaths = dedupeMetadataValues(result.includePaths);
  result.outputPaths = dedupeMetadataValues(result.outputPaths);
  result.requiredPackages = dedupeMetadataValues(result.requiredPackages);
  result.runtimePackages = dedupeMetadataValues(result.runtimePackages);
  result.projectReferences = Array.from(
    new Map(
      result.projectReferences.map((reference) => [
        [reference.path, reference.lineNumber ?? "unknown", reference.condition ?? ""].join("::"),
        reference,
      ])
    ).values()
  );
  result.evidence = Array.from(new Set(result.evidence));
  result.personalityEvidence = Array.from(new Set(result.personalityEvidence));

  return result;
}

function scoreSeverity(severity: DelphiBuildFinding["severity"]) {
  if (severity === "blocker") return 0;
  if (severity === "error") return 1;
  if (severity === "warning") return 2;
  return 3;
}

function stableSortFindings(findings: DelphiBuildFinding[]) {
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      const key = [
        finding.code,
        finding.severity,
        finding.title,
        finding.sourceFile ?? "",
        String(finding.lineNumber ?? ""),
        finding.evidence ?? "",
      ].join("|").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        scoreSeverity(left.severity) - scoreSeverity(right.severity)
        || left.code.localeCompare(right.code)
        || (left.sourceFile ?? "").localeCompare(right.sourceFile ?? "")
        || (left.lineNumber ?? 0) - (right.lineNumber ?? 0)
        || (left.evidence ?? "").localeCompare(right.evidence ?? "")
        || left.title.localeCompare(right.title)
    );
}

export function scoreBuildDoctorFindings(findings: DelphiBuildFinding[]) {
  const score = findings.reduce((current, finding) => {
    if (finding.severity === "blocker") return current - 15;
    if (finding.severity === "error") return current - 8;
    if (finding.severity === "warning") return current - 3;
    return current;
  }, 100);
  return Math.max(0, Math.min(100, score));
}

export function analyzeDelphiBuild(files: AnalyzableFile[]): DelphiBuildDoctorResult {
  const normalizedFiles = files.map((file) => ({ ...file, path: normalizePath(file.path), extension: extensionOf(file.path) }));
  const hasDelphiEvidence = normalizedFiles.some((file) => DELPHI_BUILD_EXTENSIONS.has(file.extension) || [".pas", ".dfm", ".fmx"].includes(file.extension));
  if (!hasDelphiEvidence) {
    return {
      status: "not_applicable",
      score: 100,
      compilerFamily: { value: null, confidence: "low", evidence: [] },
      projectEntries: [],
      configurations: [],
      platforms: [],
      defines: [],
      searchPaths: [],
      includePaths: [],
      outputPaths: [],
      runtimePackages: [],
      requiredPackages: [],
      packageResolutions: [],
      requiredUnits: [],
      missingUnits: [],
      unresolvedUnits: [],
      missingPackages: [],
      externalDependencies: [],
      findings: [],
      limitations: ["No Delphi project, package, form, or Pascal evidence was found."],
    };
  }

  const findings: DelphiBuildFinding[] = [];
  const projectEntries: DelphiBuildDoctorResult["projectEntries"] = [];
  const configurations: string[] = [];
  const platforms: string[] = [];
  const defines: DelphiMetadataValue[] = [];
  const searchPaths: DelphiMetadataValue[] = [];
  const includePaths: DelphiMetadataValue[] = [];
  const outputPaths: DelphiMetadataValue[] = [];
  const runtimePackages: DelphiMetadataValue[] = [];
  const requiredPackages: DelphiMetadataValue[] = [];
  const requiredUnits: string[] = [];
  const explicitMissingUnits: string[] = [];
  const concreteMissingPackages: string[] = [];
  const externalDependencies: string[] = [];
  const knownPaths = new Set(normalizedFiles.map((file) => file.path.toLowerCase()));
  const unitIndex = new Map<string, string[]>();
  const localPackageIndex = new Map<string, string[]>();
  const compilerEvidence: string[] = [];
  const resourceChecks: Array<{ resource: string; sourceFile: string; lineNumber: number | null }> = [];
  const groupProjectRefs: Array<{ sourceFile: string; path: string; lineNumber: number | null; condition?: string }> = [];

  for (const file of normalizedFiles) {
    if (DELPHI_SOURCE_EXTENSIONS.has(file.extension)) {
      const unit = unitNameFromPascal(file.content) ?? stem(file.path);
      if (unit) {
        const bucket = unitIndex.get(normalizeKey(unit)) ?? [];
        bucket.push(file.path);
        unitIndex.set(normalizeKey(unit), bucket);
      }
      requiredUnits.push(...parseUses(file.content));
      for (const resource of resourceRefs(file.content)) {
        if (resource === "*.res") continue;
        resourceChecks.push({ resource, sourceFile: file.path, lineNumber: lineForLiteral(file.content, resource) });
      }
      for (const explicit of explicitUnitPaths(file.content)) {
        const resolved = resolveRelativePath(file.path, explicit.path);
        requiredUnits.push(explicit.unit);
        if (resolved.absolute) {
          findings.push({
            code: "DELPHI_ABSOLUTE_SEARCH_PATH",
            severity: "warning",
            title: "Absolute local path was found in Delphi source metadata",
            description: `${explicit.unit} uses an absolute path that reduces portability across machines.`,
            recommendation: "Prefer project-relative paths or documented environment macros.",
            confidence: "high",
            sourceFile: file.path,
            lineNumber: lineForLiteral(file.content, explicit.path) ?? undefined,
            evidence: explicit.path,
          });
        }
        if (resolved.escaping) {
          findings.push({
            code: "DELPHI_ESCAPING_SEARCH_PATH",
            severity: "warning",
            title: "Path escapes the imported project tree",
            description: `${explicit.path} references a parent directory outside the declaring file tree.`,
            recommendation: "Import the shared dependency or document the external path requirement explicitly.",
            confidence: "medium",
            sourceFile: file.path,
            lineNumber: lineForLiteral(file.content, explicit.path) ?? undefined,
            evidence: explicit.path,
          });
        }
        if (!resolved.unresolvedMacro && resolved.resolvedPath && !knownPaths.has(resolved.resolvedPath.toLowerCase())) {
          explicitMissingUnits.push(explicit.unit);
          findings.push({
            code: "DELPHI_EXPLICIT_UNIT_PATH_MISSING",
            severity: "blocker",
            title: `Explicit unit path is missing: ${explicit.unit}`,
            description: `${file.path} references ${explicit.path}, but that file was not imported.`,
            recommendation: "Import the referenced unit or adjust the project path before compiling.",
            confidence: "high",
            sourceFile: file.path,
            lineNumber: lineForLiteral(file.content, explicit.path) ?? undefined,
            evidence: `${explicit.unit} in '${explicit.path}'`,
          });
        }
      }
    }

    if (file.extension === ".dpr" || file.extension === ".dpk") {
      projectEntries.push({ path: file.path, kind: file.extension === ".dpr" ? "project" : "package", lineNumber: 1, evidence: file.content.split(/\r?\n/, 1)[0] ?? file.path });
    }

    if (file.extension === ".dpk") {
      const declaredPackage = packageNameFromDpk(file.content) ?? stem(file.path);
      const packageCandidates = localPackageIndex.get(normalizeKey(declaredPackage)) ?? [];
      packageCandidates.push(file.path);
      localPackageIndex.set(normalizeKey(declaredPackage), packageCandidates);
      const stemCandidates = localPackageIndex.get(normalizeKey(stem(file.path))) ?? [];
      stemCandidates.push(file.path);
      localPackageIndex.set(normalizeKey(stem(file.path)), stemCandidates);
      requiredPackages.push(
        ...parseRequiredPackagesFromDpk(file.content).map((entry) => metadataValue(entry, file.path, lineForLiteral(file.content, entry), undefined))
      );
    }

    if (XML_METADATA_EXTENSIONS.has(file.extension)) {
      projectEntries.push({ path: file.path, kind: file.extension.slice(1), lineNumber: 1, evidence: "XML project metadata imported" });
      const parsed = parseXmlMetadata(file, findings);
      configurations.push(...parsed.configurations);
      platforms.push(...parsed.platforms);
      defines.push(...parsed.defines);
      searchPaths.push(...parsed.searchPaths);
      includePaths.push(...parsed.includePaths);
      outputPaths.push(...parsed.outputPaths);
      requiredPackages.push(...parsed.requiredPackages);
      runtimePackages.push(...parsed.runtimePackages);
      compilerEvidence.push(...parsed.personalityEvidence, ...parsed.evidence);
      if (file.extension === ".groupproj") {
        groupProjectRefs.push(...parsed.projectReferences.map((reference) => ({ sourceFile: file.path, ...reference })));
      }
    }

    if ([".cfg", ".dof"].includes(file.extension)) {
      projectEntries.push({ path: file.path, kind: file.extension.slice(1), lineNumber: 1, evidence: "compiler configuration imported" });
      defines.push(...parseCfgLikeList(file.content, [/(?:^-D|Defines=)([^\r\n]+)/gim]).map((entry) => metadataValue(entry, file.path, lineForLiteral(file.content, entry), undefined)));
      searchPaths.push(...parseCfgLikeList(file.content, [/(?:^-U|UnitSearchPath=)([^\r\n]+)/gim]).map((entry) => metadataValue(entry, file.path, lineForLiteral(file.content, entry), undefined)));
      includePaths.push(...parseCfgLikeList(file.content, [/(?:^-I|IncludePath=)([^\r\n]+)/gim]).map((entry) => metadataValue(entry, file.path, lineForLiteral(file.content, entry), undefined)));
      outputPaths.push(...parseCfgLikeList(file.content, [/(?:^-E|-N0|-N|OutputDir=)([^\r\n]+)/gim]).map((entry) => metadataValue(entry, file.path, lineForLiteral(file.content, entry), undefined)));
      requiredPackages.push(
        ...parseCfgLikeList(file.content, [/(?:^-LU|UsePackages=)([^\r\n]+)/gim])
          .flatMap((entry) => splitPackageValues(entry))
          .map((entry) => metadataValue(entry, file.path, lineForLiteral(file.content, entry), undefined))
      );
    }

    if (file.extension === ".rc") {
      projectEntries.push({ path: file.path, kind: "rc", lineNumber: 1, evidence: "resource script imported" });
      for (const reference of parseRcReferences(file.content)) {
        resourceChecks.push({ resource: reference.target, sourceFile: file.path, lineNumber: reference.lineNumber });
      }
    }
  }

  const dprOrDpkEntries = projectEntries.filter((entry) => entry.kind === "project" || entry.kind === "package");
  const metadataEntries = projectEntries.filter((entry) => ["dproj", "bdsproj", "groupproj", "cfg", "dof", "rc"].includes(entry.kind));

  if (dprOrDpkEntries.length === 0) {
    findings.push({
      code: "DELPHI_PROJECT_ENTRY_MISSING",
      severity: "warning",
      title: "No Delphi project or package entry file was imported",
      description: "Delphi source was imported, but no DPR or DPK entry file was found.",
      recommendation: "Import the main DPR/DPK file so Build Doctor can verify entry points and package topology.",
      confidence: "high",
    });
  }

  if (metadataEntries.length === 0) {
    findings.push({
      code: "DELPHI_PROJECT_METADATA_MISSING",
      severity: "warning",
      title: "No Delphi project metadata file was imported",
      description: "Pascal or form files exist, but no DPROJ, BDSPROJ, GROUPPROJ, CFG, DOF, or RC metadata was found.",
      recommendation: "Import Delphi project metadata for more reliable build-readiness checks.",
      confidence: "high",
    });
  }

  for (const [unit, paths] of unitIndex.entries()) {
    if (paths.length > 1) {
      findings.push({
        code: "DELPHI_UNIT_AMBIGUOUS",
        severity: "warning",
        title: `Duplicate unit name: ${unit}`,
        description: `Multiple imported files declare or imply the same Delphi unit: ${paths.join(", ")}`,
        recommendation: "Confirm the intended search-path order and remove duplicate units where possible.",
        confidence: "high",
        relatedFiles: [...paths].sort(),
      });
    }
  }

  const unresolvedUnits = uniq(requiredUnits).filter((unit) => !unitIndex.has(normalizeKey(unit)) && !isStandardUnit(unit));
  for (const unit of unresolvedUnits.filter((candidate) => !explicitMissingUnits.includes(candidate))) {
    findings.push({
      code: "DELPHI_UNIT_UNRESOLVED",
      severity: "warning",
      title: `Unit may require external verification: ${unit}`,
      description: `${unit} was referenced but was not resolved among imported project files or the conservative Delphi standard-unit registry.`,
      recommendation: "Verify IDE library paths or import the missing third-party/source unit before compiling.",
      confidence: "low",
      evidence: unit,
    });
    externalDependencies.push(unit);
  }

  for (const pathEntry of [...searchPaths, ...includePaths, ...outputPaths]) {
    const resolved = resolveRelativePath(pathEntry.sourceFile, pathEntry.value);
    if (resolved.absolute) {
      findings.push({
        code: "DELPHI_ABSOLUTE_SEARCH_PATH",
        severity: "warning",
        title: "Absolute search path reduces build portability",
        description: `${pathEntry.value} is machine-specific and may not exist on another workstation or CI agent.`,
        recommendation: "Replace absolute component paths with project-relative paths or documented environment variables.",
        confidence: "high",
        sourceFile: pathEntry.sourceFile,
        lineNumber: pathEntry.lineNumber ?? undefined,
        condition: pathEntry.condition,
        rawValue: pathEntry.value,
        resolvedPath: resolved.resolvedPath ?? undefined,
        evidence: metadataEvidence(pathEntry, { resolvedPath: resolved.resolvedPath }),
      });
    }
    if (resolved.escaping) {
      findings.push({
        code: "DELPHI_ESCAPING_SEARCH_PATH",
        severity: "warning",
        title: "Search path escapes the imported project tree",
        description: `${pathEntry.value} references a parent directory outside the imported project.`,
        recommendation: "Import the referenced shared units or document the required external dependency.",
        confidence: "medium",
        sourceFile: pathEntry.sourceFile,
        lineNumber: pathEntry.lineNumber ?? undefined,
        condition: pathEntry.condition,
        rawValue: pathEntry.value,
        resolvedPath: resolved.resolvedPath ?? undefined,
        evidence: metadataEvidence(pathEntry, { resolvedPath: resolved.resolvedPath }),
      });
    }
  }

  for (const reference of resourceChecks) {
    if (reference.resource.includes("*")) continue;
    const resolved = resolveRelativePath(reference.sourceFile, reference.resource);
    if (resolved.unresolvedMacro || !resolved.resolvedPath) continue;
    if (!knownPaths.has(resolved.resolvedPath.toLowerCase())) {
      findings.push({
        code: "DELPHI_RESOURCE_REFERENCE_MISSING",
        severity: "warning",
        title: `Resource reference was not imported: ${reference.resource}`,
        description: "The source references a statically resolvable resource file that is not present in the imported snapshot.",
        recommendation: "Verify the resource exists in the build checkout. Wildcard `.res` generation is intentionally not treated as missing.",
        confidence: "medium",
        sourceFile: reference.sourceFile,
        lineNumber: reference.lineNumber ?? undefined,
        evidence: reference.resource,
      });
    }
  }

  for (const reference of groupProjectRefs) {
    const resolved = resolveRelativePath(reference.sourceFile, reference.path);
    if (resolved.unresolvedMacro || !resolved.resolvedPath) continue;
    if (!knownPaths.has(resolved.resolvedPath.toLowerCase())) {
      findings.push({
        code: "DELPHI_GROUP_PROJECT_REFERENCE_MISSING",
        severity: "warning",
        title: "Group project member is missing from the imported snapshot",
        description: `${reference.path} was referenced by a GROUPPROJ file but was not imported.`,
        recommendation: "Import the referenced project member or correct the GROUPPROJ project list.",
        confidence: "high",
        sourceFile: reference.sourceFile,
        lineNumber: reference.lineNumber ?? undefined,
        evidence: reference.path,
      });
    }
  }

  const duplicateGroupRefs = new Map<string, Array<typeof groupProjectRefs[number] & { normalizedPath: string }>>();
  for (const reference of groupProjectRefs) {
    const resolved = resolveRelativePath(reference.sourceFile, reference.path);
    if (resolved.unresolvedMacro || !resolved.resolvedPath) continue;
    const normalizedPath = normalizePath(resolved.resolvedPath);
    const duplicateKey = normalizedPath.toLowerCase();
    const bucket = duplicateGroupRefs.get(duplicateKey) ?? [];
    bucket.push({ ...reference, normalizedPath });
    duplicateGroupRefs.set(duplicateKey, bucket);
  }

  for (const entries of duplicateGroupRefs.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      findings.push({
        code: "DELPHI_GROUP_PROJECT_REFERENCE_DUPLICATE",
        severity: "warning",
        title: "Group project member was listed more than once",
        description: `${entry.path} resolves to the same GROUPPROJ member as another project entry.`,
        recommendation: "Remove duplicate GROUPPROJ members so project membership stays deterministic.",
        confidence: "high",
        sourceFile: entry.sourceFile,
        lineNumber: entry.lineNumber ?? undefined,
        condition: entry.condition,
        rawValue: entry.path,
        resolvedPath: entry.normalizedPath,
        evidence: `rawValue=${entry.path}; normalizedPath=${entry.normalizedPath}`,
      });
    }
  }

  const packageGroups = new Map<string, DelphiMetadataValue[]>();
  for (const pkg of requiredPackages) {
    const key = normalizeKey(pkg.value);
    const bucket = packageGroups.get(key) ?? [];
    bucket.push(pkg);
    packageGroups.set(key, bucket);
  }

  const packageResolutions: DelphiPackageResolutionDetail[] = Array.from(packageGroups.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([, entries]) => {
    const pkg = entries[0]!.value;
    const normalizedPkg = normalizeKey(pkg);
    const localMatches = uniq([
      ...(localPackageIndex.get(normalizedPkg) ?? []),
      ...(localPackageIndex.get(normalizeKey(stem(pkg))) ?? []),
    ]);
    const explicitEntries = /[\\/]|\.dpk$|\.dproj$/i.test(pkg) ? entries.map((entry) => ({ entry, resolved: resolveRelativePath(entry.sourceFile, entry.value) })) : [];

    for (const explicit of explicitEntries) {
      if (!explicit.resolved.absolute) continue;
      findings.push({
        code: "DELPHI_ABSOLUTE_SEARCH_PATH",
        severity: "warning",
        title: "Absolute package path reduces build portability",
        description: `${pkg} uses an absolute package path.`,
        recommendation: "Prefer project-relative or macro-based package references.",
        confidence: "high",
        sourceFile: explicit.entry.sourceFile,
        lineNumber: explicit.entry.lineNumber ?? undefined,
        condition: explicit.entry.condition,
        rawValue: explicit.entry.value,
        resolvedPath: explicit.resolved.resolvedPath ?? undefined,
        evidence: metadataEvidence(explicit.entry, { resolvedPath: explicit.resolved.resolvedPath }),
      });
    }

    const missingExplicit = explicitEntries.find((entry) => !entry.resolved.unresolvedMacro && entry.resolved.resolvedPath && !knownPaths.has(entry.resolved.resolvedPath.toLowerCase()));
    if (missingExplicit) {
      concreteMissingPackages.push(pkg);
      findings.push({
        code: "DELPHI_PACKAGE_MISSING",
        severity: "blocker",
        title: `Package file is missing: ${pkg}`,
        description: "The project references a statically resolvable package path that was not imported.",
        recommendation: "Import the referenced package/project file or correct the path before compiling.",
        confidence: "high",
        sourceFile: missingExplicit.entry.sourceFile,
        lineNumber: missingExplicit.entry.lineNumber ?? undefined,
        condition: missingExplicit.entry.condition,
        rawValue: missingExplicit.entry.value,
        resolvedPath: missingExplicit.resolved.resolvedPath ?? undefined,
        evidence: metadataEvidence(missingExplicit.entry, { resolvedPath: missingExplicit.resolved.resolvedPath }),
      });
      return { packageName: pkg, resolution: "missing", resolvedPath: missingExplicit.resolved.resolvedPath!, evidence: entries.map((entry) => metadataEvidence(entry, { resolvedPath: resolveRelativePath(entry.sourceFile, entry.value).resolvedPath })) };
    }

    if (localMatches.length === 1) {
      return { packageName: pkg, resolution: "project_local", resolvedPath: localMatches[0], evidence: localMatches };
    }

    if (localMatches.length > 1) {
      findings.push({
        code: "DELPHI_PACKAGE_AMBIGUOUS",
        severity: "warning",
        title: `Package resolution is ambiguous: ${pkg}`,
        description: `Multiple imported packages match ${pkg}: ${localMatches.join(", ")}`,
        recommendation: "Review package naming/search-path order and keep only the intended package snapshot.",
        confidence: "high",
        evidence: pkg,
        relatedFiles: localMatches,
      });
      return { packageName: pkg, resolution: "ambiguous", evidence: localMatches };
    }

    if (isStandardPackage(pkg)) {
      return { packageName: pkg, resolution: "delphi_standard", evidence: entries.map((entry) => metadataEvidence(entry)) };
    }

    findings.push({
      code: "DELPHI_PACKAGE_UNRESOLVED",
      severity: "warning",
      title: `Package dependency needs external verification: ${pkg}`,
      description: `${pkg} is not project-local and is not in the conservative Delphi standard-package registry.`,
      recommendation: "Verify vendor/IDE package availability manually before treating the build as ready.",
      confidence: "medium",
      evidence: pkg,
    });
    externalDependencies.push(pkg);
    return { packageName: pkg, resolution: "external_unverified", evidence: entries.map((entry) => metadataEvidence(entry)) };
  });

  if (runtimePackages.length > 0) {
    findings.push({
      code: "DELPHI_RUNTIME_PACKAGE_DETECTED",
      severity: "info",
      title: "Runtime packages detected",
      description: "Project metadata includes runtime package configuration.",
      recommendation: "Verify BPL/package deployment policy for target environments.",
      confidence: "medium",
      evidence: uniq(runtimePackages.map((entry) => entry.value)).join(", "),
    });
  }

  if (defines.length > 0) {
    findings.push({
      code: "DELPHI_CONDITIONAL_DEFINE_DETECTED",
      severity: "info",
      title: "Conditional defines detected",
      description: "Conditional compilation may change the actual build graph.",
      recommendation: "Review the active Delphi configuration before relying on static path/build findings.",
      confidence: "medium",
      evidence: uniq(defines.map((entry) => entry.value)).join(", "),
    });
  }

  if (compilerEvidence.length === 0) {
    findings.push({
      code: "DELPHI_COMPILER_VERSION_UNCERTAIN",
      severity: "warning",
      title: "Compiler family/version evidence is limited",
      description: "Build Doctor could not extract strong Delphi compiler-family evidence from the imported metadata.",
      recommendation: "Import DPROJ/BDSPROJ metadata or document the expected Delphi version explicitly.",
      confidence: "medium",
    });
  }

  const stableFindings = stableSortFindings(findings);
  const score = scoreBuildDoctorFindings(stableFindings);
  const status = stableFindings.some((finding) => finding.severity === "blocker")
    ? "blocked"
    : stableFindings.some((finding) => finding.severity === "error" || finding.severity === "warning")
      ? "ready_with_warnings"
      : "ready";

  return {
    status,
    score,
    compilerFamily: {
      value: compilerEvidence.length > 0 ? compilerEvidence[0] : null,
      confidence: compilerEvidence.length > 0 ? "medium" : "low",
      evidence: uniq(compilerEvidence),
    },
    projectEntries: [...projectEntries].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)),
    configurations: uniq(configurations),
    platforms: uniq(platforms),
    defines: uniq(defines.map((entry) => entry.value)),
    searchPaths: uniq(searchPaths.map((entry) => entry.value)),
    includePaths: uniq(includePaths.map((entry) => entry.value)),
    outputPaths: uniq(outputPaths.map((entry) => entry.value)),
    runtimePackages: uniq(runtimePackages.map((entry) => entry.value)),
    requiredPackages: uniq(requiredPackages.map((entry) => entry.value)),
    packageResolutions: packageResolutions.sort((left, right) => left.packageName.localeCompare(right.packageName)),
    requiredUnits: uniq(requiredUnits),
    missingUnits: uniq(explicitMissingUnits),
    unresolvedUnits,
    missingPackages: uniq(concreteMissingPackages),
    externalDependencies: uniq(externalDependencies),
    findings: stableFindings,
    limitations: [
      "Build Doctor is heuristic static analysis; it does not invoke Delphi, MSBuild, scripts, binaries, or project commands.",
      "Third-party namespace and package classification is conservative and remains heuristic when IDE-managed library paths were not imported.",
      "MSBuild conditions, inherited properties, and unresolved macros are preserved as evidence and are not executed or evaluated.",
    ],
  };
}
