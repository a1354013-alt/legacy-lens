import { afterEach, describe, expect, it, vi } from "vitest";

describe("rate limiter production initialization", () => {
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    vi.doUnmock("express-rate-limit");
    vi.resetModules();
  });

  it("fails closed when express-rate-limit cannot initialize in production", async () => {
    process.env.NODE_ENV = "production";
    vi.doMock("express-rate-limit", () => {
      throw new Error("module load failed");
    });

    const { createRateLimiter } = await import("./rateLimiter");
    const middleware = createRateLimiter("api");

    await expect(
      middleware({ path: "/api/trpc", originalUrl: "/api/trpc", headers: {}, ip: "127.0.0.1" } as any, {} as any, vi.fn())
    ).rejects.toThrow(/Rate limiting failed to initialize in production:/);
  });
});
