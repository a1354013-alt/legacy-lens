import { afterEach, describe, expect, it } from "vitest";
import { getAppVersion, getCommitHash, resetVersionCacheForTests } from "./version";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetVersionCacheForTests();
});

describe("version", () => {
  it("uses APP_VERSION when provided", () => {
    process.env.APP_VERSION = "2.3.4-build.5";
    process.env.npm_package_version = "1.0.0";

    expect(getAppVersion()).toBe("2.3.4-build.5");
  });

  it("falls back without crashing when APP_VERSION is absent", () => {
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;

    expect(getAppVersion()).toMatch(/^(\d+\.\d+\.\d+|unknown)$/);
  });

  it("reports commit hash when injected and unknown otherwise", () => {
    delete process.env.GIT_COMMIT;
    expect(getCommitHash()).toBe("unknown");

    resetVersionCacheForTests();
    process.env.GIT_COMMIT = "abc123";
    expect(getCommitHash()).toBe("abc123");
  });
});
