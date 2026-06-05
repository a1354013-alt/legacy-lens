import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("dev auth bypass gating", () => {
  it("parses positive integer env values with fallback protection", async () => {
    const { parsePositiveIntEnv } = await import("./env");

    expect(parsePositiveIntEnv("MISSING_TIMEOUT", 123, {})).toBe(123);
    expect(parsePositiveIntEnv("BLANK_TIMEOUT", 123, { BLANK_TIMEOUT: "" })).toBe(123);
    expect(parsePositiveIntEnv("BAD_TIMEOUT", 123, { BAD_TIMEOUT: "abc" })).toBe(123);
    expect(parsePositiveIntEnv("NEGATIVE_TIMEOUT", 123, { NEGATIVE_TIMEOUT: "-1" })).toBe(123);
    expect(parsePositiveIntEnv("ZERO_TIMEOUT", 123, { ZERO_TIMEOUT: "0" })).toBe(123);
    expect(parsePositiveIntEnv("GOOD_TIMEOUT", 123, { GOOD_TIMEOUT: "456" })).toBe(456);
  });

  it("disables dev auth bypass in production by default", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_AUTH_BYPASS = "1";
    process.env.DEV_AUTH_BYPASS_UNSAFE_ALLOW = "";

    const { isDevAuthBypassEnabled } = await import("./env");
    expect(isDevAuthBypassEnabled()).toBe(false);
  });

  it("keeps production auth disabled even when a demo open id is present", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_AUTH_BYPASS = "1";
    process.env.DEV_AUTH_OPEN_ID = "local-dev-user";
    delete process.env.DEV_AUTH_BYPASS_UNSAFE_ALLOW;

    const { isDevAuthBypassEnabled } = await import("./env");
    expect(isDevAuthBypassEnabled()).toBe(false);
  });

  it("allows dev auth bypass in production only with the explicit unsafe gate", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_AUTH_BYPASS = "1";
    process.env.DEV_AUTH_BYPASS_UNSAFE_ALLOW = "1";

    const { isDevAuthBypassEnabled } = await import("./env");
    expect(isDevAuthBypassEnabled()).toBe(true);
  });

  it("rejects an empty JWT_SECRET", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(() =>
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "   ",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
      })
    ).toThrow("JWT_SECRET must be at least 32 characters.");
  });

  it("rejects a JWT_SECRET shorter than 32 characters after trimming", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(() =>
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: " too-short-secret ",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
      })
    ).toThrow("JWT_SECRET must be at least 32 characters.");
  });

  it("accepts a JWT_SECRET with 32 or more characters", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
      }).JWT_SECRET
    ).toBe("12345678901234567890123456789012");
  });
});
