import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppVersion, getCommitHash, resetVersionCacheForTests } from "./version";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  resetVersionCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.chdir(ORIGINAL_CWD);
  resetVersionCacheForTests();
});

describe("version", () => {
  it("uses APP_VERSION when provided", () => {
    process.env.APP_VERSION = "2.3.4-build.5";
    process.env.npm_package_version = "1.0.0";

    expect(getAppVersion()).toBe("2.3.4-build.5");
  });

  it("falls back to npm_package_version", () => {
    delete process.env.APP_VERSION;
    process.env.npm_package_version = "1.0.1";

    expect(getAppVersion()).toBe("1.0.1");
  });

  it("reads package.json from process.cwd() in production-like environments", () => {
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-lens-version-"));
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");
    process.chdir(tempDir);

    expect(getAppVersion()).toBe("9.9.9");
  });

  it("returns unknown when no version source exists", () => {
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-lens-version-empty-"));
    process.chdir(tempDir);

    expect(getAppVersion()).toBe("unknown");
  });

  it("reports commit hash when injected and unknown otherwise", () => {
    delete process.env.GIT_COMMIT;
    expect(getCommitHash()).toBe("unknown");

    resetVersionCacheForTests();
    process.env.GIT_COMMIT = "abc123";
    expect(getCommitHash()).toBe("abc123");
  });
});
