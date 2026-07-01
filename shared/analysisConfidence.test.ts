import { describe, expect, it } from "vitest";
import { calculateAnalysisConfidence } from "./analysisConfidence";

describe("calculateAnalysisConfidence", () => {
  it("keeps confidence high when coverage is strong and warnings are absent", () => {
    const confidence = calculateAnalysisConfidence({
      metrics: {
        fileCount: 4,
        eligibleFileCount: 4,
        analyzedFileCount: 4,
        skippedFileCount: 0,
        degradedFileCount: 0,
        delphiEventMap: [{ status: "resolved" }],
        delphiDataBindings: [{ confidence: "high", accessHint: "read-write" }],
      },
      fileTypes: [".pas", ".dfm", ".dpr", ".sql"],
      analyzerWarnings: [],
      importWarnings: [],
      risks: [],
    });

    expect(confidence.level).toBe("high");
    expect(confidence.score).toBeGreaterThanOrEqual(90);
  });

  it("subtracts confidence for unresolved DFM event handlers", () => {
    const confidence = calculateAnalysisConfidence({
      metrics: {
        fileCount: 3,
        eligibleFileCount: 3,
        analyzedFileCount: 3,
        delphiEventMap: [{ status: "resolved" }, { status: "unresolved" }],
      },
      fileTypes: [".pas", ".dfm", ".dpr"],
    });

    expect(confidence.breakdown).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Unresolved DFM event handlers", impact: -4 })])
    );
  });

  it("subtracts confidence for unresolved DFM data bindings", () => {
    const confidence = calculateAnalysisConfidence({
      metrics: {
        fileCount: 3,
        eligibleFileCount: 3,
        analyzedFileCount: 3,
        delphiDataBindings: [
          { confidence: "high", accessHint: "read-write" },
          { confidence: "low", accessHint: "unresolved" },
        ],
      },
      fileTypes: [".pas", ".dfm", ".dpr"],
    });

    expect(confidence.breakdown).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Unresolved DFM data bindings", impact: -4 })])
    );
  });

  it("subtracts confidence for dynamic SQL", () => {
    const confidence = calculateAnalysisConfidence({
      metrics: { fileCount: 1, eligibleFileCount: 1, analyzedFileCount: 1 },
      fileTypes: [".pas"],
      analyzerWarnings: [{ code: "SQL_DYNAMIC_STRING", message: "Detected dynamic SQL.", level: "warning" }],
      risks: [{ title: "Dynamic SQL review", description: "SQL.Text assignment using string concatenation." }],
    });

    expect(confidence.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Dynamic SQL" })]));
    expect(confidence.score).toBeLessThan(100);
  });
});
