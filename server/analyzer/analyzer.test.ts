import { afterEach, describe, expect, it, vi } from "vitest";
import { Analyzer } from "./analyzer";
import { ParserFactory } from "./parser";
import { RiskDetector } from "./riskDetector";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Analyzer", () => {
  it("marks clean supported analysis as completed when only note-level heuristic warnings are present", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "repo.sql",
          language: "sql",
          content: "SELECT u.Name FROM dbo.Users u WHERE u.Id = 1;",
        },
      ],
      1
    );

    expect(result.status).toBe("completed");
    expect(result.warnings.every((warning) => warning.level === "note" || warning.level === "warning")).toBe(true);
    expect(result.metrics.skippedFileCount).toBe(0);
    expect(result.metrics.degradedFileCount).toBe(0);
  });

  it("marks dynamic and multi-line SQL extraction as degraded heuristic output", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "repo.go",
          language: "go",
          content: [
            'const query = "SELECT amount " +',
            '  "FROM orders"',
            "func main() {}",
          ].join("\n"),
        },
      ],
      1
    );

    expect(result.status).toBe("partial");
    expect(result.metrics.heuristicFileCount).toBe(1);
    expect(result.metrics.degradedFileCount).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["SQL_STRING_MULTILINE", "SQL_DYNAMIC_STRING", "HEURISTIC_ANALYSIS"])
    );
  });

  it("keeps schema-qualified table names intact in project analysis output", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "repo.sql",
          language: "sql",
          content: [
            "SELECT u.Name FROM dbo.Users u;",
            "UPDATE ERP.SIGNB SET MARK_2 = 'Y' WHERE MARK_2 = 'N';",
          ].join("\n"),
        },
      ],
      1
    );

    expect(result.fieldReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "dbo.Users", field: "Name" }),
        expect.objectContaining({ table: "ERP.SIGNB", field: "MARK_2" }),
      ])
    );
    expect(result.metrics.fieldCount).toBe(2);
  });

  it("does not raise missing WHERE for complete multi-line SQL statements or Delphi SQL concatenation", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "repo.sql",
          language: "sql",
          content: [
            "UPDATE dbo.Users",
            "SET Name = 'A'",
            "WHERE Id = 1",
          ].join("\n"),
        },
        {
          path: "repo.pas",
          language: "delphi",
          content: [
            "unit Repo;",
            "interface",
            "implementation",
            "procedure Save;",
            "begin",
            "  Query.SQL.Text := 'UPDATE dbo.Users ' +",
            "    'SET Name = ''A'' ' +",
            "    'WHERE Id = 1';",
            "end;",
            "end.",
          ].join("\n"),
        },
      ],
      1
    );

    expect(result.risks.some((risk) => risk.category === "missing_condition")).toBe(false);
  });

  it("resolves DFM event handlers to same-basename Pascal methods and reports unresolved handlers", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "ui/Form1.dfm",
          language: "dfm",
          content: [
            "object Form1: TForm1",
            "  object Button1: TButton",
            "    OnClick = Button1Click",
            "  end",
            "  object MissingButton: TButton",
            "    OnClick = MissingButtonClick",
            "  end",
            "end",
          ].join("\n"),
        },
        {
          path: "ui/Form1.pas",
          language: "pas",
          content: [
            "unit Form1;",
            "interface",
            "type",
            "  TForm1 = class",
            "  public",
            "    procedure Button1Click(Sender: TObject);",
            "  end;",
            "implementation",
            "procedure TForm1.Button1Click(Sender: TObject);",
            "begin",
            "end;",
            "end.",
          ].join("\n"),
        },
      ],
      1
    );

    expect(result.delphiEventMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentName: "Button1",
          eventName: "OnClick",
          handlerName: "Button1Click",
          resolvedMethod: "TForm1.Button1Click",
          resolvedFile: "ui/Form1.pas",
          status: "resolved",
        }),
        expect.objectContaining({
          componentName: "MissingButton",
          handlerName: "MissingButtonClick",
          resolvedMethod: null,
          status: "unresolved",
          warnings: expect.arrayContaining([expect.stringContaining("No matching Pascal")]),
        }),
      ])
    );
    expect(result.metrics.delphiEventMap).toEqual(result.delphiEventMap);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DELPHI_EVENT_HANDLER_UNRESOLVED",
          filePath: "ui/Form1.dfm",
        }),
      ])
    );
  });

  it("collects Delphi DB UI bindings from DFM DataSource and grid columns", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "ui/CustomerForm.dfm",
          language: "dfm",
          content: [
            "object CustomerForm: TCustomerForm",
            "  object cdsMaster: TClientDataSet",
            "  end",
            "  object dsMaster: TDataSource",
            "    DataSet = cdsMaster",
            "  end",
            "  object DBEdit1: TDBEdit",
            "    DataSource = dsMaster",
            "    DataField = 'CUST_NAME'",
            "  end",
            "  object DBCheckBox1: TDBCheckBox",
            "    DataSource = dsMaster",
            "    DataField = 'ACTIVE'",
            "  end",
            "  object DBGrid1: TDBGrid",
            "    DataSource = dsMaster",
            "    Columns = <",
            "      item",
            "        FieldName = 'CUST_ID'",
            "      end",
            "      item",
            "        FieldName = 'CUST_NAME'",
            "      end",
            "    >",
            "  end",
            "end",
          ].join("\n"),
        },
      ],
      1
    );

    expect(result.delphiDataBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ componentName: "DBEdit1", dataSource: "dsMaster", dataSet: "cdsMaster", dataField: "CUST_NAME" }),
        expect.objectContaining({ componentName: "DBCheckBox1", dataSource: "dsMaster", dataSet: "cdsMaster", dataField: "ACTIVE" }),
        expect.objectContaining({ componentName: "DBGrid1", dataSource: "dsMaster", dataSet: "cdsMaster", dataField: "CUST_ID" }),
        expect.objectContaining({ componentName: "DBGrid1", dataSource: "dsMaster", dataSet: "cdsMaster", dataField: "CUST_NAME" }),
      ])
    );
    expect(result.metrics.delphiDataBindings).toEqual(result.delphiDataBindings);
  });

  it("raises missing WHERE only when UPDATE or DELETE truly lack predicates", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "repo.sql",
          language: "sql",
          content: [
            "UPDATE dbo.Users",
            "SET Name = 'A'",
            "",
            "DELETE FROM dbo.Users",
          ].join("\n"),
        },
      ],
      1
    );

    const missingWhereRisks = result.risks.filter((risk) => risk.category === "missing_condition");
    expect(missingWhereRisks).toHaveLength(2);
    expect(missingWhereRisks.map((risk) => risk.codeSnippet)).toEqual(
      expect.arrayContaining(["UPDATE dbo.Users SET Name = 'A'", "DELETE FROM dbo.Users"])
    );
  });

  it("fails when there are no analyzable files at all", async () => {
    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "legacy.txt",
          language: "txt",
          content: "plain text",
        },
      ],
      1
    );

    expect(result.status).toBe("failed");
    expect(result.metrics.eligibleFileCount).toBe(0);
    expect(result.metrics.analyzedFileCount).toBe(0);
  });

  it("still marks parser-warning analysis as partial because parser warnings are treated as degraded output", async () => {
    const originalCreateParser = ParserFactory.createParser.bind(ParserFactory);
    vi.spyOn(ParserFactory, "createParser").mockImplementation((language, content, file) => {
      if (file === "legacy/Form1.dfm") {
        return {
          parseSymbols() {
            return [];
          },
          parseDependencies() {
            return [];
          },
          parseFieldReferences() {
            return [];
          },
          parseSchemaFields() {
            return [];
          },
          collectWarnings() {
            return [{ code: "IMPORT_LIMITED_ANALYSIS", message: "Limited DFM analysis.", level: "warning" as const }];
          },
        };
      }

      return originalCreateParser(language, content, file);
    });

    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "legacy/Form1.dfm",
          language: "delphi",
          content: ["object Form1: TForm1", "  Caption = 'Legacy'", "end"].join("\n"),
        },
      ],
      1
    );

    expect(result.status).toBe("partial");
    expect(result.metrics.skippedFileCount).toBe(0);
    expect(result.metrics.degradedFileCount).toBe(1);
    expect(result.warnings.some((warning) => warning.level === "warning")).toBe(true);
  });

  it("records a warning and continues when one Delphi file parser fails", async () => {
    const originalCreateParser = ParserFactory.createParser.bind(ParserFactory);
    vi.spyOn(ParserFactory, "createParser").mockImplementation((language, content, file) => {
      if (file === "broken/Form1.pas") {
        return {
          parseSymbols() {
            throw new Error("Unexpected token near inherited Create");
          },
          parseDependencies() {
            return [];
          },
          parseFieldReferences() {
            return [];
          },
          parseSchemaFields() {
            return [];
          },
          collectWarnings() {
            return [];
          },
        };
      }

      return originalCreateParser(language, content, file);
    });

    const analyzer = new Analyzer();
    const result = await analyzer.analyzeProject(
      [
        {
          path: "broken/Form1.pas",
          language: "pas",
          content: "unit Broken;",
        },
        {
          path: "repo.sql",
          language: "sql",
          content: "SELECT u.Name FROM dbo.Users u WHERE u.Id = 1;",
        },
      ],
      1
    );

    expect(result.status).toBe("partial");
    expect(result.metrics.analyzedFileCount).toBe(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ANALYSIS_FILE_SKIPPED",
          filePath: "broken/Form1.pas",
        }),
      ])
    );
  });

  it("runs Delphi risk detection for pas language imports", async () => {
    const detectSpy = vi.spyOn(RiskDetector.prototype, "detectDelphiPatterns");
    const analyzer = new Analyzer();

    await analyzer.analyzeFile({
      path: "repo.txt",
      language: "pas",
      content: "Query.FieldByName('Status').AsString := 'paid';",
    });

    expect(detectSpy).toHaveBeenCalledWith("Query.FieldByName('Status').AsString := 'paid';", "repo.txt");
  });

  it("runs Delphi risk detection from file extension even when language is not delphi", async () => {
    const detectSpy = vi.spyOn(RiskDetector.prototype, "detectDelphiPatterns");
    const analyzer = new Analyzer();

    await analyzer.analyzeFile({
      path: "repo.pas",
      language: "txt",
      content: "Query.FieldByName('Status').AsString := 'paid';",
    });

    expect(detectSpy).toHaveBeenCalledWith("Query.FieldByName('Status').AsString := 'paid';", "repo.pas");
  });
});
