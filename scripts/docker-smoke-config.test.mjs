import { describe, expect, it } from "vitest";
import { parseStrictPositiveIntegerEnv } from "./docker-smoke-config.mjs";

describe("parseStrictPositiveIntegerEnv", () => {
  it("uses the default when the variable is undefined", () => {
    expect(
      parseStrictPositiveIntegerEnv("LEGACY_LENS_SMOKE_TIMEOUT_MS", 180000, {})
    ).toBe(180000);
  });

  it("accepts strict positive integers", () => {
    expect(
      parseStrictPositiveIntegerEnv("LEGACY_LENS_SMOKE_TIMEOUT_MS", 180000, {
        LEGACY_LENS_SMOKE_TIMEOUT_MS: "180000",
      })
    ).toBe(180000);
  });

  it.each(["0", "-1", "1.5", "30abc", ""])("rejects %s", value => {
    expect(() =>
      parseStrictPositiveIntegerEnv("LEGACY_LENS_SMOKE_TIMEOUT_MS", 180000, {
        LEGACY_LENS_SMOKE_TIMEOUT_MS: value,
      })
    ).toThrow("LEGACY_LENS_SMOKE_TIMEOUT_MS must be a positive integer.");
  });
});
