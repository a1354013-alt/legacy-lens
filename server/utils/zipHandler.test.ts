import JSZip from "jszip";
import { Readable } from "node:stream";
import unzipper from "unzipper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EXTRACTED_BYTES, MAX_FILE_COUNT, MAX_SINGLE_FILE_BYTES, MAX_ZIP_RAW_BYTES } from "../../shared/const";
import {
  assertExtractedSize,
  assertSingleFileSize,
  assertSourceFileCount,
  assertZipRawSize,
  createSingleFileSizeWarning,
  extractFilesFromZip,
  isAbsoluteArchivePath,
  isSafeRelativePath,
  normalizePath,
} from "./zipHandler";

describe("zipHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    expect(createSingleFileSizeWarning("src/huge.go")).toEqual({
      code: "IMPORT_FILE_TOO_LARGE",
      message: "The file was skipped because it exceeds the maximum supported size (5MB).",
      filePath: "src/huge.go",
    });
  });

  it("rejects an uploaded ZIP payload larger than the raw archive limit before parsing", async () => {
    const oversizedBase64 = Buffer.alloc(MAX_ZIP_RAW_BYTES + 1).toString("base64");

    await expect(extractFilesFromZip(oversizedBase64)).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: expect.stringContaining("Limit: 30MB"),
    });
  });

  it("rejects invalid ZIP payloads with a stable ZIP_INVALID error", async () => {
    await expect(extractFilesFromZip(Buffer.from("not-a-zip").toString("base64"))).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: "Failed to read ZIP archive.",
    });
  });

  it("rejects empty ZIP payloads before parsing", async () => {
    await expect(extractFilesFromZip("")).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: "Uploaded ZIP archive is empty.",
    });
  });

  it("rejects archives with unsafe paths instead of silently skipping them", async () => {
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValue({
      files: [
        {
          path: "../evil.go",
          type: "File",
          vars: { uncompressedSize: 13 },
          stream: () => Readable.from([Buffer.from("package main\n")]),
        },
      ],
    } as any);

    await expect(extractFilesFromZip("ZmFrZQ==")).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH",
      message: expect.stringContaining("unsafe path"),
    });
  });

  it("rejects archives with absolute paths", async () => {
    const zip = new JSZip();
    zip.file("/absolute/main.go", "package main\n");

    await expect(extractFilesFromZip(await zip.generateAsync({ type: "base64" }))).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH",
      message: expect.stringContaining("unsafe path"),
    });
  });

  it("rejects archives with Windows drive paths", async () => {
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValue({
      files: [
        {
          path: "C:/windows/system32/evil.go",
          type: "File",
          vars: { uncompressedSize: 13 },
          stream: () => Readable.from([Buffer.from("package main\n")]),
        },
      ],
    } as any);

    await expect(extractFilesFromZip("ZmFrZQ==")).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH",
      message: expect.stringContaining("unsafe path"),
    });
  });

  it("rejects archives with nested traversal paths", async () => {
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValue({
      files: [
        {
          path: "safe/../../evil.go",
          type: "File",
          vars: { uncompressedSize: 13 },
          stream: () => Readable.from([Buffer.from("package main\n")]),
        },
      ],
    } as any);

    await expect(extractFilesFromZip("ZmFrZQ==")).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH",
      message: expect.stringContaining("unsafe path"),
    });
  });

  it("rejects archives whose extracted supported-source bytes exceed the limit", async () => {
    const nearSingleFileLimitBuffer = Buffer.alloc(MAX_SINGLE_FILE_BYTES, "a");
    const openBufferSpy = vi.spyOn(unzipper.Open, "buffer").mockResolvedValue({
      files: Array.from({ length: 101 }, (_, index) => ({
        path: `src/file-${index}.go`,
        type: "File",
        vars: { uncompressedSize: nearSingleFileLimitBuffer.length },
        stream: () => Readable.from([nearSingleFileLimitBuffer]),
      })),
    } as any);

    await expect(extractFilesFromZip("ZmFrZQ==")).rejects.toMatchObject({
      code: "ZIP_INVALID",
      message: expect.stringContaining("allowed size limit"),
    });

    expect(openBufferSpy).toHaveBeenCalled();
  });

  it("skips oversize files and keeps importing the remaining supported files", async () => {
    const zip = new JSZip();
    zip.file("src/huge.go", Buffer.alloc(MAX_SINGLE_FILE_BYTES + 1, "a"));
    zip.file("src/main.go", "package main\nfunc main() {}\n");

    const result = await extractFilesFromZip(await zip.generateAsync({ type: "base64" }));

    expect(result.files.map((file) => file.path)).toEqual(["src/main.go"]);
    expect(result.warnings).toContainEqual({
      code: "IMPORT_FILE_TOO_LARGE",
      message: "The file was skipped because it exceeds the maximum supported size (5MB).",
      filePath: "src/huge.go",
    });
  });

  it("blocks highly compressed source files that expand beyond the single-file limit before they are imported", async () => {
    const zip = new JSZip();
    zip.file("src/bomb.go", "a".repeat(MAX_SINGLE_FILE_BYTES + 1024));
    zip.file("src/main.go", "package main\nfunc main() {}\n");

    const result = await extractFilesFromZip(await zip.generateAsync({ type: "base64", compression: "DEFLATE" }));

    expect(result.files.map((file) => file.path)).toEqual(["src/main.go"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "IMPORT_FILE_TOO_LARGE",
        filePath: "src/bomb.go",
      })
    );
  });
});
