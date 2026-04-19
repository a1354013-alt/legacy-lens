import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractFilesFromZip, isAbsoluteArchivePath, isSafeRelativePath, normalizePath } from "./zipHandler";

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
});
