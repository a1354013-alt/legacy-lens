import type { DelphiBuildDoctorResult, DelphiBuildFinding } from "../../shared/contracts";
import type { AnalyzableFile } from "./types";

const DELPHI_BUILD_EXTENSIONS = new Set([".dpr", ".dpk", ".dproj", ".groupproj", ".bdsproj", ".cfg", ".dof"]);
const DELPHI_SOURCE_EXTENSIONS = new Set([".pas", ".dpr", ".dpk", ".inc"]);
const STANDARD_UNITS = new Set([
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
]);

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function extensionOf(path: string) {
  const match = path.toLowerCase().match(/\.[^.\\/]+$/);
  return match?.[0] ?? "";
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function findLine(content: string, pattern: RegExp) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index + 1;
  }
  return null;
}

function unitNameFromPascal(content: string) {
  return content.match(/^\s*unit\s+([A-Za-z_][\w.]*)\s*;/im)?.[1] ?? null;
}

function parseUses(content: string) {
  const units: string[] = [];
  for (const match of content.matchAll(/\buses\s+([\s\S]*?);/gi)) {
    const body = match[1] ?? "";
    for (const part of body.split(",")) {
      const unit = part.trim().replace(/\s+in\s+['"][^'"]+['"]/i, "").replace(/[^\w.].*$/, "").trim();
      if (unit) units.push(unit);
    }
  }
  return units;
}

function explicitUnitPaths(content: string) {
  return Array.from(content.matchAll(/\b([A-Za-z_][\w.]*)\s+in\s+['"]([^'"]+)['"]/gi), (match) => ({
    unit: match[1] ?? "",
    path: normalizePath(match[2] ?? ""),
  })).filter((entry) => entry.unit && entry.path);
}

