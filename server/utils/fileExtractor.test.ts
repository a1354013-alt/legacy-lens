import { describe, expect, it } from "vitest";
import { saveExtractedFiles } from "./fileExtractor";

function createFakeDb() {
  const inserted: Record<string, unknown>[] = [];
  const batchSizes: number[] = [];

  return {
    inserted,
    batchSizes,
    insert() {
      return {
        values: async (payload: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = Array.isArray(payload) ? payload : [payload];
          batchSizes.push(rows.length);
          inserted.push(...rows);
          return { insertId: 0 };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where: async () =>
              inserted
                .map((row, index) => ({ id: index + 1, filePath: row.filePath }))
                .reverse(),
          };
        },
      };
    },
    delete() {
      return {
        where: async () => undefined,
      };
    },
  };
}

function createExtractedFile(path: string, content = "line 1\nline 2") {
  return {
    path,
    fileName: path.split("/").at(-1) ?? path,
    content,
    language: "delphi" as const,
    size: content.length,
  };
}

describe("saveExtractedFiles", () => {
  it("returns an empty array without touching the database for empty input", async () => {
    await expect(saveExtractedFiles(1, [])).resolves.toEqual([]);
  });

  it("bulk inserts a small file set and returns ids in input order", async () => {
    const db = createFakeDb();

    const ids = await saveExtractedFiles(1, [createExtractedFile("a.pas"), createExtractedFile("nested/b.sql")], db as any);

    expect(ids).toEqual([1, 2]);
    expect(db.batchSizes).toEqual([2]);
    expect(db.inserted).toHaveLength(2);
  });

  it("bulk inserts more than one chunk and returns every id in input order", async () => {
    const db = createFakeDb();
    const files = Array.from({ length: 251 }, (_, index) => createExtractedFile(`file-${index}.pas`));

    const ids = await saveExtractedFiles(1, files, db as any);

    expect(db.batchSizes).toEqual([250, 1]);
    expect(ids).toHaveLength(files.length);
    expect(ids).toEqual(files.map((_, index) => index + 1));
  });

  it("preserves source content larger than 64KB before persistence", async () => {
    const db = createFakeDb();
    const largeContent = "A".repeat(70 * 1024);

    const ids = await saveExtractedFiles(
      1,
      [
        {
          path: "large.pas",
          fileName: "large.pas",
          content: largeContent,
          language: "delphi",
          size: largeContent.length,
        },
      ],
      db as any
    );

    expect(ids).toEqual([1]);
    expect(String(db.inserted[0]?.content).length).toBe(largeContent.length);
  });
});
