import { describe, expect, it } from "vitest";
import { buildContainsLikePattern, escapeLikePattern } from "./sqlLike";

describe("sqlLike helpers", () => {
  it("keeps ordinary keywords unchanged apart from wrapping for contains search", () => {
    expect(buildContainsLikePattern("legacy")).toBe("%legacy%");
  });

  it("escapes percent characters so they do not become wildcards", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(buildContainsLikePattern("100%")).toBe("%100\\%%");
  });

  it("escapes underscores so they do not match arbitrary single characters", () => {
    expect(escapeLikePattern("_")).toBe("\\_");
    expect(buildContainsLikePattern("user_name")).toBe("%user\\_name%");
  });

  it("escapes backslashes before passing the pattern to SQL", () => {
    expect(escapeLikePattern(String.raw`C:\legacy`)).toBe(String.raw`C:\\legacy`);
    expect(buildContainsLikePattern(String.raw`src\legacy_%`)).toBe(String.raw`%src\\legacy\_\%%`);
  });
});
