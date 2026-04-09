import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { AppError } from "../appError";
import { SUPPORTED_EXTENSIONS } from "./zipHandler";

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

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function detectLanguage(extension: string): string {
  const languageMap: Record<string, string> = {
    ".go": "go",
    ".sql": "sql",
    ".pas": "delphi",
    ".dpr": "delphi",
    ".delphi": "delphi",
    ".ts": "typescript",
    ".js": "javascript",
    ".java": "java",
    ".py": "python",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".scala": "scala",
    ".kt": "kotlin",
    ".rs": "rust",
    ".swift": "swift",
  };
  return languageMap[extension] ?? "unknown";
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
): Promise<Array<{ path: string; fileName: string; content: string; language: string; size: number }>> {
  const repoName = extractRepoName(gitUrl);
  const repoPath = path.join(tempDir, repoName);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await simpleGit().clone(gitUrl, repoPath, ["--depth", "1"]);
    const extractedFiles = await scanDirectoryForCodeFiles(repoPath);
    if (extractedFiles.length === 0) {
      throw new AppError("EMPTY_SOURCE", "The repository does not contain supported source files.");
    }
    return extractedFiles;
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
): Promise<Array<{ path: string; fileName: string; content: string; language: string; size: number }>> {
  const extractedFiles: Array<{ path: string; fileName: string; content: string; language: string; size: number }> = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = normalizePath(path.relative(baseDir, fullPath));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      extractedFiles.push(...(await scanDirectoryForCodeFiles(fullPath, baseDir)));
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
      continue;
    }

    const content = await fs.readFile(fullPath, "utf8");
    const size = Buffer.byteLength(content, "utf8");
    if (size > 5 * 1024 * 1024) {
      continue;
    }

    extractedFiles.push({
      path: relativePath,
      fileName: entry.name,
      content,
      language: detectLanguage(extension),
      size,
    });
  }

  return extractedFiles;
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Intentionally swallow cleanup errors.
  }
}
