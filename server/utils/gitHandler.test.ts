import { describe, expect, it } from "vitest";
import { assertSafeGitUrl, isSafeRelativePath, normalizeRepoPath } from "./gitHandler";

describe("gitHandler", () => {
  it("normalizes and rejects unsafe import paths (stable safety contract)", () => {
    expect(isSafeRelativePath(normalizeRepoPath("safe/main.go"))).toBe(true);
    expect(isSafeRelativePath(normalizeRepoPath("../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizeRepoPath("safe/../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizeRepoPath("C:/windows/evil.go"))).toBe(false);
  });

  it("allows github.com and gitlab.com in production by default", () => {
    expect(() =>
      assertSafeGitUrl("https://github.com/org/repo.git", { NODE_ENV: "production" })
    ).not.toThrow();
    expect(() =>
      assertSafeGitUrl("git@github.com:org/repo.git", { NODE_ENV: "production" })
    ).not.toThrow();
    expect(() =>
      assertSafeGitUrl("https://gitlab.com/org/repo.git", { NODE_ENV: "production" })
    ).not.toThrow();
    expect(() =>
      assertSafeGitUrl("git@gitlab.com:org/repo.git", { NODE_ENV: "production" })
    ).not.toThrow();
  });

  it("rejects loopback and private hosts", () => {
    expect(() =>
      assertSafeGitUrl("https://localhost/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/localhost/);
    expect(() =>
      assertSafeGitUrl("https://127.0.0.1/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/127\.0\.0\.1/);
    expect(() =>
      assertSafeGitUrl("https://0.0.0.0/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/0\.0\.0\.0/);
    expect(() =>
      assertSafeGitUrl("https://[::1]/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/::1/);
    expect(() =>
      assertSafeGitUrl("https://10.0.0.8/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/10\.0\.0\.8/);
    expect(() =>
      assertSafeGitUrl("https://172.16.0.8/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/172\.16\.0\.8/);
    expect(() =>
      assertSafeGitUrl("https://172.31.255.9/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/172\.31\.255\.9/);
    expect(() =>
      assertSafeGitUrl("https://192.168.1.10/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/192\.168\.1\.10/);
    expect(() =>
      assertSafeGitUrl("https://169.254.10.1/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/169\.254\.10\.1/);
  });

  it("rejects unknown public hosts in production unless they are allowlisted", () => {
    expect(() =>
      assertSafeGitUrl("https://example.com/org/repo.git", { NODE_ENV: "production" })
    ).toThrow(/LEGACY_LENS_GIT_HOST_ALLOWLIST/);

    expect(() =>
      assertSafeGitUrl("https://example.com/org/repo.git", {
        NODE_ENV: "production",
        LEGACY_LENS_GIT_HOST_ALLOWLIST: "example.com,github.com",
      })
    ).not.toThrow();
  });
});
