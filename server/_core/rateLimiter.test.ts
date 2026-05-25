import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicProcedure, protectedProcedure, router } from "./trpc";
import {
  buildProcedureRateLimitKey,
  configureTrustProxy,
  createRateLimiter,
  defaultConfigs,
  getProcedureRateLimitBucket,
  registerRateLimiters,
  resetProcedureRateLimiterStore,
} from "./rateLimiter";

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

  return (req: any, res: any, next: () => void) => {
    if (options.skip(req)) {
      next();
      return;
    }

    appliedRequests.push({ message: options.message.message, url: req.originalUrl ?? req.url ?? req.path ?? "" });
    count += 1;
    if (count <= options.max) {
      next();
      return;
    }

    res.status?.(429)?.json?.({
      error: options.message.error,
      message: options.message.message,
    });
  };
});

vi.mock("express-rate-limit", () => ({
  default: rateLimitFactory,
}));

describe("createRateLimiter", () => {
  afterEach(() => {
    resetProcedureRateLimiterStore();
  });

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

  it("uses separate limiter buckets for clone, analysis, and heavy read routes", async () => {
    const cloneLimiter = createRateLimiter("clone");
    const analysisLimiter = createRateLimiter("analysis");
    const heavyReadLimiter = createRateLimiter("heavyRead");

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await cloneLimiter({ path: "/api/trpc/projects.cloneGit", originalUrl: "/api/trpc/projects.cloneGit", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
      await analysisLimiter({ path: "/api/trpc/analysis.trigger", originalUrl: "/api/trpc/analysis.trigger", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
      await heavyReadLimiter({ path: "/api/trpc/analysis.getSnapshot", originalUrl: "/api/trpc/analysis.getSnapshot", headers: {}, ip: "198.51.100.10" } as any, {} as any, vi.fn());
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    const cloneOptions = rateLimitFactory.mock.calls.find((call) => call[0].message.message === defaultConfigs.clone.message)?.[0];
    const analysisOptions = rateLimitFactory.mock.calls.find((call) => call[0].message.message === defaultConfigs.analysis.message)?.[0];
    const heavyReadOptions = rateLimitFactory.mock.calls.find((call) => call[0].message.message === defaultConfigs.heavyRead.message)?.[0];

    expect(cloneOptions?.keyGenerator({ ip: "198.51.100.10" } as any)).toBe("clone:198.51.100.10");
    expect(analysisOptions?.keyGenerator({ ip: "198.51.100.10" } as any)).toBe("analysis:198.51.100.10");
    expect(heavyReadOptions?.keyGenerator({ ip: "198.51.100.10" } as any)).toBe("heavyRead:198.51.100.10");
  });

  it("skips the generic API limiter for dedicated upload/clone/analysis/heavy read endpoints using originalUrl", async () => {
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
    app.post("/api/trpc/analysis.getSnapshot", (_req, res) => res.status(200).json({ ok: true }));
    app.post("/api/trpc/system.health", (_req, res) => res.status(200).json({ ok: true }));

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await fetch(`http://127.0.0.1:${port}/api/trpc/projects.uploadFiles`, { method: "POST" });
      await fetch(`http://127.0.0.1:${port}/api/trpc/projects.cloneGit`, { method: "POST" });
      await fetch(`http://127.0.0.1:${port}/api/trpc/analysis.trigger`, { method: "POST" });
      await fetch(`http://127.0.0.1:${port}/api/trpc/analysis.getSnapshot`, { method: "POST" });
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
      appliedRequests.filter((entry) => entry.message === defaultConfigs.heavyRead.message).map((entry) => entry.url)
    ).toEqual(["/api/trpc/analysis.getSnapshot"]);
    expect(
      appliedRequests.filter((entry) => entry.message === defaultConfigs.api.message).map((entry) => entry.url)
    ).toEqual(["/api/trpc/system.health"]);
  });

  it("can enforce heavy read limits during tests when requested", async () => {
    const middleware = createRateLimiter("heavyRead", { skipInTest: false });
    const next = vi.fn();
    const json = vi.fn();
    const response = { status: vi.fn(() => ({ json })) } as any;

    for (let index = 0; index < defaultConfigs.heavyRead.max; index += 1) {
      await middleware({ path: "/api/trpc/analysis.getSnapshot", originalUrl: "/api/trpc/analysis.getSnapshot", headers: {}, ip: "198.51.100.10" } as any, response, next);
    }
    await middleware({ path: "/api/trpc/analysis.getSnapshot", originalUrl: "/api/trpc/analysis.getSnapshot", headers: {}, ip: "198.51.100.10" } as any, response, next);

    expect(next).toHaveBeenCalledTimes(defaultConfigs.heavyRead.max);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({
      error: "Too Many Requests",
      message: defaultConfigs.heavyRead.message,
    });
  });

  it("applies per-procedure buckets to batched tRPC requests so heavy reads cannot bypass limits", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    resetProcedureRateLimiterStore();

    const testRouter = router({
      projects: router({
        list: publicProcedure.query(() => ({ ok: true })),
      }),
      analysis: router({
        getSnapshot: publicProcedure.input(z.number()).query(() => ({ ok: true })),
      }),
    });

    const app = express();
    app.use(
      "/api/trpc",
      createExpressMiddleware({
        router: testRouter,
        createContext: ({ req, res }) => ({ req, res, user: null }),
      })
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = createTRPCProxyClient<typeof testRouter>({
      links: [
        httpBatchLink({
          url: `http://127.0.0.1:${port}/api/trpc`,
          transformer: superjson,
          fetch: (input, init) => fetch(input, init),
        }),
      ],
    });

    try {
      for (let index = 0; index < defaultConfigs.heavyRead.max; index += 1) {
        await Promise.all([client.projects.list.query(), client.analysis.getSnapshot.query(1)]);
      }

      await expect(Promise.all([client.projects.list.query(), client.analysis.getSnapshot.query(1)])).rejects.toBeInstanceOf(TRPCClientError);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("configureTrustProxy", () => {
  it("applies trust proxy through centralized app configuration", () => {
    const app = express();
    configureTrustProxy(app, { LEGACY_LENS_TRUST_PROXY: "loopback, linklocal, uniquelocal" });
    expect(app.get("trust proxy")).toEqual(["loopback", "linklocal", "uniquelocal"]);
  });

  it("derives stable per-procedure bucket keys for upload, clone, analysis, heavy read, and general routes", () => {
    expect(getProcedureRateLimitBucket("projects.uploadFiles")).toBe("upload");
    expect(getProcedureRateLimitBucket("projects.cloneGit")).toBe("clone");
    expect(getProcedureRateLimitBucket("analysis.trigger")).toBe("analysis");
    expect(getProcedureRateLimitBucket("analysis.getSnapshot")).toBe("heavyRead");
    expect(getProcedureRateLimitBucket("projects.list")).toBe("api");
    expect(
      buildProcedureRateLimitKey({
        path: "analysis.getSnapshot",
        userId: 7,
        sessionId: "session-1",
        ip: "198.51.100.10",
      })
    ).toBe("heavyRead:user:7:analysis.getSnapshot");
  });

  it("applies rate limiting to protectedProcedure heavy reads", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    resetProcedureRateLimiterStore();

    const testRouter = router({
      analysis: router({
        getSnapshot: protectedProcedure.input(z.number()).query(() => ({ ok: true })),
      }),
    });

    const app = express();
    app.use(
      "/api/trpc",
      createExpressMiddleware({
        router: testRouter,
        createContext: ({ req, res }) => ({
          req,
          res,
          user: {
            id: 1,
            openId: "rate-limit-user",
            name: "Rate Limit User",
            email: "rate-limit@example.com",
            loginMethod: "test",
            role: "user",
            createdAt: new Date(0),
            updatedAt: new Date(0),
            lastSignedIn: new Date(0),
          },
        }),
      })
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = createTRPCProxyClient<typeof testRouter>({
      links: [
        httpBatchLink({
          url: `http://127.0.0.1:${port}/api/trpc`,
          transformer: superjson,
          fetch: (input, init) => fetch(input, init),
        }),
      ],
    });

    try {
      for (let index = 0; index < defaultConfigs.heavyRead.max; index += 1) {
        await client.analysis.getSnapshot.query(1);
      }

      await expect(client.analysis.getSnapshot.query(1)).rejects.toBeInstanceOf(TRPCClientError);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
