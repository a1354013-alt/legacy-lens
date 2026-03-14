import { getDb } from "../db";
import { files as filesTable } from "../../drizzle/schema";
import type { ExtractedFile } from "./zipHandler";

/**
 * P0-A FIX: Accept optional transaction parameter
 * 將提取的檔案保存到資料庫
 * @param projectId - 專案 ID
 * @param extractedFiles - 提取的檔案列表
 * @param dbOrTx - 可選的資料庫或 transaction 實例（如果提供，使用它；否則獲取新的 DB 連接）
 */
export async function saveExtractedFiles(
  projectId: number,
  extractedFiles: ExtractedFile[],
  dbOrTx?: any
): Promise<number[]> {
  const db = dbOrTx || (await getDb());
  if (!db) {
    throw new Error("Database not available");
  }

  const fileIds: number[] = [];

  for (const file of extractedFiles) {
    try {
      // P1-B FIX: Insert file
      await db
        .insert(filesTable)
        .values({
          projectId,
          filePath: file.path,
          fileName: file.fileName,
          fileType: file.path.substring(file.path.lastIndexOf(".")),
          content: file.content,
          lineCount: file.content.split("\n").length,
        });
    } catch (error) {
      console.error(`Failed to save file ${file.fileName}:`, error);
      throw error;
    }
  }

  // P1-B FIX: Query back the inserted file IDs
  // This is more reliable than depending on insertId which may not be available
  // in all Drizzle + mysql2 combinations
  if (extractedFiles.length > 0) {
    const { eq, desc } = await import("drizzle-orm");
    const insertedRecords = await db
      .select({ id: filesTable.id })
      .from(filesTable)
      .where(eq(filesTable.projectId, projectId))
      .orderBy(desc(filesTable.id))
      .limit(extractedFiles.length);

    for (const record of insertedRecords) {
      fileIds.push(record.id);
    }
  }

  return fileIds;
}

/**
 * 獲取專案的所有檔案
 */
export async function getProjectFiles(projectId: number, dbOrTx?: any) {
  const db = dbOrTx || (await getDb());
  if (!db) {
    return [];
  }

  const { eq } = await import("drizzle-orm");
  return db.select().from(filesTable).where(eq(filesTable.projectId, projectId));
}

/**
 * P0-A FIX: Accept optional transaction parameter
 * 刪除專案的所有檔案
 * @param projectId - 專案 ID
 * @param dbOrTx - 可選的資料庫或 transaction 實例
 */
export async function deleteProjectFiles(projectId: number, dbOrTx?: any): Promise<void> {
  const db = dbOrTx || (await getDb());
  if (!db) {
    throw new Error("Database not available");
  }

  const { eq } = await import("drizzle-orm");
  await db.delete(filesTable).where(eq(filesTable.projectId, projectId));
}

/**
 * 計算專案的總程式碼行數
 */
export async function calculateTotalLineCount(projectId: number, dbOrTx?: any): Promise<number> {
  const projectFiles = await getProjectFiles(projectId, dbOrTx);
  return projectFiles.reduce((total: number, file: any) => total + (file.lineCount || 0), 0);
}

/**
 * 按語言分組統計檔案
 */
export async function getFileStatsByLanguage(projectId: number, dbOrTx?: any) {
  const projectFiles = await getProjectFiles(projectId, dbOrTx);

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
