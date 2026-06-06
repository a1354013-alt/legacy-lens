import { describe, expect, it } from "vitest";
import { groupRisks, groupRules, summarizeWarnings } from "./analysisPresentation";

describe("analysisPresentation helpers", () => {
  it("aggregates repeated warnings into localized summary buckets", () => {
    const summary = summarizeWarnings([
      { code: "IMPORT_LIMITED_ANALYSIS", message: "limited", filePath: "forms/A.dfm" },
      { code: "IMPORT_LIMITED_ANALYSIS", message: "limited", filePath: "forms/B.dfm" },
      { code: "IMPORT_ENCODING_DETECTED", message: "encoding", filePath: "legacy/Main.pas" },
    ]);

    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "IMPORT_LIMITED_ANALYSIS", label: "DFM 有限分析", count: 2 }),
        expect.objectContaining({ code: "IMPORT_ENCODING_DETECTED", label: "舊編碼偵測", count: 1 }),
      ])
    );
  });

  it("groups duplicate risks into actionable buckets with occurrence counts", () => {
    const grouped = groupRisks(
      [
        {
          id: "1",
          riskType: "other",
          severity: "high",
          title: "Dynamic SQL text assignment",
          description: "Detected SQL.Text assignment using string concatenation.",
          sourceFile: "repo/A.pas",
          lineNumber: 10,
          recommendation: "Use parameterized queries.",
        },
        {
          id: "2",
          riskType: "other",
          severity: "high",
          title: "Dynamic SQL text assignment",
          description: "Detected SQL.Text assignment using string concatenation.",
          sourceFile: "repo/B.pas",
          lineNumber: 22,
          recommendation: "Use parameterized queries.",
        },
      ],
      { hideDuplicates: true }
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      title: "Dynamic SQL text assignment",
      occurrenceCount: 2,
      affectedFileCount: 2,
    });
  });

  it("hides duplicate risks by default", () => {
    const grouped = groupRisks([
      {
        id: "1",
        riskType: "other",
        severity: "high",
        title: "Dynamic SQL text assignment",
        description: "Detected SQL.Text assignment using string concatenation.",
        sourceFile: "repo/A.pas",
        lineNumber: 10,
        recommendation: "Use parameterized queries.",
      },
      {
        id: "2",
        riskType: "other",
        severity: "high",
        title: "Dynamic SQL text assignment",
        description: "Detected SQL.Text assignment using string concatenation.",
        sourceFile: "repo/B.pas",
        lineNumber: 22,
        recommendation: "Use parameterized queries.",
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.occurrenceCount).toBe(2);
  });

  it("groups single-owner rules into readable Chinese titles", () => {
    const grouped = groupRules(
      [
        {
          id: "1",
          ruleType: "validation",
          name: "validate_access_modify_alpha_single_owner",
          description: "Review write ownership for access_modify.alpha.",
          condition: "access_modify.alpha should have a documented write owner",
          sourceFile: null,
          lineNumber: null,
        },
        {
          id: "2",
          ruleType: "validation",
          name: "validate_access_modify_beta_single_owner",
          description: "Review write ownership for access_modify.beta.",
          condition: "access_modify.beta should have a documented write owner",
          sourceFile: "repo/access.pas",
          lineNumber: 30,
        },
      ],
      { hideDuplicates: true }
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.title).toContain("access_modify");
    expect(grouped[0]?.title).toContain("欄位有多處寫入來源");
    expect(grouped[0]?.sourceLabel).toBe("來源待確認");
  });
  it("groups rules by human-readable title", () => {
    const grouped = groupRules(
      [
        {
          id: "1",
          ruleType: "magic_value",
          title: "商業常數應抽離管理",
          description: "A",
          recommendation: "A",
          sourceFile: "repo/A.pas",
          lineNumber: 10,
        },
        {
          id: "2",
          ruleType: "magic_value",
          title: "商業常數應抽離管理",
          description: "B",
          recommendation: "B",
          sourceFile: "repo/B.pas",
          lineNumber: 20,
        },
      ],
      { hideDuplicates: true }
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.occurrenceCount).toBe(2);
    expect(grouped[0]?.affectedFileCount).toBe(2);
  });
});
