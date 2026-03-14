import { getDb } from "../db";
import { files as filesTable } from "../../drizzle/schema";
import type { ExtractedFile } from "./zipHandler";

/**
 * 將提取的檔案保存到資料庫
 */
export async function saveExtractedFiles(
  projectId: number,
  extractedFiles: ExtractedFile[]
): Promise<number[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const fileIds: number[] = [];

  for (const file of extractedFiles) {
    try {
      const result = await db.insert(filesTable).values({
        projectId,
        filePath: file.path,
        fileName: file.fileName,
        fileType: file.path.substring(file.path.lastIndexOf(".")),
        content: file.content,
        lineCount: file.content.split("\n").length,
      });

      // 獲取插入的 ID
      const insertId = (result as any).insertId;
      if (insertId) {
        fileIds.push(insertId);
      }
    } catch (error) {
      console.error(`Failed to save file ${file.fileName}:`, error);
      throw error;
    }
  }

  return fileIds;
}

/**
 * 獲取專案的所有檔案
 */
export async function getProjectFiles(projectId: number) {
  const db = await getDb();
  if (!db) {
    return [];
  }

  const { eq } = await import("drizzle-orm");
  return db.select().from(filesTable).where(eq(filesTable.projectId, projectId));
}

/**
 * 刪除專案的所有檔案
 */
export async function deleteProjectFiles(projectId: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const { eq } = await import("drizzle-orm");
  await db.delete(filesTable).where(eq(filesTable.projectId, projectId));
}

/**
 * 計算專案的總程式碼行數
 */
export async function calculateTotalLineCount(projectId: number): Promise<number> {
  const projectFiles = await getProjectFiles(projectId);
  return projectFiles.reduce((total, file) => total + (file.lineCount || 0), 0);
}

/**
 * 按語言分組統計檔案
 */
export async function getFileStatsByLanguage(projectId: number) {
  const projectFiles = await getProjectFiles(projectId);

  const stats: Record<string, { count: number; lines: number }> = {};

  for (const file of projectFiles) {
    const ext = file.fileType || "unknown";
    if (!stats[ext]) {
      stats[ext] = { count: 0, lines: 0 };
    }
    stats[ext].count++;
    stats[ext].lines += file.lineCount || 0;
  }

  return stats;
}
