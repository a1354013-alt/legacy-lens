import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vite", () => {
  throw new Error("static module must not import vite");
});

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("production static serving module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("can be imported without loading vite", async () => {
    const { serveStatic } = await import("./static");

    expect(serveStatic).toEqual(expect.any(Function));
  });

  it("keeps vite and vite config imports out of the production static module", () => {
    const source = fs.readFileSync(path.join(testDir, "static.ts"), "utf-8");

    expect(source).not.toContain("vite");
    expect(source).not.toContain("vite.config");
  });

  it("fails fast in production when the built client files are missing", async () => {
    const { serveStatic } = await import("./static");
    const app = { use: vi.fn() } as unknown as { use: ReturnType<typeof vi.fn> };
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    try {
      expect(() => serveStatic(app as never)).toThrow(/Missing production static build output/);
      expect(app.use).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("fails fast in production when index.html is missing even if the directory exists", async () => {
    const { serveStatic } = await import("./static");
    const app = { use: vi.fn() } as unknown as { use: ReturnType<typeof vi.fn> };
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.spyOn(fs, "existsSync")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    try {
      expect(() => serveStatic(app as never)).toThrow(/Missing production static build output/);
      expect(app.use).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("does not fail fast outside production even if build artifacts are absent", async () => {
    const { serveStatic } = await import("./static");
    const app = { use: vi.fn() } as unknown as { use: ReturnType<typeof vi.fn> };
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    try {
      expect(() => serveStatic(app as never)).not.toThrow();
      expect(app.use).toHaveBeenCalledTimes(2);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
