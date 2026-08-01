import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "./index";

describe("createGracefulShutdown", () => {
  it("stops worker polling, closes HTTP before DB, and is idempotent", async () => {
    const events: string[] = [];
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const exitProcess = vi.fn((code: number) => {
      events.push(`exit:${code}`);
      throw new Error(`exit:${code}`);
    }) as unknown as (code: number) => never;

    const shutdown = createGracefulShutdown(server, {
      timeoutMs: 1_000,
      exitProcess,
      stopWorkerPolling: () => events.push("stop-worker"),
      waitForWorkerIdle: async () => {
        events.push(`http-closed:${server.listening ? "no" : "yes"}`);
        return true;
      },
      closeDatabase: async () => {
        events.push("close-db");
      },
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");

    await expect(first).rejects.toThrow("exit:0");
    await expect(second).rejects.toThrow("exit:0");
    expect(exitProcess).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["stop-worker", "http-closed:yes", "close-db", "exit:0"]);
  });

  it("uses a non-zero exit code when bounded cleanup times out", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const exitProcess = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown as (code: number) => never;

    const shutdown = createGracefulShutdown(server, {
      timeoutMs: 1,
      exitProcess,
      stopWorkerPolling: vi.fn(),
      waitForWorkerIdle: async () => true,
      closeDatabase: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    await expect(shutdown("SIGTERM")).rejects.toThrow("exit:1");
    expect(exitProcess).toHaveBeenCalledWith(1);
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  });
});
