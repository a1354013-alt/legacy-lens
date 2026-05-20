import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SINGLE_FILE_BYTES } from "../../shared/const";

const tempDirs: string[] = [];

describe("gitHandler", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("normalizes and rejects unsafe import paths (stable safety contract)", async () => {
    const { isSafeRelativePath, normalizeRepoPath } = await import("./gitHandler");
    expect(isSafeRelativePath(normalizeRepoPath("safe/main.go"))).toBe(true);
    expect(isSafeRelativePath(normalizeRepoPath("../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizeRepoPath("safe/../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizeRepoPath("C:/windows/evil.go"))).toBe(false);
  });

  it("allows github.com and gitlab.com in production by default after safe DNS resolution", async () => {
    const { assertSafeGitUrl } = await import("./gitHandler");
    const resolvePublicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

    await expect(
      assertSafeGitUrl("https://github.com/org/repo.git", { NODE_ENV: "production" }, resolvePublicDns)
    ).resolves.toBeUndefined();
    await expect(
      assertSafeGitUrl("git@github.com:org/repo.git", { NODE_ENV: "production" }, resolvePublicDns)
    ).resolves.toBeUndefined();
    await expect(
      assertSafeGitUrl("https://gitlab.com/org/repo.git", { NODE_ENV: "production" }, resolvePublicDns)
    ).resolves.toBeUndefined();
  });

  it("rejects localhost, loopback, private, and metadata targets before clone", async () => {
    const { assertSafeGitUrl } = await import("./gitHandler");
    await expect(assertSafeGitUrl("https://localhost/org/repo.git", { NODE_ENV: "development" })).rejects.toThrow(/localhost/);
    await expect(assertSafeGitUrl("https://127.0.0.1/org/repo.git", { NODE_ENV: "development" })).rejects.toThrow(/127\.0\.0\.1/);
    await expect(assertSafeGitUrl("https://10.0.0.8/org/repo.git", { NODE_ENV: "development" })).rejects.toThrow(/unsafe address "10\.0\.0\.8"/);
    await expect(assertSafeGitUrl("https://169.254.169.254/org/repo.git", { NODE_ENV: "development" })).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("rejects DNS results that resolve a public hostname to a private address", async () => {
    const { assertSafeGitUrl } = await import("./gitHandler");
    await expect(
      assertSafeGitUrl(
        "https://example.com/org/repo.git",
        { NODE_ENV: "development" },
        async () => [{ address: "192.168.1.10", family: 4 }]
      )
    ).rejects.toThrow(/example\.com.*192\.168\.1\.10/);
  });

  it("rejects the import when DNS resolution fails", async () => {
    const { assertSafeGitUrl } = await import("./gitHandler");
    await expect(
      assertSafeGitUrl("https://example.com/org/repo.git", { NODE_ENV: "development" }, async () => {
        throw new Error("lookup failed");
      })
    ).rejects.toThrow(/failed to resolve host "example\.com"/);
  });

  it("rejects unknown public hosts in production unless they are allowlisted", async () => {
    const { assertSafeGitUrl } = await import("./gitHandler");
    const resolvePublicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

    await expect(
      assertSafeGitUrl("https://example.com/org/repo.git", { NODE_ENV: "production" }, resolvePublicDns)
    ).rejects.toThrow(/LEGACY_LENS_GIT_HOST_ALLOWLIST/);

    await expect(
      assertSafeGitUrl(
        "https://example.com/org/repo.git",
        {
          NODE_ENV: "production",
          LEGACY_LENS_GIT_HOST_ALLOWLIST: "example.com,github.com",
        },
        resolvePublicDns
      )
    ).resolves.toBeUndefined();
  });

  it("returns validated metadata that can be reused by the clone step", async () => {
    const { validateSafeGitUrl } = await import("./gitHandler");
    const resolvePublicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

    await expect(
      validateSafeGitUrl("https://github.com/org/repo.git", { NODE_ENV: "production" }, resolvePublicDns)
    ).resolves.toMatchObject({
      gitUrl: "https://github.com/org/repo.git",
      host: "github.com",
      resolvedAddresses: [{ address: "93.184.216.34", family: 4 }],
      production: true,
      allowlist: ["github.com", "gitlab.com"],
    });
  });

  it("skips oversize repository files before readFile and keeps smaller files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "legacy-lens-git-handler-"));
    tempDirs.push(tempDir);
    const hugeFile = path.join(tempDir, "huge.go");
    const smallFile = path.join(tempDir, "main.go");

    await writeFile(hugeFile, "");
    await truncate(hugeFile, MAX_SINGLE_FILE_BYTES + 1);
    await writeFile(smallFile, "package main\nfunc main() {}\n");

    const { scanDirectoryForCodeFiles } = await import("./gitHandler");
    const actualFs = await import("node:fs/promises");
    const readFileCalls: string[] = [];
    const io = {
      readdir: actualFs.readdir,
      realpath: actualFs.realpath,
      stat: actualFs.stat,
      readFile: async (targetPath: Parameters<typeof actualFs.readFile>[0]) => {
        readFileCalls.push(String(targetPath));
        return actualFs.readFile(targetPath);
      },
    };
    const result = await scanDirectoryForCodeFiles(tempDir, tempDir, undefined, undefined, tempDir, new Map(), io);

    expect(result.files.map((file) => file.path)).toEqual(["main.go"]);
    expect(result.warnings).toContainEqual({
      code: "IMPORT_FILE_TOO_LARGE",
      message: "The file was skipped because it exceeds the maximum supported size (5MB).",
      filePath: "huge.go",
    });
    expect(readFileCalls).toEqual([smallFile]);
  });
});
