import express from "express";
import { describe, expect, it, vi } from "vitest";
import { configureTrustProxy, createRateLimiter } from "./rateLimiter";

type RateLimitFactoryOptions = {
  max: number;
  keyGenerator: (request: unknown) => string;
};

const rateLimitFactory = vi.fn((options: RateLimitFactoryOptions) => {
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

  it("uses req.ip instead of trusting spoofed x-forwarded-for headers", async () => {
    const middleware = createRateLimiter("api");
    await middleware({ path: "/api/trpc", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
    const options = rateLimitFactory.mock.calls.at(-1)?.[0];

    expect(options).toBeDefined();

    expect(
      options!.keyGenerator({
        ip: "198.51.100.10",
        headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      } as any)
    ).toBe("198.51.100.10");
  });
});

describe("configureTrustProxy", () => {
  it("applies trust proxy through centralized app configuration", () => {
    const app = express();
    configureTrustProxy(app, { LEGACY_LENS_TRUST_PROXY: "loopback, linklocal, uniquelocal" });
    expect(app.get("trust proxy")).toEqual(["loopback", "linklocal", "uniquelocal"]);
  });
});