function resourceRefs(content: string) {
  return Array.from(content.matchAll(/\{\$R\s+([^}]+)\}/gi), (match) => (match[1] ?? "").trim().replace(/^['"]|['"]$/g, ""));
}

function parseXmlish(content: string, tag: string) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return Array.from(content.matchAll(pattern), (match) => (match[1] ?? "").trim()).filter(Boolean);
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
      runtimePackages: [],
      requiredPackages: [],
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
  const defines: string[] = [];
  const searchPaths: string[] = [];
  const runtimePackages: string[] = [];
  const requiredPackages: string[] = [];
  const requiredUnits: string[] = [];
  const explicitMissingUnits: string[] = [];
  const resourceRefsFound: string[] = [];
  const knownPaths = new Set(normalizedFiles.map((file) => file.path.toLowerCase()));
  const unitIndex = new Map<string, string[]>();

  for (const file of normalizedFiles) {
    if (DELPHI_SOURCE_EXTENSIONS.has(file.extension)) {
      const unit = unitNameFromPascal(file.content) ?? file.path.split("/").at(-1)?.replace(/\.[^.]+$/, "");
      if (unit) {
        const key = unit.toLowerCase();
        const bucket = unitIndex.get(key) ?? [];
        bucket.push(file.path);
        unitIndex.set(key, bucket);
      }
      requiredUnits.push(...parseUses(file.content));
      resourceRefsFound.push(...resourceRefs(file.content).map((resource) => resource === "*.res" ? `${file.path.replace(/\.[^.]+$/, "")}.res` : resource));
      for (const explicit of explicitUnitPaths(file.content)) {
        const parent = file.path.split("/").slice(0, -1).join("/");
        const candidate = normalizePath(explicit.path.startsWith(".") || !/^[A-Za-z]:/.test(explicit.path) ? `${parent}/${explicit.path}` : explicit.path).replace(/\/\.\//g, "/");
        requiredUnits.push(explicit.unit);
        if (!knownPaths.has(candidate.toLowerCase()) && !knownPaths.has(explicit.path.toLowerCase())) {
          explicitMissingUnits.push(explicit.unit);
          findings.push({
            code: "DELPHI_EXPLICIT_UNIT_PATH_MISSING",
            severity: "blocker",
            title: `Explicit unit path is missing: ${explicit.unit}`,
            description: `${file.path} references ${explicit.path}, but that file was not imported.`,
            recommendation: "Import the referenced unit or adjust the project path before compiling.",
            confidence: "high",
            sourceFile: file.path,
            lineNumber: findLine(file.content, new RegExp(`${explicit.unit}\\s+in`, "i")) ?? undefined,
            evidence: `${explicit.unit} in '${explicit.path}'`,
          });
        }
      }
    }

    if (file.extension === ".dpr" || file.extension === ".dpk") {
      projectEntries.push({ path: file.path, kind: file.extension === ".dpr" ? "project" : "package", lineNumber: 1, evidence: file.content.split(/\r?\n/, 1)[0] ?? file.path });
    }

    if (file.extension === ".dpk") {
      for (const match of file.content.matchAll(/\brequires\s+([\s\S]*?);/gi)) {
        requiredPackages.push(...(match[1] ?? "").split(",").map((value) => value.trim().replace(/[^\w.].*$/, "")).filter(Boolean));
      }
    }

    if ([".dproj", ".bdsproj", ".groupproj"].includes(file.extension)) {
      projectEntries.push({ path: file.path, kind: file.extension.slice(1), lineNumber: 1, evidence: "XML project metadata imported" });
      if (file.content.includes("<") && !file.content.includes(">")) {
        findings.push({
          code: "DELPHI_CONFIG_PARSE_LIMITED",
          severity: "warning",
          title: "Project XML could not be fully parsed",
          description: "The XML-like project metadata appears malformed, so Build Doctor used limited text extraction.",
          recommendation: "Open the project file in Delphi or an XML editor and repair malformed markup.",
          confidence: "medium",
          sourceFile: file.path,
          evidence: file.content.slice(0, 120),
        });
      }
      configurations.push(...parseXmlish(file.content, "Config"));
      platforms.push(...parseXmlish(file.content, "Platform"));
      defines.push(...parseXmlish(file.content, "DCC_Define").flatMap((value) => value.split(/[;,]/).map((part) => part.trim())));
      searchPaths.push(...parseXmlish(file.content, "DCC_UnitSearchPath").flatMap((value) => value.split(/[;,]/).map((part) => part.trim())));
      runtimePackages.push(...parseXmlish(file.content, "RuntimeOnlyPackage").flatMap((value) => value.split(/[;,]/).map((part) => part.trim())));
    }

    if ([".cfg", ".dof"].includes(file.extension)) {
      projectEntries.push({ path: file.path, kind: file.extension.slice(1), lineNumber: 1, evidence: "compiler configuration imported" });
      defines.push(...Array.from(file.content.matchAll(/(?:^-D|Defines=)([^\r\n]+)/gim), (match) => match[1] ?? "").flatMap((value) => value.split(/[;,]/).map((part) => part.trim())));
      searchPaths.push(...Array.from(file.content.matchAll(/(?:^-U|UnitSearchPath=)([^\r\n]+)/gim), (match) => match[1] ?? "").flatMap((value) => value.split(/[;,]/).map((part) => part.trim())));
    }
  }

  if (projectEntries.length === 0) {
    findings.push({
      code: "DELPHI_PROJECT_METADATA_MISSING",
      severity: "warning",
      title: "No Delphi project metadata file was imported",
      description: "Pascal or form files exist, but no DPR, DPK, DPROJ, BDSPROJ, GROUPPROJ, CFG, or DOF was found.",
      recommendation: "Import project metadata for more reliable build-readiness checks.",
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
        relatedFiles: paths,
      });
    }
  }

  const unresolvedUnits = uniq(requiredUnits).filter((unit) => !unitIndex.has(unit.toLowerCase()) && !STANDARD_UNITS.has(unit.toLowerCase()));
  for (const unit of unresolvedUnits.filter((unit) => !explicitMissingUnits.includes(unit))) {
    findings.push({
      code: "DELPHI_UNIT_UNRESOLVED",
      severity: "warning",
      title: `Unit may require an external path: ${unit}`,
      description: `${unit} was referenced but not found among imported files or the built-in standard-unit allowlist.`,
      recommendation: "Verify Delphi library paths and third-party components during manual build setup.",
      confidence: "low",
      evidence: unit,
    });
  }

  for (const searchPath of searchPaths) {
    if (/^[A-Za-z]:\\|^[A-Za-z]:\//.test(searchPath)) {
      findings.push({
        code: "DELPHI_ABSOLUTE_SEARCH_PATH",
        severity: "warning",
        title: "Absolute search path reduces build portability",
        description: `${searchPath} is machine-specific and may not exist on another workstation or CI agent.`,
        recommendation: "Replace absolute component paths with project-relative paths or documented environment variables.",
        confidence: "high",
        evidence: searchPath,
      });
    }
    if (searchPath.includes("..")) {
      findings.push({
        code: "DELPHI_ESCAPING_SEARCH_PATH",
        severity: "warning",
        title: "Search path escapes the imported project tree",
        description: `${searchPath} references a parent directory outside the imported project.`,
        recommendation: "Import the referenced shared units or document the required external dependency.",
        confidence: "medium",
        evidence: searchPath,
      });
    }
  }

  for (const resource of resourceRefsFound) {
    if (resource.includes("*")) continue;
    if (!knownPaths.has(normalizePath(resource).toLowerCase())) {
      findings.push({
        code: "DELPHI_RESOURCE_REFERENCE_MISSING",
        severity: "warning",
        title: `Resource reference was not imported: ${resource}`,
        description: "The source references a resource file that is not present in the imported text snapshot.",
        recommendation: "Verify the resource exists in the build checkout. Binary .res content is intentionally not imported as text.",
        confidence: "medium",
        evidence: resource,
      });
    }
  }

  for (const pkg of requiredPackages) {
    findings.push({
      code: "DELPHI_PACKAGE_UNRESOLVED",
      severity: "warning",
      title: `Package dependency requires verification: ${pkg}`,
      description: `${pkg} is required by package metadata and may be a Delphi, vendor, or project-local package.`,
      recommendation: "Confirm package availability in the Delphi installation or project dependencies.",
      confidence: STANDARD_UNITS.has(pkg.toLowerCase()) ? "low" : "medium",
      evidence: pkg,
    });
  }

  if (runtimePackages.length > 0) {
    findings.push({
      code: "DELPHI_RUNTIME_PACKAGE_DETECTED",
      severity: "info",
      title: "Runtime packages detected",
      description: "Project metadata includes runtime package configuration.",
      recommendation: "Verify package deployment policy for target environments.",
      confidence: "medium",
      evidence: runtimePackages.join(", "),
    });
  }
  if (defines.length > 0) {
    findings.push({
      code: "DELPHI_CONDITIONAL_DEFINE_DETECTED",
      severity: "info",
      title: "Conditional defines detected",
      description: "Conditional compilation may change the actual build graph.",
      recommendation: "Review active build configuration before relying on static traces.",
      confidence: "medium",
      evidence: defines.join(", "),
    });
  }

  const score = scoreBuildDoctorFindings(findings);
  const status = findings.some((finding) => finding.severity === "blocker")
    ? "blocked"
    : findings.some((finding) => finding.severity === "error" || finding.severity === "warning")
      ? "ready_with_warnings"
      : "ready";

  return {
    status,
    score,
    compilerFamily: {
      value: normalizedFiles.some((file) => file.content.includes("ProjectExtensions")) ? "Likely Delphi 2009+ project family" : null,
      confidence: normalizedFiles.some((file) => file.extension === ".dproj") ? "medium" : "low",
      evidence: normalizedFiles.filter((file) => [".dproj", ".bdsproj"].includes(file.extension)).map((file) => file.path),
    },
    projectEntries,
    configurations: uniq(configurations),
    platforms: uniq(platforms),
    defines: uniq(defines),
    searchPaths: uniq(searchPaths),
    runtimePackages: uniq(runtimePackages),
    requiredPackages: uniq(requiredPackages),
    requiredUnits: uniq(requiredUnits),
    missingUnits: uniq(explicitMissingUnits),
    unresolvedUnits,
    missingPackages: uniq(requiredPackages),
    externalDependencies: unresolvedUnits,
    findings,
    limitations: [
      "Build Doctor is heuristic static analysis; it does not invoke Delphi, MSBuild, scripts, or project commands.",
      "Third-party units can be unresolved when they are supplied by IDE library paths that were not imported.",
    ],
  };
}
