import { describe, expect, it } from "vitest";
import { analysisStatusLabel, localizeProjectJobErrorMessage, projectJobFailureTitle } from "./uiLabels";

describe("project job error labels", () => {
  it("localizes every persisted analysis status, including completed_with_warnings", () => {
    expect(analysisStatusLabel("pending")).toBe("尚未分析");
    expect(analysisStatusLabel("processing")).toBe("分析中");
    expect(analysisStatusLabel("completed")).toBe("分析完成");
    expect(analysisStatusLabel("completed_with_warnings")).toBe("分析完成（含警告）");
    expect(analysisStatusLabel("partial")).toBe("部分完成");
    expect(analysisStatusLabel("failed")).toBe("分析失敗");
  });

  it("shows analysis failure labels for analyze jobs", () => {
    expect(projectJobFailureTitle("analyze")).toBe("分析失敗");
    expect(localizeProjectJobErrorMessage("analyze", "Analysis failed.")).toBe("分析失敗，請查看分析紀錄或伺服器日誌。");
  });

  it("keeps import failure labels for import jobs", () => {
    expect(projectJobFailureTitle("import_zip")).toBe("匯入失敗");
    expect(localizeProjectJobErrorMessage("import_zip", "Import failed.")).toBe("匯入工作失敗。");
  });
});
