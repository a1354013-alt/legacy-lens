import JSZip from "jszip";
import { AppError } from "../appError";

const MAX_FILES_IN_ZIP = 2_000;
const MAX_TOTAL_EXTRACTED_SIZE = 500 * 1024 * 1024;
const MAX_SINGLE_FILE_SIZE = 5 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = [
  ".go",
  ".sql",
  ".pas",
  ".dpr",
  ".delphi",
  ".ts",
  ".js",
  ".java",
  ".py",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".scala",
  ".kt",
  ".rs",
  ".swift",
] as const;

const IGNORED_PATTERNS = [
  /^__MACOSX\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)target\//,
  /(^|\/)\.idea\//,
  /(^|\/)\.vscode\//,
  /\.lock$/,
  /\.env/i,
] as const;

export interface ExtractedFile {
  path: string;
  fileName: string;
  content: string;
  language: string;
  size: number;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function shouldIgnoreFile(filePath: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(filePath));
}

function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
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
  return languageMap[ext] ?? "unknown";
}

function isSupportedFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number]);
}

export async function validateZipFile(base64Content: string): Promise<boolean> {
  try {
    const buffer = Buffer.from(base64Content, "base64");
    if (buffer.length === 0 || buffer.length > MAX_TOTAL_EXTRACTED_SIZE) {
      return false;
    }

    await JSZip.loadAsync(buffer);
    return true;
  } catch {
    return false;
  }
}

export async function extractFilesFromZip(base64Content: string): Promise<ExtractedFile[]> {
  try {
    const buffer = Buffer.from(base64Content, "base64");
    const zip = await JSZip.loadAsync(buffer);
    const extractedFiles: ExtractedFile[] = [];
    let totalExtractedSize = 0;

    const entries = Object.entries(zip.files);
    if (entries.length > MAX_FILES_IN_ZIP) {
      throw new AppError("ZIP_INVALID", `Archive contains too many entries (${entries.length}).`);
    }

    for (const [rawPath, entry] of entries) {
      if (entry.dir) {
        continue;
      }

      const normalizedPath = normalizePath(rawPath);
      if (!normalizedPath || shouldIgnoreFile(normalizedPath) || !isSupportedFile(normalizedPath)) {
        continue;
      }

      const fileBuffer = await entry.async("nodebuffer");
      const fileSize = fileBuffer.length;
      if (fileSize > MAX_SINGLE_FILE_SIZE) {
        continue;
      }

      totalExtractedSize += fileSize;
      if (totalExtractedSize > MAX_TOTAL_EXTRACTED_SIZE) {
        throw new AppError("ZIP_INVALID", "Archive expands beyond the allowed size limit.");
      }

      extractedFiles.push({
        path: normalizedPath,
        fileName: normalizedPath.split("/").pop() ?? normalizedPath,
        content: fileBuffer.toString("utf8"),
        language: detectLanguage(normalizedPath),
        size: fileSize,
      });
    }

    if (extractedFiles.length === 0) {
      throw new AppError("EMPTY_SOURCE", "No supported source files were found in the uploaded archive.");
    }

    return extractedFiles;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("ZIP_INVALID", "Failed to read ZIP archive.", error instanceof Error ? error.message : undefined);
  }
}

export async function countCodeFilesInZip(base64Content: string): Promise<number> {
  try {
    const buffer = Buffer.from(base64Content, "base64");
    const zip = await JSZip.loadAsync(buffer);
    let count = 0;

    for (const [rawPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const normalizedPath = normalizePath(rawPath);
      if (shouldIgnoreFile(normalizedPath) || !isSupportedFile(normalizedPath)) continue;
      count += 1;
    }

    return count;
  } catch {
    return 0;
  }
}
