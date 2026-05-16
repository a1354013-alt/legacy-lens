import { lookup } from "node:dns/promises";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { FocusLanguage, ImportWarning } from "../../shared/contracts";
import { simpleGit } from "simple-git";
import { AppError } from "../appError";
import { SUPPORTED_SOURCE_EXTENSIONS, UNSUPPORTED_CODE_EXTENSIONS, decodeTextContent } from "./zipHandler";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".idea",
  ".vscode",
]);

const LIMITED_ANALYSIS_EXTENSIONS = new Set([".dfm", ".inc", ".dpk", ".fmx"]);

const MAX_FILES_IN_REPO = 2_000;
const MAX_TOTAL_EXTRACTED_SIZE = 500 * 1024 * 1024;
const MAX_SINGLE_FILE_SIZE = 5 * 1024 * 1024;
const GIT_CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_PRODUCTION_GIT_HOST_ALLOWLIST = ["github.com", "gitlab.com"] as const;
const unsafeAddressBlockList = new net.BlockList();

unsafeAddressBlockList.addAddress("0.0.0.0");
unsafeAddressBlockList.addAddress("169.254.169.254");
unsafeAddressBlockList.addAddress("::", "ipv6");
unsafeAddressBlockList.addAddress("::1", "ipv6");
unsafeAddressBlockList.addSubnet("10.0.0.0", 8);
unsafeAddressBlockList.addSubnet("100.64.0.0", 10);
unsafeAddressBlockList.addSubnet("127.0.0.0", 8);
unsafeAddressBlockList.addSubnet("169.254.0.0", 16);
unsafeAddressBlockList.addSubnet("172.16.0.0", 12);
unsafeAddressBlockList.addSubnet("192.168.0.0", 16);
unsafeAddressBlockList.addSubnet("fc00::", 7, "ipv6");
unsafeAddressBlockList.addSubnet("fe80::", 10, "ipv6");

type ResolvedAddress = { address: string; family: 4 | 6 };
type ResolveDns = (hostname: string) => Promise<ResolvedAddress[]>;
export interface ValidatedGitUrl {
  gitUrl: string;
  host: string;
  resolvedAddresses: ResolvedAddress[];
  allowlist: string[] | null;
  production: boolean;
}

// Exported for tests (import safety must remain stable).
export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

// Exported for tests (import safety must remain stable).
export function isSafeRelativePath(normalizedPath: string): boolean {
  if (!normalizedPath) return false;
  if (normalizedPath.includes("\0")) return false;

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  if (/^[a-zA-Z]:$/.test(segments[0] ?? "")) return false;

  return true;
}

function detectLanguage(extension: string): FocusLanguage | null {
  const languageMap: Record<string, FocusLanguage> = {
    ".go": "go",
    ".sql": "sql",
    ".pas": "delphi",
    ".dpr": "delphi",
    ".delphi": "delphi",
    ".dfm": "delphi",
    ".inc": "delphi",
    ".dpk": "delphi",
    ".fmx": "delphi",
  };
  return languageMap[extension] ?? null;
}

export function isValidGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }

  if (/^git@[^:]+:[^/]+\/[^/]+(?:\.git)?$/i.test(trimmed)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      return false;
    }

    if (parsed.protocol === "http:") {
      const host = parsed.hostname.toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1") {
        return false;
      }
    } else if (parsed.protocol !== "https:") {
      return false;
    }

    return parsed.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function isProductionEnv(env: NodeJS.ProcessEnv) {
  return String(env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

function getConfiguredGitHostAllowlist(env: NodeJS.ProcessEnv) {
  const rawValue = String(env.LEGACY_LENS_GIT_HOST_ALLOWLIST ?? "").trim();
  if (!rawValue) {
    return [...DEFAULT_PRODUCTION_GIT_HOST_ALLOWLIST];
  }

  return rawValue
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseGitHost(gitUrl: string) {
  const trimmed = gitUrl.trim();
  const sshMatch = trimmed.match(/^git@([^:]+):[^/]+\/[^/]+(?:\.git)?$/i);
  if (sshMatch) {
    return sshMatch[1].toLowerCase();
  }

  const parsed = new URL(trimmed);
  return parsed.hostname.toLowerCase();
}

function isLoopbackHost(host: string) {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host);
}

function normalizeIpAddress(address: string) {
  return address.toLowerCase().split("%")[0] ?? address.toLowerCase();
}

function isUnsafeResolvedAddress(address: string) {
  const normalizedAddress = normalizeIpAddress(address);
  const family = net.isIP(normalizedAddress);

  if (family === 0) {
    return false;
  }

  if (family === 6 && normalizedAddress.startsWith("::ffff:")) {
    return isUnsafeResolvedAddress(normalizedAddress.slice("::ffff:".length));
  }

  return unsafeAddressBlockList.check(normalizedAddress, family === 6 ? "ipv6" : "ipv4");
}

async function resolveDnsHost(host: string): Promise<ResolvedAddress[]> {
  const resolved = await lookup(host, { all: true, verbatim: true });
  return resolved
    .filter((entry): entry is typeof entry & { family: 4 | 6 } => entry.family === 4 || entry.family === 6)
    .map((entry) => ({
      address: normalizeIpAddress(entry.address),
      family: entry.family,
    }));
}

async function resolveGitHostAddresses(host: string, resolver: ResolveDns) {
  const literalFamily = net.isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizeIpAddress(host), family: literalFamily as 4 | 6 }];
  }

  try {
    const resolved = await resolver(host);
    if (resolved.length === 0) {
      throw new Error("No addresses returned");
    }
    return resolved;
  } catch (error) {
    throw new AppError(
      "INVALID_GIT_URL",
      `Git import blocked: failed to resolve host "${host}" before clone.`,
      error instanceof Error ? error.message : undefined
    );
  }
}

