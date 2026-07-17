import { describe, expect, it } from "vitest";
import { analyzeDelphiBuild, scoreBuildDoctorFindings } from "./buildDoctor";
import type { AnalyzableFile } from "./types";

describe("Delphi Build Doctor", () => {
  it("reports ready for a DPR with matching PAS unit and standard Delphi units", () => {
    const files: AnalyzableFile[] = [
      {
        path: "Project1.dpr",
        language: "delphi",
        content: "program Project1;\nuses\n  Forms,\n  MainForm in 'MainForm.pas';\n{$R *.res}\nbegin\nend.",
      },
      {
        path: "MainForm.pas",
        language: "delphi",
        content: "unit MainForm;\ninterface\nuses SysUtils, Classes;\nimplementation\nend.",
      },
    ];

    const result = analyzeDelphiBuild(files);

    expect(result.requiredUnits).toContain("Forms");
    expect(result.unresolvedUnits).not.toContain("Forms");
    expect(result.missingUnits).toEqual([]);
    expect(result.status).not.toBe("blocked");
  });

  it("flags missing explicit unit paths as blockers", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Project1.dpr",
        language: "delphi",
        content: "program Project1;\nuses MissingUnit in 'missing/MissingUnit.pas';\nbegin\nend.",
      },
    ]);

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toContain("DELPHI_EXPLICIT_UNIT_PATH_MISSING");
    expect(result.missingUnits).toContain("MissingUnit");
  });

  it("uses the documented scoring policy", () => {
    expect(
      scoreBuildDoctorFindings([
        { code: "A", severity: "blocker", title: "A", description: "A", recommendation: "A", confidence: "high" },
        { code: "B", severity: "error", title: "B", description: "B", recommendation: "B", confidence: "high" },
        { code: "C", severity: "warning", title: "C", description: "C", recommendation: "C", confidence: "high" },
        { code: "D", severity: "info", title: "D", description: "D", recommendation: "D", confidence: "high" },
      ])
    ).toBe(74);
  });
});
