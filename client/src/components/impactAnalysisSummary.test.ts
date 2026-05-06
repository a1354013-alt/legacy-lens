import { describe, expect, it } from "vitest";
import { getAffectedComponentCount } from "./impactAnalysisSummary";

describe("getAffectedComponentCount", () => {
  it("uses the backend affectedCount when it is available", () => {
    expect(
      getAffectedComponentCount({
        affectedCount: 9,
        affectedFiles: ["a.go"],
        affectedSymbols: [],
        affectedTables: [],
        affectedFields: [],
        affectedRules: [],
        affectedRisks: [],
      })
    ).toBe(9);
  });

  it("falls back to a full local count including rules and risks", () => {
    expect(
      getAffectedComponentCount({
        affectedFiles: ["a.go"],
        affectedSymbols: [{ name: "run", file: "a.go", type: "function" }],
        affectedTables: ["orders"],
        affectedFields: [{ table: "orders", field: "amount" }],
        affectedRules: ["SharedRule"],
        affectedRisks: ["Shared risk"],
      })
    ).toBe(6);
  });

  it("treats missing arrays as empty", () => {
    expect(getAffectedComponentCount({})).toBe(0);
  });
});