export async function validateSafeGitUrl(
  gitUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  resolver: ResolveDns = resolveDnsHost
): Promise<ValidatedGitUrl> {
  if (!isValidGitUrl(gitUrl)) {
    throw new AppError("INVALID_GIT_URL", "Repository URL is invalid or unsupported.");
  }

  const normalizedUrl = gitUrl.trim();
  const host = parseGitHost(gitUrl);
  if (isLoopbackHost(host)) {
    throw new AppError("INVALID_GIT_URL", `Git import blocked: host "${host}" is not allowed.`);
  }

  const production = isProductionEnv(env);
  const resolvedAddresses = await resolveGitHostAddresses(host, resolver);

  if (!production) {
    const unsafeAddress = resolvedAddresses.find((entry) => isUnsafeResolvedAddress(entry.address));
    if (unsafeAddress) {
      throw new AppError(
        "INVALID_GIT_URL",
        `Git import blocked: host "${host}" resolves to unsafe address "${unsafeAddress.address}".`
      );
    }
    return {
      gitUrl: normalizedUrl,
      host,
      resolvedAddresses,
      allowlist: null,
      production,
    };
  }

  const allowlist = getConfiguredGitHostAllowlist(env);
  if (!allowlist.includes(host)) {
    throw new AppError(
      "INVALID_GIT_URL",
      `Git import blocked in production: host "${host}" is not in LEGACY_LENS_GIT_HOST_ALLOWLIST.`
    );
  }

  const unsafeAddress = resolvedAddresses.find((entry) => isUnsafeResolvedAddress(entry.address));
  if (unsafeAddress) {
    throw new AppError(
      "INVALID_GIT_URL",
      `Git import blocked: host "${host}" resolves to unsafe address "${unsafeAddress.address}".`
    );
  }

  return {
    gitUrl: normalizedUrl,
    host,
    resolvedAddresses,
    allowlist,
    production,
  };
}

export async function assertSafeGitUrl(
  gitUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  resolver: ResolveDns = resolveDnsHost
) {
  await validateSafeGitUrl(gitUrl, env, resolver);
}

export function extractRepoName(gitUrl: string): string {
  const sanitized = gitUrl.trim().replace(/\/+$/, "");
  const rawName = sanitized.split(/[/:]/).pop() ?? "repository";
  return rawName.replace(/\.git$/i, "") || "repository";
}

export async function cloneAndExtractFiles(
  gitSource: string | ValidatedGitUrl,
  tempDir: string
): Promise<{
  files: Array<{ path: string; fileName: string; content: string; language: FocusLanguage; size: number; encoding?: string; encodingWarning?: string }>;
  warnings: ImportWarning[];
}> {
  const validatedGitUrl = typeof gitSource === "string" ? await validateSafeGitUrl(gitSource) : gitSource;
  const gitUrl = validatedGitUrl.gitUrl;
  const repoName = extractRepoName(gitUrl);
  const repoPath = path.join(tempDir, repoName);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await simpleGit({ timeout: { block: GIT_CLONE_TIMEOUT_MS } }).clone(gitUrl, repoPath, ["--depth", "1", "--no-tags"]);
    const realRepoPath = await fs.realpath(repoPath);
    const extracted = await scanDirectoryForCodeFiles(repoPath, undefined, {
      fileLimit: MAX_FILES_IN_REPO,
      maxTotalBytes: MAX_TOTAL_EXTRACTED_SIZE,
    }, undefined, realRepoPath, new Map());
    if (extracted.files.length === 0) {
      throw new AppError("EMPTY_SOURCE", "The repository does not contain supported Go, SQL, or Delphi source files. Supported extensions: .go, .sql, .pas, .dpr, .dfm, .inc, .dpk, .fmx");
    }
    return extracted;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const details = error instanceof Error ? error.message : undefined;
    const detailsNormalized = String(details ?? "").toLowerCase();
    const timeoutHint = detailsNormalized.includes("timeout") || detailsNormalized.includes("timed out");

    throw new AppError(
      "GIT_CLONE_FAILED",
      timeoutHint
        ? `Failed to clone the repository (timeout after ${Math.round(GIT_CLONE_TIMEOUT_MS / 1000)}s). Try a smaller repo, or use ZIP import for a bounded upload.`
        : "Failed to clone or scan the repository.",
      details
    );
  }
}

