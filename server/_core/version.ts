import fs from "node:fs";
import path from "node:path";

let cachedVersion: string | null = null;

function readPackageVersionFromDisk(): string | null {
  try {
    const candidate = path.resolve(import.meta.dirname, "..", "..", "package.json");
    const raw = fs.readFileSync(candidate, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;

  const envVersion =
    typeof process.env.npm_package_version === "string"
      ? process.env.npm_package_version.trim()
      : "";

  cachedVersion =
    envVersion.length > 0
      ? envVersion
      : readPackageVersionFromDisk() ?? "0.0.0";

  return cachedVersion;
}

