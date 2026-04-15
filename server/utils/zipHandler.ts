import type { ImportWarning, ProjectLanguage } from "../../shared/contracts";
import JSZip from "jszip";
import { AppError } from "../appError";

const MAX_FILES_IN_ZIP = 2_000;
const MAX_TOTAL_EXTRACTED_SIZE = 500 * 1024 * 1024;
const MAX_SINGLE_FILE_SIZE = 5 * 1024 * 1024;

export const SUPPORTED_SOURCE_EXTENSIONS = [".go", ".sql", ".pas", ".dpr", ".delphi", ".dfm", ".inc", ".dpk", ".fmx"] as const;
export const UNSUPPORTED_CODE_EXTENSIONS = [
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

/**
 * Extensions that are supported for import but have limited analysis capabilities.
 * These files will be imported and counted, but may not produce full symbol/dependency data.
 */
export const LIMITED_ANALYSIS_EXTENSIONS = [".dfm", ".inc", ".fmx"] as const;

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
  language: ProjectLanguage;
  size: number;
}

export interface ExtractedSourceBundle {
  files: ExtractedFile[];
  warnings: ImportWarning[];
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function shouldIgnoreFile(filePath: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(filePath));
}

function detectLanguage(filePath: string): ProjectLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
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
  return languageMap[ext] ?? null;
}

function getExtension(filePath: string) {
  const index = filePath.lastIndexOf(".");
  return index >= 0 ? filePath.slice(index).toLowerCase() : "";
}

function isSupportedFile(filePath: string) {
  return SUPPORTED_SOURCE_EXTENSIONS.includes(getExtension(filePath) as (typeof SUPPORTED_SOURCE_EXTENSIONS)[number]);
}

function isKnownUnsupportedCodeFile(filePath: string) {
  return UNSUPPORTED_CODE_EXTENSIONS.includes(getExtension(filePath) as (typeof UNSUPPORTED_CODE_EXTENSIONS)[number]);
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

export async function extractFilesFromZip(base64Content: string): Promise<ExtractedSourceBundle> {
  try {
    const buffer = Buffer.from(base64Content, "base64");
    const zip = await JSZip.loadAsync(buffer);
    const extractedFiles: ExtractedFile[] = [];
    const warnings: ImportWarning[] = [];
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
      if (!normalizedPath || shouldIgnoreFile(normalizedPath)) {
        continue;
      }

      if (!isSupportedFile(normalizedPath)) {
        if (isKnownUnsupportedCodeFile(normalizedPath)) {
          warnings.push({
            code: "IMPORT_LANGUAGE_UNSUPPORTED",
            message: "The file was skipped because Legacy Lens currently supports import analysis only for Go, SQL, and Delphi.",
            filePath: normalizedPath,
          });
        }
        continue;
      }

      const fileBuffer = await entry.async("nodebuffer");
      const fileSize = fileBuffer.length;
      if (fileSize > MAX_SINGLE_FILE_SIZE) {
        warnings.push({
          code: "IMPORT_FILE_TOO_LARGE",
          message: "The file was skipped because it exceeds the maximum supported size.",
          filePath: normalizedPath,
        });
        continue;
      }

      totalExtractedSize += fileSize;
      if (totalExtractedSize > MAX_TOTAL_EXTRACTED_SIZE) {
        throw new AppError("ZIP_INVALID", "Archive expands beyond the allowed size limit.");
      }

      const language = detectLanguage(normalizedPath);
      if (!language) {
        continue;
      }

      extractedFiles.push({
        path: normalizedPath,
        fileName: normalizedPath.split("/").pop() ?? normalizedPath,
        content: fileBuffer.toString("utf8"),
        language,
        size: fileSize,
      });
    }

    if (extractedFiles.length === 0) {
      throw new AppError("EMPTY_SOURCE", "No supported Go, SQL, or Delphi source files were found in the uploaded archive. Supported extensions: .go, .sql, .pas, .dpr, .dfm, .inc, .dpk, .fmx");
    }

    return {
      files: extractedFiles,
      warnings,
    };
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
