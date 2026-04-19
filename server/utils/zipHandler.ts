import type { ImportWarning, ProjectLanguage } from "../../shared/contracts";
import JSZip from "jszip";
import { AppError } from "../appError";
import iconvLite from "iconv-lite";
import jschardet from "jschardet";

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
export const LIMITED_ANALYSIS_EXTENSIONS = [".dfm", ".inc", ".dpk", ".fmx"] as const;

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
  encoding?: string;
  encodingWarning?: string;
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

function isLimitedAnalysisFile(filePath: string) {
  return LIMITED_ANALYSIS_EXTENSIONS.includes(getExtension(filePath) as (typeof LIMITED_ANALYSIS_EXTENSIONS)[number]);
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

      if (isLimitedAnalysisFile(normalizedPath)) {
        warnings.push({
          code: "IMPORT_LIMITED_ANALYSIS",
          message: "The file was imported, but only limited Delphi analysis is available for this file type.",
          filePath: normalizedPath,
        });
      }

      const decoded = decodeTextContent(fileBuffer);
      if (decoded.warning) {
        warnings.push({
          code: "IMPORT_ENCODING_DETECTED",
          message: decoded.warning,
          filePath: normalizedPath,
        });
      }

      extractedFiles.push({
        path: normalizedPath,
        fileName: normalizedPath.split("/").pop() ?? normalizedPath,
        content: decoded.content,
        language,
        size: fileSize,
        encoding: decoded.encoding,
        encodingWarning: decoded.warning,
      });
    }

    if (extractedFiles.length === 0) {
      throw new AppError(
        "EMPTY_SOURCE",
        "No supported Go, SQL, or Delphi source files were found in the uploaded archive. Supported extensions: .go, .sql, .pas, .dpr, .dfm, .inc, .dpk, .fmx"
      );
    }

    return {
      files: extractedFiles,
      warnings,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "ZIP_INVALID",
      "Failed to read ZIP archive.",
      error instanceof Error ? error.message : undefined
    );
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

/**
 * Detect text encoding and decode buffer to string.
 * Supports UTF-8, UTF-8 BOM, and attempts to detect legacy encodings.
 * Returns decoded content with encoding metadata.
 */
export function decodeTextContent(buffer: Buffer): { content: string; encoding: string; warning?: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return {
      content: buffer.toString("utf8", 3),
      encoding: "UTF-8-BOM",
    };
  }

  try {
    const content = buffer.toString("utf8");
    const hasNonAscii = Array.from(content).some((char) => char.charCodeAt(0) > 127);

    if (!hasNonAscii || Buffer.from(content, "utf8").equals(buffer)) {
      return { content, encoding: "UTF-8" };
    }
  } catch {
    // Fall through to detection
  }

  const detected = jschardet.detect(buffer);
  const detectedEncoding = detected.encoding?.toLowerCase() ?? "utf8";

  const encodingMap: Record<string, string> = {
    "utf-8": "utf8",
    ascii: "utf8",
    "iso-8859-1": "latin1",
    "windows-1252": "win1252",
    ibm866: "cp866",
    shift_jis: "shiftjis",
    "euc-jp": "eucjp",
    "euc-kr": "euckr",
    big5: "big5",
    gb2312: "gb2312",
    gbk: "gbk",
    "windows-1250": "win1250",
    "windows-1251": "win1251",
    "windows-1253": "win1253",
    "windows-1254": "win1254",
    "windows-1255": "win1255",
    "windows-1256": "win1256",
    "windows-1257": "win1257",
    "windows-1258": "win1258",
    macroman: "macroman",
    "koi8-r": "koi8r",
    "koi8-u": "koi8u",
  };

  const targetEncoding = encodingMap[detectedEncoding] ?? "utf8";

  try {
    const content = iconvLite.decode(buffer, targetEncoding);
    const confidence = detected.confidence ?? 0;

    let warning: string | undefined;
    if (confidence < 0.8 || targetEncoding !== "utf8") {
      warning = `Detected encoding: ${detected.encoding} (confidence: ${(confidence * 100).toFixed(0)}%). Content decoded with ${targetEncoding}. Legacy encoding may cause analysis issues.`;
    }

    return {
      content,
      encoding: detected.encoding ?? "UTF-8",
      warning,
    };
  } catch {
    const fallbackContent = buffer.toString("latin1");
    return {
      content: fallbackContent,
      encoding: "LATIN1-FALLBACK",
      warning: `Failed to decode with detected encoding (${detected.encoding}). Fell back to Latin-1. Content may be corrupted.`,
    };
  }
}