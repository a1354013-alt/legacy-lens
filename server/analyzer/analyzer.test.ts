import { describe, expect, it } from "vitest";
import { Analyzer } from "./analyzer";

describe("Analyzer", () => {
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
});
