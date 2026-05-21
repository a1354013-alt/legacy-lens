import fs from "node:fs";
import path from "node:path";

let cachedVersion: string | null = null;
let cachedCommitHash: string | null = null;

function readPackageVersionFromDisk(): string | null {
  try {
    const candidate = path.resolve(process.cwd(), "package.json");
    const raw = fs.readFileSync(candidate, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;

  const appVersion =
    typeof process.env.APP_VERSION === "string"
      ? process.env.APP_VERSION.trim()
      : "";
  const envVersion =
    typeof process.env.npm_package_version === "string"
      ? process.env.npm_package_version.trim()
      : "";

  cachedVersion =
    appVersion.length > 0
      ? appVersion
      : envVersion.length > 0
      ? envVersion
      : readPackageVersionFromDisk() ?? "unknown";

  return cachedVersion;
}

export function getCommitHash(): string {
  if (cachedCommitHash) return cachedCommitHash;

  const commitHash =
    typeof process.env.GIT_COMMIT === "string"
      ? process.env.GIT_COMMIT.trim()
      : "";

  cachedCommitHash = commitHash.length > 0 ? commitHash : "unknown";
  return cachedCommitHash;
}

export function resetVersionCacheForTests() {
  cachedVersion = null;
  cachedCommitHash = null;
}
