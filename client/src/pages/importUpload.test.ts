import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_ZIP_SIZE, validateUploadedZip } from "./importUpload";

describe("validateUploadedZip", () => {
  it("rejects ZIP files that exceed the frontend upload limit", () => {
    const result = validateUploadedZip({ name: "too-large.zip", size: MAX_UPLOAD_ZIP_SIZE + 1 } as File);

    expect(result).toContain("30MB");
  });

  it("rejects files that do not use the .zip extension", () => {
    expect(validateUploadedZip({ name: "notes.txt", size: 1 } as File)).toBe("請上傳 .zip 檔案。");
  });

  it("accepts ZIP files within the limit", () => {
    expect(validateUploadedZip({ name: "source.zip", size: MAX_UPLOAD_ZIP_SIZE } as File)).toBeNull();
  });
});
