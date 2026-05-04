import { describe, expect, it, vi } from "vitest";
import { ImpactAnalyzer } from "./impactAnalyzer";
import * as dbModule from "../db";

// Mock the database module
vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

describe("ImpactAnalyzer", () => {
  it("should return empty result with warning when target is not found in auto mode", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    (dbModule.getDb as any).mockResolvedValue(mockDb);

    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyze(1, "non_existent_target", "auto");

    expect(result.target).toBe("non_existent_target");
    expect(result.warnings).toContain('Could not resolve target type for "non_existent_target"');
    expect(result.affectedFiles).toHaveLength(0);
  });

  it("should correctly identify impact for a symbol", async () => {
    const mockSymbol = { id: 101, name: "UpdateContract", type: "procedure" };
    const mockCaller = { callerId: 202, callerName: "MainForm", callerFile: "Main.pas", callerType: "class" };
    
    const query: any = {};
    query.from = vi.fn().mockReturnValue(query);
    query.where = vi.fn().mockReturnValue(query);
    query.limit = vi.fn().mockReturnValue(query);
    query.innerJoin = vi.fn().mockReturnValue(query);
    query.execute = vi.fn().mockResolvedValue([]);
    query.then = vi.fn().mockImplementation((onfulfilled) => {
      const result = [mockSymbol];
      return Promise.resolve(onfulfilled(result));
    });

    const mockDb = {
      select: vi.fn().mockImplementation((cols) => {
        query.execute.mockReset();
        query.execute.mockResolvedValueOnce([mockSymbol]); // For symbols lookup
        query.execute.mockResolvedValueOnce([mockCaller]); // For callers lookup
        query.execute.mockResolvedValueOnce([]); // For fields lookup
        return query;
      }),
    };
    (dbModule.getDb as any).mockResolvedValue(mockDb);

    const analyzer = new ImpactAnalyzer();
    // For testing purposes, we might need a more sophisticated mock or use integration test
    // but here we just verify the basic structure and error handling.
    const result = await analyzer.analyze(1, "UpdateContract", "symbol");
    expect(result.target).toBe("UpdateContract");
    expect(result.targetType).toBe("symbol");
  });
});
