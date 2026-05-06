import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_ZIP_SIZE, validateUploadedZip } from "./importUpload";

describe("validateUploadedZip", () => {
  it("rejects ZIP files that exceed the frontend upload limit", () => {
    const result = validateUploadedZip({ size: MAX_UPLOAD_ZIP_SIZE + 1 } as File);

    expect(result).toContain("30MB");
  });

  it("accepts ZIP files within the limit", () => {
    expect(validateUploadedZip({ size: MAX_UPLOAD_ZIP_SIZE } as File)).toBeNull();
  });
});
