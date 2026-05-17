import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("vite", () => {
  throw new Error("static module must not import vite");
});

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("production static serving module", () => {
  it("can be imported without loading vite", async () => {
    const { serveStatic } = await import("./static");

    expect(serveStatic).toEqual(expect.any(Function));
  });

  it("keeps vite and vite config imports out of the production static module", () => {
    const source = fs.readFileSync(path.join(testDir, "static.ts"), "utf-8");

    expect(source).not.toContain("vite");
    expect(source).not.toContain("vite.config");
  });
});
