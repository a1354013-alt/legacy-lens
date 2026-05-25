import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHealthEndpoint } from "./health";

vi.mock("../db", () => ({
  getDb: vi.fn(async () => ({
    execute: vi.fn(async () => [{ 1: 1 }]),
  })),
}));

vi.mock("./version", () => ({
  getAppVersion: vi.fn(() => "1.2.3"),
  getCommitHash: vi.fn(() => "abcdef0"),
}));

async function withHealthServer<T>(callback: (baseUrl: string) => Promise<T>) {
  const app = express();
  registerHealthEndpoint(app);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("health endpoints", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("/health stays a pure liveness check", async () => {
    await withHealthServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.status).toBe("alive");
      expect(body).not.toHaveProperty("checks");
    });
  });

  it("/ready returns success when required runtime checks are available", async () => {
    await withHealthServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ready`);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.status).toBe("ready");
      expect(body.checks).toMatchObject({
        database: "up",
        disk: "up",
        memory: "up",
      });
    });
  });

  it("/ready and /api/health fail when the database is unavailable", async () => {
    const { getDb } = await import("../db");
    vi.mocked(getDb).mockResolvedValueOnce(null);
    vi.mocked(getDb).mockResolvedValueOnce(null);

    await withHealthServer(async (baseUrl) => {
      const readinessResponse = await fetch(`${baseUrl}/ready`);
      const readinessBody = (await readinessResponse.json()) as Record<string, unknown>;
      expect(readinessResponse.status).toBe(503);
      expect(readinessBody.status).toBe("not_ready");

      const healthResponse = await fetch(`${baseUrl}/api/health`);
      const healthBody = (await healthResponse.json()) as Record<string, unknown>;
      expect(healthResponse.status).toBe(503);
      expect(healthBody.status).toBe("unhealthy");
    });
  });
});
