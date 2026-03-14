import { simpleGit, SimpleGit } from "simple-git";
import { promises as fs } from "fs";
import path from "path";
import { extractFilesFromZip, SUPPORTED_EXTENSIONS } from "./zipHandler";

/**
 * 驗證 Git URL 的有效性
 */
export function isValidGitUrl(url: string): boolean {
  try {
    // 支援 HTTPS 和 SSH 格式
    const httpsPattern = /^https:\/\/github\.com\/[\w-]+\/[\w-]+\.git$/;
    const gitlabPattern = /^https:\/\/gitlab\.com\/[\w-]+\/[\w-]+\.git$/;
    const sshPattern = /^git@(github\.com|gitlab\.com):[\w-]+\/[\w-]+\.git$/;

    return httpsPattern.test(url) || gitlabPattern.test(url) || sshPattern.test(url);
  } catch {
    return false;
  }
}

/**
 * 從 Git URL 提取倉庫名稱
 */
export function extractRepoName(gitUrl: string): string {
  try {
    const match = gitUrl.match(/\/([^/]+)\.git$/);
    return match ? match[1] : "unknown-repo";
  } catch {
    return "unknown-repo";
  }
}

/**
 * 從 Git 倉庫克隆並提取程式碼檔案
 */
export async function cloneAndExtractFiles(
  gitUrl: string,
  tempDir: string
): Promise<Array<{
  path: string;
  fileName: string;
  content: string;
  language: string;
  size: number;
}>> {
  let git: SimpleGit | null = null;
  const repoName = extractRepoName(gitUrl);
  const repoPath = path.join(tempDir, repoName);

  try {
    // 建立臨時目錄
    await fs.mkdir(tempDir, { recursive: true });

    // 克隆倉庫
    git = simpleGit();
    console.log(`Cloning repository from ${gitUrl}...`);
    await git.clone(gitUrl, repoPath, ["--depth", "1"]); // 只克隆最新提交以加快速度

    // 遞歸掃描目錄中的程式碼檔案
    const extractedFiles = await scanDirectoryForCodeFiles(repoPath);

    if (extractedFiles.length === 0) {
      throw new Error("Git 倉庫中沒有找到支援的程式碼檔案");
    }

    return extractedFiles;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Git 克隆失敗: ${error.message}`);
    }
    throw new Error("Git 克隆失敗");
  }
}

/**
 * 遞歸掃描目錄中的程式碼檔案
 */
async function scanDirectoryForCodeFiles(
  dirPath: string,
  baseDir: string = dirPath
): Promise<
  Array<{
    path: string;
    fileName: string;
    content: string;
    language: string;
    size: number;
  }>
> {
  const files: Array<{
    path: string;
    fileName: string;
    content: string;
    language: string;
    size: number;
  }> = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      // 跳過應忽略的目錄
      if (
        entry.isDirectory() &&
        [
          "node_modules",
          ".git",
          "dist",
          "build",
          "target",
          ".vscode",
          ".idea",
          ".next",
          "out",
        ].includes(entry.name)
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        // 遞歸掃描子目錄
        const subFiles = await scanDirectoryForCodeFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        // 檢查是否是支援的程式碼檔案
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          try {
            const content = await fs.readFile(fullPath, "utf-8");

            // 檢查檔案大小（限制為 1MB）
            if (content.length > 1024 * 1024) {
              console.warn(`File ${relativePath} exceeds 1MB limit, skipping`);
              continue;
            }

            files.push({
              path: relativePath,
              fileName: entry.name,
              content,
              language: detectLanguage(ext),
              size: content.length,
            });
          } catch (error) {
            console.warn(`Failed to read file ${relativePath}:`, error);
            continue;
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dirPath}:`, error);
  }

  return files;
}

/**
 * 從檔案副檔名推斷程式語言
 */
function detectLanguage(ext: string): string {
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
  return languageMap[ext.toLowerCase()] || "unknown";
}

/**
 * 清理臨時目錄
 */
export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(tempDir, entry.name);
      if (entry.isDirectory()) {
        await removeDirectory(fullPath);
      } else {
        await fs.unlink(fullPath);
      }
    }
    await fs.rmdir(tempDir);
  } catch (error) {
    console.warn(`Failed to cleanup temp directory ${tempDir}:`, error);
  }
}

/**
 * 遞歸刪除目錄
 */
async function removeDirectory(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await removeDirectory(fullPath);
      } else {
        await fs.unlink(fullPath);
      }
    }
    await fs.rmdir(dirPath);
  } catch (error) {
    console.warn(`Failed to remove directory ${dirPath}:`, error);
  }
}
