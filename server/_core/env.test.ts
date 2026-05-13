import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("dev auth bypass gating", () => {
  it("disables dev auth bypass in production by default", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_AUTH_BYPASS = "1";
    process.env.DEV_AUTH_BYPASS_UNSAFE_ALLOW = "";

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

  it("requires JWT_SECRET to be at least 32 characters after trimming", async () => {
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
});
