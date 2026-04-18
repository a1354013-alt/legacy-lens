import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImportWarning, ProjectLanguage } from "../../shared/contracts";
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

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function detectLanguage(extension: string): ProjectLanguage | null {
  const languageMap: Record<string, ProjectLanguage> = {
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
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return false;
    }
    return parsed.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

export function extractRepoName(gitUrl: string): string {
  const sanitized = gitUrl.trim().replace(/\/+$/, "");
  const rawName = sanitized.split(/[/:]/).pop() ?? "repository";
  return rawName.replace(/\.git$/i, "") || "repository";
}

export async function cloneAndExtractFiles(
  gitUrl: string,
  tempDir: string
): Promise<{
  files: Array<{ path: string; fileName: string; content: string; language: ProjectLanguage; size: number; encoding?: string; encodingWarning?: string }>;
  warnings: ImportWarning[];
}> {
  const repoName = extractRepoName(gitUrl);
  const repoPath = path.join(tempDir, repoName);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await simpleGit().clone(gitUrl, repoPath, ["--depth", "1"]);
    const extracted = await scanDirectoryForCodeFiles(repoPath);
    if (extracted.files.length === 0) {
      throw new AppError("EMPTY_SOURCE", "The repository does not contain supported Go, SQL, or Delphi source files. Supported extensions: .go, .sql, .pas, .dpr, .dfm, .inc, .dpk, .fmx");
    }
    return extracted;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("GIT_CLONE_FAILED", "Failed to clone or scan the repository.", error instanceof Error ? error.message : undefined);
  }
}

async function scanDirectoryForCodeFiles(
  directoryPath: string,
  baseDir: string = directoryPath
): Promise<{
  files: Array<{ path: string; fileName: string; content: string; language: ProjectLanguage; size: number; encoding?: string; encodingWarning?: string }>;
  warnings: ImportWarning[];
}> {
  const files: Array<{ path: string; fileName: string; content: string; language: ProjectLanguage; size: number; encoding?: string; encodingWarning?: string }> = [];
  const warnings: ImportWarning[] = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = normalizePath(path.relative(baseDir, fullPath));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const nested = await scanDirectoryForCodeFiles(fullPath, baseDir);
      files.push(...nested.files);
      warnings.push(...nested.warnings);
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

    const content = await fs.readFile(fullPath, "utf8");
    const decoded = decodeTextContent(Buffer.from(content), relativePath);
    if (decoded.warning) {
      warnings.push({
        code: "IMPORT_ENCODING_DETECTED",
        message: decoded.warning,
        filePath: relativePath,
      });
    }
    const size = Buffer.byteLength(decoded.content, "utf8");
    if (size > 5 * 1024 * 1024) {
      warnings.push({
        code: "IMPORT_FILE_TOO_LARGE",
        message: "The file was skipped because it exceeds the maximum supported size.",
        filePath: relativePath,
      });
      continue;
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
