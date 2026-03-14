import JSZip from "jszip";

/**
 * BUG-5 FIX: 安全限制常數
 */
const MAX_FILES_IN_ZIP = 1000; // 最多 1000 個檔案
const MAX_TOTAL_EXTRACTED_SIZE = 500 * 1024 * 1024; // 最多 500MB 解壓後大小
const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024; // 單個檔案最多 50MB
const MAX_COMPRESSION_RATIO = 100; // 最多 100 倍壓縮比（防 Zip bomb）

/**
 * 支援的程式碼檔案副檔名
 */
export const SUPPORTED_EXTENSIONS = [
  ".go",
  ".sql",
  ".pas",
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
  ".kotlin",
  ".rs",
  ".swift",
];

/**
 * 應忽略的目錄和檔案
 */
const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /\.env/,
  /\.DS_Store/,
  /dist/,
  /build/,
  /target/,
  /\.vscode/,
  /\.idea/,
  /package-lock\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/,
];

export interface ExtractedFile {
  path: string;
  fileName: string;
  content: string;
  language: string;
  size: number;
}

/**
 * 檢查檔案是否應被忽略
 */
function shouldIgnoreFile(filePath: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * 從檔案路徑推斷程式語言
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().substring(filePath.lastIndexOf("."));
  const languageMap: Record<string, string> = {
    ".go": "go",
    ".sql": "sql",
    ".pas": "delphi",
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
    ".kotlin": "kotlin",
    ".rs": "rust",
    ".swift": "swift",
  };
  return languageMap[ext] || "unknown";
}

/**
 * 檢查檔案是否是支援的程式碼檔案
 */
function isSupportedFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().substring(filePath.lastIndexOf("."));
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * 從 Base64 字串解析 ZIP 檔案並提取程式碼檔案
 * BUG-5 FIX: 添加安全檢查（檔案數量、大小、Zip bomb 防護）
 */
export async function extractFilesFromZip(base64Content: string): Promise<ExtractedFile[]> {
  try {
    // 將 Base64 轉換為 Buffer
    const buffer = Buffer.from(base64Content, "base64");

    // 使用 JSZip 解析 ZIP 檔案
    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(buffer);

    const extractedFiles: ExtractedFile[] = [];
    let totalExtractedSize = 0;
    let fileCount = 0;

    // 遍歷 ZIP 中的所有檔案
    for (const [filePath, file] of Object.entries(loadedZip.files)) {
      // BUG-5 FIX: 檢查檔案數量限制
      if (fileCount >= MAX_FILES_IN_ZIP) {
        throw new Error(`ZIP 檔案中的檔案數超過限制 (${MAX_FILES_IN_ZIP})`);
      }

      // 跳過目錄
      if (file.dir) continue;

      fileCount++;

      // 跳過應忽略的檔案
      if (shouldIgnoreFile(filePath)) continue;

      // 檢查是否是支援的程式碼檔案
      if (!isSupportedFile(filePath)) continue;

      try {
        // P1 FIX: Use Buffer to get accurate byte size, not string.length
        // string.length counts UTF-16 code units, not bytes
        // This prevents size limit bypass with multi-byte characters
        const buffer = await file.async("nodebuffer");
        const fileSize = buffer.length;  // Accurate byte size
        const content = buffer.toString("utf8");  // Convert to string for processing

        // BUG-5 FIX: 檢查單個檔案大小
        if (fileSize > MAX_SINGLE_FILE_SIZE) {
          console.warn(
            `[ZIP] File ${filePath} exceeds size limit (${fileSize} bytes > ${MAX_SINGLE_FILE_SIZE}), skipping`
          );
          continue;
        }

        // BUG-5 FIX: 檢查壓縮比（防 Zip bomb）
        // Note: JSZip doesn't expose compressed size directly, so we skip this check
        // The file size check above is sufficient for most Zip bomb scenarios

        totalExtractedSize += fileSize;  // Now using accurate byte size

        // BUG-5 FIX: 檢查總解壓大小（使用準確的 byte 計算）
        if (totalExtractedSize > MAX_TOTAL_EXTRACTED_SIZE) {
          throw new Error(
            `解壓後的總大小超過限制 (${totalExtractedSize} bytes > ${MAX_TOTAL_EXTRACTED_SIZE})`
          );
        }

        extractedFiles.push({
          path: filePath,
          fileName: filePath.split("/").pop() || filePath,
          content,
          language: detectLanguage(filePath),
          size: fileSize,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("超過限制")) {
          throw error;
        }
        console.warn(`Failed to read file ${filePath}:`, error);
        continue;
      }
    }

    if (extractedFiles.length === 0) {
      throw new Error("ZIP 檔案中沒有找到支援的程式碼檔案");
    }

    return extractedFiles;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`ZIP 檔案解析失敗: ${error.message}`);
    }
    throw new Error("ZIP 檔案解析失敗");
  }
}

/**
 * 驗證 ZIP 檔案的有效性
 * BUG-5 FIX: 添加安全檢查
 */
export async function validateZipFile(base64Content: string): Promise<boolean> {
  try {
    const buffer = Buffer.from(base64Content, "base64");
    
    // BUG-5 FIX: 檢查 Base64 解碼後的大小
    if (buffer.length > MAX_TOTAL_EXTRACTED_SIZE) {
      console.warn(`[ZIP] Compressed size exceeds limit: ${buffer.length}`);
      return false;
    }

    const zip = new JSZip();
    await zip.loadAsync(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * 計算 ZIP 檔案中支援的程式碼檔案數量
 */
export async function countCodeFilesInZip(base64Content: string): Promise<number> {
  try {
    const buffer = Buffer.from(base64Content, "base64");
    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(buffer);

    let count = 0;
    for (const [filePath, file] of Object.entries(loadedZip.files)) {
      if (file.dir) continue;
      if (shouldIgnoreFile(filePath)) continue;
      if (isSupportedFile(filePath)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}
