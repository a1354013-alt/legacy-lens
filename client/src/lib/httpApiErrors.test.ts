import { describe, expect, it } from "vitest";
import { getImportUploadErrorMessage, getReportDownloadErrorMessage } from "./httpApiErrors";

describe("httpApiErrors", () => {
  it("maps upload conflict and unsafe ZIP errors to actionable messages", () => {
    expect(
      getImportUploadErrorMessage(400, {
        code: "ZIP_UNSAFE_PATH",
        error: "Archive contains an unsafe path.",
        message: "Archive contains an unsafe path.",
      })
    ).toContain("整包已被拒絕");

    expect(
      getImportUploadErrorMessage(409, {
        code: "PROJECT_JOB_ACTIVE",
        error: "Project already has an active job.",
        message: "Project already has an active job.",
      })
    ).toContain("已有進行中的匯入或分析工作");
  });

  it("maps report readiness and size errors to stable download guidance", () => {
    expect(
      getReportDownloadErrorMessage(409, {
        code: "REPORT_NOT_READY",
        error: "Analysis report is not ready for download.",
        message: "Analysis report is not ready for download.",
      })
    ).toContain("尚未準備完成");

    expect(
      getReportDownloadErrorMessage(413, {
        code: "REPORT_TOO_LARGE",
        error: "Report too large.",
        message: "Report too large.",
        remediation: "Split the project.",
      })
    ).toContain("Split the project.");
  });
});
