import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rateLimiter";

const rateLimitFactory = vi.fn((options: { max: number }) => {
  let count = 0;

  return (_req: unknown, _res: unknown, next: () => void) => {
    count += 1;
    if (count <= options.max) {
      next();
    }
  };
});

vi.mock("express-rate-limit", () => ({
  default: rateLimitFactory,
}));

describe("createRateLimiter", () => {
  it("creates the underlying limiter only once per middleware instance", async () => {
    const middleware = createRateLimiter("api");
    const next = vi.fn();

    await middleware({ path: "/api/trpc", headers: {}, ip: "127.0.0.1" } as any, {} as any, next);
    await middleware({ path: "/api/trpc", headers: {}, ip: "127.0.0.1" } as any, {} as any, next);

    expect(rateLimitFactory).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
