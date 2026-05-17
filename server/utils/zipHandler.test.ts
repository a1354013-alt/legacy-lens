import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { MAX_EXTRACTED_BYTES, MAX_FILE_COUNT, MAX_SINGLE_FILE_BYTES, MAX_ZIP_RAW_BYTES } from "../../shared/const";
import {
  assertExtractedSize,
  assertSingleFileSize,
  assertSourceFileCount,
  assertZipRawSize,
  extractFilesFromZip,
  isAbsoluteArchivePath,
  isSafeRelativePath,
  normalizePath,
} from "./zipHandler";

describe("zipHandler", () => {
  it("normalizes and rejects unsafe import paths (stable safety contract)", () => {
    expect(isSafeRelativePath(normalizePath("safe/main.go"))).toBe(true);
    expect(isSafeRelativePath(normalizePath("../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizePath("safe/../evil.go"))).toBe(false);
    expect(isSafeRelativePath(normalizePath("C:/windows/evil.go"))).toBe(false);

    expect(isAbsoluteArchivePath("/evil.go")).toBe(true);
    expect(isAbsoluteArchivePath("\\evil.go")).toBe(true);
    expect(isAbsoluteArchivePath("C:/windows/evil.go")).toBe(true);
  });

  it("returns explicit warnings for unsupported languages in mixed archives", async () => {
    const zip = new JSZip();
    zip.file("main.go", "package main\nfunc main() {}\n");
    zip.file("legacy.ts", "export const x = 1;\n");

    const base64 = await zip.generateAsync({ type: "base64" });
    const result = await extractFilesFromZip(base64);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.language).toBe("go");
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "IMPORT_LANGUAGE_UNSUPPORTED",
        filePath: "legacy.ts",
      }),
    ]);
  });

  it("imports Delphi support files and emits limited analysis warnings", async () => {
    const zip = new JSZip();
    zip.file("Form1.dfm", "object Form1: TForm1\nend\n");
    zip.file("types.inc", "const X = 1;\n");
    zip.file("package.dpk", "package Project;\nend.\n");
    zip.file("layout.fmx", "object Form1: TForm1\nend\n");

    const base64 = await zip.generateAsync({ type: "base64" });
    const result = await extractFilesFromZip(base64);

    expect(result.files.map((file) => file.fileName).sort()).toEqual(["Form1.dfm", "layout.fmx", "package.dpk", "types.inc"].sort());
    expect(result.files.every((file) => file.language === "delphi")).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IMPORT_LIMITED_ANALYSIS", filePath: "Form1.dfm" }),
      expect.objectContaining({ code: "IMPORT_LIMITED_ANALYSIS", filePath: "types.inc" }),
      expect.objectContaining({ code: "IMPORT_LIMITED_ANALYSIS", filePath: "package.dpk" }),
      expect.objectContaining({ code: "IMPORT_LIMITED_ANALYSIS", filePath: "layout.fmx" }),
    ]));
  });

  it("does not count ignored or unsupported entries against the source-file limit", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2100; index += 1) {
      zip.file(`node_modules/pkg-${index}/index.js`, "export const x = 1;\n");
      zip.file(`images/screenshot-${index}.png`, "binary");
    }
    zip.file("src/main.go", "package main\nfunc main() {}\n");
    zip.file("src/schema.sql", "SELECT 1;\n");

    const base64 = await zip.generateAsync({ type: "base64" });
    const result = await extractFilesFromZip(base64);

    expect(result.files.map((file) => file.path).sort()).toEqual(["src/main.go", "src/schema.sql"]);
  });

  it("still rejects archives with too many supported source files", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2001; index += 1) {
      zip.file(`src/file-${index}.go`, "package main\n");
    }

    const base64 = await zip.generateAsync({ type: "base64" });
    await expect(extractFilesFromZip(base64)).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: expect.stringContaining("too many source files"),
    });
  });

  it("returns stable errors for raw ZIP, extracted, file-count, and single-file limits", () => {
    expect(() => assertZipRawSize(MAX_ZIP_RAW_BYTES + 1)).toThrow(/too large.*Limit: 30MB/);
    expect(() => assertExtractedSize(MAX_EXTRACTED_BYTES + 1)).toThrow(/expands beyond.*500MB/);
    expect(() => assertSourceFileCount(MAX_FILE_COUNT + 1)).toThrow(/too many source files.*2000/);
    expect(() => assertSingleFileSize(MAX_SINGLE_FILE_BYTES + 1, "src/huge.go")).toThrow(/single-file limit.*5MB.*src\/huge\.go/);
  });

  it("rejects an uploaded ZIP payload larger than the raw archive limit before parsing", async () => {
    const oversizedBase64 = Buffer.alloc(MAX_ZIP_RAW_BYTES + 1).toString("base64");

    await expect(extractFilesFromZip(oversizedBase64)).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: expect.stringContaining("Limit: 30MB"),
    });
  });

  it("rejects a ZIP containing a source file larger than the single-file limit", async () => {
    const zip = new JSZip();
    zip.file("src/huge.go", Buffer.alloc(MAX_SINGLE_FILE_BYTES + 1, "a"));

    const base64 = await zip.generateAsync({ type: "base64" });
    await expect(extractFilesFromZip(base64)).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: expect.stringContaining("single-file limit"),
    });
  });
});
