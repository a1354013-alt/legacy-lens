import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("worker build artifacts", () => {
  it("keeps the production build and image copy steps for the worker thread bundle", async () => {
    const [packageJson, dockerfile] = await Promise.all([
      readFile(resolve(repoRoot, "package.json"), "utf8"),
      readFile(resolve(repoRoot, "Dockerfile"), "utf8"),
    ]);

    expect(packageJson).toContain("server/services/jobWorkerThread.ts");
    expect(packageJson).toContain("--outdir=dist/services");
    expect(dockerfile).toContain("COPY --from=builder /app/dist ./dist");
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
  });
});
