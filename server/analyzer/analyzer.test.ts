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
});
