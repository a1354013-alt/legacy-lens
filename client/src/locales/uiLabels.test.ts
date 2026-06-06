import { describe, expect, it } from "vitest";
import { localizeProjectJobErrorMessage, projectJobFailureTitle } from "./uiLabels";

describe("project job error labels", () => {
  it("shows analysis failure labels for analyze jobs", () => {
    expect(projectJobFailureTitle("analyze")).toBe("分析失敗");
    expect(localizeProjectJobErrorMessage("analyze", "Analysis failed.")).toBe("分析失敗，請查看分析紀錄或伺服器日誌。");
  });

  it("keeps import failure labels for import jobs", () => {
    expect(projectJobFailureTitle("import_zip")).toBe("匯入失敗");
    expect(localizeProjectJobErrorMessage("import_zip", "Import failed.")).toBe("匯入工作失敗。");
  });
});
