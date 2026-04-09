import { and, eq, inArray } from "drizzle-orm";
import { files as filesTable } from "../../drizzle/schema";
import { getDb } from "../db";
import type { ExtractedFile } from "./zipHandler";

type DbLike = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "insert" | "select" | "delete">;

function detectFileType(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  return lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : "unknown";
}

async function resolveDb(dbOrTx?: DbLike): Promise<DbLike> {
  const db = dbOrTx ?? (await getDb());
  if (!db) {
    throw new Error("Database not available");
  }
  return db;
}

export async function saveExtractedFiles(projectId: number, extractedFiles: ExtractedFile[], dbOrTx?: DbLike): Promise<number[]> {
  const db = await resolveDb(dbOrTx);
  const fileIds: number[] = [];

  for (const file of extractedFiles) {
    const insertResult = await db.insert(filesTable).values({
      projectId,
      filePath: file.path,
      fileName: file.fileName,
      fileType: detectFileType(file.path),
      status: "stored",
      content: file.content,
      lineCount: file.content.split(/\r?\n/).length,
    });

    const insertId = Number((insertResult as { insertId?: number }).insertId ?? 0);
    if (insertId > 0) {
      fileIds.push(insertId);
    }
  }

  if (fileIds.length === extractedFiles.length) {
    return fileIds;
  }

  const filePaths = Array.from(new Set(extractedFiles.map((file) => file.path)));
  const insertedRecords = await db
    .select({ id: filesTable.id, filePath: filesTable.filePath })
    .from(filesTable)
    .where(and(eq(filesTable.projectId, projectId), inArray(filesTable.filePath, filePaths)));

  const idByPath = new Map(insertedRecords.map((record) => [record.filePath, record.id]));
  return extractedFiles
    .map((file) => idByPath.get(file.path))
    .filter((id): id is number => typeof id === "number");
}

export async function getProjectFiles(projectId: number, dbOrTx?: DbLike) {
  const db = dbOrTx ?? (await getDb());
  if (!db) {
    return [];
  }

  return db.select().from(filesTable).where(eq(filesTable.projectId, projectId));
}

export async function deleteProjectFiles(projectId: number, dbOrTx?: DbLike): Promise<void> {
  const db = await resolveDb(dbOrTx);
  await db.delete(filesTable).where(eq(filesTable.projectId, projectId));
}

export async function calculateTotalLineCount(projectId: number, dbOrTx?: DbLike): Promise<number> {
  const projectFiles = await getProjectFiles(projectId, dbOrTx);
  return projectFiles.reduce((total, file) => total + (file.lineCount ?? 0), 0);
}

export async function getFileStatsByLanguage(projectId: number, dbOrTx?: DbLike) {
  const projectFiles = await getProjectFiles(projectId, dbOrTx);
  const stats: Record<string, { count: number; lines: number }> = {};

  for (const file of projectFiles) {
    const key = file.fileType ?? "unknown";
    if (!stats[key]) {
      stats[key] = { count: 0, lines: 0 };
    }
    stats[key].count += 1;
    stats[key].lines += file.lineCount ?? 0;
  }

  return stats;
}
