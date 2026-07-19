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

  it("classifies local, standard, and external Delphi packages without marking all of them missing", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Packages/AppCore.dpk",
        language: "delphi",
        content: "package AppCore;\nrequires rtl, Vendor.Reporting, LocalShared;\ncontains\nend.",
      },
      {
        path: "Packages/LocalShared.dpk",
        language: "delphi",
        content: "package LocalShared;\nrequires rtl;\ncontains\nend.",
      },
    ]);

    expect(result.missingPackages).toEqual([]);
    expect(result.packageResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: "rtl", resolution: "delphi_standard" }),
        expect.objectContaining({ packageName: "LocalShared", resolution: "project_local", resolvedPath: "Packages/LocalShared.dpk" }),
        expect.objectContaining({ packageName: "Vendor.Reporting", resolution: "external_unverified" }),
      ])
    );
  });

  it("treats common namespaced Delphi units as standard", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Project1.dpr",
        language: "delphi",
        content: "program Project1;\nuses\n  System.SysUtils,\n  Vcl.Forms,\n  Winapi.Windows,\n  FireDAC.Comp.Client;\nbegin\nend.",
      },
    ]);

    expect(result.unresolvedUnits).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).not.toContain("DELPHI_UNIT_UNRESOLVED");
  });

  it("reports malformed Delphi XML metadata with a controlled parse-limited finding", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Project1.dproj",
        language: "delphi",
        content: "<Project><PropertyGroup><Config>Debug</Config>",
      },
    ]);

    expect(result.findings.map((finding) => finding.code)).toContain("DELPHI_CONFIG_PARSE_LIMITED");
  });

  it("reports statically missing group project members", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Suite.groupproj",
        language: "delphi",
        content: "<Project><ItemGroup><Projects Include=\"Modules/App.dproj\" /></ItemGroup></Project>",
      },
    ]);

    expect(result.findings.map((finding) => finding.code)).toContain("DELPHI_GROUP_PROJECT_REFERENCE_MISSING");
  });

  it("inherits parent PropertyGroup conditions into child metadata values without duplicates", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Project1.dproj",
        language: "delphi",
        content: [
          "<Project>",
          "  <PropertyGroup Condition=\"'$(Config)'=='Debug'\">",
          "    <DCC_Define>DEBUG</DCC_Define>",
          "    <DCC_UnitSearchPath>C:\\DebugUnits</DCC_UnitSearchPath>",
          "  </PropertyGroup>",
          "</Project>",
        ].join("\n"),
      },
    ]);

    const pathFindings = result.findings.filter((finding) => finding.code === "DELPHI_ABSOLUTE_SEARCH_PATH");

    expect(result.defines).toEqual(["DEBUG"]);
    expect(pathFindings).toHaveLength(1);
    expect(pathFindings[0]).toMatchObject({
      sourceFile: "Project1.dproj",
      rawValue: "C:\\DebugUnits",
      condition: "'$(Config)'=='Debug'",
    });
  });

  it("lets child XML conditions override inherited conditions", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Project1.dproj",
        language: "delphi",
        content: [
          "<Project>",
          "  <PropertyGroup Condition=\"'$(Config)'=='Debug'\">",
          "    <DCC_UnitSearchPath Condition=\"'$(Platform)'=='Win64'\">C:\\Win64Units</DCC_UnitSearchPath>",
          "  </PropertyGroup>",
          "</Project>",
        ].join("\n"),
      },
    ]);

    const pathFinding = result.findings.find((finding) => finding.code === "DELPHI_ABSOLUTE_SEARCH_PATH");

    expect(result.searchPaths).toEqual(["C:\\Win64Units"]);
    expect(pathFinding).toMatchObject({
      sourceFile: "Project1.dproj",
      rawValue: "C:\\Win64Units",
      condition: "'$(Platform)'=='Win64'",
    });
  });

  it("reports duplicate GROUPPROJ members only when their resolved paths are the same", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Suite.groupproj",
        language: "delphi",
        content: [
          "<Project>",
          "  <ItemGroup>",
          "    <Projects Include=\"Modules/App.dproj\" />",
          "    <Projects Include=\"Modules\\\\APP.dproj\" />",
          "    <Projects Include=\"Other/App.dproj\" />",
          "  </ItemGroup>",
          "</Project>",
        ].join("\n"),
      },
      { path: "Modules/App.dproj", language: "delphi", content: "<Project />" },
      { path: "Other/App.dproj", language: "delphi", content: "<Project />" },
    ]);

    const duplicateFindings = result.findings.filter((finding) => finding.code === "DELPHI_GROUP_PROJECT_REFERENCE_DUPLICATE");

    expect(duplicateFindings).toHaveLength(2);
    expect(duplicateFindings[0]).toMatchObject({
      sourceFile: "Suite.groupproj",
      rawValue: expect.stringMatching(/Modules/i),
      resolvedPath: "Modules/App.dproj",
    });
  });

  it("reports explicit missing package paths as missing packages", () => {
    const result = analyzeDelphiBuild([
      {
        path: "Packages/AppCore.dpk",
        language: "delphi",
        content: "package AppCore;\nrequires Packages/MissingPkg.dpk;\ncontains\nend.",
      },
    ]);

    expect(result.missingPackages).toEqual(["Packages/MissingPkg.dpk"]);
    expect(result.packageResolutions).toEqual(
      expect.arrayContaining([expect.objectContaining({ packageName: "Packages/MissingPkg.dpk", resolution: "missing" })])
    );
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
