import { describe, expect, it } from "vitest";
import { RiskDetector } from "./riskDetector";

describe("RiskDetector", () => {
  it("detects Delphi-specific dynamic SQL and parameter usage patterns", () => {
    const detector = new RiskDetector();
    const content = [
      "Query.SQL.Add('SELECT * FROM Customers WHERE Id = ' + IntToStr(Id));",
      "Params.ParamByName('Id').AsInteger := Id;",
      "try",
      "  DoWork;",
      "except",
      "  ;",
      "end;",
      "DataSource := MySource;",
      "Database:= 'C:\\Temp\\legacy.db';",
    ].join("\n");

    const risks = detector.detectDelphiPatterns(content, "invoice.pas");

    expect(risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Dynamic Delphi SQL construction",
          category: "other",
          sourceFile: "invoice.pas",
        }),
        expect.objectContaining({
          title: "Delphi query parameter usage detected",
          category: "other",
          sourceFile: "invoice.pas",
        }),
        expect.objectContaining({
          title: "Broad or empty Delphi exception handling",
          category: "other",
          sourceFile: "invoice.pas",
        }),
        expect.objectContaining({
          title: "Hardcoded Delphi path or connection string",
          category: "other",
          sourceFile: "invoice.pas",
        }),
      ])
    );
  });
});
