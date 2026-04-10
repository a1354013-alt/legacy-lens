import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractFilesFromZip } from "./zipHandler";

describe("zipHandler", () => {
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
});
