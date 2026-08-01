import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("dev auth bypass gating", () => {
  it("strictly parses positive integer env values", async () => {
    const { parsePositiveIntEnv, parseNonNegativeIntEnv } = await import("./env");

    expect(parsePositiveIntEnv("MISSING_TIMEOUT", 123, {})).toBe(123);
    expect(parsePositiveIntEnv("GOOD_TIMEOUT", 123, { GOOD_TIMEOUT: "456" })).toBe(456);
    expect(parsePositiveIntEnv("TRIMMED_TIMEOUT", 123, { TRIMMED_TIMEOUT: " 456 " })).toBe(456);
    expect(parseNonNegativeIntEnv("ZERO_QUEUE_LIMIT", 10, { ZERO_QUEUE_LIMIT: "0" })).toBe(0);
  });

  it.each([
    ["BLANK_TIMEOUT", ""],
    ["BAD_TIMEOUT", "abc"],
    ["MIXED_TIMEOUT", "30abc"],
    ["DECIMAL_TIMEOUT", "1.5"],
    ["NEGATIVE_TIMEOUT", "-1"],
    ["ZERO_TIMEOUT", "0"],
  ])("rejects invalid positive integer env %s=%s", async (name, value) => {
    const { parsePositiveIntEnv } = await import("./env");

    expect(() => parsePositiveIntEnv(name, 123, { [name]: value })).toThrow(`[Config] ${name} must be a positive integer.`);
  });

  it("rejects invalid production env instead of falling back", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(() =>
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
        NODE_ENV: "production",
        PROJECT_JOB_LEASE_MS: "30abc",
      })
    ).toThrow("Must be a positive integer.");
  });

  it("rejects heartbeat intervals that are not lower than the lease", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(() =>
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
        PROJECT_JOB_LEASE_MS: "30000",
        PROJECT_JOB_HEARTBEAT_MS: "30000",
      })
    ).toThrow("PROJECT_JOB_HEARTBEAT_MS must be lower than PROJECT_JOB_LEASE_MS.");
  });

  it("rejects heartbeat intervals greater than one third of the lease", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(() =>
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
        PROJECT_JOB_LEASE_MS: "30000",
        PROJECT_JOB_HEARTBEAT_MS: "10001",
      })
    ).toThrow("PROJECT_JOB_HEARTBEAT_MS must be no more than one third of PROJECT_JOB_LEASE_MS.");
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

  it("rejects a non-positive PROJECT_WORKER_POLL_INTERVAL_MS", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(() =>
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
        PROJECT_WORKER_POLL_INTERVAL_MS: "0",
      })
    ).toThrow("Must be a positive integer.");
  });

  it("accepts a positive PROJECT_WORKER_POLL_INTERVAL_MS", async () => {
    const { validateRuntimeConfig } = await import("./env");

    expect(
      validateRuntimeConfig({
        VITE_APP_ID: "app",
        VITE_OAUTH_PORTAL_URL: "http://localhost:3001",
        JWT_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "mysql://root:password@localhost:3306/legacy_lens",
        OAUTH_SERVER_URL: "http://localhost:3001",
        PROJECT_WORKER_POLL_INTERVAL_MS: "2000",
      }).PROJECT_WORKER_POLL_INTERVAL_MS
    ).toBe("2000");
  });

  it("allows an explicit localhost HTTP origin for production demo mode", async () => {
    const { parseCanonicalPublicOrigin } = await import("./env");

    expect(
      parseCanonicalPublicOrigin({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "http://localhost:3000",
        DEV_AUTH_BYPASS_UNSAFE_ALLOW: "1",
      })
    ).toBe("http://localhost:3000");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])(
    "allows loopback HTTP origins only when the unsafe demo gate is enabled: %s",
    async origin => {
      const { parseCanonicalPublicOrigin } = await import("./env");

      expect(
        parseCanonicalPublicOrigin({
          NODE_ENV: "production",
          PUBLIC_ORIGIN: origin,
          DEV_AUTH_BYPASS_UNSAFE_ALLOW: "1",
        })
      ).toBe(origin);
    }
  );

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])(
    "rejects loopback HTTP origins in production without the unsafe demo gate: %s",
    async origin => {
      const { parseCanonicalPublicOrigin } = await import("./env");

      expect(() =>
        parseCanonicalPublicOrigin({
          NODE_ENV: "production",
          PUBLIC_ORIGIN: origin,
        })
      ).toThrow(
        "PUBLIC_ORIGIN must use https in production unless DEV_AUTH_BYPASS_UNSAFE_ALLOW explicitly permits a loopback demo origin."
      );
    }
  );

  it.each([
    "http://example.com",
    "http://192.168.1.25:3000",
    "http://10.0.0.10:3000",
  ])(
    "rejects non-loopback HTTP origins even with the unsafe demo gate: %s",
    async origin => {
      const { parseCanonicalPublicOrigin } = await import("./env");

      expect(() =>
        parseCanonicalPublicOrigin({
          NODE_ENV: "production",
          PUBLIC_ORIGIN: origin,
          DEV_AUTH_BYPASS_UNSAFE_ALLOW: "1",
        })
      ).toThrow(
        "PUBLIC_ORIGIN must use https in production unless DEV_AUTH_BYPASS_UNSAFE_ALLOW explicitly permits a loopback demo origin."
      );
    }
  );

  it.each([
    "https://user:pass@legacy.example.com",
    "https://legacy.example.com/path",
    "https://legacy.example.com?debug=1",
    "https://legacy.example.com#frag",
  ])("rejects non-canonical PUBLIC_ORIGIN values: %s", async origin => {
    const { parseCanonicalPublicOrigin } = await import("./env");

    expect(() =>
      parseCanonicalPublicOrigin({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: origin,
      })
    ).toThrow();
  });
});
