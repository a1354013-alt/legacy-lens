import { describe, expect, it } from "vitest";
import type { ImpactAnalysisResult } from "@shared/contracts";
import { buildImpactSections } from "./impactAnalysisSections";

function createResult(overrides: Partial<ImpactAnalysisResult> = {}): ImpactAnalysisResult {
  return {
    target: "UpdateContract",
    targetType: "symbol",
    confidence: 1,
    affectedCount: 0,
    summary: "summary",
    affectedFiles: [],
    affectedSymbols: [],
    affectedTables: [],
    affectedFields: [],
    affectedRules: [],
    affectedRisks: [],
    dependencyChains: [],
    warnings: [],
    ...overrides,
  };
}

describe("buildImpactSections", () => {
  it("includes explicit sections for affected rules and risks", () => {
    const sections = buildImpactSections(
      createResult({
        affectedRules: ["SharedRule"],
        affectedRisks: ["Shared risk"],
      })
    );

    expect(sections.map((section) => section.id)).toContain("rules");
    expect(sections.map((section) => section.id)).toContain("risks");
    expect(sections.find((section) => section.id === "rules")?.items[0]?.label).toBe("SharedRule");
    expect(sections.find((section) => section.id === "risks")?.items[0]?.label).toBe("Shared risk");
  });

  it("caps large sections and reports hidden counts for large projects", () => {
    const sections = buildImpactSections(
      createResult({
        affectedFiles: Array.from({ length: 15 }, (_, index) => `src/file-${index + 1}.go`),
      }),
      12
    );

    const fileSection = sections.find((section) => section.id === "files");
    expect(fileSection?.items).toHaveLength(12);
    expect(fileSection?.count).toBe(15);
    expect(fileSection?.hiddenCount).toBe(3);
  });
});
