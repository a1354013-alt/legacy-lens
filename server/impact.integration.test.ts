import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import * as dbModule from "./db";

vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

describe("Impact Analysis Integration", () => {
  it("should return impact results through TRPC", async () => {
    const mockSymbol = { id: 1, name: "EB_SPECI", type: "table" };
    const query: any = {};
    query.from = vi.fn().mockReturnValue(query);
    query.where = vi.fn().mockReturnValue(query);
    query.limit = vi.fn().mockReturnValue(query);
    query.innerJoin = vi.fn().mockReturnValue(query);
    query.execute = vi.fn().mockResolvedValue([mockSymbol]);
    query.then = vi.fn().mockImplementation((onfulfilled) => Promise.resolve(onfulfilled([mockSymbol])));

    const mockDb = {
      select: vi.fn().mockReturnValue(query),
    };
    (dbModule.getDb as any).mockResolvedValue(mockDb);

    const caller = appRouter.createCaller({
      user: { id: 1, role: "user", openId: "test", name: "Test", email: "test@example.com", loginMethod: "test", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: {} as any,
      res: {} as any,
    });

    // Mocking getOwnedProject to pass
    vi.mock("./services/projectWorkflow", async () => {
      const actual = await vi.importActual("./services/projectWorkflow") as any;
      return {
        ...actual,
        getOwnedProject: vi.fn().mockResolvedValue({ id: 1, userId: 1 }),
      };
    });

    const result = await caller.analysis.getImpact({
      projectId: 1,
      target: "EB_SPECI",
      type: "auto",
    });

    expect(result.target).toBe("EB_SPECI");
    expect(result.summary).toBeDefined();
  });
});
