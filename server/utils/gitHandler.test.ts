import { describe, expect, it } from "vitest";
import { isSafeRelativePath, normalizeRepoPath } from "./gitHandler";

describe("gitHandler", () => {
  it("normalizes and rejects unsafe import paths (stable safety contract)", () => {
    expect(isSafeRelativePath(normalizeRepoPath("safe/main.go"))).toBe(true);
    expect(isSafeRelativePath(normalizeRepoPath("../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizeRepoPath("safe/../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizeRepoPath("C:/windows/evil.go"))).toBe(false);
  });
});

