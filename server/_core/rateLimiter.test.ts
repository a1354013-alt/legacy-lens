import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { configureTrustProxy, createRateLimiter, defaultConfigs, registerRateLimiters } from "./rateLimiter";

type RateLimitFactoryOptions = {
  max: number;
  keyGenerator: (request: unknown) => string;
  skip: (request: unknown) => boolean;
  message: {
    error: string;
    message: string | undefined;
  };
};

const appliedRequests: Array<{ message: string | undefined; url: string }> = [];
const rateLimitFactory = vi.fn((options: RateLimitFactoryOptions) => {
  let count = 0;

  return (req: any, _res: unknown, next: () => void) => {
    if (options.skip(req)) {
      next();
      return;
    }

    appliedRequests.push({ message: options.message.message, url: req.originalUrl ?? req.url ?? req.path ?? "" });
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

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await middleware({ path: "/api/trpc", originalUrl: "/api/trpc", headers: {}, ip: "127.0.0.1" } as any, {} as any, next);
      await middleware({ path: "/api/trpc", originalUrl: "/api/trpc", headers: {}, ip: "127.0.0.1" } as any, {} as any, next);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    expect(rateLimitFactory).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("uses req.ip instead of trusting spoofed x-forwarded-for headers", async () => {
    const middleware = createRateLimiter("api");
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await middleware({ path: "/api/trpc", originalUrl: "/api/trpc", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    const options = rateLimitFactory.mock.calls.at(-1)?.[0];

    expect(options).toBeDefined();

    expect(
      options!.keyGenerator({
        ip: "198.51.100.10",
        headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      } as any)
    ).toBe("api:198.51.100.10");
  });

  it("uses separate limiter buckets for clone and analysis routes", async () => {
    const cloneLimiter = createRateLimiter("clone");
    const analysisLimiter = createRateLimiter("analysis");

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await cloneLimiter({ path: "/api/trpc/projects.cloneGit", originalUrl: "/api/trpc/projects.cloneGit", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
      await analysisLimiter({ path: "/api/trpc/analysis.trigger", originalUrl: "/api/trpc/analysis.trigger", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    const cloneOptions = rateLimitFactory.mock.calls.find((call) => call[0].message.message === defaultConfigs.clone.message)?.[0];
    const analysisOptions = rateLimitFactory.mock.calls.find((call) => call[0].message.message === defaultConfigs.analysis.message)?.[0];

    expect(cloneOptions?.keyGenerator({ ip: "198.51.100.10" } as any)).toBe("clone:198.51.100.10");
    expect(analysisOptions?.keyGenerator({ ip: "198.51.100.10" } as any)).toBe("analysis:198.51.100.10");
  });

  it("skips the generic API limiter for dedicated upload/clone/analysis endpoints using originalUrl", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    appliedRequests.length = 0;
    rateLimitFactory.mockClear();

    const app = express();
    registerRateLimiters(app);
    app.use(express.json());
    app.post("/api/trpc/projects.uploadFiles", (_req, res) => res.status(200).json({ ok: true }));
    app.post("/api/trpc/projects.cloneGit", (_req, res) => res.status(200).json({ ok: true }));
    app.post("/api/trpc/analysis.trigger", (_req, res) => res.status(200).json({ ok: true }));
    app.post("/api/trpc/system.health", (_req, res) => res.status(200).json({ ok: true }));

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await fetch(`http://127.0.0.1:${port}/api/trpc/projects.uploadFiles`, { method: "POST" });
      await fetch(`http://127.0.0.1:${port}/api/trpc/projects.cloneGit`, { method: "POST" });
      await fetch(`http://127.0.0.1:${port}/api/trpc/analysis.trigger`, { method: "POST" });
      await fetch(`http://127.0.0.1:${port}/api/trpc/system.health`, { method: "POST" });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }

    expect(
      appliedRequests.filter((entry) => entry.message === defaultConfigs.upload.message).map((entry) => entry.url)
    ).toEqual(["/api/trpc/projects.uploadFiles"]);
    expect(
      appliedRequests.filter((entry) => entry.message === defaultConfigs.clone.message).map((entry) => entry.url)
    ).toEqual(["/api/trpc/projects.cloneGit"]);
    expect(
      appliedRequests.filter((entry) => entry.message === defaultConfigs.analysis.message).map((entry) => entry.url)
    ).toEqual(["/api/trpc/analysis.trigger"]);
    expect(
      appliedRequests.filter((entry) => entry.message === defaultConfigs.api.message).map((entry) => entry.url)
    ).toEqual(["/api/trpc/system.health"]);
  });
});

describe("configureTrustProxy", () => {
  it("applies trust proxy through centralized app configuration", () => {
    const app = express();
    configureTrustProxy(app, { LEGACY_LENS_TRUST_PROXY: "loopback, linklocal, uniquelocal" });
    expect(app.get("trust proxy")).toEqual(["loopback", "linklocal", "uniquelocal"]);
  });
});
