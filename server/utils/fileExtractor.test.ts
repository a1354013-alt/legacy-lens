import { describe, expect, it } from "vitest";
import { saveExtractedFiles } from "./fileExtractor";

function createFakeDb() {
  const inserted: Record<string, unknown>[] = [];

  return {
    inserted,
    insert() {
      return {
        values: async (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return { insertId: inserted.length };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where: async () => inserted.map((row, index) => ({ id: index + 1, filePath: row.filePath })),
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

describe("saveExtractedFiles", () => {
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