async function scanDirectoryForCodeFiles(
  directoryPath: string,
  baseDir: string = directoryPath,
  limits: { fileLimit: number; maxTotalBytes: number } = { fileLimit: MAX_FILES_IN_REPO, maxTotalBytes: MAX_TOTAL_EXTRACTED_SIZE },
  state: { totalFiles: number; totalBytes: number } = { totalFiles: 0, totalBytes: 0 },
  realBaseDir: string = baseDir,
  realpathCache: Map<string, string> = new Map()
): Promise<{
  files: Array<{ path: string; fileName: string; content: string; language: FocusLanguage; size: number; encoding?: string; encodingWarning?: string }>;
  warnings: ImportWarning[];
}> {
  const files: Array<{ path: string; fileName: string; content: string; language: FocusLanguage; size: number; encoding?: string; encodingWarning?: string }> = [];
  const warnings: ImportWarning[] = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = normalizeRepoPath(path.relative(baseDir, fullPath));

    try {
      const cached = realpathCache.get(fullPath);
      const realFullPath = cached ?? (await fs.realpath(fullPath));
      realpathCache.set(fullPath, realFullPath);

      const relativeReal = path.relative(realBaseDir, realFullPath);
      if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
        warnings.push({
          code: "IMPORT_UNSAFE_PATH",
          message: "The file was skipped because its path is not a safe relative path.",
          filePath: relativePath || entry.name,
        });
        continue;
      }
    } catch {
      warnings.push({
        code: "IMPORT_UNSAFE_PATH",
        message: "The file was skipped because its path is not a safe relative path.",
        filePath: relativePath || entry.name,
      });
      continue;
    }

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const nested = await scanDirectoryForCodeFiles(fullPath, baseDir, limits, state, realBaseDir, realpathCache);
      files.push(...nested.files);
      warnings.push(...nested.warnings);
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (!isSafeRelativePath(relativePath)) {
      warnings.push({
        code: "IMPORT_UNSAFE_PATH",
        message: "The file was skipped because its path is not a safe relative path.",
        filePath: relativePath || entry.name,
      });
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_SOURCE_EXTENSIONS.includes(extension as (typeof SUPPORTED_SOURCE_EXTENSIONS)[number])) {
      if (UNSUPPORTED_CODE_EXTENSIONS.includes(extension as (typeof UNSUPPORTED_CODE_EXTENSIONS)[number])) {
        warnings.push({
          code: "IMPORT_LANGUAGE_UNSUPPORTED",
          message: "The file was skipped because Legacy Lens currently supports import analysis only for Go, SQL, and Delphi.",
          filePath: relativePath,
        });
      }
      continue;
    }

    const buffer = await fs.readFile(fullPath);
    const decoded = decodeTextContent(buffer);
    if (decoded.warning) {
      warnings.push({
        code: "IMPORT_ENCODING_DETECTED",
        message: decoded.warning,
        filePath: relativePath,
      });
    }
    const size = Buffer.byteLength(decoded.content, "utf8");
    if (size > MAX_SINGLE_FILE_SIZE) {
      warnings.push({
        code: "IMPORT_FILE_TOO_LARGE",
        message: `The file was skipped because it exceeds the maximum supported size (${Math.round(MAX_SINGLE_FILE_SIZE / (1024 * 1024))}MB).`,
        filePath: relativePath,
      });
      continue;
    }

    state.totalFiles += 1;
    if (state.totalFiles > limits.fileLimit) {
      throw new AppError("IMPORT_FAILED", `Repository contains too many source files (limit: ${limits.fileLimit}).`);
    }

    state.totalBytes += size;
    if (state.totalBytes > limits.maxTotalBytes) {
      throw new AppError("IMPORT_FAILED", `Repository import exceeds the allowed total size limit (${Math.round(limits.maxTotalBytes / (1024 * 1024))}MB).`);
    }

    const language = detectLanguage(extension);
    if (!language) {
      continue;
    }

    if (LIMITED_ANALYSIS_EXTENSIONS.has(extension)) {
      warnings.push({
        code: "IMPORT_LIMITED_ANALYSIS",
        message: "The file was imported, but only limited Delphi analysis is available for this file type.",
        filePath: relativePath,
      });
    }

    files.push({
      path: relativePath,
      fileName: entry.name,
      content: decoded.content,
      language,
      size,
      encoding: decoded.encoding,
      encodingWarning: decoded.warning,
    });
  }

  return { files, warnings };
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Intentionally swallow cleanup errors.
  }
}
