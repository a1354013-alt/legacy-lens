import { describe, expect, it } from "vitest";
import { buildAnalysisRunSnapshot, parseAnalysisSnapshot } from "./analysisHistory";
import type { ProjectAnalysisResult } from "../analyzer/types";

const baseResult: ProjectAnalysisResult = {
  projectId: 1,
  status: "completed",
  language: "delphi",
  symbols: [],
  dependencies: [],
  fieldReferences: [],
  schemaFields: [],
  risks: [],
  rules: [],
  warnings: [],
  flowDocument: "# flow",
  dataDependencyDocument: "# data",
  risksDocument: "# risks",
  rulesYaml: "rules: []",
  delphiEventMap: [],
  delphiDataBindings: [],
  sqlStatements: [],
  buildDoctor: {
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
    limitations: [],
  },
  flowTraces: [],
  riskScore: 0,
  metrics: {
    fileCount: 1,
    eligibleFileCount: 1,
    analyzedFileCount: 1,
    skippedFileCount: 0,
    heuristicFileCount: 0,
    degradedFileCount: 0,
    symbolCount: 0,
    dependencyCount: 0,
    fieldCount: 0,
    fieldDependencyCount: 0,
    riskCount: 0,
    ruleCount: 0,
    warningCount: 0,
  },
};

describe("analysis run snapshots", () => {
  it("builds deterministic source fingerprints independent of input order", () => {
    const files = [
      { filePath: "b.pas", fileType: ".pas", lineCount: 1, content: "unit B;" },
      { filePath: "a.pas", fileType: ".pas", lineCount: 1, content: "unit A;" },
    ];

    const left = buildAnalysisRunSnapshot(files, baseResult);
    const right = buildAnalysisRunSnapshot([...files].reverse(), baseResult);

    expect(left.sourceFingerprint).toBe(right.sourceFingerprint);
    expect(left.snapshotJson).toBe(right.snapshotJson);
  });

  it("uses source paths and content, not derived metadata, for source fingerprints", () => {
    const base = buildAnalysisRunSnapshot([{ filePath: "a.pas", fileType: ".pas", lineCount: 1, content: "unit A;" }], baseResult);
    const metadataOnlyChange = buildAnalysisRunSnapshot([{ filePath: "a.pas", fileType: "pascal", lineCount: 9, content: "unit A;" }], baseResult);
    const contentChange = buildAnalysisRunSnapshot([{ filePath: "a.pas", fileType: ".pas", lineCount: 1, content: "unit B;" }], baseResult);

    expect(metadataOnlyChange.sourceFingerprint).toBe(base.sourceFingerprint);
    expect(contentChange.sourceFingerprint).not.toBe(base.sourceFingerprint);
  });

  it("returns a controlled warning for unsupported future snapshot versions", () => {
    const parsed = parseAnalysisSnapshot(JSON.stringify({ schemaVersion: 99 }));

    expect(parsed.snapshot).toBeNull();
    expect(parsed.warning).toContain("not supported");
  });
});
