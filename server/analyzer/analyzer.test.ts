import { afterEach, describe, expect, it, vi } from "vitest";
import { Analyzer } from "./analyzer";
import { ParserFactory } from "./parser";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Analyzer", () => {
  it("marks clean supported analysis as completed when there are no skipped or degraded files", async () => {
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
});
